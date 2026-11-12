// 发布上传：把安装包与更新元数据推到对象存储
//
// electron-updater 需要这三类文件同时存在于 release 目录：
//   - <artifactSlug>-ai-canvas-<version>-setup.exe            安装包
//   - <artifactSlug>-ai-canvas-<version>-setup.exe.blockmap   差异更新块索引
//   - latest.yml                                              版本清单（客户端靠它判断有没有新版本）
//
// 注意 artifactSlug 随品牌变（kuaduoduo- / oem-a- / oem-b-）：
// 白标包用的是各自的 appId 与安装包名，发布时别把 OEM 包传到跨多多的更新源上，
// 否则跨多多客户端会把 OEM 包当成自己的新版本下下来。
//
// 用法：
//   npm run release:upload                      # 自动探测可用的上传方式
//   OSS_BUCKET=xxx OSS_REGION=oss-cn-beijing npm run release:upload
//
// 支持三种上传方式，按可用性自动选择：
//   1. ossutil  （阿里云官方 CLI，最省事）
//   2. ali-oss  （Node SDK，需 npm i -D ali-oss）
//   3. 打印手动上传清单（都没装时）
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const RELEASE_DIR = path.join(ROOT, "release");
// 更新源地址的唯一真源是 electron-builder.config.cjs（它读 AI_CANVAS_UPDATE_URL）。
// build 段已从 package.json 抽走，这里不能再读 pkg.build —— 否则占位符检查会静默失效。
const brandCfg = require("../config/brand-resolver.cjs").resolveBuilderConfig({
  rootDir: ROOT,
  env: process.env,
  pkgVersion: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version
});

const BUCKET = process.env.OSS_BUCKET || "";
const REGION = process.env.OSS_REGION || "oss-cn-beijing";
const PREFIX = process.env.OSS_PREFIX || "releases";

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function run(cmd) {
  try {
    return execSync(cmd, { stdio: "pipe" }).toString().trim();
  } catch {
    return "";
  }
}

// ---------- 1) 检查产物 ----------
if (!fs.existsSync(RELEASE_DIR)) fail(`找不到 release 目录：${RELEASE_DIR}\n请先执行 npm run dist`);

const files = fs.readdirSync(RELEASE_DIR);
const setup = files.find((f) => f.endsWith("-setup.exe"));
const blockmap = files.find((f) => f.endsWith(".blockmap"));
const latestYml = files.find((f) => f === "latest.yml");

console.log("\n=== 发布前检查 ===\n");
console.log(`  安装包     ${setup || "❌ 缺失"}`);
console.log(`  差异索引   ${blockmap || "（可选，缺失则只能全量更新）"}`);
console.log(`  版本清单   ${latestYml || "❌ 缺失（客户端无法发现新版本）"}`);

if (!setup) fail("没有找到安装包，请先 npm run dist");
if (!latestYml) {
  fail(
    "缺少 latest.yml —— electron-updater 靠它判断版本。\n" +
      "检查 electron-builder.config.cjs 里 publish 是否配置（配置后 electron-builder 会自动生成）。"
  );
}

// 版本号与清单一致性
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ymlText = fs.readFileSync(path.join(RELEASE_DIR, latestYml), "utf8");
const ymlVersion = (ymlText.match(/^version:\s*(.+)$/m) || [])[1]?.trim();
console.log(`\n  package.json 版本  ${pkg.version}`);
console.log(`  latest.yml 版本    ${ymlVersion || "?"}`);
if (ymlVersion && ymlVersion !== pkg.version) {
  fail(`版本不一致！latest.yml 是 ${ymlVersion}，package.json 是 ${pkg.version}`);
}
console.log("  ✅ 版本一致\n");

const uploadList = [setup, blockmap, latestYml].filter(Boolean);
const totalMB = uploadList
  .map((f) => fs.statSync(path.join(RELEASE_DIR, f)).size)
  .reduce((a, b) => a + b, 0) / 1024 / 1024;
console.log(`  待上传 ${uploadList.length} 个文件，共 ${totalMB.toFixed(1)} MB\n`);

// ---------- 2) 配置提醒 ----------
console.log(`  当前品牌           ${brandCfg.brandKey}（安装包前缀 ${brandCfg.artifactNameSample}）`);
console.log(`  更新源             ${brandCfg.publish.url}`);
const publishUrl = brandCfg.publish.url;
if (publishUrl.includes("REPLACE-WITH-YOUR-OSS")) {
  console.log("⚠️  更新源地址还是占位符（electron-builder.config.cjs 的默认值）。");
  console.log("   请设置 AI_CANVAS_UPDATE_URL 后重新 npm run dist，否则客户端检查更新会 404。\n");
  console.log(`   当前：${publishUrl}`);
  console.log(`   应为：https://<bucket>.${REGION}.aliyuncs.com/${PREFIX}/\n`);
}

// ---------- 3) 选择上传方式 ----------
const hasOssutil = Boolean(run("ossutil --version"));
const hasAliOss = fs.existsSync(path.join(ROOT, "node_modules", "ali-oss"));

if (hasOssutil) {
  console.log("=== 使用 ossutil 上传 ===\n");
  if (!BUCKET) fail("需要设置 OSS_BUCKET 环境变量，例如：OSS_BUCKET=my-bucket npm run release:upload");
  for (const f of uploadList) {
    const src = path.join(RELEASE_DIR, f);
    const dst = `oss://${BUCKET}/${PREFIX}/${f}`;
    console.log(`  ↑ ${f}`);
    try {
      execSync(`ossutil cp -f "${src}" "${dst}"`, { stdio: "inherit" });
    } catch {
      fail(`上传失败：${f}`);
    }
  }
  console.log(`\n✅ 全部上传完成：oss://${BUCKET}/${PREFIX}/\n`);
} else if (hasAliOss) {
  console.log("=== 使用 ali-oss SDK 上传 ===\n");
  const required = ["OSS_BUCKET", "OSS_REGION", "OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) fail(`缺少环境变量：${missing.join(", ")}`);

  const OSS = (await import("ali-oss")).default;
  const client = new OSS({
    region: REGION,
    bucket: BUCKET,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET
  });

  for (const f of uploadList) {
    console.log(`  ↑ ${f}`);
    await client.put(`${PREFIX}/${f}`, path.join(RELEASE_DIR, f));
  }
  console.log(`\n✅ 全部上传完成\n`);
} else {
  console.log("=== 未检测到上传工具，请手动上传 ===\n");
  console.log("以下文件需要放到 OSS 的 releases/ 目录（保持文件名不变）：\n");
  for (const f of uploadList) {
    const p = path.join(RELEASE_DIR, f);
    console.log(`  ${f}    ${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`     ${p}\n`);
  }
  console.log("推荐任选其一：");
  console.log("  ① 安装阿里云 CLI：https://help.aliyun.com/zh/oss/developer-reference/ossutil");
  console.log("     然后：OSS_BUCKET=你的bucket npm run release:upload");
  console.log("  ② 安装 Node SDK：npm i -D ali-oss");
  console.log("     然后设置 OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET 再运行本脚本");
  console.log("  ③ 直接用 OSS 控制台上传（目录要与 electron-builder.config.cjs 的 publish.url 一致）\n");
}

console.log("=== 下一步 ===");
console.log("  1. 确认 OSS 上的路径与 electron-builder.config.cjs 的 publish.url 完全一致");
console.log("  2. 老版本客户端启动 8 秒后会自动检查更新");
console.log("  3. 首次发布务必让客户端走全量包（见 electron/updater.cjs 的版本门控）\n");
