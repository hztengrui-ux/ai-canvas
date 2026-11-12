/**
 * 第 15 个测试套件：白标打包配置（品牌解析 + 打包身份 + 品牌固化 + 假进度条防回归）
 *
 * 为什么要有这套：
 *   第三轮拆解确认「白标打包不成立」—— BRAND=oem-a npm run dist 打出来的包和默认包
 *   一模一样，装完从快捷方式启动还会回落 kuaduoduo。根因是 package.json 是静态 JSON，
 *   读不到环境变量；修法是把 build 段抽成 electron-builder.config.cjs 按 BRAND 现算。
 *   这个「现算」的逻辑必须有测试锁住，否则下次谁改回静态配置都没人发现。
 *
 * 本套件独立可跑：node scripts/__brand.config.test.mjs（失败以非 0 退出）
 *
 * 覆盖：
 *   [1] 解析器单元（临时 fixture，隔离真实配置）：BRAND 命中 / 缺失 / 未知 / 空串 / 配置损坏
 *   [2] 真实 electron-builder.config.cjs：三个品牌下 appId / productName / artifactName /
 *       shortcutName / extraMetadata（品牌固化）/ files / directories.output
 *   [3] 运行期链路：electron/main.cjs 的取值规则 + 真实 server/brand.js 的返回（不启动服务）
 *   [4] 防回归：UpdateToast 不再用 Math.random 造假进度、preload 桥接 update:*、
 *       updater.init 幂等且只在 whenReady 调一次、vite 有 /materials 代理、bat 指向 release
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const resolver = require("../config/brand-resolver.cjs");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

function readText(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
}

/**
 * 去掉注释再断言。
 * 理由：UpdateToast 头部注释里必须写明「改造前用 setInterval + Math.random 造假进度」，
 * 否则后人不知道这段历史。但断言要针对**真正会执行的代码**，不能被注释误伤。
 * （`//` 的匹配避开了 `://`，免得把 URL 截断。）
 */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// =============================================================================
console.log("\n[1] 品牌解析器（临时 fixture，不依赖真实 brand.json）");
// =============================================================================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ai-canvas-brand-"));
const tmpCfgDir = path.join(TMP, "config");
fs.mkdirSync(tmpCfgDir, { recursive: true });
fs.mkdirSync(path.join(TMP, "build"), { recursive: true });
fs.writeFileSync(path.join(TMP, "build", "icon.ico"), "fake-ico");

const FIXTURE = {
  _comment: "fixture",
  kuaduoduo: { name: "跨多多", appName: "跨多多 AI 创作台", logo: "/brand/logo-mark.png" },
  "oem-a": {
    name: "X.MULO",
    appName: "X.MULO 智能助手",
    logo: "",
    logoPending: true,
    appId: "com.xmulo.ai-canvas",
    exeName: "XMULO-AI-Canvas"
  },
  "oem-b": { name: "晶灵服装AI", appName: "晶灵服装AI 创作台", appId: "com.jingling.ai-canvas" }
};
fs.writeFileSync(path.join(tmpCfgDir, "brand.json"), JSON.stringify(FIXTURE, null, 2), "utf8");

const builderFixture = (brand) =>
  resolver.resolveBuilderConfig({ rootDir: TMP, env: brand === undefined ? {} : { BRAND: brand }, pkgVersion: "9.9.9" });

const a = builderFixture("oem-a");
check("BRAND=oem-a → productName = 品牌 appName", a.productName === "X.MULO 智能助手", a.productName);
check("BRAND=oem-a → appId 用品牌自己的（否则会覆盖跨多多的安装）", a.appId === "com.xmulo.ai-canvas", a.appId);
check("BRAND=oem-a → shortcutName 跟随品牌", a.shortcutName === "X.MULO 智能助手", a.shortcutName);
check(
  "BRAND=oem-a → artifactName 带品牌前缀（不再固定 kuaduoduo-）",
  a.artifactName === "oem-a-ai-canvas-${version}-setup.${ext}",
  a.artifactName
);
check("BRAND=oem-a → 可选 exeName 生效", a.executableName === "XMULO-AI-Canvas", String(a.executableName));
check("BRAND=oem-a → 品牌来源标记为 env", a.brandSource === "env" && a.brandKey === "oem-a", a.brandSource);

const b = builderFixture("oem-b");
check("BRAND=oem-b → appId 各自独立", b.appId === "com.jingling.ai-canvas", b.appId);
check("BRAND=oem-b → artifactName 前缀 oem-b-", b.artifactName.startsWith("oem-b-ai-canvas-"), b.artifactName);
check("BRAND=oem-b 未给 exeName → 不设置 executableName（沿用 electron-builder 默认）", b.executableName === undefined, String(b.executableName));

const d = builderFixture(undefined);
check("BRAND 缺失 → 回退默认品牌 kuaduoduo", d.brandKey === "kuaduoduo" && d.productName === "跨多多 AI 创作台", d.brandKey);
check("BRAND 缺失 → appId 回落默认（不抛错）", d.appId === "com.kuaduoduo.ai-canvas", d.appId);
check("BRAND 缺失 → artifactName 兼容旧命名 kuaduoduo-ai-canvas-…", d.artifactName.startsWith("kuaduoduo-ai-canvas-"), d.artifactName);

const blank = builderFixture("   ");
check("BRAND 为空白串 → 视为未设置，回退默认", blank.brandKey === "kuaduoduo", blank.brandKey);

const unknown = builderFixture("oem-zzz");
check("未知 BRAND → 不崩，回退默认品牌", unknown.brandKey === "kuaduoduo", unknown.brandKey);
check("未知 BRAND → 给出可读的回退原因", unknown.fallbackReason.includes("oem-zzz"), unknown.fallbackReason);

// logo 诚实回退
const aLogo = builderFixture("oem-a");
check("logo 留空的品牌 → logoPending=true（如实标注待补）", aLogo.logoPending === true);
check("logo 留空的品牌 → logo 回退默认 mark", aLogo.logo === resolver.DEFAULT_LOGO, aLogo.logo);
check("logo 留空的品牌 → logoNote 里写明待补", /待补/.test(aLogo.logoNote), aLogo.logoNote);
const dLogo = builderFixture(undefined);
check("有 logo 的品牌 → logoPending=false 且保留原值", dLogo.logoPending === false && dLogo.logo === "/brand/logo-mark.png", dLogo.logo);

// 品牌配置损坏不该让打包/启动崩掉
fs.writeFileSync(path.join(tmpCfgDir, "brand.json"), "{ 这不是 JSON", "utf8");
const broken = builderFixture("oem-a");
check("brand.json 损坏 → 不崩，回退默认品牌", broken.brandKey === "kuaduoduo", broken.brandKey);
fs.rmSync(path.join(tmpCfgDir, "brand.json"), { force: true });
const missing = builderFixture("oem-a");
check("brand.json 缺失 → 不崩，回退默认品牌", missing.brandKey === "kuaduoduo", missing.brandKey);
fs.writeFileSync(path.join(tmpCfgDir, "brand.json"), JSON.stringify(FIXTURE, null, 2), "utf8");

// slug 清洗
check("slugify 清洗大写与空格", resolver.slugify("OEM A") === "oem-a", resolver.slugify("OEM A"));
check("slugify 纯中文没有可用字符 → 兜底 brand（不会产出空文件名）", resolver.slugify("晶灵") === "brand", resolver.slugify("晶灵"));
check("slugify 空值有兜底", resolver.slugify("") === "brand", resolver.slugify(""));
check(
  "artifactSlug 可显式覆盖，未给则用品牌 key",
  resolver.resolveBrand({ rootDir: TMP, env: { BRAND: "oem-a" } }).brand.artifactSlug === "oem-a"
);

// 运行期取值优先级
const rt = (env, frozenKey) => resolver.resolveRuntimeBrandKey({ rootDir: TMP, env, frozenKey });
check("运行期：环境变量优先于固化值", rt({ BRAND: "oem-b" }, "oem-a").key === "oem-b");
check("运行期：无环境变量时用打包固化值", rt({}, "oem-a").key === "oem-a");
check("运行期：固化值来源标记为 frozen", rt({}, "oem-a").source === "frozen");
check("运行期：都没有 → 默认 kuaduoduo", rt({}, undefined).key === "kuaduoduo");
check("运行期：固化值未知 → 回退默认，不崩", rt({}, "nope").key === "kuaduoduo");
check("运行期：环境变量未知但固化值有效 → 用固化值", rt({ BRAND: "nope" }, "oem-b").key === "oem-b");

// 图标回退
check("未提供品牌图标 → pending=true 且回退 build/icon.ico", resolver.resolveBrandIcon({ rootDir: TMP, key: "oem-a" }).pending === true);
fs.mkdirSync(path.join(TMP, "config", "brand-assets", "oem-a"), { recursive: true });
fs.writeFileSync(path.join(TMP, "config", "brand-assets", "oem-a", "icon.ico"), "fake-brand-ico");
const iconA = resolver.resolveBrandIcon({ rootDir: TMP, key: "oem-a" });
check("放了品牌图标 → branded=true 且路径指向品牌目录", iconA.branded === true && iconA.file.includes("brand-assets/oem-a"), iconA.file);
check("打包配置里带上品牌图标与 nsis 安装图标", builderFixture("oem-a").iconFile.includes("brand-assets/oem-a"));

// =============================================================================
console.log("\n[2] 真实 electron-builder.config.cjs（打包器实际读到的对象）");
// =============================================================================
function loadBuilderConfig(brand) {
  const entry = require.resolve("../electron-builder.config.cjs");
  delete require.cache[entry];
  const saved = process.env.BRAND;
  if (brand === undefined) delete process.env.BRAND;
  else process.env.BRAND = brand;
  // 配置文件自己会往打包日志里打几行，这里静音避免污染测试输出
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return require("../electron-builder.config.cjs");
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    if (saved === undefined) delete process.env.BRAND;
    else process.env.BRAND = saved;
  }
}

const cfgA = loadBuilderConfig("oem-a");
check("[真实配置] BRAND=oem-a → appId 独立", cfgA.appId === "com.xmulo.ai-canvas", cfgA.appId);
check("[真实配置] BRAND=oem-a → productName 独立", cfgA.productName === "X.MULO 智能助手", cfgA.productName);
check(
  "[真实配置] BRAND=oem-a → win.artifactName 带品牌前缀",
  cfgA.win.artifactName === "oem-a-ai-canvas-${version}-setup.${ext}",
  cfgA.win.artifactName
);
check("[真实配置] BRAND=oem-a → nsis.shortcutName 独立", cfgA.nsis.shortcutName === "X.MULO 智能助手", cfgA.nsis.shortcutName);
check("[真实配置] 品牌固化：extraMetadata.aiCanvasBrand = oem-a", cfgA.extraMetadata.aiCanvasBrand === "oem-a", String(cfgA.extraMetadata.aiCanvasBrand));
check("[真实配置] 品牌固化不破坏 main 入口", cfgA.extraMetadata.main === "electron/main.cjs", String(cfgA.extraMetadata.main));
check("[真实配置] files 包含 config/**（否则固化字段与 brand.json 进不了包）", cfgA.files.includes("config/**/*"), JSON.stringify(cfgA.files));
check("[真实配置] 输出目录是 release（不是 dist）", cfgA.directories.output === "release", cfgA.directories.output);
// 图标回退：品牌没提供专属图标时，必须如实回退到 build/icon.ico，不许伪造 OEM 图。
// 注意 win.icon 是**有条件**的：它只在 AI_CANVAS_SIGN_EXE=1（允许改写 exe）时才写。
// 原因（实测）：只要 electron-builder 执行「改写 exe」，就会去解压 winCodeSign-2.6.0.7z，
// 而那个包里的 darwin 符号链接在非管理员/未开开发者模式的 Windows 上解不开，
// 整个打包会中止（ERROR: Cannot create symbolic link）。所以默认跳过改写 exe。
// 安装器图标（nsis.installerIcon）走 NSIS 自己的资源，不受这个限制，因此始终设置。
const signExeOn = process.env.AI_CANVAS_SIGN_EXE === "1";
check(
  "[真实配置] 品牌图标待补时如实回退 build/icon.ico（不伪造 OEM 图）",
  cfgA.nsis.installerIcon === "build/icon.ico",
  String(cfgA.nsis.installerIcon)
);
if (signExeOn) {
  check("[真实配置] 允许改写 exe 时 win.icon 也用回退图标", cfgA.win.icon === "build/icon.ico", String(cfgA.win.icon));
} else {
  check(
    "[真实配置] 默认不改写 exe（规避 winCodeSign 符号链接权限问题），故不设 win.icon",
    cfgA.win.signAndEditExecutable === false && cfgA.win.icon === undefined,
    `signAndEditExecutable=${cfgA.win.signAndEditExecutable} icon=${String(cfgA.win.icon)}`
  );
}
check(
  "[真实配置] nsis.installerIcon 始终有回退图标（安装器图标不依赖改写 exe）",
  typeof cfgA.nsis.installerIcon === "string" && cfgA.nsis.installerIcon.endsWith("icon.ico"),
  String(cfgA.nsis.installerIcon)
);
check("[真实配置] publish 仍是 generic 静态托管（electron-updater 需要）", cfgA.publish[0].provider === "generic" && /^https?:\/\//.test(cfgA.publish[0].url), cfgA.publish[0].url);

const cfgD = loadBuilderConfig(undefined);
check("[真实配置] 默认品牌 → appId 仍是 com.kuaduoduo.ai-canvas（老用户升级路径不变）", cfgD.appId === "com.kuaduoduo.ai-canvas", cfgD.appId);
check("[真实配置] 默认品牌 → 产物名保持 kuaduoduo- 前缀", cfgD.win.artifactName.startsWith("kuaduoduo-ai-canvas-"), cfgD.win.artifactName);
check("[真实配置] 默认品牌 → extraMetadata.aiCanvasBrand = kuaduoduo", cfgD.extraMetadata.aiCanvasBrand === "kuaduoduo", String(cfgD.extraMetadata.aiCanvasBrand));
check("[真实配置] 默认品牌 → 不设 executableName（不改变老用户已装 exe 路径）", cfgD.win.executableName === undefined, String(cfgD.win.executableName));
check("[真实配置] 默认品牌 → nsis.shortcutName 仍是「跨多多 AI 创作台」", cfgD.nsis.shortcutName === "跨多多 AI 创作台", cfgD.nsis.shortcutName);

const cfgB = loadBuilderConfig("oem-b");
check("[真实配置] BRAND=oem-b → 三项身份与 A 包互不覆盖", cfgB.appId === "com.jingling.ai-canvas" && cfgB.productName === "晶灵服装AI 创作台", cfgB.appId);
check("[真实配置] BRAND=oem-b → 固化 oem-b", cfgB.extraMetadata.aiCanvasBrand === "oem-b", String(cfgB.extraMetadata.aiCanvasBrand));

const cfgUnknown = loadBuilderConfig("oem-zzz");
check("[真实配置] 未知 BRAND 不抛错，回退默认身份", cfgUnknown.appId === "com.kuaduoduo.ai-canvas", cfgUnknown.appId);

// =============================================================================
console.log("\n[3] 运行期链路：main.cjs 取值规则 + 真实 server/brand.js 返回");
// =============================================================================
const realKeyA = resolver.resolveRuntimeBrandKey({ rootDir: ROOT, env: {}, frozenKey: "oem-a" });
check("固化 key=oem-a（真实 brand.json）→ 运行期解析出 oem-a", realKeyA.key === "oem-a", realKeyA.key);
const realKeyBad = resolver.resolveRuntimeBrandKey({ rootDir: ROOT, env: {}, frozenKey: "oem-不存在" });
check("固化 key 非法 → 运行期回退 kuaduoduo（不崩）", realKeyBad.key === "kuaduoduo", realKeyBad.key);

// 真实 brand.json 的资产缺口如实标注
const realA = resolver.resolveBrand({ rootDir: ROOT, env: { BRAND: "oem-a" } });
check("真实 brand.json：oem-a 标了 logoPending（OEM logo 待补）", realA.brand.logoPending === true);
check("真实 brand.json：oem-a logo 留空 → 回退默认 mark", realA.brand.logo === resolver.DEFAULT_LOGO, realA.brand.logo);
const realB = resolver.resolveBrand({ rootDir: ROOT, env: { BRAND: "oem-b" } });
check("真实 brand.json：oem-b 同样标注 logoPending", realB.brand.logoPending === true);
const realK = resolver.resolveBrand({ rootDir: ROOT, env: {} });
check("真实 brand.json：默认品牌 logo 不变（跨多多 mark 仍在）", realK.brand.logo === "/brand/logo-mark.png" && realK.brand.logoPending === false, realK.brand.logo);
check(
  "真实 brand.json：三个品牌 appId 互不相同（否则 OEM 包会覆盖安装）",
  new Set(["kuaduoduo", "oem-a", "oem-b"].map((k) => resolver.resolveBrand({ rootDir: ROOT, env: { BRAND: k } }).brand.appId)).size === 3
);

// 真链路终点：server/brand.js（未改动）在 process.env.BRAND 下真的返回 OEM 品牌
const serverBrand = await import("../server/brand.js");
const savedBrandEnv = process.env.BRAND;
process.env.BRAND = realKeyA.key;
const serverA = serverBrand.current();
check("server/brand.js（未改）：固化品牌写回 env 后 → key=oem-a", serverA.key === "oem-a", serverA.key);
check("server/brand.js：name = X.MULO", serverA.name === "X.MULO", serverA.name);
check("server/brand.js：appName = X.MULO 智能助手", serverA.appName === "X.MULO 智能助手", serverA.appName);
check("server/brand.js：主色跟随品牌（#E8590C）", serverA.primary === "#E8590C", serverA.primary);
check("server/brand.js：logo 留空时如实回退默认 mark", serverA.logo === "/brand/logo-mark.png", serverA.logo);
delete process.env.BRAND;
const serverD = serverBrand.current();
check("server/brand.js：无 BRAND 时回到 kuaduoduo（默认行为不变）", serverD.key === "kuaduoduo", serverD.key);
process.env.BRAND = "不存在的品牌";
const serverUnknown = serverBrand.current();
check("server/brand.js：未知 BRAND 不崩，回退默认", serverUnknown.key === "kuaduoduo", serverUnknown.key);
if (savedBrandEnv === undefined) delete process.env.BRAND;
else process.env.BRAND = savedBrandEnv;
check("server/brand.js：可用品牌清单仍能列出三套", serverBrand.listKeys().length === 3, String(serverBrand.listKeys().length));

// =============================================================================
console.log("\n[4] 防回归：假进度条 / preload 桥接 / init 幂等 / bat 与代理");
// =============================================================================
const toast = readText("src/components/UpdateToast.vue");
const toastCode = stripComments(toast);
check("UpdateToast 不再用 Math.random 冒充进度（只看代码，不算注释）", !/Math\.random/.test(toastCode), "代码里仍有 Math.random");
check("UpdateToast 里 setInterval 假进度已删干净", !/setInterval/.test(toastCode), "代码里仍有 setInterval");
check("UpdateToast 优先走桌面真链路 window.desktop.update", /window\.desktop\?\.update/.test(toast));
check("UpdateToast 以 update.check 是否存在作为真链路判据", /window\.desktop\?\.update\?\.check \?/.test(toast));
check("UpdateToast 订阅 update:progress 真进度", /onProgress\?\./.test(toast));
check("UpdateToast 订阅 update:downloaded", /onDownloaded\?\./.test(toast));
check("UpdateToast「立即重启」调 update.install() 而不是 location.reload()", /desktopUpdate\.install/.test(toast));
check("UpdateToast 保留并明确标注 web 兜底路径", /web 兜底/.test(toast));
check(
  "UpdateToast 的 location.reload() 只在 web 兜底分支（真链路分支先 return）",
  (() => {
    const idxInstall = toast.indexOf("async function applyNow");
    // 注意用带分号的代码形态匹配：文件头部注释里也提到了 location.reload()
    const idxReload = toast.indexOf("location.reload();");
    const idxReturnBefore = toast.lastIndexOf("return;", idxReload);
    return idxInstall >= 0 && idxReload > idxInstall && idxReturnBefore > idxInstall;
  })()
);

// UpdateToast.vue 用真实的 @vue/compiler-sfc 编译一遍。
// 本沙箱跑不了 vite build（esbuild spawn EPERM，见报告「未验证」），
// 这是唯一能在本地证明「SFC 语法与模板没写坏」的手段。
const { parse: parseSfc, compileScript: compileSfcScript, compileTemplate } = await import("vue/compiler-sfc");
const sfcParsed = parseSfc(toast, { filename: "UpdateToast.vue" });
check("UpdateToast.vue 能被 @vue/compiler-sfc 解析（0 错误）", sfcParsed.errors.length === 0, sfcParsed.errors.map((e) => e.message).join(" | "));
let sfcScript = null;
let sfcScriptError = "";
try {
  sfcScript = compileSfcScript(sfcParsed.descriptor, { id: "brand-test" });
} catch (e) {
  sfcScriptError = e.message;
}
check("UpdateToast.vue 的 <script setup> 编译通过", Boolean(sfcScript), sfcScriptError);
const sfcTpl = compileTemplate({
  source: sfcParsed.descriptor.template ? sfcParsed.descriptor.template.content : "",
  filename: "UpdateToast.vue",
  id: "brand-test",
  compilerOptions: { bindingMetadata: sfcScript ? sfcScript.bindings : undefined }
});
check(
  "UpdateToast.vue 模板编译通过（0 错误）",
  sfcTpl.errors.length === 0,
  sfcTpl.errors.map((e) => e.message || String(e)).join(" | ")
);

const preload = readText("electron/preload.cjs");
check("preload 暴露 update.check / install / state", /check: \(\) => ipcRenderer\.invoke\("update:check"\)/.test(preload) && /install: \(\) => ipcRenderer\.invoke\("update:install"\)/.test(preload) && /state: \(\) => ipcRenderer\.invoke\("update:state"\)/.test(preload));
check(
  "preload 六个事件订阅齐全",
  ["onChecking", "onAvailable", "onNone", "onProgress", "onDownloaded", "onError"].every((k) => preload.includes(`${k}:`))
);
check("preload 订阅函数返回取消订阅函数", /return \(\) => ipcRenderer\.removeListener\(channel, handler\)/.test(preload));
check("preload 未整体暴露 ipcRenderer", !/exposeInMainWorld\(\s*["']ipcRenderer/.test(preload));

const updaterSrc = readText("electron/updater.cjs");
check("updater 导出 setWindow（主窗重建后可换推送目标）", /module\.exports = \{ init, setWindow/.test(updaterSrc));
check("updater init 幂等（initialized 守卫，不再重复注册同名通道）", /let initialized = false/.test(updaterSrc) && /if \(initialized\)/.test(updaterSrc));
check("updater 三个通道无条件注册（渲染层能问出不可用原因）", /registerIpc\(\);\s*\n\s*if \(isDev\)/.test(updaterSrc));
check("updater 保留 quitAndInstall 真安装", /quitAndInstall\(false, true\)/.test(updaterSrc));
check(
  "updater 的启动自动检查挂在 setWindow 上（不会在窗口还不存在时就把事件发丢）",
  /function scheduleAutoCheck/.test(updaterSrc) && /if \(mainWinRef\) scheduleAutoCheck\(\)/.test(updaterSrc)
);
check(
  "updater 自动检查有「窗口未挂上则不排」的守卫",
  /if \(!mainWinRef\) return;/.test(updaterSrc)
);

const mainSrc = readText("electron/main.cjs");
const initCalls = (mainSrc.match(/updater\.init\(/g) || []).length;
check("main.cjs 里 updater.init 只调用一次（修掉登出→登录重复注册）", initCalls === 1, `实际 ${initCalls} 次`);
check("main.cjs 建主窗时只 setWindow", /updater\.setWindow\(mainWin\)/.test(mainSrc));
check(
  "main.cjs 的 init 在 app.whenReady 之后、createMainWindow 定义之外",
  mainSrc.indexOf("updater.init(") > mainSrc.indexOf("app.whenReady()")
);
check("main.cjs 把品牌固化值写回 process.env.BRAND（server/brand.js 无需改动）", /process\.env\.BRAND = BRAND_RESOLVED\.key/.test(mainSrc));

// vite.config.js 是纯 ESM，可以直接 import 拿到**真实配置对象** ——
// 不需要 esbuild、不需要起 dev server（本沙箱里 esbuild spawn 会被拒，见报告「未验证」）。
const viteCfg = (await import("../vite.config.js")).default;
check(
  "vite 真配置：/materials 代理指向 127.0.0.1:5181（dev 下素材图不再 404）",
  viteCfg.server.proxy["/materials"] === "http://127.0.0.1:5181",
  JSON.stringify(viteCfg.server.proxy["/materials"])
);
check(
  "vite 真配置：原有 /api 与 /outputs 代理未丢",
  viteCfg.server.proxy["/api"] === "http://127.0.0.1:5181" && viteCfg.server.proxy["/outputs"] === "http://127.0.0.1:5181",
  JSON.stringify(viteCfg.server.proxy)
);
check(
  "vite 真配置：剔除生成源文件的插件仍在（防止误删导致包体回涨）",
  viteCfg.plugins.some((p) => p.name === "strip-generated-sources"),
  viteCfg.plugins.map((p) => p.name).join(",")
);

const bat = readText("build-installer.bat");
check("bat 从 release 目录取安装包（不再是 dist\\*.exe）", /release\\\*\.exe/.test(bat) && !/dist\\\*\.exe/.test(bat));
check("bat 打开目录前先判断存在性", /if not exist "release"/.test(bat));
check("bat 没安装包时给可读提示并非 0 退出", /没有 \.exe 安装包/.test(bat) && /exit \/b 1/.test(bat));
check("bat 支持按品牌打包（build-installer.bat oem-a）", /set "BRAND=%~1"/.test(bat));

const pkg = JSON.parse(readText("package.json"));
check("package.json 的 dist 指向 electron-builder.config.cjs", pkg.scripts.dist.includes("--config electron-builder.config.cjs"), pkg.scripts.dist);
check("package.json 不再保留静态 build 段（避免和 JS 配置双真源）", pkg.build === undefined);
check("package.json 有独立品牌测试脚本 test:brand", pkg.scripts["test:brand"] === "node scripts/__brand.config.test.mjs", String(pkg.scripts["test:brand"]));

// 收尾：清掉临时 fixture
fs.rmSync(TMP, { recursive: true, force: true });

// =============================================================================
console.log("\n════════ 白标打包配置测试汇总 ════════");
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log("");
process.exit(fail === 0 ? 0 : 1);
