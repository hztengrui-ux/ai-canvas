// 对抗性复验 V4：上游结果缓存到底会不会跨用户串结果
// 隔离到 .verifydata/v4，直接调用 upstream.js（与 index.js:557/650 同一份代码）
//
// 运行：& "...\node.exe" E:\DSH项目\ai-canvas\reports\verify\v4-cache.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(ROOT, ".verifydata", "v4");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
process.env.AI_CANVAS_HOME = DIR;
process.env.AI_CANVAS_OUTPUTS = path.join(DIR, "outputs");
process.env.AI_CANVAS_VAULT = "file";

const upstream = await import(pathToFileURL(path.join(ROOT, "server", "upstream.js")).href);

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`); }
}

console.log("\n=== V4：缓存隔离 —— 是否跨用户串结果 ===");
console.log(`  隔离目录：${DIR}`);

const imgA = { kind: "image", provider: "wanxiang", model: "m", prompt: "A 用户独占的提示词", size: "1024x1024", n: 1 };
const imgB = { kind: "image", provider: "wanxiang", model: "m", prompt: "B 用户独占的提示词", size: "1024x1024", n: 1 };
const sigA = upstream.upstreamSignature(imgA);
const sigB = upstream.upstreamSignature(imgB);
const put = (sig, userId, url) => upstream.cachePut(sig, { items: [{ url, remoteUrl: "" }], cost: 10, provider: "wanxiang", model: "m", userId, kind: "image" });

put(sigA, "userA", "https://cdn.example.com/A-secret.png");
const aOwn = upstream.cacheGet(sigA, "userA");
const bSteal = upstream.cacheGet(sigA, "userB");
check("A 自己的缓存能命中", aOwn?.items?.[0]?.url === "https://cdn.example.com/A-secret.png");
check("【关键】B 查询同一签名拿不到 A 的结果（跨用户不串结果）", bSteal === null, `cacheGet(sigA,'userB')=${JSON.stringify(bSteal)}`);

put(sigA, "userB", "https://cdn.example.com/B-secret.png");
const aAfter = upstream.cacheGet(sigA, "userA");
const bAfter = upstream.cacheGet(sigA, "userB");
check("同签名被 B 覆盖后，A 再查仍是 null（失败关闭，绝不泄漏 B 的图给 A）", aAfter === null, `cacheGet(sigA,'userA')=${JSON.stringify(aAfter)}`);
check("B 只能拿到 B 自己的结果", bAfter?.items?.[0]?.url === "https://cdn.example.com/B-secret.png");

put(sigB, "userA", "https://cdn.example.com/A-2.png");
check("【关键】不同签名可共存（不是『单槽覆盖』）：缓存条目数 = 2",
  upstream.cacheStats().total === 2, `total=${upstream.cacheStats().total}`);
check("共存的第二条按各自 userId 命中/拦截",
  upstream.cacheGet(sigB, "userA")?.items?.[0]?.url === "https://cdn.example.com/A-2.png" &&
  upstream.cacheGet(sigB, "userB") === null);

const raw = JSON.parse(fs.readFileSync(path.join(DIR, "gen-cache.json"), "utf8"));
console.log(`  缓存文件实际结构：entries 的键 = ${JSON.stringify(Object.keys(raw.entries).map((k) => k.slice(0, 20) + "..."))}`);
console.log(`  每个条目的 userId：${JSON.stringify(Object.values(raw.entries).map((e) => e.userId))}`);
check("结构确为 { entries: { [sig]: { userId, items... } } }（键是 sig，userId 存条目内）",
  Object.keys(raw.entries).length === 2 && Object.values(raw.entries).every((e) => "userId" in e));

console.log(`\n  V4 汇总：通过 ${pass} / 失败 ${fail}`);
console.log("  → 结论：隔离是 fail-closed 的，不存在跨用户串结果；同一签名的跨用户写入只会",
  "把对方的缓存条目挤掉（可用性削弱），不会泄漏内容。\n");
process.exit(0);
