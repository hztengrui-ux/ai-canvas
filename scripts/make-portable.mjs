/**
 * 生成「免安装版（绿色版）」目录。
 *
 * 为什么要有这个脚本，而不是让你手动拷 win-unpacked：
 *   免安装版必须是**真绿色** —— 运行数据（账号/项目/算力账本/窗口状态/日志）
 *   全部落在程序自己目录下的 data\，不碰 %APPDATA% 和 %USERPROFILE%。
 *   主进程靠 exe 同级的 portable.flag 标记进入绿色模式（见 electron/main.cjs），
 *   所以这个标记文件必须由脚本落进去，漏了就变成"假绿色版"。
 *
 * 用法：node scripts/make-portable.mjs
 * 产物：release/跨多多AI创作台-免安装版/   （整个目录拷走即用）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "release", "win-unpacked");
// 目录名用纯 ASCII：中文目录名在命令行/打包工具链里容易被按 ANSI 转码成"?"，
// 排查打包问题时反复踩到。中文标题放在内部的「使用说明」和快捷方式里就够了。
const OUT = path.join(ROOT, "release", "ai-canvas-portable");

function log(m) {
  console.log("  " + m);
}

if (!fs.existsSync(SRC)) {
  console.error(`[portable] 找不到 ${SRC}\n  请先跑：npm run build && electron-builder --config electron-builder.config.cjs`);
  process.exit(1);
}

// 先清掉上一次的产物，避免旧文件残留造成"改了没生效"的错觉。
//
// ⚠️ 但 `data/` 必须保住（2026-10-23 事故）：
//   绿色版的数据根就在 <exe目录>\data —— 账号、算力账本、设置里的 API Key、出图历史全在这里。
//   原来这里直接 rmSync(OUT)，等于每次打包都把用户的钱包和密钥一起删了。
//   现在先把 data 挪到同级临时目录，重建完再挪回来；失败也不会丢（临时目录还在）。
const DATA_DIR = path.join(OUT, "data");
const DATA_KEEP = path.join(ROOT, "release", ".portable-data-keep");
let keepData = false;

if (fs.existsSync(OUT)) {
  if (fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_KEEP, { recursive: true, force: true });
    fs.renameSync(DATA_DIR, DATA_KEEP);
    keepData = true;
    log("已暂存既有 data/（账号、算力、API Key、出图历史），打包后原样放回");
  }
  log(`清理旧产物 ${path.relative(ROOT, OUT)}`);
  fs.rmSync(OUT, { recursive: true, force: true });
}

log(`复制 ${path.relative(ROOT, SRC)} → ${path.relative(ROOT, OUT)}`);
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(SRC, OUT, { recursive: true });

// 绿色模式标记：主进程看到它就启用 portable 模式
fs.writeFileSync(path.join(OUT, "portable.flag"), "1\n", "utf8");

// 预建数据目录，让用户一眼看出数据存在哪
for (const d of ["data", "data/outputs", "data/materials", "data/appdata"]) {
  fs.mkdirSync(path.join(OUT, d), { recursive: true });
}

// 把打包前暂存的 data/ 放回来（覆盖刚建的空目录）
if (keepData && fs.existsSync(DATA_KEEP)) {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.renameSync(DATA_KEEP, DATA_DIR);
  log("已恢复 data/（账号 / 算力 / API Key / 出图历史都在）");
}

// 附带启动器与工具（都随绿色版一起走）
//
// 为什么 bat 只是三行的 ASCII 外壳、真正的逻辑在 .ps1 里：
//   cmd 解析 .bat 时按**系统代码页**（中文 Windows 是 936）读字节，
//   把 UTF-8 中文放进去会被从多字节中间切断，报出 "'PP' 不是内部或外部命令"
//   这种完全不指向根因的错；for 括号块里的管道和 ^ 续行也会互相打架。
//   所以：外壳 .bat 只保留 ASCII（切目录 + 叫 PowerShell），
//        中文提示与逻辑全部放进 .ps1（UTF-8 **带 BOM**，PowerShell 才认）。
for (const [srcRel, dstName] of [
  // 常用
  [path.join("scripts", "launch-unblocked.bat"), "直接打开-免安装版.bat"],
  [path.join("scripts", "open-app.ps1"), "open-app.ps1"],
  [path.join("scripts", "make-shortcut.bat"), "创建桌面快捷方式.bat"],
  // 手机
  [path.join("scripts", "mobile-launch.bat"), "启动-手机联调.bat"],
  [path.join("scripts", "mobile-mode.ps1"), "mobile-mode.ps1"],
  // 兜底
  [path.join("scripts", "bypass-smartscreen.bat"), "跳过安全检查-慎用.bat"],
  [path.join("scripts", "bypass-smartscreen.ps1"), "bypass-smartscreen.ps1"],
  [path.join("scripts", "diagnose-install.ps1"), "安装失败诊断.ps1"]
]) {
  const src = path.join(ROOT, srcRel);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(OUT, dstName));
  }
}

// 使用说明
fs.writeFileSync(
  path.join(OUT, "使用说明-免安装版.txt"),
  [
    "跨多多 AI 创作台 · 免安装版（绿色版）",
    "=====================================",
    "",
    "怎么用：",
    "  ★ 第一次打开，请双击「直接打开-免安装版.bat」（不要直接双击 exe）。",
    "    它会先解除文件的「来自网络」锁定，再启动 —— 这样 Windows 的",
    "    「SmartScreen 已保护你的电脑 / 发布者未知」弹窗就不会再出现。",
    "    之后就可以正常用「创建桌面快捷方式.bat」建快捷方式了。",
    "  方式二：直接双击「跨多多 AI 创作台.exe」（第一次可能弹一次警告，",
    "          点「更多信息」→「仍要运行」即可，只需点一次）。",
    "  首次进入会引导初始化管理员账号（建议立刻改成自己的密码）。",
    "",
    "遇到 SmartScreen 怎么处理（按顺序试）：",
    "  1) 双击「直接打开-免安装版.bat」——解除锁定，90% 的情况到这一步就没了。",
    "  2) 还弹：点弹窗里的「更多信息」→「仍要运行」，一次性。",
    "  3) 连「更多信息」都没有（单位电脑被策略锁死）：跑「跳过安全检查-慎用.bat」，",
    "     选 1 关闭当前用户的 SmartScreen 应用检查；以后想恢复，再跑它选 2。",
    "  说明：exe 已经写入公司/产品/版本信息（属性页可见），但**没有代码签名证书**，",
    "        所以 Windows 仍会显示「发布者未知」——这是证书问题，不是程序问题。",
    "",
    "为什么叫绿色版：",
    "  本目录带一个 portable.flag 标记，程序看到它就进入「绿色模式」：",
    "  账号、项目、算力账本、窗口状态、日志全部写在",
    "      本目录\\data\\",
    "  不会往 %APPDATA% 或 %USERPROFILE%\\.ai-canvas 写任何东西。",
    "  所以整个文件夹拷到 U 盘 / 另一台机器，接着用即可，数据跟着走。",
    "",
    "和安装版的区别：",
    "  功能完全一样。安装版多做的只是「写注册表 + 建卸载器 + 装到 Program Files」，",
    "  如果你那边安装包报错（写临时文件失败 / 写卸载器被拒），用本绿色版即可绕过，",
    "  跑一次「创建桌面快捷方式.bat」体验就一样了。",
    "",
    "想搬家：整个文件夹一起复制（别只拷 exe）。",
    "想删干净：先删掉快捷方式，再删掉整个文件夹。",
    "",
    "说明：",
    "  - 若双击没反应，看 data\\appdata\\boot.log 里的最后几行。",
    "  - 安装包仍想尝试的话：先跑「安装失败诊断.ps1」，它会告诉你卡在哪一步。",
    ""
  ].join("\r\n"),
  "utf8"
);

const exe = fs.readdirSync(OUT).find((f) => f.toLowerCase().endsWith(".exe"));

// 换图标 + 写版本信息（公司/产品/描述）。
// 必须在生成 SHA256SUMS 之前做：rcedit 会改 exe 字节，先算校验和就会对不上。
// 没有签名证书时这一步是唯一能让"属性页"看起来正规的动作，失败也不阻断打包。
// 万一 rcedit 把 exe 改坏了（极少数杀软会锁文件），用 AI_CANVAS_SKIP_ICON=1 重跑即可跳过。
if (exe && process.env.AI_CANVAS_SKIP_ICON !== "1") {
  log("换图标 + 写版本信息…");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "apply-brand-icon.mjs")], {
    cwd: ROOT,
    stdio: "inherit"
  });
  if (r.status !== 0) log("  （换图标失败，不影响运行；exe 仍是 Electron 默认图标）");
} else if (exe) {
  log("已按 AI_CANVAS_SKIP_ICON=1 跳过换图标");
}

// 安全加固：写 Electron fuses（关 RunAsNode / NODE_OPTIONS / --inspect，开 asar 完整性校验）
//
// 位置很关键：
//   - 必须在「换图标」之后：rcedit 会重写 exe 的资源段，先写熔断位再换图标等于白写；
//   - 必须在生成 SHA256SUMS 之前：熔断位改动 exe 字节，校验清单要算最终字节。
// 失败就中断打包 —— 安全开关没写进去的包不该流出去。
if (exe) {
  log("写入安全熔断位（Electron fuses）…");
  const fused = spawnSync(process.execPath, [path.join(ROOT, "scripts", "apply-fuses.mjs"), path.join(OUT, exe)], {
    cwd: ROOT,
    stdio: "inherit"
  });
  if (fused.status !== 0) {
    console.error("[portable] ✗ 熔断位写入失败：产物没有调试防护，中止打包");
    process.exit(1);
  }
}

// 校验清单：拷到别的机器后可以用它核对文件有没有拷全/被改动
const manifest = [];
(function walk(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (rel === "data") continue; // 运行期数据不参与校验
      walk(full, rel);
    } else {
      manifest.push(`${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}  ${rel}`);
    }
  }
})(OUT, "");
fs.writeFileSync(path.join(OUT, "SHA256SUMS.txt"), manifest.join("\n") + "\n", "utf8");

const size = (p) => {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += size(full);
    else total += fs.statSync(full).size;
  }
  return total;
};
const mb = (size(OUT) / 1024 / 1024).toFixed(1);

console.log("");
console.log("════════ 免安装版已生成 ════════");
console.log(`  目录   ${OUT}`);
console.log(`  主程序  ${exe || "(未找到 exe)"}`);
console.log(`  大小   ${mb} MB`);
console.log(`  绿色标记 portable.flag 已就位: ${fs.existsSync(path.join(OUT, "portable.flag"))}`);
console.log(`  校验清单 SHA256SUMS.txt: ${manifest.length} 个文件`);
console.log("");
