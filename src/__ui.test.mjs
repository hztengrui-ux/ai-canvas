/**
 * 新界面层自测（2026-09-25 新增的导出 / 持久化 / 语义缩放分档）
 *
 * 这些模块是纯逻辑，不依赖 DOM，可以在 Node 里直接跑：
 *   - exportkit：CRC32、ZIP 结构、命名规则
 *   - project：localStorage 持久化、资产去重、配额兜底
 *   - 缩放分档：纯函数，从 NodeCanvas 抽出来同逻辑校验
 *
 * localStorage / document 在 Node 里不存在，测试开头做最小 mock。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- 最小环境 mock（必须在 import 被测模块之前） ----
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
globalThis.localStorage = new MemoryStorage();

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

const ek = await import("./exportkit.js");
const proj = await import("./project.js");
const { store } = await import("./store.js");

console.log("\n=== 导出命名规则 ===");
check("文件名清洗掉路径分隔符", ek.safeName("a/b:c*d?e<f>g|h") === "abcdefgh", ek.safeName("a/b:c*d?e<f>g|h"));
check("文件名去掉空格", ek.safeName("毛 衫 印花") === "毛衫印花", ek.safeName("毛 衫 印花"));
// 前缀全是非法字符 → safeName 洗空 → 必须退回 ai-canvas，不能产出 "-001.png" 这种怪名
check(
  "非法前缀兜底为 ai-canvas",
  ek.assetName(1, "png", "///:::") === `ai-canvas-${ek.stamp()}-001.png`,
  ek.assetName(1, "png", "///:::")
);
check("序号补三位", ek.assetName(7, "png", "proj").endsWith("-007.png"), ek.assetName(7, "png", "proj"));
check("扩展名来自 url 后缀", ek.assetName(1, "mp4", "v").endsWith(".mp4"));

console.log("\n=== CRC32（ZIP 正确性依赖它）===");
const enc = new TextEncoder();
// 标准 CRC-32 已知值，错了说明整个 ZIP 的校验和都是废品
check("crc32('hello') = 0x3610a686", ek.crc32(enc.encode("hello")) === 0x3610a686, ek.crc32(enc.encode("hello")).toString(16));
check("crc32('') = 0", ek.crc32(new Uint8Array(0)) === 0);
check("crc32('123456789') = 0xcbf43926", ek.crc32(enc.encode("123456789")) === 0xcbf43926, ek.crc32(enc.encode("123456789")).toString(16));

const zipA = ek.makeZip([{ name: "a.txt", data: enc.encode("hello") }]);
check("ZIP 产出 Blob", zipA instanceof Blob && zipA.size > 0, `size=${zipA?.size}`);

// 手工解析 EOCD 验证结构。EOCD 固定 22 字节，字段偏移：
//   0 sig(4) 4 disk(2) 6 cdDisk(2) 8 entriesHere(2) 10 entriesTotal(2)
//   12 cdSize(4) 16 cdOffset(4) 20 commentLen(2)
const buf = Buffer.from(await zipA.arrayBuffer());
const eocd = buf.length - 22;
check("EOCD 签名正确", buf.readUInt32LE(eocd) === 0x06054b50);
check("中央目录条目数 = 1", buf.readUInt16LE(eocd + 10) === 1, String(buf.readUInt16LE(eocd + 10)));
check("注释长度为 0", buf.readUInt16LE(eocd + 20) === 0);
check("本地头签名正确", buf.readUInt32LE(0) === 0x04034b50);
check("条目名写入为 UTF-8", buf.includes(Buffer.from("a.txt")));

console.log("\n=== 多文件 ZIP ===");
const zipB = ek.makeZip([
  { name: "第一张.png", data: enc.encode("aaa") },
  { name: "第二张.png", data: enc.encode("bbbbbb") }
]);
const bufB = Buffer.from(await zipB.arrayBuffer());
const eocdB = bufB.length - 22;
check("两条目录项", bufB.readUInt16LE(eocdB + 10) === 2, String(bufB.readUInt16LE(eocdB + 10)));
check("中央目录偏移指向第二条之后", bufB.readUInt32LE(eocdB + 16) > 0);
check("中文文件名写入（UTF-8 flag）", bufB.includes(Buffer.from("第一张.png", "utf8")));
check("UTF-8 标志位已置", bufB.readUInt16LE(6) === 0x0800, String(bufB.readUInt16LE(6).toString(16)));

// 落盘一份，交给外部（python zipfile / 资源管理器）做真实解压验证
const outDir = process.env.UI_TEST_OUT || path.join(os.tmpdir(), "ai-canvas-ui-test");
fs.mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, "export-sample.zip");
fs.writeFileSync(zipPath, bufB);
check("ZIP 已落盘供外部校验", fs.existsSync(zipPath), zipPath);

console.log("\n=== 项目持久化（E7）===");
store.projectName = "毛衫印花测试";
store.currentProjectId = "proj-ui-test";
const graph = {
  nodes: [
    { id: "n1", type: "prompt", position: { x: 10, y: 20 }, data: { prompt: "杏色毛衫" } },
    { id: "n2", type: "result", position: { x: 300, y: 20 }, data: { images: [{ url: "/outputs/a.png" }, { url: "/outputs/b.png" }] } }
  ],
  edges: [{ id: "e1", source: "n1", target: "n2", dataType: "ai-image" }],
  viewport: { x: 0, y: 0, zoom: 1 }
};
proj.scheduleSave(graph, { immediate: true });
check("保存态转为 saved", store.saveState === "saved", store.saveState);
check("保存状态文案含时间", proj.saveStateLabel().includes("已保存"), proj.saveStateLabel());

const loaded = proj.loadGraph();
check("读回节点数一致", loaded?.nodes?.length === 2, String(loaded?.nodes?.length));
check("读回连线数一致", loaded?.edges?.length === 1);
check("读回连线保留 dataType", loaded?.edges?.[0]?.dataType === "ai-image");
check("项目名称一并恢复", store.projectName === "毛衫印花测试", store.projectName);

const list = proj.loadList();
check("项目列表出现当前项目", list.some((p) => p.id === "proj-ui-test"), JSON.stringify(list.map((p) => p.id)));
const row = list.find((p) => p.id === "proj-ui-test");
check("列表记录了节点数", row?.nodeCount === 2, String(row?.nodeCount));
check("列表缩略图来自结果节点", Array.isArray(row?.thumbs) && row.thumbs.length === 2, JSON.stringify(row?.thumbs));

console.log("\n=== 资产库（审阅视图数据源）===");
proj.addAsset({ url: "/outputs/a.png", model: "万相", prompt: "杏色毛衫", kind: "image", cost: 10 });
proj.addAsset({ url: "/outputs/b.png", model: "万相", prompt: "杏色毛衫" });
proj.addAsset({ url: "/outputs/a.png", model: "万相" }); // 重复，应被去重
check("资产落库两条", store.assets.length === 2, String(store.assets.length));
check("相同 url 不去重失败（去重生效）", store.assets.filter((a) => a.url === "/outputs/a.png").length === 1);
check("资产带时间戳", Number(store.assets[0].ts) > 0);
check("提示词截断到 200 字", store.assets.every((a) => String(a.prompt).length <= 200));

const before = store.assets.length;
proj.removeAsset(store.assets[0].id);
check("移除后少一条", store.assets.length === before - 1);
check("移除后落盘同步", (proj.loadAssets() || []).length === before - 1);

console.log("\n=== 语义缩放分档（与 NodeCanvas 同逻辑）===");
const tierOf = (z) => (z < 0.5 ? "far" : z > 1.1 ? "near" : "mid");
check("zoom 0.2 → far", tierOf(0.2) === "far");
check("zoom 0.49 → far", tierOf(0.49) === "far");
check("zoom 0.5 → mid", tierOf(0.5) === "mid");
check("zoom 1.0 → mid", tierOf(1.0) === "mid");
check("zoom 1.1 → mid", tierOf(1.1) === "mid");
check("zoom 1.2 → near", tierOf(1.2) === "near");
check("zoom 2.5 → near", tierOf(2.5) === "near");

console.log(`\n  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
