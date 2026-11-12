// 多品牌白标：品牌解析的唯一入口（CommonJS，打包期与运行期共用）
//
// 为什么单独抽一个模块，而不是把逻辑写在 electron-builder.config.cjs 里：
//   打包配置（electron-builder.config.cjs）、运行时（electron/main.cjs）、自测
//   （scripts/__brand.config.test.mjs）必须走同一套规则。规则只写一份，
//   测试才是在测「真的在跑的那段代码」，而不是测一份抄来的副本。
//
// 三层取值优先级（运行期，见 resolveRuntimeBrandKey）：
//   1. 环境变量 BRAND         —— 显式覆盖，开发/调试用（BRAND=oem-a npm run desktop）
//   2. 打包固化值 aiCanvasBrand —— electron-builder 的 extraMetadata 写进产物 package.json
//   3. 默认品牌 kuaduoduo      —— brand.json 缺失或都取不到时的兜底
//
// 注意：server/brand.js 只认 process.env.BRAND，本模块不修改它（不在本轮写盘范围）。
//       electron/main.cjs 负责在起内置服务之前，把这里算出的 key 写回 process.env.BRAND，
//       于是 server/brand.js 无需改动也能拿到固化品牌。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_KEY = "kuaduoduo";
const DEFAULT_LOGO = "/brand/logo-mark.png";
const DEFAULT_APP_NAME = "跨多多 AI 创作台";
const DEFAULT_APP_ID = "com.kuaduoduo.ai-canvas";
const DEFAULT_PUBLISH_URL = "https://REPLACE-WITH-YOUR-OSS.oss-cn-beijing.aliyuncs.com/releases/";

/** 打包固化值的字段名（写在产物 package.json 里，由 electron-builder extraMetadata 注入） */
const FROZEN_FIELD = "aiCanvasBrand";

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 读取 config/brand.json，任何异常都回退成 {}（品牌配置坏掉不该让应用起不来） */
function readBrandJson(rootDir) {
  try {
    const raw = fs.readFileSync(path.join(rootDir, "config", "brand.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 可用品牌 key（下划线开头的是注释字段，不算品牌） */
function availableKeys(all) {
  return Object.keys(all || {}).filter((k) => !k.startsWith("_"));
}

function isKnownKey(all, key) {
  const k = String(key || "").trim();
  return Boolean(k) && Boolean(all[k]) && typeof all[k] === "object";
}

/** 只保留 a-z0-9.-_，用于产物文件名 / appId 尾段（中文、大写、空格都不适合进文件名） */
function slugify(input, fallback = "brand") {
  const s = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

/**
 * 归一化单个品牌条目：补齐所有字段 + 如实标注资产缺口。
 *
 * logo 的诚实回退：OEM 的 logo 图还没做，配置里就把 logo 留空，
 * 绝不指向一个「看起来是 OEM 实际是跨多多」的文件冒充。留空 → 回退默认图，
 * 同时把 logoPending 置真，让调用方能如实提示「OEM logo 待补」。
 */
function normalizeBrandEntry(key, raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const slug = slugify(b.artifactSlug || key, DEFAULT_KEY);
  const rawLogo = typeof b.logo === "string" ? b.logo.trim() : "";
  const logoPending = b.logoPending === true || !rawLogo;

  return {
    key,
    // 展示用
    name: b.name || "跨多多",
    appName: b.appName || DEFAULT_APP_NAME,
    shortName: b.shortName || "创作台",
    company: b.company || "跨多多科技",
    slogan: b.slogan || "",
    subtitle: b.subtitle || "",
    primary: b.primary || "#2563EB",
    primaryDeep: b.primaryDeep || "#0A1F3D",
    loginTitle: b.loginTitle || "登录",
    creditName: b.creditName || "算力",
    // 资产：logo 留空即回退默认图
    logo: rawLogo || DEFAULT_LOGO,
    logoPending,
    logoNote: b.logoNote || (logoPending ? "OEM logo 待补：当前回退默认 mark" : ""),
    // 打包标识
    appId: b.appId || `com.${slug}.ai-canvas`,
    artifactSlug: slug,
    exeName: typeof b.exeName === "string" && b.exeName.trim() ? b.exeName.trim() : ""
  };
}

/**
 * 打包期解析：BRAND 环境变量 → 品牌条目。
 * 未知 BRAND 不抛错（打包脚本不该因为拼错品牌名就崩），回退默认并给出原因。
 */
function resolveBrand({ rootDir, env } = {}) {
  const all = readBrandJson(rootDir);
  const keys = availableKeys(all);
  const requestedKey = String((env && env.BRAND) || "").trim();

  let key = DEFAULT_KEY;
  let source = "default";
  let fallbackReason = "";

  if (requestedKey) {
    if (isKnownKey(all, requestedKey)) {
      key = requestedKey;
      source = "env";
    } else {
      fallbackReason = `未知品牌 "${requestedKey}"，回退 ${DEFAULT_KEY}`;
    }
  } else if (!isKnownKey(all, DEFAULT_KEY)) {
    key = keys[0] || DEFAULT_KEY;
    fallbackReason = `brand.json 里没有 ${DEFAULT_KEY} 条目，回退 ${key}`;
  }

  return {
    key,
    source,
    requestedKey,
    availableKeys: keys,
    fallbackReason,
    brand: normalizeBrandEntry(key, all[key] || {})
  };
}

/**
 * 运行期解析：环境变量 > 打包固化值 > 默认。
 * 与 server/brand.js:24-27 的口径保持一致（未知 key 一律回退默认，不抛错）。
 */
function resolveRuntimeBrandKey({ rootDir, env, frozenKey } = {}) {
  const all = readBrandJson(rootDir);
  const requested = String((env && env.BRAND) || "").trim();
  if (isKnownKey(all, requested)) return { key: requested, source: "env" };

  const frozen = String(frozenKey || "").trim();
  if (isKnownKey(all, frozen)) return { key: frozen, source: "frozen" };

  if (isKnownKey(all, DEFAULT_KEY)) return { key: DEFAULT_KEY, source: "default" };
  const first = availableKeys(all)[0];
  return { key: first || DEFAULT_KEY, source: "default" };
}

/**
 * 图标解析：优先用品牌自己的图标，没有就回退 build/icon.ico，并标记 pending。
 * 预期投放位置：config/brand-assets/<brandKey>/icon.ico（见同目录 README.md）
 */
function resolveBrandIcon({ rootDir, key } = {}) {
  // 只认 .ico：electron-builder 的 win.icon / nsis.installerIcon 要的是 ico，
  // 丢个 png 进去有转换失败的风险，所以宁可回退也不猜。
  const brandAsset = path.join("config", "brand-assets", String(key || DEFAULT_KEY), "icon.ico");
  if (!safeExists(path.join(rootDir, brandAsset))) {
    const fallback = ["build/icon.ico", "build/icon.png"].find((rel) => safeExists(path.join(rootDir, rel)));
    return {
      file: fallback || null,
      branded: false,
      pending: true,
      note: `品牌 ${key} 未提供专属图标（config/brand-assets/${key}/icon.ico），回退 ${
        fallback || "electron-builder 默认图标"
      }`
    };
  }

  return { file: brandAsset.split(path.sep).join("/"), branded: true, pending: false };
}

/**
 * 打包配置解析结果：electron-builder.config.cjs 直接消费这份数据。
 * 返回值全部是纯数据，可被 scripts/__brand.config.test.mjs 独立断言。
 */
function resolveBuilderConfig({ rootDir, env, pkgVersion } = {}) {
  const resolved = resolveBrand({ rootDir, env });
  const b = resolved.brand;
  const icon = resolveBrandIcon({ rootDir, key: resolved.key });
  const version = String(pkgVersion || "0.0.0");
  const artifactTemplate = `${b.artifactSlug}-ai-canvas-\${version}-setup.\${ext}`;

  return {
    brandKey: resolved.key,
    brandSource: resolved.source,
    requestedKey: resolved.requestedKey,
    fallbackReason: resolved.fallbackReason,
    // 四项白标身份
    appId: b.appId,
    productName: b.appName,
    shortcutName: b.appName,
    artifactName: artifactTemplate,
    artifactNameSample: `${b.artifactSlug}-ai-canvas-${version}-setup.exe`,
    // 可选：产物 exe 名。留空 = 用 electron-builder 默认（productName），
    // 默认品牌保持原样不动，避免改掉老用户已安装的 exe 路径。
    executableName: b.exeName || undefined,
    iconFile: icon.file || undefined,
    iconPending: icon.pending,
    iconNote: icon.note || "",
    logo: b.logo,
    logoPending: b.logoPending,
    logoNote: b.logoNote,
    brand: b,
    publish: {
      provider: "generic",
      url: String((env && env.AI_CANVAS_UPDATE_URL) || "").trim() || DEFAULT_PUBLISH_URL,
      isPlaceholder: !String((env && env.AI_CANVAS_UPDATE_URL) || "").trim()
    },
    extraMetadata: {
      main: "electron/main.cjs",
      [FROZEN_FIELD]: resolved.key
    }
  };
}

module.exports = {
  DEFAULT_KEY,
  DEFAULT_LOGO,
  DEFAULT_APP_NAME,
  DEFAULT_APP_ID,
  DEFAULT_PUBLISH_URL,
  FROZEN_FIELD,
  slugify,
  readBrandJson,
  availableKeys,
  normalizeBrandEntry,
  resolveBrand,
  resolveRuntimeBrandKey,
  resolveBrandIcon,
  resolveBuilderConfig
};
