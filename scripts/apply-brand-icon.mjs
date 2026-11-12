// 给已打包出来的 exe 换图标 + 写版本信息（公司/产品/描述）
//
// 为什么要有这一步：
//   electron-builder 的 `signAndEditExecutable` 只在签名流程里顺带跑 rcedit。
//   本机没有代码签名证书，所以它被关掉了（AI_CANVAS_SIGN_EXE 默认 false）——
//   结果就是交付的 exe 顶着 **Electron 默认的原子图标**、发布者是空白。
//   用户看到"一个原子图标 + 未知发布者"，第一反应就是"这玩意儿可疑"，
//   Windows SmartScreen 的"未知发布者"警告又会加重这个印象。
//
//   图标改不了 SmartScreen 的判断（那靠代码签名 + 下载量声誉），但能显著降低
//   "这是不是野软件"的疑虑。这一步只是改 PE 资源（RT_ICON / RT_VERSION），
//   不动 asar 完整性资源，所以 Electron 的 asar integrity 校验不受影响。
//
// 用法：node scripts/apply-brand-icon.mjs [exe路径...]
//   不给参数时，默认处理 release/win-unpacked 与 release/ai-canvas-portable 两处主程序。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 在 electron-builder / winCodeSign 缓存里找 rcedit-x64.exe */
function findRcedit() {
  const candidates = [];
  const caches = [
    process.env.ELECTRON_BUILDER_CACHE,
    path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache"),
    path.join(ROOT, ".electron-cache", "builder")
  ].filter(Boolean);
  for (const cache of caches) {
    if (!fs.existsSync(cache)) continue;
    // 直接命中
    candidates.push(path.join(cache, "winCodeSign", "rcedit-x64.exe"));
    // 递归找（winCodeSign 下面还有一层哈希目录）
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let list = [];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/^rcedit-x64\.exe$/i.test(e.name)) candidates.push(p);
      }
    };
    walk(cache, 0);
  }
  return candidates.find((p) => fs.existsSync(p)) || "";
}

function main() {
  const ico = path.join(ROOT, "build", "icon.ico");
  if (!fs.existsSync(ico)) {
    console.error(`找不到图标：${ico}`);
    process.exit(1);
  }
  const rcedit = findRcedit();
  if (!rcedit) {
    console.error("找不到 rcedit-x64.exe（electron-builder 缓存里没有）。跳过换图标，不影响可用性。");
    process.exit(1);
  }

  let targets = process.argv.slice(2);
  if (!targets.length) {
    targets = [
      path.join(ROOT, "release", "win-unpacked", "跨多多 AI 创作台.exe"),
      path.join(ROOT, "release", "ai-canvas-portable", "跨多多 AI 创作台.exe")
    ];
  }

  let ok = 0;
  for (const exe of targets) {
    if (!fs.existsSync(exe)) {
      console.log(`  跳过（不存在）：${exe}`);
      continue;
    }
    const before = fs.statSync(exe);
    const r = spawnSync(
      rcedit,
      [
        exe,
        "--set-icon", ico,
        "--set-version-string", "ProductName", "跨多多 AI 创作台",
        "--set-version-string", "FileDescription", "跨多多 AI 创作台",
        "--set-version-string", "CompanyName", "跨多多科技",
        "--set-version-string", "LegalCopyright", "© 跨多多科技",
        // 文件版本：让资源管理器属性页有个像样的版本号
        "--set-file-version", "0.2.0.0",
        "--set-product-version", "0.2.0.0"
      ],
      { stdio: "inherit" }
    );
    if (r.status !== 0) {
      console.log(`  ✗ 失败：${exe}（exit ${r.status}）`);
      continue;
    }
    const after = fs.statSync(exe);
    console.log(
      `  ✓ ${path.basename(exe)} 已换图标并写入版本信息` +
        `（${(before.size / 1024 / 1024).toFixed(1)}MB → ${(after.size / 1024 / 1024).toFixed(1)}MB）`
    );
    ok += 1;
  }
  if (!ok) {
    console.error("没有成功处理任何 exe");
    process.exit(1);
  }
  console.log(`完成：${ok} 个 exe`);
}

main();
