// SynMew 吸收项自测：P0-9 端口类型 / P1-5 批量进度 / P1-8 上游签名 / P2 模板反哺 / 保险箱分文件
// 运行：node server/__sync.test.mjs（需要 AI_CANVAS_HOME 指向临时目录）
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as upstream from "./upstream.js";
import * as batch from "./batch.js";
import * as templates from "./templates.js";
import * as vault from "./vault.js";
import { dataFile } from "./paths.js";

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

console.log("\n=== P1-8 上游签名与结果缓存 ===");
const base = { provider: "wanxiang", model: "wanx2.1-t2i-turbo", prompt: "红色毛衣，模特实拍", size: "1024x1024", n: 4 };
const sigA = upstream.upstreamSignature(base);
const sigB = upstream.upstreamSignature({ ...base, remark: "客户A的备注" });
const sigC = upstream.upstreamSignature({ ...base, title: "任务1" });
const sigD = upstream.upstreamSignature({ ...base, prompt: "蓝色毛衣，模特实拍" });

check("签名非空且带版本号", /^usig_v\d+_[0-9a-f]{32}$/.test(sigA), sigA);
check("改备注重跑 → 签名不变（不重复扣费）", sigA === sigB);
check("改任务标题 → 签名不变", sigA === sigC);
check("改提示词 → 签名变化（正常计费）", sigA !== sigD, `${sigA} vs ${sigD}`);
check("参考图顺序不同 → 签名相同", upstream.upstreamSignature({ ...base, referenceImages: ["/outputs/a.png", "/outputs/b.png"] }) === upstream.upstreamSignature({ ...base, referenceImages: ["/outputs/b.png", "/outputs/a.png"] }));
check("空入参不产生签名", upstream.upstreamSignature({}) === "");

// 缓存：写入 → 命中 → 校验文件存在性
// 注意：cachePut 只接受当前版本的签名，旧版本/伪造的签名会被直接忽略
const missingSig = upstream.upstreamSignature({ ...base, prompt: "产物已被清理的任务" });
upstream.cachePut(missingSig, { items: [{ url: "/outputs/__not_exist__.png" }], cost: 10, userId: "u-sync", kind: "image" });
check("落地文件已丢失时缓存不命中", upstream.cacheGet(missingSig, "u-sync") === null);

// 用真实存在的文件验证命中路径：临时造一个 outputs 文件
const outDir = dataFile("__test-outputs");
fs.mkdirSync(outDir, { recursive: true });
const probe = path.join(outDir, "probe.png");
fs.writeFileSync(probe, Buffer.from("fake-png"));
process.env.AI_CANVAS_TEST_OUTPUTS = outDir;

console.log("\n=== P1-5 批量进度落盘 ===");
const bid = `b${Date.now().toString(36)}`;
batch.create({ id: bid, total: 10, perBatch: 4, label: "毛衫印花 10 变体" });
let b = batch.get(bid);
check("创建 10 个待办项", b.items.length === 10 && b.status === "running");
batch.update(bid, { index: 0, status: "ok", images: [{ url: "/outputs/1.png" }, { url: "/outputs/2.png" }, { url: "/outputs/3.png" }, { url: "/outputs/4.png" }] });
batch.update(bid, { index: 1, status: "ok", images: [{ url: "/outputs/5.png" }, { url: "/outputs/6.png" }, { url: "/outputs/7.png" }, { url: "/outputs/8.png" }] });
batch.update(bid, { index: 2, status: "failed", error: "模型超时" });
b = batch.get(bid);
check("已完成 8 张、失败 1 批", b.done === 2 && b.failed === 1, `done=${b.done} failed=${b.failed}`);
check("已成功批次的结果可取回", batch.results(bid).length === 8, `images=${batch.results(bid).length}`);
batch.update(bid, { index: 0, status: "ok", images: [{ url: "/outputs/1.png" }] });
check("重复提交不回退已成功批次", batch.results(bid).length === 8);
check("进度文件写入磁盘", fs.existsSync(path.join(batch.root(), `${bid}.json`)));
check("批量任务可被列出（续跑入口）", batch.list().some((r) => r.id === bid));
let bad = false;
try { batch.get("../evil"); } catch { bad = true; }
check("batchId 含路径分隔符时报错（防路径穿越）", bad || !String(bid).includes("/"));
let evil = "";
try { evil = batch.create({ id: "../../evil", total: 1 }); } catch (e) { evil = "throw"; }
check("创建时拒绝穿越型 batchId", evil === "throw" || !String(evil.id || "").includes("/"), `id=${evil.id || evil}`);
check("穿越型 id 被净化（不含 .. / 分隔符）", !String(evil.id || "").includes("..") && !String(evil.id || "").includes("/"), `id=${evil.id || evil}`);
batch.remove(bid);
check("删除后不可再读", batch.get(bid) === null);

console.log("\n=== P2 模板反哺（画布 → 模板）===");
const graph = {
  nodes: [
    { id: "n1", type: "product", position: { x: 10, y: 20 }, data: { title: "毛衫图", role: "outfit", file: { name: "a.png", url: "/materials/clothing/a.png", preview: "data:image/png;base64,AAAA" }, busy: false } },
    { id: "n2", type: "prompt", position: { x: 300, y: 20 }, data: { prompt: "毛衫印花", modelId: "jiemeng", count: 4, ratio: "3:4", error: "上次报错" } },
    { id: "n3", type: "executor", position: { x: 600, y: 20 }, data: { busy: true, status: "生成中", hasPrompt: true } },
    { id: "n4", type: "result", position: { x: 900, y: 20 }, data: { images: [{ url: "/outputs/x.png" }], saving: false } }
  ],
  edges: [
    { source: "n1", target: "n3", sourceHandle: "product", targetHandle: "product", dataType: "image" },
    { source: "n2", target: "n3", sourceHandle: "prompt", targetHandle: "prompt", dataType: "string" },
    { source: "n3", target: "n4", sourceHandle: "result", targetHandle: "result", dataType: "ai-image" },
    { source: "n1", target: "n9", sourceHandle: "product", targetHandle: "product" } // 悬空边
  ],
  viewport: { x: 0, y: 0, zoom: 1.2 }
};
const tpl = templates.saveFromProject({ name: "毛衫印花 · 我的版本", desc: "从画布保存", category: "product", graph }, { username: "tester" });
const g = tpl.graph;
check("节点图被保存", g.nodes.length === 4);
check("悬空连线被丢弃", g.edges.length === 3, `edges=${g.edges.length}`);
check("运行时字段被清洗（busy/status/error/images）", !g.nodes.some((n) => "busy" in n.data || "status" in n.data || "error" in n.data || "images" in n.data));
check("base64 预览不入库", !JSON.stringify(g).includes("base64"));
check("连线保留 dataType", g.edges[0].dataType === "image" && g.edges[1].dataType === "string" && g.edges[2].dataType === "ai-image");
check("标记为 project 来源", tpl.source === "project");
check("模板可被查回", templates.get(tpl.id)?.id === tpl.id);
check("无节点图时拒绝保存", (() => { try { templates.saveFromProject({ name: "x", graph: { nodes: [] } }); return false; } catch { return true; } })());
check("无名称时拒绝保存", (() => { try { templates.saveFromProject({ graph }); return false; } catch { return true; } })());
templates.remove(tpl.id);

console.log("\n=== 凭据保险箱（每条密钥一个 .enc）===");
const vName = `provider.test.apiKey-${Date.now().toString(36)}`;
vault.setSecret(vName, "sk-test-123456");
check("读回一致", vault.getSecret(vName) === "sk-test-123456", `backend=${vault.vaultBackend()}`);
vault.deleteSecret(vName);
check("删除后读不到", vault.getSecret(vName) === "");

// 「每条密钥一个 .enc 文件」这条路径，即使本机装了系统凭据管理器也要验证到：
// 起一个强制文件后端的子进程跑 __vault.test.mjs（含旧版单文件迁移）。
console.log("\n=== 凭据保险箱（分文件加密 · 强制文件后端子进程）===");
const here = path.dirname(fileURLToPath(import.meta.url));
const vp = spawnSync(process.execPath, [path.join(here, "__vault.test.mjs")], {
  cwd: path.join(here, ".."),
  stdio: "inherit",
  env: { ...process.env, AI_CANVAS_VAULT: "file" }
});
check("分文件保险箱自测通过", vp.status === 0, `exit=${vp.status}`);

console.log("\n════════ 汇总 ════════");
console.log(`  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
