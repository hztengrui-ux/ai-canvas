/**
 * 项目持久化（补齐差距 E7 / F4）
 *
 * 现状问题：store.projects 是纯内存数组，刷新即丢；顶栏只有项目名，没有保存状态。
 * 这里实现三件事：
 *   1. 画布图（节点+连线+视口）自动落 localStorage，防抖 800ms
 *   2. 保存状态三态：saving → saved / error（顶栏可见）
 *   3. 结果资产库独立持久化，供「审阅视图」跨会话使用
 *
 * 存储键统一带 .v1 后缀，将来换结构直接换后缀，旧数据自然失效而不是解析崩溃。
 */
import { store } from "./store.js";

const KEY_GRAPH = "ai-canvas.project.graph.v1";
const KEY_LIST = "ai-canvas.projects.v1";
const KEY_ASSETS = "ai-canvas.assets.v1";
const KEY_META = "ai-canvas.project.meta.v1";

// 资产库上限：结果图 url 很小，但无上限会无限膨胀 localStorage（浏览器一般 5MB）
const ASSET_LIMIT = 600;

let saveTimer = null;
let lastError = "";

function safeGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    // 配额超限最常见：资产库太大。先砍资产再试一次，仍失败才报错。
    if (key === KEY_GRAPH) {
      try {
        localStorage.removeItem(KEY_ASSETS);
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch { /* 落盘失败，交给调用方显示 error 态 */ }
    }
    lastError = e?.name === "QuotaExceededError" ? "本地存储空间已满" : "保存失败";
    return false;
  }
}

// ---------------- 保存状态 ----------------
export const SAVE_STATE = {
  IDLE: "idle",
  SAVING: "saving",
  SAVED: "saved",
  ERROR: "error"
};

export function markSaving() {
  store.saveState = SAVE_STATE.SAVING;
}

export function markSaved() {
  store.saveState = SAVE_STATE.SAVED;
  store.lastSavedAt = Date.now();
  store.saveError = "";
}

export function markError(msg) {
  store.saveState = SAVE_STATE.ERROR;
  store.saveError = msg || lastError || "保存失败";
}

/** 保存状态的中文文案（顶栏直接显示） */
export function saveStateLabel() {
  switch (store.saveState) {
    case SAVE_STATE.SAVING:
      return "保存中…";
    case SAVE_STATE.SAVED:
      return store.lastSavedAt ? `已保存 ${new Date(store.lastSavedAt).toLocaleTimeString()}` : "已保存";
    case SAVE_STATE.ERROR:
      return store.saveError || "保存失败";
    default:
      return "未保存";
  }
}

// ---------------- 画布图 ----------------

/**
 * 请求保存画布。防抖 800ms，避免拖节点时每帧都写。
 * @param {{nodes:Array, edges:Array, viewport:Object}} graph
 * @param {{immediate?:boolean}} opts
 */
export function scheduleSave(graph, { immediate = false } = {}) {
  if (!graph || !graph.nodes) return;
  store.saveState = SAVE_STATE.SAVING;
  clearTimeout(saveTimer);
  const write = () => {
    const payload = {
      name: store.projectName,
      projectId: store.currentProjectId,
      savedAt: Date.now(),
      graph
    };
    if (safeSet(KEY_GRAPH, payload)) {
      markSaved();
      upsertList(store.currentProjectId, store.projectName, graph);
    } else {
      markError();
    }
  };
  if (immediate) write();
  else saveTimer = setTimeout(write, 800);
}

/** 立刻落盘（页面卸载、切走前调用） */
export function flushSave(graph) {
  scheduleSave(graph, { immediate: true });
}

export function loadGraph() {
  const p = safeGet(KEY_GRAPH);
  if (!p || !p.graph || !Array.isArray(p.graph.nodes)) return null;
  // 恢复项目名，避免顶栏显示「未命名项目」而画布里其实是上次的内容
  if (p.name) store.projectName = p.name;
  if (p.projectId) store.currentProjectId = p.projectId;
  return p.graph;
}

export function clearGraph() {
  try {
    localStorage.removeItem(KEY_GRAPH);
  } catch { /* 无痕模式下无localStorage，忽略 */ }
  store.saveState = SAVE_STATE.IDLE;
  store.lastSavedAt = 0;
}

// ---------------- 项目列表 ----------------
function upsertList(id, name, graph) {
  const list = safeGet(KEY_LIST) || [];
  const nodeCount = graph?.nodes?.length || 0;
  const thumbs = (graph?.nodes || [])
    .filter((n) => n.type === "result")
    .flatMap((n) => (n.data?.images || []).slice(0, 2).map((im) => im.url))
    .slice(0, 3);

  const idx = list.findIndex((p) => p.id === id);
  const row = {
    id,
    name: name || "未命名项目",
    updatedAt: new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
    nodeCount,
    thumbs
  };
  if (idx >= 0) list[idx] = { ...list[idx], ...row };
  else list.unshift(row);

  safeSet(KEY_LIST, list.slice(0, 50));
  store.projects = list.slice(0, 50);
}

export function loadList() {
  const list = safeGet(KEY_LIST);
  if (Array.isArray(list) && list.length) store.projects = list;
  return store.projects;
}

export function removeProject(id) {
  const list = (safeGet(KEY_LIST) || []).filter((p) => p.id !== id);
  safeSet(KEY_LIST, list);
  store.projects = list;
  if (store.currentProjectId === id) clearGraph();
}

// ---------------- 项目操作（2026-09-25 项目页补强） ----------------
// 之前 ProjectsView 的「新建 / 删除」只改内存里的 store.projects，
// 刷新页面项目就回来了 —— 用户以为删掉了，其实一直都在。
// 下面这几个一律落 localStorage，列表与磁盘保持同一份真源。

function writeList(list) {
  const capped = list.slice(0, 50);
  safeSet(KEY_LIST, capped);
  store.projects = capped;
  return capped;
}

/** 新建项目：落盘 + 切成当前项目 + 清空画布（新项目不该带着上一个项目的节点） */
export function createProject(name = "未命名项目") {
  const id = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const row = {
    id,
    name: String(name || "未命名项目").slice(0, 60),
    updatedAt: new Date().toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }),
    nodeCount: 0,
    thumbs: []
  };
  writeList([row, ...(safeGet(KEY_LIST) || [])]);
  store.currentProjectId = id;
  store.projectName = row.name;
  clearGraph();
  return row;
}

/** 重命名。改的是列表项；若改的正是当前项目，顶栏项目名也要跟着变。 */
export function renameProject(id, name) {
  const clean = String(name || "").trim().slice(0, 60) || "未命名项目";
  const list = safeGet(KEY_LIST) || [];
  const row = list.find((p) => p.id === id);
  if (!row) return null;
  row.name = clean;
  row.updatedAt = new Date().toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
  writeList(list);
  if (store.currentProjectId === id) store.projectName = clean;
  return row;
}

/**
 * 复制项目。
 * 画布内容只有「当前项目」这一份（KEY_GRAPH 单键存储），
 * 所以能真正连图一起复制的只有当前项目；复制别的项目时如实只复制条目信息
 * （缩略图与名称），不假装画布也复制过去了。
 * @returns {{row:object, withGraph:boolean}|null}
 */
export function duplicateProject(id) {
  const list = safeGet(KEY_LIST) || [];
  const src = list.find((p) => p.id === id);
  if (!src) return null;

  const newId = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const row = {
    ...src,
    id: newId,
    name: `${src.name} 副本`.slice(0, 60),
    updatedAt: new Date().toLocaleString("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    })
  };
  writeList([row, ...list]);

  // 复制的正是当前打开的项目 → 把当前画布也带给副本，并切到副本
  const withGraph = store.currentProjectId === id;
  if (withGraph) {
    const graph = safeGet(KEY_GRAPH);
    if (graph) safeSet(KEY_GRAPH, graph);
    store.currentProjectId = newId;
    store.projectName = row.name;
  }
  return { row, withGraph };
}

/** 打开项目：切成当前项目名。画布内容仍是 KEY_GRAPH 那一份（单画布模型）。 */
export function openProject(id) {
  const row = (safeGet(KEY_LIST) || []).find((p) => p.id === id);
  if (!row) return null;
  store.currentProjectId = id;
  store.projectName = row.name;
  return row;
}

/** 排序：只影响展示顺序，不写回磁盘（磁盘顺序按更新时间，天然有序） */
export const PROJECT_SORTS = [
  { key: "updated", label: "最近修改" },
  { key: "name", label: "名称" },
  { key: "created", label: "创建时间" }
];

export function sortProjects(list, by = "updated") {
  const arr = [...list];
  if (by === "name") return arr.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
  if (by === "created") return arr.reverse(); // 列表是 unshift 的，倒序即创建时间从新到旧
  return arr; // 默认已按更新时间排列
}

// ---------------- 结果资产库（审阅视图数据源） ----------------

/**
 * 记录一次生成结果。去重按 url，重复生成同一张图不会刷出两条。
 * @param {{url:string, kind?:string, model?:string, prompt?:string, nodeId?:string, cost?:number}} asset
 */
export function addAsset(asset) {
  if (!asset?.url) return;
  const list = store.assets;
  if (list.some((a) => a.url === asset.url)) return;
  list.unshift({
    id: `as-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: asset.kind || "image",
    url: asset.url,
    model: asset.model || "",
    prompt: String(asset.prompt || "").slice(0, 200),
    nodeId: asset.nodeId || "",
    cost: Number(asset.cost) || 0,
    ts: Date.now()
  });
  if (list.length > ASSET_LIMIT) list.length = ASSET_LIMIT;
  safeSet(KEY_ASSETS, list);
}

export function removeAsset(id) {
  store.assets = store.assets.filter((a) => a.id !== id);
  safeSet(KEY_ASSETS, store.assets);
}

export function loadAssets() {
  const list = safeGet(KEY_ASSETS);
  if (Array.isArray(list)) store.assets = list;
  return store.assets;
}

// ---------------- 启动装载 ----------------
export function bootstrap() {
  loadList();
  loadAssets();
  const meta = safeGet(KEY_META);
  if (meta?.projectName) store.projectName = meta.projectName;
  return { graph: loadGraph(), hasSaved: Boolean(safeGet(KEY_GRAPH)) };
}

export function saveMeta() {
  safeSet(KEY_META, {
    projectName: store.projectName,
    currentProjectId: store.currentProjectId
  });
}
