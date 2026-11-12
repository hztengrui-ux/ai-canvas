/**
 * 第 13 套件：资产血缘 E6（2026-09-25）
 * --------------------------------------------------------------------------
 * 要解决的问题很朴素：三周后看着一张图，**不知道它是怎么来的**。
 * 用的是哪句提示词、哪个模型、参考了哪张图、花了多少点，全都没留下。
 *
 * 这里锁住四件事：
 *   1. 复现所必需的字段真的被写进去了（漏一个 seed 就复现不出来）
 *   2. sidecar 路径不能被穿越（文件名来自 URL，是用户可控的）
 *   3. 元数据读写失败不许把已经出给用户的结果判成失败
 *   4. 界面摘要要诚实 —— 没 prompt 就别显示「可复现」
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lineage-test-"));
process.env.AI_CANVAS_HOME = HOME;
process.env.AI_CANVAS_VAULT = "file";
process.env.AI_CANVAS_OUTPUTS = path.join(HOME, "outputs");
fs.mkdirSync(process.env.AI_CANVAS_OUTPUTS, { recursive: true });

const L = await import("./lineage.js");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const FULL = {
  provider: "comfyui",
  model: "Z-Image Turbo",
  prompt: "杏色圆领针织毛衫，胸前有细小印花",
  negativePrompt: "低清晰度，水印",
  size: "1024x1024",
  steps: 24,
  cfg: 6.5,
  seed: 123456,
  strength: 0.75,
  printArea: "chest",
  keepTexture: true,
  references: ["https://x/a.png", { url: "https://x/b.png", name: "毛衫正面.png" }],
  cost: 3,
  taskId: "task-8899",
  batchId: "batch-1",
  batchIndex: 0,
  nodeId: "node-12",
  projectId: "proj-7",
  userId: "u-1",
  username: "alice",
  remark: "春季主推款"
};

console.log("\n[1] 路径校验（文件名来自 URL，必须防穿越）");
{
  const { outputsDir } = await import("./config.js");
  const root = path.resolve(outputsDir());
  // 主防线是 basename：只取最后一段，压根走不出目录，所以不靠抛异常
  const trav = L.metaPathFor("../../../../etc/passwd");
  check("穿越路径被压平后仍落在 outputs 内", trav.startsWith(root + path.sep), trav);
  check("穿越路径只剩最后一个文件名", path.basename(trav) === `passwd${L.META_SUFFIX}`, trav);
  check("未产生 ../ 片段", !trav.includes(".."));

  check("正常文件名落在 outputs 内", L.metaPathFor("a.png").startsWith(root + path.sep));
  check("sidecar 后缀正确", L.metaPathFor("a.png").endsWith("a.png" + L.META_SUFFIX), L.metaPathFor("a.png"));
  check("传入路径被压成纯文件名", !L.metaPathFor("sub/dir/a.png").includes("sub"));
  let emptyThrew = false;
  try {
    L.metaPathFor("");
  } catch {
    emptyThrew = true;
  }
  check("空文件名被拒绝而不是落到目录本身", emptyThrew);
}

console.log("\n[2] 写入 → 读回，字段不丢");
{
  const entry = L.record("pic-0001.png", FULL);
  check("record 返回条目而非 null", Boolean(entry));
  check("文件名与 url 就位", entry.file === "pic-0001.png" && entry.url === "/outputs/pic-0001.png", entry.url);

  const back = L.read("pic-0001.png");
  check("能按文件名读回", Boolean(back));
  check("提示词完整保留（复现的第一要素）", back.prompt === FULL.prompt);
  check("反向提示词保留", back.negativePrompt === FULL.negativePrompt);
  check("提供方与模型保留", back.provider === "comfyui" && back.model === "Z-Image Turbo");
  check("画幅保留", back.size === "1024x1024");
  check("步数 / CFG 保留", back.steps === 24 && back.cfg === 6.5);
  check("种子保留（缺了就复现不出来）", back.seed === 123456);
  check("重绘强度保留", back.strength === 0.75);
  check("印花区域与纹理开关保留", back.printArea === "chest" && back.keepTexture === true);
  check("任务号与节点号保留（能定位回画布）", back.taskId === "task-8899" && back.nodeId === "node-12");
  check("项目号保留", back.projectId === "proj-7");
  check("花费与用户保留", back.cost === 3 && back.userId === "u-1");
  check("备注保留", back.remark === "春季主推款");
  check("生成时间已落", Boolean(back.createdAt));
  check("同一张图只生成一个 id", back.id === entry.id);
}

console.log("\n[3] 参考图形状归一化");
{
  const back = L.read("pic-0001.png");
  check("参考图数量正确", back.references.length === 2, String(back.references.length));
  check("字符串形态也能还原出 url", back.references[0].url === "https://x/a.png");
  check("对象形态保留文件名", back.references[1].name === "毛衫正面.png", JSON.stringify(back.references[1]));

  const none = L.buildEntry({ references: "not-an-array" });
  check("传入非数组不炸，退化为空", Array.isArray(none.references) && none.references.length === 0);

  const empty = L.buildEntry({});
  check("什么都不传也不炸", empty.references.length === 0 && empty.prompt === "");
}

console.log("\n[4] 异常情况都不许连带把结果弄没");
{
  check("读不存在的图返回 null（老图没 sidecar 是正常的）", L.read("no-such-file.png") === null);

  fs.writeFileSync(path.join(process.env.AI_CANVAS_OUTPUTS, "broken.png.meta.json"), "{ 这不是 json");
  check("sidecar 损坏时 read 返回 null 而不是抛异常", L.read("broken.png") === null);

  check("文件名为空时 record 安全返回 null", L.record("", FULL) === null);
  // 元信息不能因为层层嵌套的子目录而失败（mkdirSync recursive 要生效）
  check("record 自带建目录能力", Boolean(L.buildEntry({ file: "deep/x.png" }).file === "x.png"));
}

console.log("\n[5] 界面摘要要诚实");
{
  const e = L.buildEntry(FULL);
  const s = L.summarize(e);
  check("完整血缘判定为可复现", s.reproducible === true);
  check("摘要标题取提示词开头", s.title.startsWith("杏色圆领针织毛衫"), s.title);
  check("摘要给出模型", s.lines.some((l) => l.includes("Z-Image Turbo")), JSON.stringify(s.lines));
  check("摘要给出种子", s.lines.some((l) => l.includes("123456")));
  check("摘要给出参考图数量", s.lines.some((l) => l.includes("参考图 2 张")));
  check("摘要给出花费", s.lines.some((l) => l.includes("3 点")));

  const noPrompt = L.summarize(L.buildEntry({ provider: "comfyui", prompt: "" }));
  check("没有提示词就不能标可复现（不给假希望）", noPrompt.reproducible === false);
  const noProvider = L.summarize(L.buildEntry({ prompt: "x", provider: "" }));
  check("没有提供方同样不可复现", noProvider.reproducible === false);
  check("空血缘摘要不报错", L.summarize(null).title.length > 0);
  check("空血缘也标不可复现", L.summarize(null).reproducible === false);
}

console.log("\n[6] 按任务反查这次跑出了哪些图");
{
  L.record("t1-a.png", { ...FULL, taskId: "task-AAAA", userId: "u-1" });
  L.record("t1-b.png", { ...FULL, taskId: "task-AAAA", userId: "u-1" });
  L.record("t2-a.png", { ...FULL, taskId: "task-BBBB", userId: "u-1" });
  const rows = L.readByTask("task-AAAA");
  check("按 taskId 查到 2 张", rows.length === 2, String(rows.length));
  check("不会串到别的任务", rows.every((r) => r.taskId === "task-AAAA"));
  check("taskId 为空时返回空数组而不是全部", L.readByTask("").length === 0);

  const all = L.listAll();
  check("listAll 能扫到已有血缘", all.length >= 4, String(all.length));
  const dates = all.map((r) => r.createdAt);
  check("listAll 按时间倒序（新的在前）", String(dates) === String([...dates].sort((a, b) => String(b).localeCompare(String(a)))));
  check("损坏的 sidecar 不污染列表", !all.some((r) => r.file === "broken.png"));
}

console.log(`\n  通过 ${pass} 项，失败 ${fail} 项`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
