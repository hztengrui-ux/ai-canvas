<script setup>
import { provide, ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import ReferenceNode from "./nodes/ReferenceNode.vue";
import ProductNode from "./nodes/ProductNode.vue";
import StyleNode from "./nodes/StyleNode.vue";
import PromptNode from "./nodes/PromptNode.vue";
import ExecutorNode from "./nodes/ExecutorNode.vue";
import ResultNode from "./nodes/ResultNode.vue";
import GroupNode from "./nodes/GroupNode.vue";
import EmptyCanvas from "./EmptyCanvas.vue";
import { store, modelById, resolveSize, WORKFLOWS, newFlowId, bumpFlowId, pushHistory, bridge, pushTask, updateTask, finishTask } from "../store.js";
import { notifyGenerated } from "../embed.js";
import { generateStream, generateVideoStream, fetchTemplateGraph, uploadMaterial, cancelServerTask } from "../api.js";
import { normalizeMaterialCategory, DEFAULT_MATERIAL_CATEGORY } from "../materials.js";
import { copySubgraph, serializeSubgraph, deserializeSubgraph, pasteSubgraph, duplicateNodes } from "../canvas-clipboard.js";
import { validateConnection, decorateEdge, edgeStyleFor, typeColor } from "../ports.js";
import { runBatches, MAX_PER_BATCH } from "../batch.js";
import { planGrid, splitPrompts, estimateBatchCost, batchRowStateLabel } from "../batchmode.js";
import { canvasDotColor } from "../theme.js";
import { scheduleSave, flushSave, markSaved, markError, addAsset } from "../project.js";

const emit = defineEmits(["tool-shortcut", "toggle-material", "toggle-minimap", "toggle-chat"]);

const flow = useVueFlow();
const {
  addNodes,
  addEdges,
  removeNodes,
  getEdges,
  findNode,
  fitView,
  zoomIn,
  zoomOut,
  viewport,
  getNodes,
  setSelection,
  setViewport,
  updateNode
} = flow;

const showMinimap = ref(false);
const zoomPct = computed(() => `${Math.round((viewport.value?.zoom || 1) * 100)}%`);

// ---------- 画布模式：无限画布（自由创作） / 批量节点（批量操作）----------
// 两种模式复用同一张画布与同一批节点，差别只在「交互契约」：
//   free  点一下选中一个，拖框、连线、随手摆 —— 创作时的默认
//   batch 点一下是「加选/取消」，顶部出现批量条，可整批串行跑
// 这样不用维护两套画布实现，也不用在两套之间同步节点。
const batchMode = computed(() => store.canvasMode === "batch");
const selectedIds = () => getNodes.value.filter((n) => n.selected).map((n) => n.id);
const selectionCount = computed(() => getNodes.value.filter((n) => n.selected).length);

// 批量模式下点击节点是「加选」，但 Vue Flow 自带的点击处理会先把其他节点清空。
// 所以在 pointerdown 捕获阶段先快照一次选中集合，click 时基于快照做异或 ——
// 拿到的是「点击前」的状态，不会被 Vue Flow 的先手操作污染。
let selSnapshot = new Set();
function onPointerDownCapture() {
  if (store.canvasMode !== "batch") return;
  selSnapshot = new Set(selectedIds());
}
function onNodeClick({ node }) {
  if (store.canvasMode !== "batch") return;
  const next = new Set(selSnapshot);
  if (next.has(node.id)) next.delete(node.id);
  else next.add(node.id);
  applySelection([...next]);
}

// 画布网点色跟随主题（Vue Flow 的 Background 只收具体色值，读不到 CSS 变量）
const dotColor = computed(() => canvasDotColor(store.theme, store.darkMode));

// ---------- 语义缩放（补齐差距 A4） ----------
// 之前 zoom 只用来显示百分比和做坐标换算，画布内容永远一个样。
// 现在按缩放分三档，父容器挂 class，节点内部用 CSS 决定显示多少信息：
//   far  (<0.5)  只留标题色块，缩略图与参数全部隐藏
//   mid  (0.5–1.1) 标准视图
//   near (>1.1)  显示完整参数与预览图
const zoomTier = computed(() => {
  const z = viewport.value?.zoom || 1;
  if (z < 0.5) return "far";
  if (z > 1.1) return "near";
  return "mid";
});

// ---------- 取消生成（补齐差距 E4） ----------
// 每个任务持有一个 AbortController，底部任务条点「取消」直接中断 fetch
const controllers = new Map(); // taskId -> AbortController

// 画布是否仍处于「初始默认」状态（一旦铺过工作流或用户手动加过节点则为 false）
let pristine = true;
// 连线样式：颜色交给 CSS（可跟随主题），这里只管虚线与粗细
// 虚线周期 = 6 + 5 = 11，配合 CSS 的 dashoffset 动画形成「蚂蚁线」
const EDGE_STYLE = { strokeWidth: 1.6, strokeDasharray: "6 5" };

// ---------- 强类型端口（P0-9） ----------
// 连线拖拽过程中会被高频调用，这里只做判断不弹提示（弹窗会刷屏），
// 拒绝原因记下来，等松手（connect-end）再提示一次。
let lastReject = "";

function isValidConnection(conn) {
  const src = findNode(conn.source);
  const dst = findNode(conn.target);
  if (!src || !dst) return true; // 查不到节点就交给 Vue Flow 自己判断
  const r = validateConnection({
    sourceType: src.type,
    sourceHandle: conn.sourceHandle,
    targetType: dst.type,
    targetHandle: conn.targetHandle
  });
  lastReject = r.ok ? "" : r.reason || "这两个端口类型不匹配";
  return r.ok;
}

function onConnectEnd() {
  if (!lastReject) return;
  ElMessage.warning(lastReject);
  lastReject = "";
}

/** 新建连线：补 id / dataType / 按类型着色 */
function onConnect(conn) {
  const src = findNode(conn.source);
  const dst = findNode(conn.target);
  const r = validateConnection({
    sourceType: src?.type,
    sourceHandle: conn.sourceHandle,
    targetType: dst?.type,
    targetHandle: conn.targetHandle
  });
  if (!r.ok) {
    ElMessage.warning(r.reason || "这两个端口类型不匹配");
    return;
  }

  // Vue Flow 在部分配置下会自己先把边加进去，这里做一次去重：
  // 已存在就只补 dataType 与配色，避免连出两条一模一样的线。
  const dup = getEdges.value.find(
    (e) =>
      e.source === conn.source &&
      e.target === conn.target &&
      (e.sourceHandle || "") === (conn.sourceHandle || "") &&
      (e.targetHandle || "") === (conn.targetHandle || "")
  );
  if (dup) {
    dup.dataType = r.dataType || "";
    dup.style = edgeStyleFor(r.dataType || "");
    nextTick(() => syncExecutorInputs());
    return;
  }

  addEdges([
    {
      ...conn,
      id: newFlowId("e"),
      dataType: r.dataType || "",
      style: edgeStyleFor(r.dataType || "")
    }
  ]);
  nextTick(() => syncExecutorInputs());
}

/** 节点类型查询器：给 decorateEdge 用 */
function nodeTypeOf(id) {
  return findNode(id)?.type || "";
}

// ---------- 撤销 / 重做历史栈 ----------
const historyStack = ref([]);
const futureStack = ref([]);
const canUndo = computed(() => historyStack.value.length > 1);
const canRedo = computed(() => futureStack.value.length > 0);
let restoring = false;
let snapTimer = null;

function serialize() {
  return {
    nodes: getNodes.value.map((n) => ({
      id: n.id,
      type: n.type,
      position: { x: n.position.x, y: n.position.y },
      data: JSON.parse(JSON.stringify(n.data ?? {})),
      // ⚠️ 2026-10-14 修复（作品组是半成品）：以下 5 个字段以前**没被导出**，
      // 于是「编组后撤销一次」或「编组后刷新页面」，子节点就从组里脱离、
      // 组框尺寸回退、折叠态丢失 —— 因为恢复时 parentNode/extent 这些关系全没了。
      // 它们是 Vue Flow 表达「结构语义」的字段，必须跟节点一起进快照与持久化。
      parentNode: n.parentNode ?? undefined,
      extent: n.extent ?? undefined,
      hidden: n.hidden ?? false,
      zIndex: n.zIndex ?? 0,
      // 组节点自己的尺寸（GroupNode 用 style 撑开），丢了组框就回退成默认大小
      style: n.style ? JSON.parse(JSON.stringify(n.style)) : undefined
    })),
    edges: getEdges.value.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      dataType: e.dataType || "", // 撤销/重做、存模板都要靠它还原连线语义
      style: e.style
    })),
    viewport: { x: viewport.value?.x || 0, y: viewport.value?.y || 0, zoom: viewport.value?.zoom || 1 }
  };
}

/** 导出整张图（模板反哺用）：与 serialize 的区别是会补 dataType 与视口 */
function exportGraph() {
  const snap = serialize();
  return {
    nodes: snap.nodes,
    edges: snap.edges.map((e) => decorateEdge(e, nodeTypeOf)),
    viewport: snap.viewport
  };
}

function pushSnapshot() {
  if (restoring) return;
  historyStack.value.push(serialize());
  if (historyStack.value.length > 60) historyStack.value.shift();
  futureStack.value = [];
}

function scheduleSnapshot() {
  if (restoring) return;
  clearTimeout(snapTimer);
  snapTimer = setTimeout(pushSnapshot, 260);
}

function restoreSnapshot(snap) {
  const ids = getNodes.value.map((n) => n.id);
  if (ids.length) removeNodes(ids);
  // 直接展开快照里的全部结构字段（含 parentNode/extent/hidden/zIndex/style），
  // 不能只挑 id/type/position/data —— 那会让作品组在撤销后散架。
  addNodes(JSON.parse(JSON.stringify(snap.nodes)));
  // 快照里的 id 可能比当前计数器大（撤销/重做跨了恢复点），抬一下防止后续新建撞 id
  bumpFlowId(getNodes.value);
  nextTick(() => {
    addEdges(JSON.parse(JSON.stringify(snap.edges)));
    nextTick(() => syncExecutorInputs());
  });
}

function undo() {
  if (historyStack.value.length < 2) return;
  restoring = true;
  const cur = historyStack.value.pop();
  futureStack.value.push(cur);
  const prev = historyStack.value[historyStack.value.length - 1];
  restoreSnapshot(prev);
  setTimeout(() => (restoring = false), 120);
  ElMessage.info("已撤销");
}

function redo() {
  if (!futureStack.value.length) return;
  restoring = true;
  const next = futureStack.value.pop();
  historyStack.value.push(next);
  restoreSnapshot(next);
  setTimeout(() => (restoring = false), 120);
  ElMessage.info("已重做");
}

// 初始画布为空（对齐参考工具：进来是干净画布，由左侧工具铺工作流）
const nodes = ref([]);

const edges = ref([]);

const isEmpty = computed(() => nodes.value.length === 0);

// 节点数同步到工作台首页统计
watch(
  nodes,
  (list) => {
    store.flowNodeCount = list.length;
  },
  { immediate: true, deep: false }
);

// ---------- 选中同步：右侧属性栏的数据源 ----------
// 属性栏不自己维护副本，直接读画布节点的引用，改哪边都一样。
function syncSelection() {
  store.selection = getNodes.value.filter((n) => n.selected);
}
watch(
  () => getNodes.value.map((n) => (n.selected ? "1" : "0")).join(""),
  () => syncSelection()
);

// ---------- 作品组（补齐差距 A3） ----------
const GROUP_PAD = 28; // 组内边距
const GROUP_BAR = 44; // 顶部标题条高度
let groupSeq = 1;

/** 把选中节点编成一个作品组：建组节点 → 子节点改挂 parent 并换成相对坐标 */
function groupSelection() {
  const sel = getNodes.value.filter((n) => n.selected && n.type !== "group" && !n.parentNode);
  if (sel.length < 2) {
    ElMessage.warning("先框选或按住 Shift 选中至少 2 个节点，再编组");
    return false;
  }

  const minX = Math.min(...sel.map((n) => n.position.x)) - GROUP_PAD;
  const minY = Math.min(...sel.map((n) => n.position.y)) - GROUP_PAD - GROUP_BAR;
  const maxX = Math.max(...sel.map((n) => n.position.x + (n.dimensions?.width || 220))) + GROUP_PAD;
  const maxY = Math.max(...sel.map((n) => n.position.y + (n.dimensions?.height || 160))) + GROUP_PAD;

  const gid = newFlowId("g");
  addNodes([
    {
      id: gid,
      type: "group",
      position: { x: minX, y: minY },
      style: { width: `${Math.max(320, maxX - minX)}px`, height: `${Math.max(200, maxY - minY)}px` },
      data: { label: `作品组 ${groupSeq++}`, collapsed: false, count: sel.length, color: "#2563EB" },
      selectable: true,
      draggable: true,
      zIndex: 0
    }
  ]);

  nextTick(() => {
    // 不用 updateNode 展开整个 node：那会把它内部的 computed（selected / dragging …）
    // 摊平成死值。Vue Flow 的 node 本身是 reactive 的，直接改属性即可触发重算。
    for (const n of sel) {
      const node = findNode(n.id);
      if (!node) continue;
      node.parentNode = gid;
      node.extent = "parent";
      node.position = {
        x: n.position.x - minX - GROUP_PAD,
        y: n.position.y - minY - GROUP_BAR - GROUP_PAD
      };
      node.zIndex = 1;
    }
    nextTick(() => {
      syncExecutorInputs();
      pushSnapshot();
      ElMessage.success(`已把 ${sel.length} 个节点编为作品组`);
    });
  });
  return true;
}

/** 解散选中的作品组：子节点坐标换算回绝对坐标后脱离父节点 */
function ungroupSelection() {
  const groups = getNodes.value.filter((n) => n.selected && n.type === "group");
  if (!groups.length) {
    ElMessage.warning("请先选中一个作品组");
    return false;
  }
  const gids = groups.map((g) => g.id);
  for (const child of getNodes.value.filter((n) => n.parentNode && gids.includes(n.parentNode))) {
    const parent = findNode(child.parentNode);
    child.parentNode = undefined;
    child.extent = undefined;
    child.hidden = false;
    child.position = {
      x: child.position.x + (parent?.position.x || 0),
      y: child.position.y + (parent?.position.y || 0)
    };
    child.zIndex = 0;
  }
  removeNodes(gids);
  nextTick(() => {
    pushSnapshot();
    ElMessage.success("已解散作品组");
  });
  return true;
}

/** 折叠 / 展开：折叠时隐藏子节点并把组压成标题条 */
function toggleGroup(id) {
  const g = findNode(id);
  if (!g) return;
  const collapsed = !g.data.collapsed;
  for (const c of getNodes.value.filter((n) => n.parentNode === id)) c.hidden = collapsed;

  if (collapsed) {
    // 折叠前记下展开高度，展开时还原
    const h = parseFloat(String(g.style?.height || "200"));
    if (Number.isFinite(h)) g.data.expandedHeight = h;
    g.style = { ...(g.style || {}), height: `${GROUP_BAR}px` };
  } else {
    g.style = { ...(g.style || {}), height: `${g.data.expandedHeight || 200}px` };
  }
  g.data.collapsed = collapsed;
  nextTick(() => scheduleSave(serialize()));
}

/** 重命名作品组 */
function renameGroup({ id, label }) {
  updateNode(id, (node) => ({ ...node, data: { ...node.data, label } }));
  nextTick(() => scheduleSave(serialize()));
}

// ---------- 执行状态同步（执行节点的 ✓ 列表） ----------
function syncExecutorInputs() {
  for (const node of getNodes.value) {
    if (node.type !== "executor") continue;
    const incoming = getEdges.value.filter((e) => e.target === node.id);
    const types = incoming.map((e) => findNode(e.source)?.type);
    node.data.hasPrompt = types.includes("prompt");
    node.data.hasProduct = types.includes("product");
    node.data.hasStyle = types.includes("style");
  }
}
watch(
  () => getEdges.value.length,
  () => syncExecutorInputs(),
  { immediate: true }
);
flow.onEdgesChange?.(() => syncExecutorInputs());

// 节点/连线数量变化 → 防抖记录历史快照
watch(
  () => `${getNodes.value.length}:${getEdges.value.length}`,
  () => scheduleSnapshot()
);

// ---------- 自动保存（E7） ----------
// 位置或连线一变就排一次防抖落盘。只监听「坐标 + 连线数」，不 deep watch 整个
// data（提示词每敲一个字都会触发，白白写 localStorage）。
watch(
  () =>
    getNodes.value.map((n) => `${n.id}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).join("|") +
    `#${getEdges.value.length}`,
  () => {
    if (restoring) return;
    scheduleSave(serialize());
  }
);

// 节点内部参数（提示词 / 张数 / 上传的图）变化也要存，但用更长防抖
watch(
  () => getNodes.value.map((n) => JSON.stringify(n.data)).join("|"),
  () => {
    if (restoring) return;
    scheduleSave(serialize());
  }
);

// ---------- 执行引擎 ----------
function addResultNode(anchorId, payload) {
  // 优先填充铺工作流时预置的「生成结果」节点（执行节点右侧那一个）
  const link = getEdges.value.find(
    (e) => e.source === anchorId && e.sourceHandle === "result"
  );
  const target = link ? findNode(link.target) : null;

  if (target) {
    target.data.images = payload.images || [];
    target.data.videos = payload.videos || [];
    return target.id;
  }

  // 手动搭的画布没有预置节点，再新建一个
  const anchor = findNode(anchorId);
  const pos = anchor
    ? { x: anchor.position.x + 300, y: anchor.position.y - 10 }
    : { x: 600, y: 600 };
  const id = newFlowId("r");
  addNodes([
    {
      id,
      type: "result",
      position: pos,
      data: {
        ...makeNodeData("result"),
        images: payload.images || [],
        videos: payload.videos || []
      }
    }
  ]);
  return id;
}

/** 单批生成：把 SSE 回调包成 Promise，顺带把「命中缓存 / 已付费重跑」带出来 */
async function generateOnce(payload, onText, signal = null) {
  let result = null;
  let error = "";
  await generateStream(payload, (evt) => {
    if (evt.type === "progress") onText?.(evt.text);
    if (evt.type === "done") {
      result = {
        images: evt.images || [],
        cost: evt.cost || 0,
        savedCost: Number(evt.savedCost) || 0,
        cached: Boolean(evt.cached),
        replay: Boolean(evt.replay)
      };
    }
    if (evt.type === "error") error = evt.error || "生成失败";
  }, { signal });
  if (error) throw new Error(error);
  return result || { images: [] };
}

// ---------- 生成前成本确认（补齐差距 E9） ----------
// 服务端会预扣，但用户点下去之前完全不知道这次要花多少。批量 10 张 = 100 点，
// 误触一次就是一笔钱。这里在发起前先算一次并弹窗。
function estimateCost(action, times = 1) {
  const unit = Number(store.costTable?.[action]?.cost ?? store.costTable?.[action] ?? 0);
  return unit * Math.max(1, times);
}

async function confirmCost(points, detail) {
  // 小额（<30 点）不打扰，直接跑
  if (points < 30) return true;
  const balance = Number(store.balance || 0);
  if (points > balance) {
    ElMessageBox.alert(
      `本次预计消耗 ${points} 点，当前余额 ${balance} 点。请先充值再生成。`,
      "算力不足",
      { confirmButtonText: "知道了" }
    ).catch(() => {});
    return false;
  }
  try {
    await ElMessageBox.confirm(
      `${detail}\n预计消耗 ${points} 点，当前余额 ${balance} 点，生成后剩余 ${balance - points} 点。`,
      "确认生成",
      { confirmButtonText: "开始生成", cancelButtonText: "再想想" }
    );
    return true;
  } catch {
    return false;
  }
}

/** 结果落资产库：审阅视图与导出的统一数据源 */
function recordAssets(items, { kind = "image", model = "", prompt = "", nodeId = "", cost = 0 }) {
  for (const im of items || []) {
    addAsset({ url: im.url, kind, model, prompt, nodeId, cost });
  }
}

/**
 * 跑一个执行节点。
 * @param {string} executorId
 * @param {{skipConfirm?:boolean}} [opts] 批量模式下由外层统一确认一次，
 *        这里就不再逐节点弹窗了（否则 20 行弹 20 次）。
 * @returns {{ok:boolean, images?:Array, error?:string, canceled?:boolean, skipped?:boolean}}
 */
async function generateImage(executorId, opts = {}) {
  const execNode = findNode(executorId);
  if (!execNode || execNode.data.busy) return { ok: false, skipped: true };
  const d = execNode.data;
  d.error = "";
  d.status = "";

  const incoming = getEdges.value.filter((e) => e.target === executorId);
  let promptNode = null;
  let outfitNode = null;
  let modelNode = null;
  let productNode = null;
  let styleNode = null;
  for (const e of incoming) {
    const src = findNode(e.source);
    if (src?.type === "prompt") promptNode = src;
    if (src?.type === "style") styleNode = src;
    if (src?.type === "product") {
      const role = src.data.role;
      if (role === "model") modelNode = src;
      else if (role === "outfit") outfitNode = src;
      else productNode = src;
    }
  }

  if (!promptNode || !String(promptNode.data.prompt || "").trim()) {
    d.error = "请先连接「画面描述」节点并输入描述";
    return { ok: false, error: d.error };
  }

  const modelCfg = modelById(promptNode.data.modelId);
  const size = resolveSize(store.imageResolution, promptNode.data.ratio);

  // 把服装/模特/产品/风格参考以文字方式并入提示词
  let finalPrompt = String(promptNode.data.prompt).trim();
  const refs = [];
  if (outfitNode?.data.file) refs.push(`服装图：${outfitNode.data.file.name}`);
  if (modelNode?.data.file) refs.push(`模特图：${modelNode.data.file.name}`);
  if (productNode?.data.file) refs.push(`产品主体：${productNode.data.file.name}`);
  if (styleNode?.data.files?.length) refs.push(`风格参考：${styleNode.data.files.map((f) => f.name).join("、")}`);
  if (refs.length) finalPrompt += `\n（参考素材 - ${refs.join("；")}）`;

  // 参考图清单：一并送服务端。
  // ⚠️ P0-0 仍是阻断项：服务端 provider 目前只发文本，图片还没真正进模型。
  //    先把清单送出去，上游签名能用它做内容级去重，图生图通路打通后直接受益。
  const referenceImages = [
    outfitNode?.data.file,
    modelNode?.data.file,
    productNode?.data.file,
    ...(styleNode?.data.files || [])
  ]
    .filter(Boolean)
    .map((f) => ({ url: f.url || "", name: f.name || "", sha256: f.sha256 || "" }))
    .filter((f) => f.url || f.name);

  const total = Math.max(1, Math.round(Number(promptNode.data.count) || 1));

  // 商品一致性参数（F6）：取自第一个有图的参考节点
  const refNode = outfitNode || productNode || modelNode || styleNode;
  const keepTexture = refNode?.data?.keepTexture !== false;
  const printArea = refNode?.data?.printArea || "auto";
  const strength = Number(refNode?.data?.strength) || 0.75;
  // 把「保留纹理 / 印花区域」也写进提示词，云端 provider 不看这两个字段也能受益
  if (refNode?.data?.file) {
    const hints = [];
    if (keepTexture) hints.push("保留原图的针织纹理与褶皱");
    if (printArea && printArea !== "auto") {
      hints.push(`印花区域限定在${{ front: "前胸", full: "整幅", sleeve: "袖部", custom: "指定遮罩" }[printArea] || printArea}`);
    }
    if (hints.length) finalPrompt += `\n（一致性要求：${hints.join("；")}）`;
  }

  // 任务 id 要在 payload 之前定下来：服务端要拿它登记任务，
  // 取消时才知道该停哪一条。放在 payload 之后会踩 TDZ（const 不提升）。
  const taskId = pushTask({
    kind: "image",
    label: `${modelCfg.label} × ${total} 张`,
    nodeId: executorId,
    prompt: String(promptNode.data.prompt || "").slice(0, 120)
  });

  const payload = {
    provider: modelCfg.provider,
    model: promptNode.data.modelId,
    prompt: finalPrompt,
    size,
    referenceImages,
    strength,
    printArea,
    keepTexture,
    // 备注不参与计费签名：改备注重跑不该再扣一次
    remark: d.remark || "",
    // 项目归属：写进服务端血缘，手机端「按项目筛选」才有东西可分。
    // 项目本身只存在渲染层 localStorage，服务端没有项目表 —— 所以名字必须在这里捎带过去，
    // 否则手机端只能显示一串 p_xxxx。
    projectId: String(store.currentProjectId || ""),
    projectName: String(store.projectName || ""),
    // 服务端任务 id：点取消时服务端靠它找到这条任务，
    // 真正去停上游（ComfyUI /interrupt），而不是只断开本地连接
    taskId
  };

  // 生成前先报价：批量 10 张就是 100 点，误触一次很贵
  // 批量模式下外层已经算过总账并确认过了，这里不再重复打扰
  if (!opts.skipConfirm) {
    const estCost = estimateCost("image.generate", total);
    if (!(await confirmCost(estCost, `${modelCfg.label} × ${total} 张（${promptNode.data.ratio}）`))) {
      return { ok: false, canceled: true };
    }
  }

  const controller = new AbortController();
  controllers.set(taskId, controller);

  d.busy = true;
  d.status = `正在通过 ${modelCfg.label} 生成 ${total} 张（${promptNode.data.ratio}）…`;
  updateTask(taskId, { text: d.status });

  try {
    let images = [];
    let noCharge = false;
    let savedCost = 0;
    let cost = 0;

    if (total <= MAX_PER_BATCH) {
      const r = await generateOnce({ ...payload, n: total }, (t) => {
        d.status = t;
        updateTask(taskId, { text: t });
      }, controller.signal);
      images = r.images;
      noCharge = r.cached || r.replay;
      savedCost = r.savedCost || 0;
      cost = r.cost || 0;
    } else {
      // 超过单批上限 → 客户端分批编排，进度落盘，可断点续跑
      const r = await runBatches({
        payload,
        total,
        label: `${modelCfg.label} × ${total} 张`,
        signal: controller.signal,
        onProgress: (info) => {
          d.status = `批量 ${info.done}/${info.total} 张 · ${info.text || "准备中"}`;
          updateTask(taskId, {
            text: d.status,
            progress: Math.round((info.done / Math.max(1, info.total)) * 100)
          });
        },
        // 每批完成就落库，中途取消也能保住已经出图的那些
        onBatchDone: (got) =>
          recordAssets(got, { model: modelCfg.label, prompt: payload.prompt, nodeId: executorId })
      });
      images = r.images;
      savedCost = r.savedCost || 0;
      if (r.resumed) ElMessage.info("已恢复上次未完成的批量任务，只对缺失批次计费");
    }

    if (controller.signal.aborted) {
      updateTask(taskId, { status: "canceled", text: "已取消" });
      d.status = "已取消";
      pushHistory({ type: "image", model: modelCfg.label, count: images.length, ok: false });
      return { ok: false, canceled: true };
    }

    if (savedCost > 0) {
      ElMessage.success(`输入未变化，本次未扣算力（已省 ${savedCost} 点）`);
    } else if (noCharge) {
      ElMessage.info("命中历史结果，本次未扣算力");
    }
    d.status = `生成完成 ✓（${images.length} 张）`;
    const nodeId = addResultNode(executorId, { images });
    recordAssets(images, { model: modelCfg.label, prompt: payload.prompt, nodeId, cost });
    pushHistory({ type: "image", model: modelCfg.label, count: images.length, ok: true });
    finishTask(taskId, { images, cost, savedCost, nodeId });
    // 嵌入模式下把结果回传给宿主系统
    notifyGenerated({ kind: "image", model: modelCfg.label, images });
    return { ok: true, images };
  } catch (e) {
    if (controller.signal.aborted) {
      updateTask(taskId, { status: "canceled", text: "已取消" });
      d.status = "已取消";
      return { ok: false, canceled: true };
    }
    d.error = e.message || String(e);
    updateTask(taskId, { status: "error", text: d.error });
    pushHistory({ type: "image", model: modelCfg.label, count: 0, ok: false });
    return { ok: false, error: d.error };
  } finally {
    controllers.delete(taskId);
    d.busy = false;
    setTimeout(() => (d.status = ""), 4000);
  }
}

async function generateVideo(refId) {
  const node = findNode(refId);
  if (!node || node.data.busy) return;
  const d = node.data;
  d.error = "";

  if (!String(d.prompt || "").trim()) {
    d.error = "请输入视频画面描述";
    return;
  }
  if (d.images.length + d.videos.length + d.audios.length === 0 && !d.prompt) {
    d.error = "请至少提供一种输入";
    return;
  }

  // 视频 120 点/次，必然弹确认
  const estCost = estimateCost("video.generate", 1);
  if (!(await confirmCost(estCost, `${d.model} · ${d.resolution} · ${d.duration}`))) return;

  const firstFrame = d.images[0] || null;
  const taskId = pushTask({ kind: "video", label: `${d.model} 视频（${d.duration}）`, nodeId: refId });
  const controller = new AbortController();
  controllers.set(taskId, controller);

  d.busy = true;
  d.status = `正在通过 ${d.model} 生成视频（${d.resolution} / ${d.duration}）…`;
  updateTask(taskId, { text: d.status });

  try {
    await generateVideoStream(
      {
        prompt: String(d.prompt).trim(),
        firstFrame,
        resolution: d.resolution,
        duration: parseInt(d.duration, 10) || 5
      },
      (evt) => {
        if (evt.type === "progress") {
          d.status = evt.text;
          updateTask(taskId, { text: evt.text });
        }
        if (evt.type === "error") d.error = evt.error;
        if (evt.type === "done") {
          const saved = Number(evt.savedCost) || 0;
          d.status = saved
            ? `视频生成完成 ✓（未扣算力，省 ${saved} 点）`
            : `视频生成完成 ✓（扣 ${evt.cost || 0} 点）`;
          const nodeId = addResultNode(refId, { videos: evt.videos });
          recordAssets(evt.videos || [], {
            kind: "video",
            model: d.model,
            prompt: String(d.prompt || "").slice(0, 120),
            nodeId,
            cost: Number(evt.cost) || 0
          });
          pushHistory({ type: "video", model: d.model, count: evt.videos.length, ok: true });
          finishTask(taskId, { images: evt.videos || [], cost: Number(evt.cost) || 0, savedCost: saved });
          if (saved) ElMessage.success(`输入未变化，视频未重复扣算力（已省 ${saved} 点）`);
        }
      },
      { signal: controller.signal }
    );
  } catch (e) {
    if (controller.signal.aborted) {
      updateTask(taskId, { status: "canceled", text: "已取消" });
      d.status = "已取消";
    } else {
      d.error = e.message || String(e);
      updateTask(taskId, { status: "error", text: d.error });
      pushHistory({ type: "video", model: d.model, count: 0, ok: false });
    }
  } finally {
    controllers.delete(taskId);
    d.busy = false;
    setTimeout(() => (d.status = ""), 4000);
  }
}

// ==========================================================================
// 批量节点模式（画布模式开关的「批量」侧）
// ==========================================================================
const CANVAS_MODE_KEY = "ai-canvas.canvas-mode.v1";
const batchRunning = ref(false);
let batchController = null;

/** 取某个执行节点上游的提示词文本（批量面板展示用） */
function promptTextOf(executorId) {
  const e = getEdges.value.find((x) => x.target === executorId);
  const src = e ? findNode(e.source) : null;
  return src?.type === "prompt" ? String(src.data.prompt || "") : "";
}

/**
 * 把一批提示词铺成节点。
 * 一行提示词 = 一个「画面描述 + 执行 + 结果」三元组，按网格排开并连好线。
 * @param {{prompts:string[], count?:number, ratio?:string, cols?:number}} o
 * @returns {string[]} 生成的执行节点 id（供批量运行直接拿去跑）
 */
function createBatchFromPrompts({ prompts = [], count = 1, ratio = "", cols = 3 }) {
  const list = (Array.isArray(prompts) ? prompts : []).filter((s) => String(s || "").trim());
  if (!list.length) return [];

  const spots = planGrid(list.length, { cols, cellW: 980, cellH: 470, x: 80, y: 80 });
  const created = [];
  const createdEdges = [];
  const execIds = [];

  list.forEach((text, i) => {
    const { x, y } = spots[i];
    const pId = newFlowId("p");
    const eId = newFlowId("e");
    const rId = newFlowId("r");

    created.push({
      id: pId,
      type: "prompt",
      position: { x, y },
      data: makeNodeData("prompt", {
        prompt: text,
        modelId: store.imageModel,
        count: Math.max(1, Math.round(Number(count) || 1)),
        ratio: ratio || store.imageRatio
      })
    });
    created.push({
      id: eId,
      type: "executor",
      position: { x: x + 330, y: y + 40 },
      data: makeNodeData("executor")
    });
    created.push({
      id: rId,
      type: "result",
      position: { x: x + 640, y: y + 20 },
      data: makeNodeData("result")
    });

    createdEdges.push({
      id: newFlowId("e"),
      source: pId,
      target: eId,
      sourceHandle: "prompt",
      targetHandle: "prompt",
      dataType: "string",
      style: edgeStyleFor("string")
    });
    createdEdges.push({
      id: newFlowId("e"),
      source: eId,
      target: rId,
      sourceHandle: "result",
      targetHandle: "result",
      dataType: "ai-image",
      style: edgeStyleFor("ai-image")
    });
    execIds.push(eId);
  });

  addNodes(created);
  addEdges(createdEdges);
  pristine = false;
  pushSnapshot();
  // 铺完选中这批执行节点，用户直接点「运行选中」就行
  applySelection(execIds);
  nextTick(() => {
    syncExecutorInputs();
    fitView({ padding: 0.08, duration: 350 });
    scheduleSave(serialize());
  });
  return execIds;
}

/** 把顶层节点（不含作品组里的子节点）重新按网格排布 */
function tidyGrid() {
  const top = getNodes.value.filter((n) => !n.parentNode);
  if (!top.length) return 0;
  const spots = planGrid(top.length, { cols: 3, cellW: 420, cellH: 460, x: 60, y: 60 });
  top.forEach((n, i) => {
    // 直接改属性，不用 updateNode 展开 —— 展开会把 selected/dragging 等
    // computed 摊成死值，节点会失去响应（踩过一次）。
    n.position = { ...spots[i] };
  });
  pushSnapshot();
  nextTick(() => {
    fitView({ padding: 0.08, duration: 300 });
    scheduleSave(serialize());
  });
  return top.length;
}

/**
 * 串行执行一批执行节点。
 * 为什么串行而不是并发：一次批量动辄十几张图，并发会把上游限流打满，
 * 而且中途取消时「已经发出去的那些」收不回来。串行 + 每步检查中止信号，
 * 取消点下去最多浪费当前这一张。
 *
 * @param {string[]} [ids] 不传就用当前选中的节点（自动挑出其中的执行节点）
 */
async function runBatchNodes(ids = null) {
  const wanted = Array.isArray(ids) && ids.length ? ids : selectedIds();
  const targets = wanted.map((id) => findNode(id)).filter((n) => n && n.type === "executor");
  if (!targets.length) {
    ElMessage.warning("请先在批量模式下选中要运行的执行节点");
    return { ran: 0, failed: 0 };
  }
  if (batchRunning.value) {
    ElMessage.info("还有一批在跑，先等它结束或取消");
    return { ran: 0, failed: 0 };
  }

  // 批量前只弹一次总账：逐节点弹窗会让人一直点「开始生成」
  const perNode = Math.max(...targets.map((n) => Number(promptCountOf(n.id)) || 1));
  const unit = Number(store.costTable?.["image.generate"]?.cost ?? store.costTable?.["image.generate"] ?? 0);
  const est = estimateBatchCost({ rows: targets.length, perNode, unitCost: unit });
  if (est >= 30) {
    const balance = Number(store.balance || 0);
    if (est > balance) {
      ElMessageBox.alert(
        `这批 ${targets.length} 行预计消耗 ${est} 点，当前余额 ${balance} 点。请先充值。`,
        "算力不足",
        { confirmButtonText: "知道了" }
      ).catch(() => {});
      return { ran: 0, failed: 0 };
    }
    try {
      await ElMessageBox.confirm(
        `共 ${targets.length} 行，每行约 ${perNode} 张，预计消耗 ${est} 点，余额 ${balance} 点。\n串行执行，中途可取消。`,
        "确认批量生成",
        { confirmButtonText: "开始批量", cancelButtonText: "再想想" }
      );
    } catch {
      return { ran: 0, failed: 0 };
    }
  }

  batchController = new AbortController();
  batchRunning.value = true;
  store.batchRows = targets.map((n, i) => ({
    id: n.id,
    index: i + 1,
    prompt: promptTextOf(n.id).slice(0, 60),
    state: "queued",
    msg: batchRowStateLabel("queued")
  }));

  let ran = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    if (batchController.signal.aborted) {
      for (let j = i; j < store.batchRows.length; j++) {
        store.batchRows[j].state = "canceled";
        store.batchRows[j].msg = "已取消";
      }
      break;
    }
    const row = store.batchRows[i];
    row.state = "running";
    row.msg = "运行中";

    const r = await generateImage(targets[i].id, { skipConfirm: true });
    if (r?.ok) {
      ran += 1;
      row.state = "done";
      row.msg = `完成 ${r.images?.length || 0} 张`;
    } else if (r?.canceled) {
      row.state = "canceled";
      row.msg = "已取消";
      failed += 1;
    } else if (r?.skipped) {
      row.state = "skipped";
      row.msg = "忙碌中，已跳过";
    } else {
      failed += 1;
      row.state = "error";
      row.msg = String(r?.error || "失败").slice(0, 40);
    }
  }

  batchRunning.value = false;
  batchController = null;
  const canceled = store.batchRows.some((r) => r.state === "canceled");
  if (canceled) ElMessage.info(`批量已取消：完成 ${ran} 行`);
  else if (failed) ElMessage.warning(`批量结束：成功 ${ran} 行，失败 ${failed} 行`);
  else ElMessage.success(`批量完成：${ran} 行`);
  return { ran, failed };
}

/** 取执行节点上游提示词节点配置的张数 */
function promptCountOf(executorId) {
  const e = getEdges.value.find((x) => x.target === executorId && x.targetHandle === "prompt");
  const src = e ? findNode(e.source) : null;
  return src?.type === "prompt" ? Number(src.data.count) || 1 : 1;
}

/** 中断当前批量：掐掉在飞的那个请求，循环下一步就停 */
function cancelBatch() {
  if (!batchController) return;
  batchController.abort();
  for (const c of controllers.values()) c.abort();
}

/** 重跑：底部任务条的「重做」与属性栏的「重新生成」都走这里 */
function rerunNode(nodeId) {
  const n = findNode(nodeId);
  if (!n) return;
  if (n.type === "executor") return generateImage(nodeId);
  if (n.type === "reference") return generateVideo(nodeId);
  // 其余类型：找下游的执行节点来跑
  const out = getEdges.value.find((e) => e.source === nodeId);
  const next = out ? findNode(out.target) : null;
  if (next?.type === "executor") return generateImage(next.id);
  ElMessage.info("这个节点没有可重跑的执行器");
}

async function cancelTask(taskId) {
  // 顺序有讲究：先通知服务端停上游（ComfyUI /interrupt），再断本地连接。
  // 反过来做，本地先断了，服务端那边还会在队列里把这张图算完。
  await cancelServerTask(taskId);
  controllers.get(taskId)?.abort();
  updateTask(taskId, { status: "canceled", text: "正在取消…" });
}

function addPromptNode(afterId) {
  const anchor = findNode(afterId);
  const pos = anchor ? { x: anchor.position.x, y: anchor.position.y + 260 } : { x: 500, y: 480 };
  addNodes([
    {
      id: newFlowId("p"),
      type: "prompt",
      position: pos,
      data: { prompt: "", modelId: store.imageModel, count: 1, ratio: store.imageRatio, error: "" }
    }
  ]);
}

provide("exec", { generateImage, generateVideo, addPromptNode, removeNode: removeNodes });

// ---------- 工作流模板：一次性铺节点 + 自动连线 ----------
const PREFIX = { product: "pd", style: "s", prompt: "p", executor: "e", reference: "ref", result: "r" };

function makeNodeData(type, extra = {}) {
  switch (type) {
    case "product":
      return { file: null, error: "", title: "产品图", role: "product", optional: false, ...extra };
    case "style":
      return { files: [], error: "", optional: true, uploadText: "点击上传风格图", ...extra };
    case "prompt":
      return { prompt: "", modelId: store.imageModel, count: 4, ratio: store.imageRatio, error: "", ...extra };
    case "executor":
      return { busy: false, status: "", error: "", hasPrompt: false, hasProduct: false, hasStyle: false, ...extra };
    case "reference":
      return {
        tab: "images", images: [], videos: [], audios: [], prompt: "",
        model: store.videoModel, resolution: store.videoResolution,
        mode: store.videoMode, duration: store.videoDuration,
        busy: false, status: "", error: "", ...extra
      };
    case "result":
      return { images: [], videos: [], saving: false, saveMsg: "", ...extra };
    default:
      return { ...extra };
  }
}

/**
 * 在画布上铺开一套预置工作流。
 * - 画布仍处于初始默认状态时：先清掉默认节点，铺一套干净流程；
 * - 之后再次点击：追加到现有内容右侧，不覆盖已有工作。
 */
/** 铺一个工作流模板（按 id 取 src/store.js 的 WORKFLOWS） */
function applyWorkflow(wfId) {
  const wf = WORKFLOWS[wfId];
  if (!wf) return;
  applyWorkflowGraph(wf, { id: wfId });
}

/**
 * 铺图的**统一入口**：内置模板与「技能计划转换出来的图」都走这里。
 *
 * 为什么不给技能另写一条铺图路径：定位、id 生成、执行器自动补结果节点、
 * 连线端口校验这些规则就必须存在两份 —— 两份必然逐渐不一致，
 * 而且出问题时很难判断是哪条路径的锅。
 */
function applyWorkflowGraph(wf, { label = "", id = "" } = {}) {
  if (!wf || !Array.isArray(wf.nodes) || !wf.nodes.length) return;
  if (label) wf = { ...wf, label };
  const opts = { id };

  const existing = getNodes.value;
  let offsetX = 0;
  let offsetY = 0;

  if (pristine || existing.length === 0) {
    if (existing.length) removeNodes(existing.map((n) => n.id));
    edges.value = [];
    pristine = false;
  } else {
    offsetX = Math.max(...existing.map((n) => n.position.x)) + 1020;
    offsetY = Math.min(...existing.map((n) => n.position.y));
  }

  const xs = wf.nodes.map((n) => n.x);
  const ys = wf.nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  const idMap = {};
  const created = wf.nodes.map((def) => {
    const id = newFlowId(PREFIX[def.type] || "n");
    idMap[def.key] = id;
    return {
      id,
      type: def.type,
      position: { x: def.x - minX + 80 + offsetX, y: def.y - minY + 80 + offsetY },
      data: makeNodeData(def.type, def.data)
    };
  });

  // 每个执行节点右侧自动补一个「生成结果」节点，并连好线
  const resultEdges = [];
  for (const execNode of created.filter((n) => n.type === "executor")) {
    const rId = newFlowId("r");
    created.push({
      id: rId,
      type: "result",
      position: { x: execNode.position.x + 300, y: execNode.position.y - 10 },
      data: makeNodeData("result")
    });
    resultEdges.push({
      id: newFlowId("e"),
      source: execNode.id,
      target: rId,
      sourceHandle: "result",
      targetHandle: "result",
      dataType: "ai-image",
      style: edgeStyleFor("ai-image")
    });
  }

  addNodes(created);

  // 首页输入的文字带入提示词节点
  if (store.pendingPrompt) {
    const pNode = created.find((n) => n.type === "prompt");
    if (pNode) pNode.data.prompt = store.pendingPrompt;
    store.pendingPrompt = "";
  }

  const createdEdges = [
    ...wf.edges.map(([from, to, sh, th]) => {
      const srcType = created.find((n) => n.id === idMap[from])?.type || "";
      const dstType = created.find((n) => n.id === idMap[to])?.type || "";
      const r = validateConnection({
        sourceType: srcType,
        sourceHandle: sh,
        targetType: dstType,
        targetHandle: th
      });
      return {
        id: newFlowId("e"),
        source: idMap[from],
        target: idMap[to],
        sourceHandle: sh,
        targetHandle: th,
        dataType: r.dataType || "",
        style: r.dataType ? edgeStyleFor(r.dataType) : EDGE_STYLE
      };
    }),
    ...resultEdges
  ];

  if (createdEdges.length) {
    // 等节点注册进 Vue Flow 再挂边，否则可能匹配不到 source/target
    nextTick(() => {
      addEdges(createdEdges);
      nextTick(() => syncExecutorInputs());
    });
  }

  store.activeTool = wf.tool || store.activeTool;
  // 内置模板用模板 id；技能铺图没有 id（模板对象由服务端计划转换而来）时退回技能 id。
  // ⚠️ 这里必须用 opts.id 而不是旧代码里的 wfId —— 那段是重构前 applyWorkflow 的局部变量，
  // 抽成通用入口后它就不存在了（真机点一次就报 ReferenceError，界面上弹软错误条）。
  store.activeSubTool = opts.id || wf.skillId || wf.tool || "";

  nextTick(() => {
    setTimeout(() => fitView({ padding: 0.22, duration: 500 }), 60);
  });

  ElMessage.success(`已铺开「${wf.label}」工作流`);
}

/**
 * 铺开一张「来自模板」的节点图（模板反哺的回收端）。
 * 与 applyWorkflow 的区别：图是用户自己存下来的，节点 id 要重新生成，
 * 连线按 key 映射；data 已由服务端清洗过，这里用 makeNodeData 兜底补全。
 */
function applyTemplateGraph(graph, { label = "模板" } = {}) {
  if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) return false;

  const existing = getNodes.value;
  if (existing.length) removeNodes(existing.map((n) => n.id));
  edges.value = [];
  pristine = false;

  const idMap = {};
  const created = graph.nodes.map((def) => {
    const id = newFlowId(PREFIX[def.type] || "n");
    idMap[def.key ?? def.id] = id;
    return {
      id,
      type: def.type,
      position: { x: Number(def.position?.x) || 0, y: Number(def.position?.y) || 0 },
      data: makeNodeData(def.type, def.data || {})
    };
  });
  addNodes(created);

  const createdEdges = (graph.edges || [])
    .map((e) => ({
      id: newFlowId("e"),
      source: idMap[e.from ?? e.source],
      target: idMap[e.to ?? e.target],
      sourceHandle: e.sourceHandle || "",
      targetHandle: e.targetHandle || "",
      dataType: e.dataType || "",
      style: e.dataType ? edgeStyleFor(e.dataType) : EDGE_STYLE
    }))
    .filter((e) => e.source && e.target);

  nextTick(() => {
    addEdges(createdEdges);
    nextTick(() => syncExecutorInputs());
  });
  nextTick(() => setTimeout(() => fitView({ padding: 0.22, duration: 400 }), 60));

  ElMessage.success(`已铺开模板「${label}」`);
  return true;
}

// ---------- 系统文件拖入（补齐差距 B5） ----------
/**
 * 之前 onCanvasDrop 只解析素材库内部的 application/json，从资源管理器拖图片进来
 * raw 为空直接 return，用户完全看不到反应 —— P0 验收「从本地拖入毛衫图」会失败。
 * 这里补上 files 分支：先上传进素材库，再在落点生成产品/参考节点。
 */
async function importFiles(files, pos, opts = {}) {
  const images = [...(files || [])].filter((f) => String(f.type || "").startsWith("image/"));
  if (!images.length) {
    ElMessage.info("只支持拖入图片文件");
    return 0;
  }
  let ok = 0;
  for (let i = 0; i < images.length; i++) {
    try {
      const r = await uploadMaterial(images[i], normalizeMaterialCategory(opts.category || DEFAULT_MATERIAL_CATEGORY));
      const m = r?.material || r;
      addNodes([
        {
          id: newFlowId("pd"),
          type: "product",
          position: { x: (pos?.x || 200) + i * 46, y: (pos?.y || 200) + i * 46 },
          data: makeNodeData("product", {
            file: m,
            title: opts.title || "参考图",
            role: opts.role || "reference"
          })
        }
      ]);
      ok += 1;
    } catch (e) {
      ElMessage.error(`${images[i].name} 上传失败：${e.message}`);
    }
  }
  if (ok) {
    pristine = false;
    pushSnapshot();
    ElMessage.success(`已导入 ${ok} 张图片`);
  }
  return ok;
}

/** 空态「上传素材」：落在画布中间 */
async function onEmptyUpload(files) {
  const vp = viewport.value || { x: 0, y: 0, zoom: 1 };
  const wrap = document.querySelector(".node-canvas-wrap");
  const rect = wrap?.getBoundingClientRect();
  const cx = ((rect?.width || 900) / 2 - vp.x) / vp.zoom - 110;
  const cy = ((rect?.height || 600) / 2 - vp.y) / vp.zoom - 80;
  await importFiles(files, { x: cx, y: cy });
}

/** 空态就地输入提示词 → 铺文生图工作流并填入 */
function onEmptyQuickStart({ prompt }) {
  applyWorkflow("image-generate");
  nextTick(() => {
    const p = getNodes.value.find((n) => n.type === "prompt");
    if (p) p.data.prompt = prompt;
    const exec = getNodes.value.find((n) => n.type === "executor");
    if (exec) generateImage(exec.id);
  });
}

// 从素材库拖拽到画布空白处 → 自动创建对应节点
function onCanvasDrop(evt) {
  // 系统文件优先：从资源管理器 / 桌面拖进来
  const droppedFiles = [...(evt.dataTransfer?.files || [])];
  if (droppedFiles.length) {
    evt.preventDefault();
    const wrap = document.querySelector(".node-canvas-wrap");
    const rect = wrap?.getBoundingClientRect();
    const vp = viewport.value || { x: 0, y: 0, zoom: 1 };
    const x = ((evt.clientX - (rect?.left || 0)) - vp.x) / vp.zoom;
    const y = ((evt.clientY - (rect?.top || 0)) - vp.y) / vp.zoom;
    importFiles(droppedFiles, { x, y });
    return;
  }

  const raw = evt.dataTransfer?.getData("application/json");
  if (!raw) return;
  evt.preventDefault();

  let material = null;
  try {
    material = JSON.parse(raw).material;
  } catch {
    return;
  }
  if (!material) return;

  const wrap = document.querySelector(".node-canvas-wrap");
  const rect = wrap?.getBoundingClientRect();
  const vp = viewport.value || { x: 0, y: 0, zoom: 1 };
  const x = ((evt.clientX - (rect?.left || 0)) - vp.x) / vp.zoom;
  const y = ((evt.clientY - (rect?.top || 0)) - vp.y) / vp.zoom;

  if (material.kind === "image") {
    addNodes([
      {
        id: newFlowId("pd"),
        type: "product",
        position: { x, y },
        data: makeNodeData("product", { file: material, title: "参考图", role: "reference" })
      }
    ]);
  } else if (material.kind === "video") {
    addNodes([
      {
        id: newFlowId("ref"),
        type: "reference",
        position: { x, y },
        data: makeNodeData("reference", { videos: [material] })
      }
    ]);
  } else {
    ElMessage.info("该素材类型暂不支持拖入画布");
    return;
  }

  pristine = false;
  ElMessage.success("已从素材库添加到画布");
}

// 从左侧预设添加节点
function addNodeByType(type) {
  pristine = false;
  const existing = getNodes.value.filter((n) => n.type === type).length;
  const offset = existing * 40;
  const id = newFlowId(type === "style" ? "s" : type === "product" ? "pd" : type === "prompt" ? "p" : type === "reference" ? "ref" : type === "executor" ? "e" : "r");
  const base = {
    style: { x: 360, y: 60 },
    product: { x: 40, y: 220 },
    prompt: { x: 360, y: 420 },
    reference: { x: 40, y: 60 },
    executor: { x: 720, y: 220 },
    result: { x: 1080, y: 280 }
  }[type] || { x: 200, y: 200 };

  const node = {
    style: { type: "style", data: { files: [], error: "", optional: true, uploadText: "点击上传风格图" } },
    product: { type: "product", data: { file: null, error: "", title: "产品图", sub: "图片生成" } },
    prompt: { type: "prompt", data: { prompt: "", modelId: store.imageModel, count: 1, ratio: store.imageRatio, error: "" } },
    reference: { type: "reference", data: { tab: "images", images: [], videos: [], audios: [], prompt: "", model: "万相 · 3.0", resolution: "1080p", mode: "自动", duration: "5s", busy: false, status: "", error: "" } },
    executor: { type: "executor", data: { busy: false, status: "", error: "", hasPrompt: false, hasProduct: false, hasStyle: false } },
    result: { type: "result", data: { images: [], videos: [], saving: false, saveMsg: "" } }
  }[type];

  addNodes([{ id, type: node.type, position: { x: base.x + offset, y: base.y + offset }, data: node.data }]);
  return id;
}

// ---------- 无限画布：键盘快捷键 ----------
/**
 * 选中 / 取消选中节点。
 * 不用 useVueFlow 的 setSelection：它在不同版本对参数形态（id 数组 / 节点对象 /
 * { nodes, edges }）要求不一致，传 id 数组时静默无效。直接改节点的 selected
 * 标记最稳妥，也能被 Vue Flow 的响应式系统正确感知。
 */
function applySelection(ids) {
  const set = new Set(ids);
  for (const n of getNodes.value) n.selected = set.has(n.id);
}

/** 判断是否有「真正可见」的弹窗遮罩 —— 关闭的弹窗节点仍在 DOM 里 */
function isModalOpen() {
  // 后台控制台与新手引导用 v-if 控制，存在即打开
  if (document.querySelector(".ad") || document.querySelector(".tour-card")) return true;

  const visible = (el) => {
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };
  return [...document.querySelectorAll(".el-overlay")].some(visible);
}

// ---------- 画布剪贴板（Sprint 2）----------
// 信封同时放「内存」与「系统剪贴板」，这不是重复而是有意的双层：
//   · 内存那份是主路径 —— 同窗口内复制粘贴是绝大多数场景，
//     不该因为系统剪贴板权限/环境不支持就让功能不可用；
//   · 系统剪贴板是加分项：跨窗口（双屏面板）、跨项目粘贴靠它，失败就静默降级。
let clipEnvelope = "";

/** 当前选中的节点 id（优先用 Vue Flow 的选中态，兜底看节点的 selected 标记） */
function selectedNodeIds() {
  const viaFlow = flow.getSelectedNodes?.value;
  if (Array.isArray(viaFlow) && viaFlow.length) return viaFlow.map((n) => n.id);
  return getNodes.value.filter((n) => n.selected).map((n) => n.id);
}

/** 复制：抽取选中子图（含内部连线），跨出选区的连线会被丢弃并如实提示 */
function copySelection() {
  const ids = selectedNodeIds();
  const res = copySubgraph(getNodes.value, getEdges.value, ids);
  if (!res.ok) {
    ElMessage.info(res.code === "EMPTY_SELECTION" ? "先选中要复制的节点" : "没有可复制的内容");
    return;
  }
  clipEnvelope = serializeSubgraph(res);
  try {
    navigator.clipboard?.writeText?.(clipEnvelope);
  } catch {
    /* 权限或环境不支持：内存信封仍可用 */
  }
  const base = `已复制 ${res.nodes.length} 个节点`;
  ElMessage.success(res.droppedEdges ? `${base}（${res.droppedEdges} 条跨区连线未复制）` : base);
}

/** 用一份信封文本粘贴；返回是否成功 */
function pasteFromText(text) {
  const parsed = deserializeSubgraph(text);
  if (!parsed.ok) {
    ElMessage.info("剪贴板里没有可粘贴的画布内容");
    return false;
  }
  const res = pasteSubgraph(parsed.payload, { idFactory: () => newFlowId("n") });
  if (!res.ok) {
    ElMessage.info("没有可粘贴的内容");
    return false;
  }
  // 先清旧选中再落新节点：否则新旧混在一起，用户会以为"没粘上"
  applySelection([]);
  addNodes(res.nodes);
  if (res.edges.length) addEdges(res.edges);
  setSelection(res.nodes.map((n) => n.id));
  const base = `已粘贴 ${res.nodes.length} 个节点`;
  const tip = res.truncated ? `${base}（超出上限已截断）` : base;
  ElMessage.success(res.droppedEdges ? `${tip}（${res.droppedEdges} 条连线未跟随）` : tip);
  return true;
}

/** 粘贴：先用内存信封（快、无需权限），再尝试系统剪贴板 */
async function pasteClipboard() {
  if (clipEnvelope && pasteFromText(clipEnvelope)) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!pasteFromText(text)) {
      ElMessage.info("请先在画布内复制节点（Ctrl+C）");
    }
  } catch {
    ElMessage.info("剪贴板不可用，请先在画布内复制");
  }
}

/** Ctrl+D：原地复制一份（不动剪贴板），方便"同款不同色"连续开工 */
function duplicateSelection() {
  const ids = selectedNodeIds();
  const res = duplicateNodes(getNodes.value, getEdges.value, ids, { idFactory: () => newFlowId("n") });
  if (!res.ok) {
    ElMessage.info("先选中要复制的节点");
    return;
  }
  applySelection([]);
  addNodes(res.nodes);
  if (res.edges.length) addEdges(res.edges);
  setSelection(res.nodes.map((n) => n.id));
  ElMessage.success(`已复制 ${res.nodes.length} 个节点`);
}

function onKeyDown(e) {
  // 输入框内不拦截
  const tag = (document.activeElement?.tagName || "").toUpperCase();
  if (["INPUT", "TEXTAREA"].includes(tag) || document.activeElement?.isContentEditable) return;

  // 有弹窗（设置 / 后台 / 新手引导）打开时不响应画布快捷键，
  // 否则在弹窗里按 Delete 会误删画布节点。
  // 注意：Element Plus 关闭的弹窗节点仍留在 DOM 里（实测有 6 个 .el-overlay），
  // 所以必须判断「是否真的可见」，不能只看选择器命中。
  if (isModalOpen()) return;

  const meta = e.ctrlKey || e.metaKey;

  // Ctrl/Cmd + Z：撤销；Ctrl/Cmd + Shift + Z：重做
  if (meta && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }

  // Ctrl/Cmd + A：全选
  if (meta && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    const ids = getNodes.value.map((n) => n.id);
    if (ids.length) applySelection(ids);
    return;
  }

  // Ctrl/Cmd + C / V / D：画布剪贴板（Sprint 2）
  if (meta && (e.key === "c" || e.key === "C")) {
    e.preventDefault();
    copySelection();
    return;
  }
  if (meta && (e.key === "v" || e.key === "V")) {
    e.preventDefault();
    pasteClipboard();
    return;
  }
  if (meta && (e.key === "d" || e.key === "D")) {
    e.preventDefault();
    duplicateSelection();
    return;
  }

  // Delete / Backspace：删除选中节点
  if (e.key === "Delete" || e.key === "Backspace") {
    const sel = (flow.getSelectedNodes?.value || []).map((n) => n.id);
    if (sel.length) {
      e.preventDefault();
      removeNodes(sel);
    }
    return;
  }

  // Escape：取消选中 / 取消拖拽
  if (e.key === "Escape") {
    applySelection([]);
    return;
  }

  // Ctrl/Cmd + 0：适配屏幕
  if (meta && e.key === "0") {
    e.preventDefault();
    fitView({ padding: 0.2, duration: 400 });
    return;
  }

  // Ctrl/Cmd + + / -：缩放
  if (meta && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    zoomIn({ duration: 200 });
    return;
  }
  if (meta && e.key === "-") {
    e.preventDefault();
    zoomOut({ duration: 200 });
    return;
  }

  // Ctrl/Cmd + G：编为作品组；Ctrl/Cmd + Shift + G：解散
  if (meta && (e.key === "g" || e.key === "G")) {
    e.preventDefault();
    if (e.shiftKey) ungroupSelection();
    else groupSelection();
    return;
  }

  // Ctrl/Cmd + B：2026-10-23 起不再切「批量节点」模式，改为直接去「全自动批量」页。
  // 保留这个快捷键是因为用户已经按习惯了 —— 但它现在通向新页面，不是画布内的加选状态。
  if (meta && (e.key === "b" || e.key === "B")) {
    e.preventDefault();
    store.canvasMode = "free";
    store.route = "batch";
    return;
  }

  // Ctrl/Cmd + D：复制选中节点（位置偏移 60px）
  if (meta && (e.key === "d" || e.key === "D")) {
    const sel = flow.getSelectedNodes?.value || [];
    if (sel.length) {
      e.preventDefault();
      const copies = sel.map((n) => ({
        ...JSON.parse(JSON.stringify(n)),
        id: newFlowId(PREFIX[n.type] || "n"),
        position: { x: n.position.x + 60, y: n.position.y + 60 },
        selected: false
      }));
      addNodes(copies);
      ElMessage.success(`已复制 ${copies.length} 个节点`);
    }
    return;
  }

  // 无修饰键的单键快捷：1-5 切工具、D 素材库、M 小地图、F 对话
  if (!meta && !e.altKey) {
    if (["1", "2", "3", "4", "5"].includes(e.key)) {
      e.preventDefault();
      emit("tool-shortcut", Number(e.key) - 1);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "d") { e.preventDefault(); emit("toggle-material"); return; }
    if (k === "m") { e.preventDefault(); emit("toggle-minimap"); return; }
    if (k === "f") { e.preventDefault(); emit("toggle-chat"); return; }
  }

  // N：在画布中央新建一个 Prompt 节点
  if (!meta && (e.key === "n" || e.key === "N")) {
    e.preventDefault();
    const wrap = document.querySelector(".node-canvas-wrap");
    const rect = wrap?.getBoundingClientRect();
    const cx = (rect?.left || 0) + (rect?.width || 0) / 2;
    const cy = (rect?.top || 0) + (rect?.height || 0) / 2;
    addNodeByTypeAt("prompt", cx, cy);
    return;
  }
}

function addNodeByTypeAt(type, clientX, clientY) {
  pristine = false;
  const existing = getNodes.value.filter((n) => n.type === type).length;
  const offset = existing * 40;
  const id = newFlowId(type === "style" ? "s" : type === "product" ? "pd" : type === "prompt" ? "p" : type === "reference" ? "ref" : type === "executor" ? "e" : "r");
  const base = { x: 200 + offset, y: 200 + offset };

  // 把屏幕坐标转成画布世界坐标
  const vp = viewport.value || { x: 0, y: 0, zoom: 1 };
  const x = (clientX - vp.x) / vp.zoom;
  const y = (clientY - vp.y) / vp.zoom;

  const node = {
    style: { type: "style", data: { files: [], error: "", optional: true, uploadText: "点击上传风格图" } },
    product: { type: "product", data: { file: null, error: "", title: "产品图", sub: "图片生成" } },
    prompt: { type: "prompt", data: { prompt: "", modelId: store.imageModel, count: 1, ratio: store.imageRatio, error: "" } },
    reference: { type: "reference", data: { tab: "images", images: [], videos: [], audios: [], prompt: "", model: "万相 · 3.0", resolution: "1080p", mode: "自动", duration: "5s", busy: false, status: "", error: "" } },
    executor: { type: "executor", data: { busy: false, status: "", error: "", hasPrompt: false, hasProduct: false, hasStyle: false } },
    result: { type: "result", data: { images: [], videos: [], saving: false, saveMsg: "" } }
  }[type];

  addNodes([{ id, type: node.type, position: { x, y }, data: node.data }]);
  return id;
}

/** 属性栏改参数：批量回写到选中节点的 data */
function patchSelected(patch) {
  const targets = getNodes.value.filter((n) => n.selected);
  if (!targets.length) return 0;
  for (const n of targets) {
    // 多选时只改「画面描述」节点，避免把产品图的 data 也塞进 count
    if (targets.length > 1 && n.type !== "prompt") continue;
    n.data = { ...n.data, ...patch };
  }
  pushSnapshot();
  nextTick(() => scheduleSave(serialize()));
  return targets.length;
}

/** 删除当前选中的节点（属性栏 / 键盘） */
function removeSelected() {
  const ids = getNodes.value.filter((n) => n.selected).map((n) => n.id);
  if (!ids.length) return;
  removeNodes(ids);
  store.selection = [];
  nextTick(() => scheduleSave(serialize()));
}

/** 全选 / 反选（批量模式顶部条） */
function selectAll() {
  applySelection(getNodes.value.map((n) => n.id));
}
function invertSelection() {
  const cur = new Set(selectedIds());
  applySelection(getNodes.value.filter((n) => !cur.has(n.id)).map((n) => n.id));
}

/** 把视口移到某个节点上（审阅视图「定位」用） */
function focusNode(id) {
  const n = findNode(id);
  if (!n) return;
  const vp = viewport.value || { zoom: 1, x: 0, y: 0 };
  const wrap = document.querySelector(".node-canvas-wrap");
  const w = wrap?.clientWidth || 900;
  const h = wrap?.clientHeight || 600;
  setViewport(
    {
      x: w / 2 - (n.position.x + 110) * vp.zoom,
      y: h / 2 - (n.position.y + 80) * vp.zoom,
      zoom: Math.max(vp.zoom, 0.8)
    },
    { duration: 400 }
  );
  applySelection([id]);
}

onMounted(() => {
  // 画布快捷键总入口。
  // 之前 onKeyDown 只定义了、也在卸载时移除了，但从来没 addEventListener，
  // 导致 Ctrl+Z 撤销/重做、Ctrl+A 全选、1-5 切工具、Esc 等全部失效。
  window.addEventListener("keydown", onKeyDown);

  // 注册桥接：外部（对话抽屉 / 嵌入桥）可直接把文字写进「画面描述」节点
  bridge.setPrompt = (text) => {
    let node = getNodes.value.find((n) => n.type === "prompt");
    if (!node) {
      addNodeByType("prompt");
      node = getNodes.value.find((n) => n.type === "prompt");
    }
    if (!node) return false;
    node.data.prompt = String(text ?? "");
    return true;
  };

  // 嵌入桥：宿主要求铺开某套工作流
  bridge.applyWorkflow = (wfId) => {
    if (!wfId) return false;
    applyWorkflow(wfId);
    return true;
  };

  // 左侧栏「技能」入口：已经在创作台里再点另一个技能时，组件不会重新挂载，
  // 上面 onMounted 里那段 pendingWorkflow 消费逻辑就不会再跑 —— 于是「点了没反应」。
  // 这里再挂一个监听补上这条路：从 pendingWorkflow 取出待铺的流程并消费掉。
  watch(
    () => store.pendingWorkflow,
    (wfId) => {
      if (!wfId) return;
      store.pendingWorkflow = "";
      nextTick(() => applyWorkflow(wfId));
    }
  );

  // 技能面板：已经在创作台里时同样不会重新挂载，所以也要有一条监听。
  // pendingWorkflowGraph 是**模板对象**（技能计划转换而来），与 pendingWorkflow 的 id 形式区分开。
  watch(
    () => store.pendingWorkflowGraph,
    (graph) => {
      if (!graph) return;
      store.pendingWorkflowGraph = null;
      nextTick(() => applyWorkflowGraph(graph));
    }
  );

  // ---- 供右侧属性栏 / 底部任务条 / 审阅视图调用的画布能力 ----
  bridge.getSelected = () => getNodes.value.filter((n) => n.selected);
  bridge.patchSelected = patchSelected;
  bridge.groupSelection = groupSelection;
  bridge.ungroupSelection = ungroupSelection;
  bridge.rerunNode = rerunNode;
  bridge.cancelTask = cancelTask;
  bridge.requestSave = () => scheduleSave(serialize());
  bridge.focusNode = focusNode;
  bridge.removeSelected = removeSelected;

  // ---- 批量节点模式 ----
  bridge.batchFromPrompts = createBatchFromPrompts;
  bridge.runBatchNodes = runBatchNodes;
  bridge.cancelBatch = cancelBatch;
  bridge.tidyGrid = tidyGrid;
  bridge.getSelectedIds = selectedIds;
  bridge.setSelectedIds = applySelection;

  // 2026-10-23：画布只保留「无限画布」一种模式。
  // 批量入口统一到独立的「全自动批量」页；旧存档里的 canvasMode="batch" 一律归零，
  // 否则老用户下次进来会莫名停在加选状态、顶部还挂着一条批量条。
  try {
    if (localStorage.getItem(CANVAS_MODE_KEY) === "batch") localStorage.setItem(CANVAS_MODE_KEY, "free");
  } catch {
    /* 隐私模式读不到就算了，用默认值 */
  }
  store.canvasMode = "free";

  // 关页面 / 刷新前把未落盘的改动写掉（防抖窗口内的修改不至于丢）
  window.addEventListener("beforeunload", flushNow);

  // 初始快照（空画布），再按需铺工作流
  nextTick(() => {
    pushSnapshot();
    // 技能面板铺图：拿到的是模板对象（不是 id），走同一个铺图入口
    if (store.pendingWorkflowGraph) {
      const graph = store.pendingWorkflowGraph;
      store.pendingWorkflowGraph = null;
      nextTick(() => applyWorkflowGraph(graph));
      return;
    }
    // 首页快捷任务跳转过来时，自动铺开对应工作流
    if (store.pendingWorkflow) {
      const wfId = store.pendingWorkflow;
      store.pendingWorkflow = "";
      nextTick(() => applyWorkflow(wfId));
      return;
    }
    // 从「我的模板」（画布存下来的）进入：拉节点图铺开
    if (store.pendingTemplateId) {
      const id = store.pendingTemplateId;
      const name = store.pendingTemplateName || "模板";
      store.pendingTemplateId = "";
      store.pendingTemplateName = "";
      fetchTemplateGraph(id)
        .then((res) => nextTick(() => applyTemplateGraph(res.graph, { label: name })))
        .catch((e) => ElMessage.error(e?.message || "模板节点图加载失败"));
      return;
    }
    // 上次没关掉的画布：优先恢复，让用户回来就在原地（E7）
    if (store.pendingRestore?.nodes?.length) {
      const graph = store.pendingRestore;
      store.pendingRestore = null;
      nextTick(() => restoreGraph(graph));
    }
  });
});

function flushNow() {
  try {
    flushSave(serialize());
  } catch { /* 卸载阶段失败无所谓，下次进来再存 */ }
}

/** 恢复整张图（含视口） */
function restoreGraph(graph) {
  if (!graph?.nodes?.length) return;
  restoring = true;
  const ids = getNodes.value.map((n) => n.id);
  if (ids.length) removeNodes(ids);
  // 展开全部结构字段：持久化下来的图同样带 parentNode/extent/zIndex/style，
  // 只挑 4 个字段恢复会让「作品组」在刷新后散架。
  addNodes(graph.nodes.map((n) => ({ ...n, selected: false })));
  // ⚠️ 2026-10-14 修复（恢复后新建节点 id 重复）：恢复的图保留原 id，
  // 而 nextId 只在模块加载时初始化为 1，必须按已有 id 把计数器抬上去。
  bumpFlowId(graph.nodes);
  nextTick(() => {
    if (graph.edges?.length) addEdges(graph.edges);
    if (graph.viewport) setViewport({ ...graph.viewport }, { duration: 0 });
    pristine = false;
    nextTick(() => {
      syncExecutorInputs();
      pushSnapshot();
      restoring = false;
      markSaved();
    });
  });
}

onBeforeUnmount(() => {
  flushNow();
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("beforeunload", flushNow);
  bridge.setPrompt = null;
  bridge.applyWorkflow = null;
  bridge.getSelected = null;
  bridge.patchSelected = null;
  bridge.groupSelection = null;
  bridge.ungroupSelection = null;
  bridge.rerunNode = null;
  bridge.cancelTask = null;
  bridge.requestSave = null;
  bridge.focusNode = null;
  bridge.removeSelected = null;
  // 批量模式
  bridge.batchFromPrompts = null;
  bridge.runBatchNodes = null;
  bridge.cancelBatch = null;
  bridge.tidyGrid = null;
  bridge.getSelectedIds = null;
  bridge.setSelectedIds = null;
  // 走到这里说明画布要卸载了（回首页 / 关窗口），把在飞的批量一起掐掉
  cancelBatch();
});

// 画布模式变了要落盘，下次进来还在同一个模式
watch(
  () => store.canvasMode,
  (v) => {
    try {
      localStorage.setItem(CANVAS_MODE_KEY, v === "batch" ? "batch" : "free");
    } catch {
      /* 忽略 */
    }
    // 切回自由模式时清掉批量态，避免残留的勾选徽章
    if (v !== "batch") {
      store.batchRows = [];
      applySelection([]);
    }
  }
);

function toggleMinimap() {
  showMinimap.value = !showMinimap.value;
}

defineExpose({
  zoomPct,
  zoomTier,
  zoomIn,
  zoomOut,
  fitView,
  showMinimap,
  addNodeByType,
  applyWorkflow,
  applyTemplateGraph,
  exportGraph,
  toggleMinimap,
  undo,
  redo,
  canUndo,
  canRedo,
  // 新增：作品组 / 持久化 / 导出
  groupSelection,
  ungroupSelection,
  restoreGraph,
  rerunNode,
  focusNode,
  // 批量节点模式
  batchMode,
  batchRunning,
  selectionCount,
  selectAll,
  invertSelection,
  tidyGrid,
  createBatchFromPrompts,
  runBatchNodes,
  cancelBatch
});
</script>

<template>
  <div
    class="node-canvas-wrap"
    :class="[`zoom-${zoomTier}`, `mode-${store.canvasMode}`, { 'has-selection': selectionCount > 0 }]"
    @contextmenu.prevent
    @drop.prevent="onCanvasDrop"
    @dragover.prevent
    @pointerdown.capture="onPointerDownCapture"
  >
    <VueFlow
      v-model:nodes="nodes"
      v-model:edges="edges"
      :default-viewport="{ zoom: 1, x: 0, y: 0 }"
      :min-zoom="0.2"
      :max-zoom="2.5"
      :selection-key-code="['Shift', 'Meta', 'Control']"
      :delete-key-code="['Delete', 'Backspace']"
      :pan-on-drag="true"
      :pan-on-scroll="false"
      :zoom-on-scroll="true"
      :zoom-on-pinch="true"
      :zoom-on-double-click="false"
      :nodes-connectable="true"
      :elements-selectable="true"
      :multi-selection-key-code="['Shift', 'Meta', 'Control']"
      :is-valid-connection="isValidConnection"
      @connect="onConnect"
      @connect-end="onConnectEnd"
      @node-click="onNodeClick"
    >
      <!-- size 被当作直径，会随画布缩放；1 太小会缩到亚像素，故用 1.6 -->
      <!-- 网点色跟随主题（color-mix 读不到，只能由 JS 查表给具体色值） -->
      <Background variant="dots" :gap="20" :size="1.6" :pattern-color="dotColor" />
      <MiniMap
        v-if="showMinimap"
        position="bottom-left"
        pannable
        zoomable
        node-color="#2563EB"
        mask-color="rgba(243,244,246,0.78)"
      />
      <Controls position="bottom-right" :show-interactive="true" />
      <template #node-reference="nodeProps"><ReferenceNode v-bind="nodeProps" /></template>
      <template #node-product="nodeProps"><ProductNode v-bind="nodeProps" /></template>
      <template #node-style="nodeProps"><StyleNode v-bind="nodeProps" /></template>
      <template #node-prompt="nodeProps"><PromptNode v-bind="nodeProps" /></template>
      <template #node-executor="nodeProps"><ExecutorNode v-bind="nodeProps" /></template>
      <template #node-result="nodeProps"><ResultNode v-bind="nodeProps" /></template>
      <template #node-group="nodeProps">
        <GroupNode v-bind="nodeProps" @toggle="toggleGroup" @rename="renameGroup" />
      </template>
    </VueFlow>

    <!-- 空画布引导：可上传、可直接写提示词（B2 / B3 / B4） -->
    <EmptyCanvas
      v-if="isEmpty"
      @upload="onEmptyUpload"
      @quickstart="onEmptyQuickStart"
      @pick="applyWorkflow"
    />

    <!-- 批量模式顶部条：加选状态与批量动作都在这里 -->
    <div v-if="batchMode" class="batch-bar">
      <span>批量模式 · 已选 <b class="bb-count">{{ selectionCount }}</b> 个</span>
      <button @click="store.batchDockOpen = !store.batchDockOpen">
        {{ store.batchDockOpen ? "收起面板" : "批量面板" }}
      </button>
      <button @click="selectAll">全选</button>
      <button @click="invertSelection">反选</button>
      <button :disabled="!selectionCount" @click="tidyGrid">网格整理</button>
      <button
        class="primary"
        :disabled="!selectionCount || batchRunning"
        @click="runBatchNodes()"
      >
        {{ batchRunning ? "批量进行中…" : "运行选中" }}
      </button>
      <button v-if="batchRunning" @click="cancelBatch">取消</button>
    </div>

    <!-- 画布右下：缩放百分比徽章（在 Controls 上方） -->
    <div class="canvas-zoom-badge">
      <span>{{ zoomPct }}</span>
    </div>
  </div>
</template>
