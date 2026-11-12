/**
 * 文件批量引擎 —— 单元自测
 * --------------------------------------------------------------------------
 * 这层最容易出事的不是"能不能出图"，而是**文件系统边界**：
 *   · 扫描会不会顺着 ../ 或者快捷方式跑出用户选的目录；
 *   · 命名模板里出现 \ / : * 之类的字符会不会把文件写到别处或直接崩；
 *   · 续跑时"已完成"的判定依据（rel 路径）稳不稳定。
 * 所以测试重点放在 scan / resolveInside / renderName / renderPrompt 与 start 的入参校验；
 * 真正的出图链路依赖 /api/generate（需要密钥），不在这里跑。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "filebatch-test-"));
process.env.AI_CANVAS_HOME = TMP;
process.env.AI_CANVAS_OUTPUTS = path.join(TMP, "outputs");
process.env.AI_CANVAS_MATERIALS = path.join(TMP, "materials");
process.env.AI_CANVAS_VAULT = "file";
fs.mkdirSync(process.env.AI_CANVAS_OUTPUTS, { recursive: true });
fs.mkdirSync(process.env.AI_CANVAS_MATERIALS, { recursive: true });

const fb = await import("../server/filebatch.js");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? "  → " + detail : ""}`);
  }
}

// 造一棵测试目录树：两个子文件夹 + 根目录 + 非图片 + 隐藏目录 + 深层目录
const ROOT = path.join(TMP, "素材");
const mk = (rel, bytes = 8) => {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
};
mk("A组/毛衣_001.png");
mk("A组/毛衣_002.JPG");
mk("A组/说明.txt");
mk("B组/大衣_001.webp");
mk("B组/深层/C组/裙装_001.bmp");
mk("根目录图.png");
mk(".hidden/看不见.png");
mk("A组/node_modules/ignore.png");

console.log("\n[1] 扫描");
const r = fb.scan({ dir: ROOT, recursive: true });
check("扫到了 5 张图片", r.total === 5, `实际 ${r.total}：${r.files.map((f) => f.rel).join(",")}`);
check("非图片被跳过", r.files.every((f) => [".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(f.ext)));
check("隐藏目录被跳过", !r.files.some((f) => f.rel.includes(".hidden")));
check("node_modules 被跳过", !r.files.some((f) => f.rel.includes("node_modules")));
check("路径用 / 分隔（跨平台一致）", r.files.every((f) => !f.rel.includes("\\")));
check("分组按子文件夹", JSON.stringify(r.groups.map((g) => g.name).sort()) === JSON.stringify(["A组", "B组", "B组/深层/C组", "（根目录）"].sort()), JSON.stringify(r.groups));
check("根目录文件 group 为空串", r.files.find((f) => f.rel === "根目录图.png").group === "");
check("每项都带 size/mtime/ext", r.files.every((f) => Number.isFinite(f.size) && f.mtime > 0 && f.ext.startsWith(".")));
check("truncated=false（没超上限）", r.truncated === false);

const flat = fb.scan({ dir: ROOT, recursive: false });
check("recursive=false 只扫根目录", flat.total === 1 && flat.files[0].rel === "根目录图.png", `实际 ${flat.total}`);

let err = null;
try {
  fb.scan({ dir: path.join(TMP, "不存在的目录") });
} catch (e) {
  err = e;
}
check("目录不存在 → DIR_NOT_FOUND", err?.code === "DIR_NOT_FOUND", err?.code);

err = null;
try {
  fb.scan({ dir: path.join(ROOT, "A组", "毛衣_001.png") });
} catch (e) {
  err = e;
}
check("传的是文件不是目录 → NOT_DIR", err?.code === "NOT_DIR", err?.code);

console.log("\n[2] 路径越界防护");
check("正常子路径放行", fb.resolveInside(ROOT, "A组/毛衣_001.png") === path.join(ROOT, "A组", "毛衣_001.png"));
check("root 本身放行", fb.resolveInside(ROOT, "") === ROOT);
for (const bad of ["../外面.png", "A组/../../外面.png", "/etc/passwd", "C:\\Windows\\win.ini"]) {
  let blocked = false;
  try {
    fb.resolveInside(ROOT, bad);
  } catch (e) {
    blocked = e.code === "PATH_ESCAPE";
  }
  check(`越界被拒：${bad}`, blocked);
}

console.log("\n[3] 命名模板");
check("默认命名 {原名}_{序号}", fb.renderName("", { name: "毛衣_001.png", index: 7 }) === "毛衣_001_007");
check("支持 {子文件夹}", fb.renderName("{子文件夹}-{原名}", { name: "a.png", index: 1, group: "A组" }) === "A组-a");
check("序号补零到 3 位", fb.renderName("{序号}", { index: 12 }) === "012");
check(
  "非法字符被替换（不会写到别的目录）",
  fb.renderName("../{原名}", { name: "a.png", index: 1 }) === ".._a",
  fb.renderName("../{原名}", { name: "a.png", index: 1 })
);
check(
  "冒号斜杠等被替换",
  fb.renderName('{原名}:a/b\\c*d?e"f<g>h|i', { name: "x.png", index: 1 }) === "x_a_b_c_d_e_f_g_h_i",
  fb.renderName('{原名}:a/b\\c*d?e"f<g>h|i', { name: "x.png", index: 1 })
);
check("模板为空回退默认", fb.renderName("   ", { name: "b.png", index: 2 }) === "b_002");

console.log("\n[4] 提示词变量");
const prompt = fb.renderPrompt("把{文件名}的{子文件夹}，用{模特}拍摄，第{序号}张", {
  name: "毛衣_001.png",
  index: 3,
  group: "A组",
  refName: "模特2"
});
check("变量全部替换", prompt === "把毛衣_001的A组，用模特2拍摄，第3张", prompt);
check("未知变量原样保留", fb.renderPrompt("{不存在的变量}", { name: "a.png", index: 1 }) === "{不存在的变量}");
check("空模板 → 空串（由上层报错）", fb.renderPrompt("", { name: "a.png", index: 1 }) === "");

console.log("\n[5] 启动批次：入参校验");
fb.reset();
err = null;
try {
  fb.start({ dir: ROOT, files: [], params: {}, selfBase: "http://127.0.0.1:1", auth: {}, outputsRoot: TMP });
} catch (e) {
  err = e;
}
check("没选文件 → NO_FILES", err?.code === "NO_FILES", err?.code);

err = null;
try {
  fb.start({
    dir: ROOT,
    files: ["../外面.png"],
    params: {},
    selfBase: "http://127.0.0.1:1",
    auth: {},
    outputsRoot: TMP
  });
} catch (e) {
  err = e;
}
check("文件列表里带越界路径 → PATH_ESCAPE", err?.code === "PATH_ESCAPE", err?.code);

console.log("\n[6] 无批次时的状态接口");
fb.reset();
check("state 返回 null", fb.state().job === null);
for (const [fn, code] of [
  [() => fb.pause(), "NOT_RUNNING"],
  [() => fb.resume({}), "NOT_PAUSED"],
  [() => fb.cancel(), "NO_JOB"]
]) {
  let e2 = null;
  try {
    fn();
  } catch (e) {
    e2 = e;
  }
  check(`空状态下报 ${code}`, e2?.code === code, e2?.code);
}

console.log("\n[7] 上限常量");
check("最多 2000 个文件", fb.LIMITS.MAX_FILES === 2000);
check("最大递归 8 层", fb.LIMITS.MAX_DEPTH === 8);
check("支持 5 种图片扩展名", fb.LIMITS.IMAGE_EXT.length === 5, JSON.stringify(fb.LIMITS.IMAGE_EXT));

// 清理
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}

console.log(`\n文件批量：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
