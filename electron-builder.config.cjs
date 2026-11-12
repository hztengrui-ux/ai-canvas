// electron-builder 打包配置（从 package.json 的 build 段抽出）
//
// 为什么要抽成 .cjs：package.json 是静态 JSON，读不到环境变量也读不到 config/brand.json，
// 于是 BRAND=oem-a npm run dist 打出来的包和默认包一模一样 —— 白标等于没做。
// JS 配置文件在打包开始时被 require，可以按 BRAND 现算 appId / productName /
// artifactName / shortcutName 四项身份，OEM 包才真的不一样。
//
// 品牌固化：把选中的 key 通过 extraMetadata 写进产物 package.json 的 aiCanvasBrand 字段。
//   - 选择理由：extraMetadata 是 electron-builder 每次打包都会写入的机制，
//     只要走了打包就一定带上，不存在「忘了跑某个前置脚本」导致固化丢失的可能；
//     也避免生成 config/brand.build.json 这类产物文件（容易和源码不一致、容易被误提交）。
//   - 运行期由 electron/main.cjs 读取：环境变量 BRAND > 固化值 > kuaduoduo 默认，
//     再把结果写回 process.env.BRAND，未改动的 server/brand.js 因此也能拿到固化品牌。
"use strict";

const { resolveBuilderConfig } = require("./config/brand-resolver.cjs");
const pkg = require("./package.json");

const r = resolveBuilderConfig({
  rootDir: __dirname,
  env: process.env,
  pkgVersion: pkg.version
});

// 打包日志里打出身份信息：CI 上翻日志就能确认「这次到底打的是哪个牌子」
console.log(
  `[brand] key=${r.brandKey} (来源 ${r.brandSource}) productName="${r.productName}" appId=${r.appId}`
);
console.log(`[brand] 安装包名 ${r.artifactNameSample}${r.executableName ? ` / exe ${r.executableName}.exe` : ""}`);
if (r.fallbackReason) console.warn(`[brand] ⚠️ ${r.fallbackReason}`);
if (r.logoPending) console.warn(`[brand] ⚠️ ${r.logoNote || `品牌 ${r.brandKey} 的 logo 待补，回退默认 mark`}`);
if (r.iconPending) console.warn(`[brand] ⚠️ ${r.iconNote}`);
if (r.publish.isPlaceholder) {
  console.warn(`[brand] ⚠️ 更新源还是占位符（${r.publish.url}）`);
  console.warn("[brand]    发布前请设置 AI_CANVAS_UPDATE_URL，否则客户端检查更新 404。");
}

// 是否允许改写 exe（写入图标/版本信息）。
//
// ⚠️ 背景（实测踩到）：electron-builder 只要执行「改写 exe」这一步，就会去下载
//   winCodeSign-2.6.0.7z 并解压。那个包里含 **darwin（macOS）的符号链接**
//   （darwin/10.12/lib/libcrypto.dylib、libssl.dylib），在 Windows 上创建符号链接
//   需要管理员权限或开启"开发者模式"；两者都没有时 7-Zip 解压直接失败：
//     ERROR: Cannot create symbolic link : 客户端没有所需的特权
//   → 整个打包中止。与项目代码无关，是打包工具链对权限的要求。
//
// 对策：默认不改写 exe（跳过 winCodeSign 依赖），产出**未签名**的安装包 ——
//   代价：exe 用 Electron 默认图标，不写版本信息；首次运行会有 SmartScreen 提示。
// 需要正式签名/图标时（在管理员或已开开发者模式的机器上）：
//   AI_CANVAS_SIGN_EXE=1 npm run dist
const signExe = process.env.AI_CANVAS_SIGN_EXE === "1";

module.exports = {
  appId: r.appId,
  productName: r.productName,
  directories: {
    output: "release"
  },
  files: [
    "dist/**/*",
    "server/**/*",
    "electron/**/*",
    // config/** 必须在包里：brand.json 与 brand-resolver.cjs 都是运行期要读的
    "config/**/*",
    "package.json"
  ],
  // ⚠️ 2026-10-18 打包事故修复（症状：客户端打开后窗口标题是 "Error"、页面全白 / 资源全 404）
  //
  // 内置服务是 main.cjs 用 child_process.fork 拉起来的子进程 —— 这类子进程以
  // ELECTRON_RUN_AS_NODE 模式运行（等价于 node）。实测 Electron 33.2.0 在该模式下：
  //   fs.existsSync / statSync / readFileSync 读 asar 内部路径  → 正常
  //   fs.createReadStream            读 asar 内部路径  → `ENOENT, xxx not found in app.asar`
  // 而 express.static 与 SPA 回退全是**流式**读 —— 于是 dist 里每个文件都读不出来，
  // 前台直接挂掉（日志里只有一行 server ENOENT，极容易误判成"路径写错了"）。
  //
  // 修法：把 dist 与品牌资源解包成 app.asar.unpacked 里的真实文件，
  // 再由 server/index.js 的 realPath() 把路径改写过去。
  // 回归检查：node scripts/__verify-packaged-app.mjs
  asarUnpack: ["dist/**", "config/**"],
  // 品牌固化点：产物 package.json 会多一个 aiCanvasBrand 字段
  extraMetadata: r.extraMetadata,
  publish: [
    {
      provider: r.publish.provider,
      url: r.publish.url
    }
  ],
  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"]
      }
    ],
    artifactName: r.artifactName,
    // 见上方注释：默认不改写 exe，避免 winCodeSign 的符号链接权限问题
    signAndEditExecutable: signExe,
    ...(signExe && r.iconFile ? { icon: r.iconFile } : {}),
    ...(r.executableName ? { executableName: r.executableName } : {})
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: r.shortcutName,
    // 安装器图标走 NSIS 自己的资源，不依赖「改写 exe」那一步，
    // 所以即使 signExe=false 也照常设置（品牌没图标时由 resolver 回退 build/icon.ico）
    ...(r.iconFile ? { installerIcon: r.iconFile } : {})
  }
};

// 说明：这里不额外挂 __resolvedBrand 之类的自定义字段 —— electron-builder 会按它的
// 配置 schema 校验顶层键，多余的键有被判「未知选项」的风险。
// 自测直接 require 本文件、断言真实的 appId / productName / artifactName / extraMetadata 即可，
// 那才是「真的会被打包器读到的值」。
