// 模板数据服务
// 模板不再硬编码在前端（原来是 store.js 里的 TOOLS/WORKFLOWS），
// 改为服务端下发：改模板不用重新构建、运营可自助、可热更新。
//
// 内置默认在 server/data/templates.json；
// 用户改动落到 ~/.ai-canvas/templates.json，升级不会覆盖。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataFile, HOME } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILTIN_FILE = path.join(__dirname, "data", "templates.json");
const USER_FILE = dataFile("templates.json");

// 模板分类（网关/筛选用）
export const CATEGORIES = [
  { key: "all", label: "全部" },
  { key: "model", label: "模特" },
  { key: "product", label: "商品" },
  { key: "scene", label: "场景" },
  { key: "detail", label: "详情页" },
  { key: "video", label: "视频" }
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function ensureDir() {
  fs.mkdirSync(HOME, { recursive: true });
}

// ---------- 读取 ----------
/** 用户配置优先，缺失的字段用内置默认补齐（升级时新增字段能生效） */
export function list() {
  const builtin = readJson(BUILTIN_FILE) || { templates: [] };
  const user = readJson(USER_FILE);

  const base = Array.isArray(builtin.templates) ? builtin.templates : [];
  if (!user || !Array.isArray(user.templates)) {
    return base.map(normalize);
  }

  // 用户改动按 id 覆盖内置项，用户新增的追加
  const userMap = new Map(user.templates.map((t) => [t.id, t]));
  const merged = base.map((t) => ({ ...t, ...(userMap.get(t.id) || {}) }));
  const baseIds = new Set(base.map((t) => t.id));
  for (const t of user.templates) {
    if (!baseIds.has(t.id)) merged.push(t);
  }
  return merged.map(normalize);
}

// ---------- 节点图清洗 ----------
// 画布直接存下来会带一堆「运行时垃圾」：正在转圈的 busy、上次生成的图片、
// 报错文本、base64 缩略图。存成模板前必须清掉，否则铺出来的模板一上来就是
// 「执行中」状态，还会把上一次的结果当成新结果。
const RUNTIME_KEYS = ["busy", "status", "error", "errors", "saving", "saveMsg", "progress", "images", "videos", "audios", "hasPrompt", "hasProduct", "hasStyle"];

/** 素材引用只留可解析的元信息，绝不存 base64 */
function cleanMaterial(m) {
  if (!m || typeof m !== "object") return null;
  const out = {};
  for (const k of ["id", "name", "url", "kind", "size", "mime", "w", "h"]) {
    if (m[k] != null && typeof m[k] !== "object") out[k] = m[k];
  }
  if (!out.url && !out.name) return null;
  return out;
}

function cleanNodeData(type, data = {}) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (RUNTIME_KEYS.includes(k)) continue;
    if (typeof v === "function" || typeof v === "symbol") continue;
    out[k] = v;
  }
  if (type === "product" && out.file) out.file = cleanMaterial(out.file);
  if (type === "style" && Array.isArray(out.files)) {
    out.files = out.files.map(cleanMaterial).filter(Boolean);
  }
  return out;
}

/** 校验并清洗整张图；返回 null 表示这不是一张可用的图 */
export function sanitizeGraph(graph) {
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !graph.nodes.length) return null;

  // id / key 两种写法都认：画布序列化出来是 id，已清洗过的图是 key。
  // 这样 sanitizeGraph 是幂等的（normalize 会对已清洗的图再调一次）。
  const nodes = graph.nodes
    .filter((n) => n && n.type)
    .map((n) => ({
      key: String(n.id ?? n.key ?? ""), // 前端真实 id 不复用，铺开时重新生成，这里只留引用
      type: String(n.type),
      position: {
        x: Math.round(Number(n.position?.x) || 0),
        y: Math.round(Number(n.position?.y) || 0)
      },
      data: cleanNodeData(n.type, n.data)
    }));
  if (!nodes.length) return null;

  // 边只保留两端都在图里的那几条，避免存下悬空连线
  const keySet = new Set(nodes.map((n) => n.key));
  const edges = (Array.isArray(graph.edges) ? graph.edges : [])
    .filter((e) => e && keySet.has(String(e.source ?? e.from ?? "")) && keySet.has(String(e.target ?? e.to ?? "")))
    .map((e) => ({
      from: String(e.source ?? e.from ?? ""),
      to: String(e.target ?? e.to ?? ""),
      sourceHandle: String(e.sourceHandle || ""),
      targetHandle: String(e.targetHandle || ""),
      dataType: String(e.dataType || e.data?.dataType || "")
    }));

  const viewport = graph.viewport
    ? {
        x: Math.round(Number(graph.viewport.x) || 0),
        y: Math.round(Number(graph.viewport.y) || 0),
        zoom: Math.min(Math.max(Number(graph.viewport.zoom) || 1, 0.2), 2.5)
      }
    : null;

  return { nodes, edges, viewport };
}

/** 补全字段 + 兜底，避免前端拿到半成品数据 */
function normalize(t) {
  return {
    id: String(t.id || ""),
    name: String(t.name || "未命名模板"),
    desc: String(t.desc || ""),
    category: String(t.category || "all"),
    workflow: String(t.workflow || ""),
    // 示意图：对应 LOOM42 那种「输入→输出」的整图，16:9
    // 没有图时前端回退到渐变占位，不会出现破图
    preview: String(t.preview || ""),
    badge: t.badge ? String(t.badge) : "",
    order: Number.isFinite(t.order) ? t.order : 999,
    enabled: t.enabled !== false,
    // 节点图：由「画布存为模板」产生（模板反哺）
    graph: sanitizeGraph(t.graph),
    source: t.source === "project" ? "project" : "builtin",
    author: String(t.author || ""),
    createdAt: Number(t.createdAt) || 0,
    updatedAt: Number(t.updatedAt) || 0
  };
}

export function listEnabled(category) {
  let rows = list().filter((t) => t.enabled);
  if (category && category !== "all") {
    rows = rows.filter((t) => t.category === category);
  }
  return rows.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "zh"));
}

export function get(id) {
  return list().find((t) => t.id === id) || null;
}

/** 按分类分组，用于「分类横滑行」那种布局 */
export function grouped() {
  const rows = listEnabled();
  const order = ["model", "product", "scene", "detail", "video"];
  const map = new Map();
  for (const t of rows) {
    if (!map.has(t.category)) map.set(t.category, []);
    map.get(t.category).push(t);
  }
  const meta = new Map(CATEGORIES.map((c) => [c.key, c.label]));
  return [...map.entries()]
    .map(([key, items]) => ({ key, label: meta.get(key) || key, items }))
    .sort((a, b) => {
      const ai = order.indexOf(a.key);
      const bi = order.indexOf(b.key);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
}

// ---------- 写入（运营后台用） ----------
export function upsert(input) {
  if (!input || !input.id) throw new Error("缺少模板 id");
  ensureDir();
  const user = readJson(USER_FILE) || { templates: [] };
  const rows = Array.isArray(user.templates) ? user.templates : [];
  const idx = rows.findIndex((t) => t.id === input.id);
  const next = normalize({ ...(idx >= 0 ? rows[idx] : {}), ...input });
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  fs.writeFileSync(USER_FILE, JSON.stringify({ templates: rows }, null, 2), "utf8");
  return next;
}

/**
 * 模板反哺：把画布上的整套节点 + 连线存成模板。
 * 与运营后台 upsert 的区别：
 *   - 必须带 graph（没节点图的模板铺不出来，直接拒绝）；
 *   - id 为空时按名称自动生成（slug 化 + 时间戳，避免重名覆盖）；
 *   - source 标记为 project，界面上可区分「官方模板」与「我的模板」。
 */
export function saveFromProject(input = {}, meta = {}) {
  const graph = sanitizeGraph(input.graph);
  if (!graph) throw new Error("画布为空或没有可保存的节点，无法存为模板");

  const name = String(input.name || "").trim();
  if (!name) throw new Error("请填写模板名称");
  if (name.length > 40) throw new Error("模板名称请控制在 40 字以内");

  const id = String(input.id || "").trim() || slugId(name);
  const now = Date.now();
  const row = normalize({
    ...input,
    id,
    name,
    graph,
    source: "project",
    author: meta.username || "",
    createdAt: now,
    updatedAt: now,
    enabled: true,
    // 反哺出来的模板优先展示在「我的模板」里
    order: Number.isFinite(input.order) ? input.order : 500
  });

  ensureDir();
  const user = readJson(USER_FILE) || { templates: [] };
  const rows = Array.isArray(user.templates) ? user.templates : [];
  const idx = rows.findIndex((t) => t.id === id);
  if (idx >= 0) row.createdAt = Number(rows[idx].createdAt) || now;
  if (idx >= 0) rows[idx] = row;
  else rows.push(row);
  fs.writeFileSync(USER_FILE, JSON.stringify({ templates: rows }, null, 2), "utf8");
  return row;
}

/** 名称 → 稳定 id：中文转拼音不现实，这里用「时间戳+短随机」保证唯一且可读 */
function slugId(name) {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const stamp = Date.now().toString(36).slice(-5);
  const rand = Math.random().toString(36).slice(2, 6);
  return `tpl-${ascii || "my"}-${stamp}${rand}`;
}

export function remove(id) {
  ensureDir();
  const user = readJson(USER_FILE) || { templates: [] };
  const rows = (user.templates || []).filter((t) => t.id !== id);
  fs.writeFileSync(USER_FILE, JSON.stringify({ templates: rows }, null, 2), "utf8");
  return { ok: true };
}

/** 恢复默认：删掉用户侧改动，回到内置定义 */
export function reset() {
  try {
    fs.unlinkSync(USER_FILE);
  } catch {
    /* 本来就没有 */
  }
  return { ok: true };
}
