/**
 * 画布剪贴板（Sprint 2 · 纯逻辑侧）
 * ==========================================================================
 * 解决什么痛点：现在只能一个一个挪节点，做「同款不同色」这类批量活要手工重画。
 * 这个模块提供完整的「复制 → 粘贴 → 原地再复制一份」的**纯数据**能力：
 *
 *   1. copySubgraph      选中子图抽取（含内部连线，跨选区连线丢弃）
 *   2. serializeSubgraph / deserializeSubgraph   系统剪贴板文本封装与健壮解析
 *   3. pasteSubgraph     粘贴：重新发 id、整体偏移、连线两端重映射
 *   4. duplicateNodes    Ctrl+D 式原地复制（不经过剪贴板）
 *   5. hitTest           点选命中测试（z 序 = 数组倒序）
 *   6. boundsOf          选区包围盒（「粘贴到视野中心」/ 对齐用）
 *
 * 刻意的边界（不要在这里加）：
 *   - 不 import vue、不碰 DOM、不读 window / localStorage / navigator。
 *   - 不写剪贴板：serializeSubgraph 只吐字符串，navigator.clipboard 的动作由接线层做。
 *   - 不碰键盘事件、不碰响应式状态：本模块所有函数都是纯函数（除模块级 id 计数器）。
 *
 * 坐标系约定：Vue Flow 里设了 parentNode 的子节点，position 是**相对父节点**的。
 * 本项目 NodeCanvas 的 groupSelection / ungroupSelection 用的就是「绝对 = 父.position + 子.position」
 * （组内边距不参与换算）。本模块的 absolutePosition / paste 偏移规则都跟这条保持一致。
 */

export const CLIPBOARD_VERSION = 1;

/** 自定义剪贴板类型：接线层写剪贴板时带上它，粘贴时优先读它，回落读 text/plain。 */
export const CLIPBOARD_MIME = "application/x-ai-canvas-nodes";

/** 默认粘贴偏移（像素）：让副本明显错开原节点，避免看起来「没反应」。 */
export const PASTE_OFFSET = 32;

/** 信封里的 kind 字段：用来和「用户从别处复制的普通 JSON」区分开。 */
export const CLIPBOARD_KIND = "ai-canvas-nodes";

/** 一次粘贴默认最多落地多少节点（软上限，超出即截断，见 pasteSubgraph）。 */
export const DEFAULT_PASTE_LIMIT = 200;

/** 节点尺寸兜底：与 NodeCanvas 里编组时的 `n.dimensions?.width || 220` 保持一致。 */
export const DEFAULT_NODE_WIDTH = 220;
export const DEFAULT_NODE_HEIGHT = 160;

/** parentNode 链的展开深度上限：防脏数据成环时把递归/循环拖死。 */
const MAX_PARENT_DEPTH = 32;

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 数字或 "320px" 这类字符串 → number；其它一律 null（调用方再用 ?? 兜底）。 */
function toNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 节点 id 一律按字符串处理：idMap 的键必须稳定可比。 */
function nodeIdOf(node) {
  if (!isObj(node)) return "";
  if (typeof node.id === "string") return node.id;
  if (node.id == null) return "";
  return String(node.id);
}

/**
 * 深拷贝：copySubgraph 的**硬要求**。
 * 拿引用回去的话，「复制一份改改参数」会直接把原节点也改了 —— 这正是本 Sprint
 * 要解决的场景，所以这里宁可自己递归，也不用 JSON 往返（JSON 会丢 undefined、
 * 遇环就抛）。环用 WeakMap 记录，遇到环返回已克隆对象而不是无限递归。
 */
function deepClone(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    seen.set(value, out);
    for (let i = 0; i < value.length; i++) out[i] = deepClone(value[i], seen);
    return out;
  }
  const out = {};
  seen.set(value, out);
  for (const key of Object.keys(value)) out[key] = deepClone(value[key], seen);
  return out;
}

/** 读取父节点 id：顶层 parentNode/parentId（Vue Flow 原生）优先，其次 data 里的同名键。 */
function parentIdOf(node) {
  if (!isObj(node)) return "";
  const direct = node.parentNode ?? node.parentId;
  if (direct != null && direct !== "") return String(direct);
  if (isObj(node.data)) {
    const nested = node.data.parentNode ?? node.data.parentId;
    if (nested != null && nested !== "") return String(nested);
  }
  return "";
}

/** 收集一个节点上「确实存在 parent 字段」的位置，写回时只动这些位置。 */
function parentSlots(node) {
  const slots = [];
  for (const key of ["parentNode", "parentId"]) {
    if (Object.prototype.hasOwnProperty.call(node, key)) slots.push({ holder: node, key });
  }
  if (isObj(node.data)) {
    for (const key of ["parentNode", "parentId"]) {
      if (Object.prototype.hasOwnProperty.call(node.data, key)) slots.push({ holder: node.data, key });
    }
  }
  return slots;
}

/**
 * 改挂 / 摘掉父节点。
 * newParentId 为 "" 时是「摘掉」：除了清 parentNode，还要把 extent:'parent' 一起清掉 ——
 * 留着 extent 却没有 parent，Vue Flow 会按「受限于父节点」去夹取坐标，节点会自己乱跑。
 * （只清 'parent' 这一种取值，不动自定义 extent，避免误删调用方自己写的约束。）
 */
function applyParent(node, newParentId) {
  const slots = parentSlots(node);
  if (!slots.length) {
    if (newParentId) node.parentNode = newParentId;
    return;
  }
  for (const { holder, key } of slots) {
    if (newParentId) holder[key] = newParentId;
    else delete holder[key];
  }
  if (!newParentId && node.extent === "parent") delete node.extent;
}

/** node 的尺寸：dimensions / width / data.width / style.width（可能是 "320px"）依次回落。 */
function sizeOf(node) {
  const width =
    toNumber(node?.dimensions?.width) ??
    toNumber(node?.width) ??
    toNumber(node?.data?.width) ??
    toNumber(node?.style?.width) ??
    DEFAULT_NODE_WIDTH;
  const height =
    toNumber(node?.dimensions?.height) ??
    toNumber(node?.height) ??
    toNumber(node?.data?.height) ??
    toNumber(node?.style?.height) ??
    DEFAULT_NODE_HEIGHT;
  return { width, height };
}

function positionOf(node) {
  return { x: toNumber(node?.position?.x) ?? 0, y: toNumber(node?.position?.y) ?? 0 };
}

function isHidden(node) {
  return Boolean(node?.hidden) || Boolean(isObj(node?.data) && node.data.hidden);
}

function indexById(nodes) {
  const map = new Map();
  for (const n of nodes) {
    if (!isObj(n)) continue;
    const id = nodeIdOf(n);
    if (id) map.set(id, n);
  }
  return map;
}

/**
 * 绝对坐标：把 parentNode 链上的 position 逐级加起来。
 * 为什么必须算：子节点的 position 是相对父节点的，拿原始 position 去比较鼠标坐标 /
 * 算包围盒，在组内节点上会整体偏掉一个组的位移。环和缺失父节点都不抛，能加多少加多少。
 */
function absolutePosition(node, byId) {
  const base = positionOf(node);
  let x = base.x;
  let y = base.y;
  const guard = new Set();
  const selfId = nodeIdOf(node);
  if (selfId) guard.add(selfId);
  let parentId = parentIdOf(node);
  let hops = 0;
  while (parentId && hops < MAX_PARENT_DEPTH) {
    if (guard.has(parentId)) break; // 脏数据成环 → 停，别把 Node 卡死
    guard.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break; // 父不在传入数组里：只能按相对坐标处理，宁可少加也不要编造
    const pp = positionOf(parent);
    x += pp.x;
    y += pp.y;
    parentId = parentIdOf(parent);
    hops += 1;
  }
  return { x, y };
}

/** 选中集合归一化：兼容 Array / Set / 任意可迭代 / 单个 id 字符串。 */
function normalizeIds(selectedIds) {
  if (selectedIds == null) return [];
  if (typeof selectedIds === "string") return selectedIds ? [selectedIds] : [];
  if (selectedIds instanceof Set) return [...selectedIds].filter((v) => typeof v === "string" && v);
  if (Array.isArray(selectedIds)) return selectedIds.filter((v) => typeof v === "string" && v);
  if (typeof selectedIds === "object" && typeof selectedIds[Symbol.iterator] === "function") {
    return [...selectedIds].filter((v) => typeof v === "string" && v);
  }
  return [];
}

function edgeEndId(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

// ---------------------------------------------------------------------------
// 模块级 id 计数器
// ---------------------------------------------------------------------------
// 为什么放在模块级：idFactory 由调用方负责「与已有画布不冲突」，但**不传** idFactory 时
// 必须我们自己保证「同一进程内单调递增」，否则同一次会话里连按两次 Ctrl+V 会拿到同一批 id，
// 表现为「粘贴出来的节点被上一次的覆盖」（store.js 里 bumpFlowId 那段注释踩过同款坑）。
let copySeq = 0;
let edgeCopySeq = 0;

function nextNodeSeq() {
  copySeq += 1;
  return copySeq;
}

/** 内置默认工厂：p1 → p1-copy-1、p1-copy-2 …（含 "-copy-"，不会撞 store.newFlowId 的 p1/e3 体系）。 */
function defaultIdFactory(oldId) {
  return `${oldId || "node"}-copy-${nextNodeSeq()}`;
}

function defaultEdgeIdFactory(oldId) {
  edgeCopySeq += 1;
  return `${oldId || "edge"}-copy-${edgeCopySeq}`;
}

// ---------------------------------------------------------------------------
// 1) 抽取选中子图
// ---------------------------------------------------------------------------

/**
 * 抽取选中子图。返回的 nodes/edges 都是深拷贝（改副本不会污染原图）。
 *
 * @param {Array<object>} nodes 画布全部节点
 * @param {Array<object>} edges 画布全部连线
 * @param {Array<string>|Set<string>} selectedIds 选中的节点 id
 */
export function copySubgraph(nodes, edges, selectedIds) {
  const failed = (code, message) => ({ ok: false, code, message, nodes: [], edges: [], droppedEdges: 0, groups: [] });

  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return failed("BAD_INPUT", "copySubgraph 需要 nodes 与 edges 两个数组");
  }

  const wanted = new Set(normalizeIds(selectedIds));
  if (!wanted.size) return failed("EMPTY_SELECTION", "没有选中任何节点");

  const picked = [];
  const pickedIds = new Set();
  for (const n of nodes) {
    const id = nodeIdOf(n);
    if (!id || !wanted.has(id) || pickedIds.has(id)) continue;
    picked.push(n);
    pickedIds.add(id);
  }
  if (!picked.length) return failed("NO_MATCHING_NODES", "选中的 id 在当前画布上都不存在");

  // 只保留两端都在选区内的连线。
  // 为什么丢：跨选区连线的一端留在原图。若把它复制过去，副本会连回**原节点**，
  // 粘贴完画布上凭空多出一条「跨图连线」，用户看到的是「复制一个节点，结果原节点多长出一条线」。
  // 这类边我们直接丢弃并计数，交给调用方决定要不要提示「N 条连线未复制」。
  const keptEdges = [];
  let droppedEdges = 0;
  for (const e of edges) {
    const s = edgeEndId(e?.source);
    const t = edgeEndId(e?.target);
    if (s && t && pickedIds.has(s) && pickedIds.has(t)) keptEdges.push(deepClone(e));
    else droppedEdges += 1;
  }

  return {
    ok: true,
    nodes: picked.map((n) => deepClone(n)),
    edges: keptEdges,
    droppedEdges,
    // 选区里涉及的 group 节点 id：粘贴时用来确认「哪些父节点会跟着一起重建」。
    groups: picked.filter((n) => n.type === "group").map(nodeIdOf).filter(Boolean)
  };
}

// ---------------------------------------------------------------------------
// 2) 剪贴板文本封装 / 解析
// ---------------------------------------------------------------------------

/**
 * 序列化成剪贴板信封字符串。
 * 只负责吐字符串 —— navigator.clipboard.write / writeText 的动作属于接线层，
 * 本模块不碰 DOM，这样 Node 里也能直接跑测试。
 */
export function serializeSubgraph(payload) {
  const src = isObj(payload) ? payload : {};
  const envelope = {
    kind: CLIPBOARD_KIND,
    version: CLIPBOARD_VERSION,
    createdAt: new Date().toISOString(),
    nodes: Array.isArray(src.nodes) ? src.nodes : [],
    edges: Array.isArray(src.edges) ? src.edges : [],
    groups: Array.isArray(src.groups) ? src.groups : []
  };
  try {
    return JSON.stringify(envelope);
  } catch {
    // 循环引用等异常情况：退化成空信封，绝不把异常抛给 Ctrl+C 的处理链
    return JSON.stringify({ kind: CLIPBOARD_KIND, version: CLIPBOARD_VERSION, createdAt: new Date().toISOString(), nodes: [], edges: [], groups: [] });
  }
}

/**
 * 健壮解析剪贴板文本。
 *
 * 为什么必须结构化失败：用户从任何地方 Ctrl+C（网页、微信、记事本）都可能命中，
 * 剪贴板里经常是 ""、"not json"、别的 App 的 JSON。这里**任何输入都不许抛异常**，
 * 一律返回 { ok:false, code }，接线层据此决定「静默忽略」还是「提示格式不对」。
 */
export function deserializeSubgraph(text) {
  const fail = (code, message) => ({ ok: false, code, message, payload: null });

  if (typeof text !== "string") return fail("EMPTY", "剪贴板里没有文本");
  const raw = text.trim();
  if (!raw) return fail("EMPTY", "剪贴板里没有文本");

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("BAD_JSON", "剪贴板内容不是合法 JSON");
  }

  if (!isObj(parsed)) return fail("BAD_SHAPE", "剪贴板内容不是本应用的节点格式");

  // 顺序有讲究：先看 version（99 这种「是本格式但太新」的诊断比「字段缺失」更准），
  // 再看 nodes 结构。
  const version = toNumber(parsed.version);
  if (version === null || !Number.isInteger(version) || version < 1) {
    return fail("BAD_SHAPE", "剪贴板内容不是本应用的节点格式");
  }
  if (version > CLIPBOARD_VERSION) {
    return fail("VERSION_UNSUPPORTED", `剪贴板来自更新的版本（v${version}），当前支持到 v${CLIPBOARD_VERSION}`);
  }
  if (!Array.isArray(parsed.nodes)) return fail("BAD_SHAPE", "剪贴板信封缺少 nodes 数组");

  return {
    ok: true,
    payload: {
      kind: typeof parsed.kind === "string" ? parsed.kind : CLIPBOARD_KIND,
      version,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      nodes: parsed.nodes,
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      groups: Array.isArray(parsed.groups) ? parsed.groups : []
    }
  };
}

// ---------------------------------------------------------------------------
// 3) 粘贴
// ---------------------------------------------------------------------------

function pasteFailed(code, message) {
  return { ok: false, code, message, nodes: [], edges: [], idMap: {}, truncated: false, droppedEdges: 0 };
}

/**
 * 把信封 payload 粘贴成「新 id + 已偏移」的节点与连线。
 *
 * @param {object} payload deserializeSubgraph 的 payload（或 copySubgraph 的结果）
 * @param {object} options
 *   - offsetX / offsetY 偏移像素，默认 PASTE_OFFSET
 *   - idFactory (oldId) => newId，建议必传；不传用内置单调计数器
 *   - limit 最多粘贴多少节点，默认 DEFAULT_PASTE_LIMIT
 *   - offsetChildren 默认 false：见下面「偏移规则」
 */
export function pasteSubgraph(payload, options = {}) {
  const opts = isObj(options) ? options : {};
  const offsetX = toNumber(opts.offsetX) ?? PASTE_OFFSET;
  const offsetY = toNumber(opts.offsetY) ?? PASTE_OFFSET;

  if (!isObj(payload) || !Array.isArray(payload.nodes)) {
    return pasteFailed("BAD_PAYLOAD", "payload 缺少 nodes 数组，无法粘贴");
  }

  // 限流：limit 必须是一个正整数。传 0 / 负数 / NaN 属于接线错误 ——
  // 若默默按 0 截断，用户看到的是「按了粘贴什么也没发生」，比直接报错难查得多。
  const limitRaw = opts.limit === undefined || opts.limit === null ? DEFAULT_PASTE_LIMIT : toNumber(opts.limit);
  if (limitRaw === null || !Number.isInteger(limitRaw) || limitRaw < 1) {
    return pasteFailed("LIMIT_EXCEEDED", `limit 必须是 >= 1 的整数，收到 ${JSON.stringify(opts.limit)}`);
  }
  const limit = limitRaw;

  const factory = typeof opts.idFactory === "function" ? opts.idFactory : defaultIdFactory;

  // 先过滤掉不可用的条目（不是对象 / 没有 id / 重复 id），再截断：
  // 让 limit 数的是「真正会落地的节点」，否则一张脏信封会把额度浪费在垃圾上。
  const valid = [];
  const seenOld = new Set();
  const sourceIds = new Set();
  for (const n of payload.nodes) {
    const id = nodeIdOf(n);
    if (!id || seenOld.has(id)) continue;
    seenOld.add(id);
    sourceIds.add(id);
    valid.push(n);
  }
  if (!valid.length) return pasteFailed("BAD_PAYLOAD", "payload 里没有可用的节点");

  // 限流（硬要求 6）：超出 limit 就截断，绝不让一次粘贴把画布撑爆。
  // 截断取前 limit 个（保持原顺序 = 用户复制时的顺序）；被截掉节点的连线会在下面
  // 因为端点不在 idMap 里而被自动丢弃，不会留悬空边。
  const truncated = valid.length > limit;
  const kept = truncated ? valid.slice(0, limit) : valid;

  // ---- 发新 id ----
  // 唯一性责任划分：与「画布上其它节点」不冲突是调用方 idFactory 的活（我们看不到全图）；
  // 我们额外保证两件事：(a) 同一次粘贴内部不重复；(b) 新 id 不等于信封里任何一个旧 id
  //（否则粘贴结果会直接顶掉原节点）。工厂返回空值也兜底。
  const used = new Set();
  const idMap = {};
  for (const n of kept) {
    const oldId = nodeIdOf(n);
    let candidate = "";
    try {
      const produced = factory(oldId);
      candidate = produced == null ? "" : String(produced);
    } catch {
      candidate = "";
    }
    if (!candidate) candidate = defaultIdFactory(oldId);
    let guard = 0;
    while ((used.has(candidate) || sourceIds.has(candidate)) && guard < 100000) {
      candidate = `${candidate}-${nextNodeSeq()}`;
      guard += 1;
    }
    used.add(candidate);
    idMap[oldId] = candidate;
  }

  const offsetChildren = opts.offsetChildren === true;

  const outNodes = kept.map((src) => {
    const oldId = nodeIdOf(src);
    const clone = deepClone(src);
    clone.id = idMap[oldId];

    // ---- parentNode 重映射（硬要求 4）----
    // 父节点也在本次粘贴集合里 → 指到**新**父节点，副本才是一个自洽的组；
    // 父节点在选区外（或父被截断掉了）→ 必须清空，否则副本会挂到「别人的组」里，
    // 拖动原组时副本跟着乱动，甚至被原组的折叠一起隐藏。
    const oldParent = parentIdOf(src);
    if (oldParent) {
      const newParent = idMap[oldParent] || "";
      applyParent(clone, newParent);
    }

    // ---- 偏移规则 ----
    // 子节点的 position 是相对父节点的：父已经在本次粘贴里整体平移了 offset，
    // 子节点若再平移一次，就会在组内部漂移 32px（父移 32、子又移 32 = 相对位移 32）。
    // 所以默认只平移「顶层节点」（粘贴后没有父节点的那些）；想让子节点也各自平移，
    // 显式传 offsetChildren: true。
    const stillHasParent = Boolean(parentIdOf(clone));
    if (!stillHasParent || offsetChildren) {
      const base = positionOf(src);
      clone.position = { ...(isObj(clone.position) ? clone.position : {}), x: base.x + offsetX, y: base.y + offsetY };
    }

    return clone;
  });

  // ---- 连线重映射（硬要求 3）----
  // 端点不在 idMap 里的一律丢弃并计数：宁少一条边，也绝不产出
  // 「source 指向不存在节点」的悬空边（Vue Flow 遇到悬空边会渲染异常甚至报错）。
  // 触发丢弃的三种情况：边本身跨选区、端点被截断、端点在脏信封里缺失。
  const srcEdges = Array.isArray(payload.edges) ? payload.edges : [];
  const outEdges = [];
  const usedEdgeIds = new Set();
  let droppedEdges = 0;
  for (const e of srcEdges) {
    if (!isObj(e)) {
      droppedEdges += 1;
      continue;
    }
    const newSource = idMap[edgeEndId(e.source)];
    const newTarget = idMap[edgeEndId(e.target)];
    if (!newSource || !newTarget) {
      droppedEdges += 1;
      continue;
    }
    const clone = deepClone(e);
    clone.source = newSource;
    clone.target = newTarget;
    let edgeId = defaultEdgeIdFactory(typeof e.id === "string" ? e.id : "");
    let guard = 0;
    while (usedEdgeIds.has(edgeId) && guard < 1000) {
      edgeId = defaultEdgeIdFactory(typeof e.id === "string" ? e.id : "");
      guard += 1;
    }
    usedEdgeIds.add(edgeId);
    clone.id = edgeId;
    outEdges.push(clone);
  }

  return { ok: true, nodes: outNodes, edges: outEdges, idMap, truncated, droppedEdges };
}

// ---------------------------------------------------------------------------
// 4) 原地复制一份（Ctrl+D）
// ---------------------------------------------------------------------------

/**
 * 不经过剪贴板，直接把选中子图复制一份就地偏移。
 * 返回形状与 pasteSubgraph 一致；额外把 copySubgraph 丢掉的「跨选区连线数」也累加进
 * droppedEdges，便于调用方统一提示「N 条连线没跟着复制」。
 * 注意：本函数不会取消原节点的 selected，也不会选中新节点 —— 那是接线层的事。
 */
export function duplicateNodes(nodes, edges, selectedIds, options = {}) {
  const copied = copySubgraph(nodes, edges, selectedIds);
  if (!copied.ok) {
    return { ok: false, code: copied.code, message: copied.message, nodes: [], edges: [], idMap: {}, truncated: false, droppedEdges: 0 };
  }
  const pasted = pasteSubgraph(
    { kind: CLIPBOARD_KIND, version: CLIPBOARD_VERSION, nodes: copied.nodes, edges: copied.edges, groups: copied.groups },
    options
  );
  return { ...pasted, droppedEdges: (pasted.droppedEdges || 0) + (copied.droppedEdges || 0) };
}

// ---------------------------------------------------------------------------
// 5) 命中测试
// ---------------------------------------------------------------------------

/**
 * 给一个画布坐标点，返回该点下的节点 id（没有则 null）。
 * z 序 = 数组倒序：nodes 数组里越靠后越在上层，所以从后往前找，第一个命中的就是视觉最上面的。
 * 隐藏节点（折叠组里的子节点等）不参与命中。
 */
export function hitTest(nodes, point) {
  if (!Array.isArray(nodes) || !isObj(point)) return null;
  const px = toNumber(point.x);
  const py = toNumber(point.y);
  if (px === null || py === null) return null;

  const byId = indexById(nodes);
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const n = nodes[i];
    if (!isObj(n) || isHidden(n)) continue;
    const id = nodeIdOf(n);
    if (!id) continue;
    const { x, y } = absolutePosition(n, byId);
    const { width, height } = sizeOf(n);
    if (px >= x && px <= x + width && py >= y && py <= y + height) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 6) 包围盒
// ---------------------------------------------------------------------------

/**
 * 选区包围盒（绝对坐标）。没有任何可用节点时返回 null（调用方据此跳过「粘贴到视野中心」）。
 * ids 省略 = 全画布；传空数组/空集合 = 空选区 → null。
 * 与 hitTest 一致：按绝对坐标算、跳过隐藏节点。
 */
export function boundsOf(nodes, ids) {
  if (!Array.isArray(nodes)) return null;

  let wanted = null;
  if (ids != null) {
    const list = normalizeIds(ids);
    if (!list.length) return null;
    wanted = new Set(list);
  }

  const byId = indexById(nodes);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hit = 0;

  for (const n of nodes) {
    if (!isObj(n) || isHidden(n)) continue;
    const id = nodeIdOf(n);
    if (!id) continue;
    if (wanted && !wanted.has(id)) continue;
    const { x, y } = absolutePosition(n, byId);
    const { width, height } = sizeOf(n);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
    hit += 1;
  }

  if (!hit) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
