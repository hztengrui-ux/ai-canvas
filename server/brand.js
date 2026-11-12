// 多品牌白标
//
// 一套代码贴牌成多个品牌：品牌名、主色、logo、文案全部由 config/brand.json 驱动。
// 切换方式：BRAND=oem-a npm run dist（打包时）/ BRAND=oem-a npm run server（运行时）
//
// 为什么值得做：边际成本几乎为零，但能多卖一份 —— 这是第二条收入曲线。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRAND_FILE = path.join(__dirname, "..", "config", "brand.json");
const DEFAULT_KEY = "kuaduoduo";

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(BRAND_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** 当前生效的品牌 key */
export function currentKey() {
  const key = String(process.env.BRAND || DEFAULT_KEY).trim();
  return readAll()[key] ? key : DEFAULT_KEY;
}

/** 当前品牌配置（已补全所有字段，前端拿到就能直接用） */
export function current() {
  const all = readAll();
  const key = currentKey();
  const b = all[key] || {};
  return {
    key,
    name: b.name || "跨多多",
    appName: b.appName || "AI 创作台",
    shortName: b.shortName || "创作台",
    company: b.company || "跨多多科技",
    slogan: b.slogan || "电商视觉领域首个垂类 Agent",
    subtitle: b.subtitle || "AI 精细化生成视觉中心",
    primary: b.primary || "#2563EB",
    primaryDeep: b.primaryDeep || "#0A1F3D",
    logo: b.logo || "/brand/logo-mark.png",
    loginTitle: b.loginTitle || "登录",
    creditName: b.creditName || "算力"
  };
}

/** 全部可用品牌（打包脚本列出用） */
export function listKeys() {
  return Object.keys(readAll()).filter((k) => !k.startsWith("_"));
}
