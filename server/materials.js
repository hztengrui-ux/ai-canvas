/**
 * 素材元数据：标签体系（2026-09-25）
 * --------------------------------------------------------------------------
 * 素材本体是磁盘上的文件，标签这类「关于文件的信息」另外存一份 JSON。
 * 之所以不写进文件名：文件名里塞标签会让路径越来越长、中文与空格难处理，
 * 而且改一次标签就要重命名文件（顺带把已生成的引用全打断）。
 *
 * 标签口径（用户定的）：颜色 / 品类 / 季节 / SKU。
 * 前三个给选项下拉（避免打错字导致「杏色」和"杏色"是两回事），
 * SKU 是自由文本 —— 每个商家的 SKU 规则都不一样，不该由我们来定。
 *
 * 路径安全：素材 url 来自前端，一律按「分类目录 + 文件名」白名单解析，
 * 出现 .. / 绝对路径的一律拒绝，绝不能拿它直接拼 fs 路径。
 */
import fs from "node:fs";
import path from "node:path";
import { MATERIAL_CATEGORIES, materialDir } from "./config.js";

const META_FILE = "ai-canvas.materials.v1.json";

/** 标签口径。前端照这个渲染，改这里即可，不用改组件。 */
export const TAG_GROUPS = [
  {
    key: "color",
    label: "颜色",
    input: "select",
    options: ["杏色", "米白", "黑色", "藏青", "灰色", "驼色", "红色", "绿色", "蓝色", "其他"]
  },
  {
    key: "category",
    label: "品类",
    input: "select",
    options: ["毛衫", "卫衣", "T恤", "外套", "裤装", "连衣裙", "配饰", "其他"]
  },
  {
    key: "season",
    label: "季节",
    input: "select",
    options: ["春夏", "秋冬", "四季", "节日"]
  },
  { key: "sku", label: "SKU", input: "text", placeholder: "例如 MS-2026-001" }
];

export const TAG_KEYS = TAG_GROUPS.map((g) => g.key);

const CAT_IDS = new Set(MATERIAL_CATEGORIES.map((c) => c.id));

/**
 * 把 /materials/clothing/xx.png 解析成 { cat, file }。
 * 任何可疑输入（..、绝对路径、非白名单分类）都返回 null。
 */
export function parseMaterialUrl(url) {
  const clean = String(url || "").split("?")[0].replace(/^\/+/, "");
  const parts = clean.split("/");
  if (parts[0] !== "materials" || parts.length !== 3) return null;
  const [, cat, file] = parts;
  if (!CAT_IDS.has(cat)) return null;
  const name = decodeURIComponent(file || "");
  if (!name || name.includes("\0")) return null;
  if (/[\\/]/.test(name) || name === ".." || name.startsWith(".")) return null;
  return { cat, file: name };
}

/** 磁盘绝对路径。parseMaterialUrl 已做白名单校验，这里才敢拼。 */
export function materialAbsPath(cat, file) {
  const dir = path.resolve(materialDir(), cat);
  const abs = path.resolve(dir, file);
  if (!abs.startsWith(dir + path.sep) && abs !== dir) return ""; // 再兜一次穿越
  return abs;
}

function metaPath() {
  return path.join(materialDir(), META_FILE);
}

export function readMeta() {
  try {
    const raw = fs.readFileSync(metaPath(), "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

export function writeMeta(meta) {
  try {
    fs.mkdirSync(materialDir(), { recursive: true });
    fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** 元数据的键统一用 cat/file，不带 /materials 前缀，省一层解析 */
const metaKey = (cat, file) => `${cat}/${file}`;

export function tagsOf(cat, file) {
  return readMeta()[metaKey(cat, file)]?.tags || {};
}

/**
 * 写入标签。只保留 TAG_KEYS 里的字段，空值清掉 ——
 * 免得前端传一堆野字段进来，以后不好迁移。
 */
export function setTags(cat, file, tags = {}) {
  const clean = {};
  for (const k of TAG_KEYS) {
    const v = String(tags?.[k] ?? "").trim();
    if (v) clean[k] = v.slice(0, 40);
  }
  const meta = readMeta();
  const key = metaKey(cat, file);
  const prev = meta[key] || {};
  meta[key] = { ...prev, tags: clean, updatedAt: Date.now() };
  return writeMeta(meta) ? clean : null;
}

/**
 * 删除素材：文件 + 元数据一起清。
 * 只删元数据不删文件，用户会看到「删了又回来」；
 * 只删文件不删元数据，标签会变成永远清不掉的垃圾。
 */
export function removeMaterial(cat, file) {
  const abs = materialAbsPath(cat, file);
  if (!abs || !fs.existsSync(abs)) return { ok: false, error: "文件不存在" };
  try {
    fs.unlinkSync(abs);
  } catch (e) {
    return { ok: false, error: `删除失败：${e?.message || e}` };
  }
  const meta = readMeta();
  delete meta[metaKey(cat, file)];
  writeMeta(meta);
  return { ok: true };
}

/** 列表页用：把标签并进每个素材条目 */
export function decorate(items) {
  const meta = readMeta();
  return items.map((it) => {
    const p = parseMaterialUrl(it.url);
    const entry = p ? meta[metaKey(p.cat, p.file)] : null;
    return { ...it, tags: entry?.tags || {} };
  });
}
