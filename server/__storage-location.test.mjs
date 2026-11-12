/**
 * 存储位置：数据/产物/素材/临时文件都必须落在项目盘（E），不碰 C 盘
 * --------------------------------------------------------------------------
 * 用户要求（原话）："E 盘还有 1.3 TB，以后任务不要放在 C 盘，一定要放在 E 盘。"
 *
 * 这条要求不能靠"下次注意"落实 —— 之前有四处会静默写 C 盘：
 *   1. 数据根默认 ~/.ai-canvas              → C:\Users\<用户>\.ai-canvas
 *   2. 素材库默认 ~/ai-canvas-materials     → C:\Users\<用户>\ai-canvas-materials（实测 50MB）
 *   3. 产物默认 cwd/outputs                 → 安装版 cwd 在 C 盘安装目录
 *   4. 测试临时目录 os.tmpdir()             → C:\Users\<用户>\AppData\Local\Temp
 *      （13 个套件都这么建临时目录，跑一次全量测试就在 C 盘撒一堆）
 *
 * 现在：数据/产物/素材统一跟随 AI_CANVAS_HOME（= E:\ai-canvas-data），
 * 测试临时目录通过覆盖 TEMP/TMP 落回项目盘。这套测试把这些口径钉住。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

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

console.log("\n[1] 数据根跟随 AI_CANVAS_HOME");
{
  const paths = read("server/paths.js");
  check("AI_CANVAS_HOME 优先生效", /process\.env\.AI_CANVAS_HOME/.test(paths));
  check("未设置时才回退到用户目录", /path\.join\(os\.homedir\(\), "\.ai-canvas"\)/.test(paths));

  // 真实解析一次（当前进程的环境）
  const saved = process.env.AI_CANVAS_HOME;
  process.env.AI_CANVAS_HOME = path.join(ROOT, ".tmp", "loc-probe");
  const mod = await import(`./paths.js?probe=${Date.now()}`);
  check(
    "解析结果就是环境变量给的路径",
    mod.HOME === path.resolve(path.join(ROOT, ".tmp", "loc-probe")),
    mod.HOME
  );
  if (saved) process.env.AI_CANVAS_HOME = saved;
  else delete process.env.AI_CANVAS_HOME;
}

console.log("\n[2] 产物与素材默认落在数据根下（不再各写各的）");
{
  const cfg = read("server/config.js");
  // 注释里会提到这些词（解释历史），所以统计前先把注释剥掉再数
  const code = cfg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");
  check("产物默认跟随数据根", /path\.join\(CONFIG_DIR, "outputs"\)/.test(cfg));
  check("素材默认跟随数据根，而不是用户目录", /path\.join\(CONFIG_DIR, "materials"\)/.test(cfg));
  check(
    "cwd 只在「识别老产物目录」那一处出现，不再当默认落盘位置",
    (code.match(/process\.cwd\(\)/g) || []).length === 1 && /LEGACY_OUTPUTS_DIR = path\.join\(process\.cwd\(\), "outputs"\)/.test(code),
    `count=${(code.match(/process\.cwd\(\)/g) || []).length}`
  );
  check(
    "os.homedir() 只在「识别老素材目录」那一处出现，不再当默认落盘位置",
    (code.match(/os\.homedir\(\)/g) || []).length === 1,
    `count=${(code.match(/os\.homedir\(\)/g) || []).length}`
  );
  check("老目录存在时仍优先用老目录（不静默搬用户的存量文件）", /LEGACY_OUTPUTS_DIR/.test(cfg) && /LEGACY_MATERIAL_DIR/.test(cfg));
  check("显式环境变量仍然最高优先（测试/多实例部署要靠它）", /AI_CANVAS_OUTPUTS/.test(cfg) && /AI_CANVAS_MATERIALS/.test(cfg));
}

console.log("\n[3] 测试临时目录不再写 C 盘");
{
  const rt = read("scripts/run-tests.mjs");
  check("DATA_DIR 建在项目盘（不是 os.tmpdir）", /mkdtempSync\(path\.join\(TMP_ROOT, "test-"\)\)/.test(rt));
  check("没有再用 os.tmpdir() 建 DATA_DIR", !/mkdtempSync\(path\.join\(os\.tmpdir\(\)\)/.test(rt));
  check("覆盖了子进程的 TEMP", /process\.env\.TEMP = TMP_CHILD/.test(rt));
  check("覆盖了子进程的 TMP", /process\.env\.TMP = TMP_CHILD/.test(rt));
  check("TEMP 指向项目盘内（而不是系统临时目录）", /const TMP_CHILD = path\.join\(TMP_ROOT, "tmp"\)/.test(rt));
  check("套件与共享服务端都能拿到这份 env", /env: \{ \.\.\.process\.env, \.\.\.env \}/.test(rt));
  check("跑完会清理 DATA_DIR", /rmSync\(DATA_DIR, \{ recursive: true, force: true \}\)/.test(rt));

  // 真实跑一次 os.tmpdir()：确认在当前测试进程里它已经指向项目盘
  const tmp = os.tmpdir();
  const sameDrive = path.parse(tmp).root.toLowerCase() === path.parse(ROOT).root.toLowerCase();
  check(
    `os.tmpdir() 与项目同盘（项目 ${path.parse(ROOT).root}，临时 ${path.parse(tmp).root}）`,
    sameDrive,
    `tmp=${tmp}`
  );
}

console.log(`\n存储位置：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
