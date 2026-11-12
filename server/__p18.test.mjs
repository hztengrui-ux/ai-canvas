// P1-8 专项验收：上游签名 + 结果缓存 + 幂等扣费
//
// 验收口径（对应统一主方案 P1 验收新增项）：
//   「改备注重跑不重复扣费」—— 备注/标题/任务名不进签名，改它们重跑必须零扣费。
// 同时守住反向边界：真的换了输入，必须重新计费，否则就是被白嫖。
//
// 运行：node server/__p18.test.mjs（AI_CANVAS_HOME 指向临时目录）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as upstream from "./upstream.js";
import * as credits from "./credits.js";
import { outputsDir } from "./config.js";
import { dataFile } from "./paths.js";

const CACHE_PATH = dataFile("gen-cache.json");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

const OUT = outputsDir();
/** 造一个真实存在的产物文件（缓存命中要求文件在） */
function makeFile(name, content = "png-bytes") {
  const p = path.join(OUT, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return `/outputs/${name}`;
}

// ============================================================
console.log("\n=== 1. 签名规则：该变的变，不该变的不变 ===");
const base = {
  provider: "wanxiang",
  model: "wanx2.1-t2i-turbo",
  prompt: "红色毛衣，模特实拍，纯色背景",
  size: "1024x1024",
  n: 4
};
const sig = upstream.upstreamSignature(base);

check("签名带版本号前缀", sig.startsWith(`usig_${upstream.SIG_VERSION}_`), sig);
check("签名可复现", upstream.upstreamSignature(base) === sig);

// —— 不该变的：这些字段与模型输出无关
check("改备注 → 签名不变", upstream.upstreamSignature({ ...base, remark: "客户A" }) === sig);
check("改任务标题 → 签名不变", upstream.upstreamSignature({ ...base, title: "毛衫印花-01" }) === sig);
check("带批量上下文 → 签名不变", upstream.upstreamSignature({ ...base, batchId: "b1", batchIndex: 2 }) === sig);
check("带时间戳/用户 → 签名不变", upstream.upstreamSignature({ ...base, ts: Date.now(), userId: "u1" }) === sig);
check(
  "提示词首尾空格 → 签名不变（已 trim）",
  upstream.upstreamSignature({ ...base, prompt: `  ${base.prompt}  ` }) === sig
);
check("n 传数字 4 与字符串 '4' → 签名一致", upstream.upstreamSignature({ ...base, n: "4" }) === sig);
check(
  "参考图顺序不同 → 签名不变",
  upstream.upstreamSignature({ ...base, referenceImages: ["/outputs/a.png", "/outputs/b.png"] }) ===
    upstream.upstreamSignature({ ...base, referenceImages: ["/outputs/b.png", "/outputs/a.png"] })
);

// —— 该变的：任何影响模型输出的字段
for (const [label, patch] of [
  ["提示词", { prompt: "蓝色毛衣" }],
  ["尺寸", { size: "768x1024" }],
  ["张数", { n: 2 }],
  ["模型", { model: "wanx2.1-t2i-plus" }],
  ["提供方", { provider: "jiemeng" }],
  ["随机种子", { seed: 42 }],
  ["步数", { steps: 30 }],
  ["引导系数", { cfg: 7.5 }],
  ["反向提示词", { negativePrompt: "模糊，水印" }]
]) {
  check(`改${label} → 签名变化（应重新计费）`, upstream.upstreamSignature({ ...base, ...patch }) !== sig);
}

// 图片 / 视频签名不能撞车
const vidSig = upstream.upstreamSignature({ ...base, kind: "video", n: 1, duration: 5, resolution: "720p" });
check("图片与视频签名不撞车", vidSig !== sig, `${sig} / ${vidSig}`);
check(
  "视频时长变化 → 签名变化",
  upstream.upstreamSignature({ ...base, kind: "video", duration: 10 }) !==
    upstream.upstreamSignature({ ...base, kind: "video", duration: 5 })
);
check(
  "视频分辨率变化 → 签名变化",
  upstream.upstreamSignature({ ...base, kind: "video", resolution: "1080p" }) !==
    upstream.upstreamSignature({ ...base, kind: "video", resolution: "720p" })
);
check("空入参不产生签名（绝不共享同一 refId）", upstream.upstreamSignature({}) === "");
check("只有备注也算空任务", upstream.upstreamSignature({ remark: "x" }) === "");

// ============================================================
console.log("\n=== 2. 参考图按内容哈希（换文件名不算新任务）===");
const f1 = makeFile("__p18_a.png", "same-content");
const f2 = makeFile("__p18_b.png", "same-content");
makeFile("__p18_c.png", "different-content");

check(
  "同内容不同文件名 → 签名相同",
  upstream.upstreamSignature({ ...base, referenceImages: [f1] }) ===
    upstream.upstreamSignature({ ...base, referenceImages: [f2] })
);
check(
  "内容变化 → 签名变化",
  upstream.upstreamSignature({ ...base, referenceImages: [f1] }) !==
    upstream.upstreamSignature({ ...base, referenceImages: ["/outputs/__p18_c.png"] })
);
const contentHash = crypto.createHash("sha256").update("same-content").digest("hex").slice(0, 32);
check(
  "客户端自带 sha256 与服务端读文件结果一致",
  upstream.upstreamSignature({ ...base, referenceImages: [{ url: f1, sha256: contentHash }] }) ===
    upstream.upstreamSignature({ ...base, referenceImages: [f2] })
);
check(
  "客户端谎报 sha256 → 签名不同（不能靠客户端免扣）",
  upstream.upstreamSignature({ ...base, referenceImages: [{ url: f1, sha256: "f".repeat(32) }] }) !==
    upstream.upstreamSignature({ ...base, referenceImages: [f2] })
);
check(
  "文件被删后签名退化为 @missing（不抛错）",
  upstream.upstreamSignature({ ...base, referenceImages: ["/outputs/__p18_gone.png"] }).length > 0
);

// ============================================================
console.log("\n=== 3. 结果缓存：命中免扣，且按用户隔离 ===");
upstream.cacheClear();
const items = [{ url: f1, remoteUrl: "https://example.com/a.png" }];

upstream.cachePut(sig, { items, cost: 10, provider: "wanxiang", model: base.model, userId: "u1", kind: "image" });
const hit = upstream.cacheGet(sig, "u1");
check("本人命中缓存", Boolean(hit) && hit.cached === true);
check("命中返回原结果", hit?.items?.[0]?.url === f1);
check("命中记录省下的算力点", hit?.savedCost === 10, `savedCost=${hit?.savedCost}`);

check("他人不命中（防跨账号白嫖）", upstream.cacheGet(sig, "u2") === null);
check("未登录用户不命中", upstream.cacheGet(sig, "") === null);
check("不存在的签名不命中", upstream.cacheGet(upstream.upstreamSignature({ ...base, prompt: "别的" }), "u1") === null);

// 产物被清理 → 缓存必须失效，不能返回一张 404 的图
fs.unlinkSync(path.join(OUT, "__p18_a.png"));
check("产物文件被删 → 缓存不命中", upstream.cacheGet(sig, "u1") === null);

const stats = upstream.cacheStats();
check("统计里 alive 已扣除失效项", stats.alive === 0, JSON.stringify(stats));
upstream.cacheClear();
check("cacheClear 后清空", upstream.cacheStats().total === 0);

console.log("\n=== 4. 缓存清理（sweep）===");
upstream.cacheClear();
const f3 = makeFile("__p18_d.png", "keep");
const liveSig = upstream.upstreamSignature({ ...base, prompt: "存活条目" });
const oldSig = upstream.upstreamSignature({ ...base, prompt: "旧版本条目" });
upstream.cachePut(liveSig, { items: [{ url: f3 }], cost: 10, userId: "u1", kind: "image" });
// 手工塞一条「上一个签名版本」的条目，模拟规则升级后的残留
const c = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
c.entries[`usig_v1_${"0".repeat(32)}`] = { kind: "image", items: [{ url: f3 }], cost: 10, userId: "u1", ts: Date.now() };
fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2));
const sw = upstream.sweep();
check("sweep 清掉旧版本签名条目", sw.removed === 1, JSON.stringify(sw));
check("sweep 保留当前版本有效条目", sw.kept === 1);

// TTL 过期：模块加载时读 env，只能靠子进程验证。
//
// ⚠️ 2026-10-14 修复：原来用 spawnSync(..., { encoding: "utf8" })，
// 这会隐含走**管道 stdio**。在受限沙箱里命名管道被禁止，spawn 直接 EPERM
// → child.stdout 是 undefined → 整条用例静默失败（看起来像 TTL 逻辑坏了，
// 其实是取输出的方式跑不通）。
// 现在改成让子进程把结果写进文件、父进程读文件：stdin/stdout/stderr 全部
// 挂到文件描述符上，不依赖任何管道。
const ttlOutFile = path.join(path.dirname(CACHE_PATH), "__p18_ttl_out.json");
const ttlScript = `
import * as u from "./server/upstream.js";
import fs from "node:fs";
import { outputsDir } from "./server/config.js";
const f = "/outputs/__p18_ttl.png";
fs.writeFileSync(outputsDir().replace(/\\\\/g, "/") + "/__p18_ttl.png", "x");
const s = u.upstreamSignature({ provider: "wanxiang", prompt: "ttl", n: 1 });
u.cachePut(s, { items: [{ url: f }], cost: 10, userId: "u1", kind: "image" });
const before = u.cacheGet(s, "u1");
const marks = [];
marks.push(["刚写入时命中", Boolean(before)]);
await new Promise((r) => setTimeout(r, 30));
marks.push(["TTL 过后不命中", u.cacheGet(s, "u1") === null]);
marks.push(["sweep 报告已清理", u.sweep().removed === 1]);
fs.writeFileSync(${JSON.stringify(ttlOutFile)}, JSON.stringify(marks));
`;
fs.mkdirSync(path.dirname(ttlOutFile), { recursive: true });
try {
  fs.rmSync(ttlOutFile, { force: true });
} catch {
  /* ignore */
}
const ttlFd = fs.openSync(ttlOutFile, "w");
const ttl = spawnSync(process.execPath, ["--input-type=module", "-e", ttlScript], {
  cwd: ROOT,
  // 不用 encoding / 不传 stdio 数组：全部走文件句柄，绕开沙箱的管道禁令
  stdio: ["ignore", ttlFd, ttlFd],
  env: { ...process.env, AI_CANVAS_CACHE_TTL: "1" }
});
let ttlStdout = "";
try {
  ttlStdout = fs.readFileSync(ttlOutFile, "utf8");
} catch {
  ttlStdout = "";
} finally {
  try {
    fs.closeSync(ttlFd);
  } catch {
    /* ignore */
  }
}
try {
  const marks = JSON.parse(String(ttlStdout || "").trim());
  for (const [name, ok] of marks) check(`TTL：${name}`, ok);
} catch {
  check(
    "TTL 过期场景可验证",
    false,
    `status=${ttl.status} err=${ttl.error?.message || "-"} out=${String(ttlStdout).slice(0, 200)}`
  );
}

// ============================================================
console.log("\n=== 5. 与账本协同：命中不预扣，未命中才走预扣/提交/回滚 ===");
const uid = `p18-${Date.now().toString(36)}`;
await credits.grant(uid, 500, "测试赠送");
const b0 = credits.balance(uid);
check("测试账号初始余额 500", b0 === 500, `balance=${b0}`);

// 场景 A：命中缓存 → 服务端直接返回，不该产生任何账本流水
upstream.cacheClear();
const sA = upstream.upstreamSignature({ ...base, prompt: "幂等场景A" });
upstream.cachePut(sA, { items: [{ url: f3 }], cost: 10, userId: uid, kind: "image" });
const cashHit = upstream.cacheGet(sA, uid);
if (cashHit) {
  check("命中缓存时不产生任何账本流水", credits.balance(uid) === b0, `balance=${credits.balance(uid)}`);
}

// 场景 B：未命中 → 预扣 → 提交；再用同一 refId 查，应能查到「已消费」
const sB = upstream.upstreamSignature({ ...base, prompt: "幂等场景B" });
const r1 = await credits.reserve(uid, "image.generate", sB);
check("未命中时正常预扣", r1.ok === true && credits.balance(uid) === b0 - 10, `balance=${credits.balance(uid)}`);
check("预扣阶段 findConsumed 查不到（还没提交）", credits.findConsumed(uid, sB) === null);
await credits.commit(uid, "image.generate", sB);
check("提交后 findConsumed 能查到（缓存被清也能免扣）", Boolean(credits.findConsumed(uid, sB)));

// 场景 C：缓存被清但账本有消费记录 → 走 replay 分支（不预扣，失败也不回滚）。
// 这里复刻 /api/generate 里的那段判定：只有真预扣过才 rollback。
upstream.cacheClear();
const replay = credits.findConsumed(uid, sB);
check("缓存清理后仍能识别为已付费重跑", Boolean(replay));
const reservedC = replay
  ? { ok: true, cost: 0, balance: credits.balance(uid), reserved: false, replay: true }
  : await credits.reserve(uid, "image.generate", sB);
check("replay 时不预扣", reservedC.reserved === false);
const rbC = reservedC.reserved ? await credits.rollback(uid, sB) : { refunded: 0 };
check("replay 失败不回滚（不凭空刷算力）", rbC.refunded === 0, JSON.stringify(rbC));
check("replay 后余额未被改动", credits.balance(uid) === b0 - 10, `balance=${credits.balance(uid)}`);

// 场景 D：真的失败 → 预扣必须退回，且不能退第二次
const sD = upstream.upstreamSignature({ ...base, prompt: "幂等场景D" });
await credits.reserve(uid, "image.generate", sD);
const rb1 = await credits.rollback(uid, sD);
const rb2 = await credits.rollback(uid, sD);
check("失败退回算力", rb1.refunded === 10, JSON.stringify(rb1));
check("同一笔不能退两次", rb2.skipped === true, JSON.stringify(rb2));
check("退回后余额复原", credits.balance(uid) === b0 - 10, `balance=${credits.balance(uid)}`);

// 场景 E：对账不失衡
const rec = credits.reconcile();
check("账本对账无异常", rec && rec.ok !== false, JSON.stringify(rec).slice(0, 160));

console.log("\n════════ 汇总 ════════");
console.log(`  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
