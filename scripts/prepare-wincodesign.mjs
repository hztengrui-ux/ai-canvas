/**
 * 预置 winCodeSign 工具（让 electron-builder 能给 exe 换图标）
 *
 * 背景（实测踩坑）：
 *   electron-builder 只要执行「改写 exe」（写图标/版本信息），就会调用
 *   getBin("winCodeSign") 去解压 winCodeSign-2.6.0.7z。那个包里含
 *   **macOS 的符号链接**（darwin/10.12/lib/libcrypto.dylib 等），
 *   Windows 上创建符号链接需要管理员权限或开启「开发者模式」，
 *   两者都没有时 7-Zip 直接非 0 退出 → 打包中止：
 *     ERROR: Cannot create symbolic link : 客户端没有所需的特权
 *
 *   但那些 darwin 文件对 Windows 打包**毫无用处**。所以本脚本：
 *     1) 下载 winCodeSign 归档
 *     2) 用 7za 解压并**排除 darwin 目录**（这一步能成功，实测 Everything is Ok）
 *     3) 放进 electron-builder 期望的缓存目录，让 download-artifact 直接复用
 *   之后 `AI_CANVAS_SIGN_EXE=1 npm run dist` 就能给 exe 写入自定义图标。
 *
 * 用法：node scripts/prepare-wincodesign.mjs
 * 幂等：已就绪则跳过。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = process.env.ELECTRON_BUILDER_CACHE || path.join(ROOT, ".electron-cache", "builder");
const NAME = "winCodeSign";
const VERSION = "2.6.0";
const ARCHIVE = `${NAME}-${VERSION}.7z`;
const MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  "https://npmmirror.com/mirrors/electron-builder-binaries/";
const URL = `${MIRROR}${NAME}-${VERSION}/${ARCHIVE}`;

const SEVEN_ZIP = path.join(ROOT, "node_modules", "7zip-bin", "win", "x64", "7za.exe");

function log(m) {
  console.log("  " + m);
}

if (!fs.existsSync(SEVEN_ZIP)) {
  console.error(`[winCodeSign] 找不到 7za：${SEVEN_ZIP}\n  请先 npm install`);
  process.exit(1);
}

fs.mkdirSync(CACHE, { recursive: true });

// 已经就绪？（有 rcedit 就行 —— 那正是换图标要用的）
const existing = fs
  .readdirSync(CACHE, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.startsWith(NAME))
  .map((e) => path.join(CACHE, e.name));
for (const dir of existing) {
  const x64 = path.join(dir, "rcedit-x64.exe");
  const ia32 = path.join(dir, "rcedit-ia32.exe");
  if (fs.existsSync(x64) && fs.existsSync(ia32)) {
    log(`已就绪：${path.relative(ROOT, dir)}`);
    log(`  rcedit-x64.exe ${(fs.statSync(x64).size / 1024).toFixed(0)} KB`);
    process.exit(0);
  }
}

// 下载归档（缓存在临时位置）
const tmpArchive = path.join(CACHE, ARCHIVE);
if (!fs.existsSync(tmpArchive) || fs.statSync(tmpArchive).size < 1000) {
  log(`下载 ${URL}`);
  const dl = spawnSync(
    "curl.exe",
    ["-sL", "-o", tmpArchive, URL],
    { stdio: "inherit" }
  );
  if (dl.status !== 0 || !fs.existsSync(tmpArchive) || fs.statSync(tmpArchive).size < 1000) {
    console.error("[winCodeSign] 下载失败。可手动把归档放到：\n  " + tmpArchive);
    process.exit(1);
  }
}
log(`归档 ${(fs.statSync(tmpArchive).size / 1024 / 1024).toFixed(1)} MB`);

// 目录名：download-artifact 用 <name>-<version>-<sha512前若干位> 这种形式，
// 但它只按前缀 <name> 判断"是否已有"，所以任意以 winCodeSign 开头的目录都会命中。
const sha = crypto.createHash("sha512").update(fs.readFileSync(tmpArchive)).digest("hex");
const outDir = path.join(CACHE, `${NAME}-${VERSION}-${sha.slice(0, 16)}`);
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

log("解压（排除 darwin 符号链接，它们只对 macOS 有用）");
const ex = spawnSync(
  SEVEN_ZIP,
  ["x", "-y", `-o${outDir}`, "-x!darwin", tmpArchive],
  { stdio: "inherit" }
);
if (ex.status !== 0) {
  console.error("[winCodeSign] 解压失败");
  process.exit(1);
}

// 校验关键工具
const need = ["rcedit-x64.exe", "rcedit-ia32.exe"];
const missing = need.filter((f) => !fs.existsSync(path.join(outDir, f)));
if (missing.length) {
  console.error(`[winCodeSign] 解压后缺少：${missing.join(", ")}`);
  process.exit(1);
}

log("完成：");
log(`  目录 ${path.relative(ROOT, outDir)}`);
for (const f of need) {
  log(`  ${f}  ${(fs.statSync(path.join(outDir, f)).size / 1024).toFixed(0)} KB`);
}
log("");
log("现在可以带图标打包：");
log("  $env:AI_CANVAS_SIGN_EXE=1; npm run portable");
