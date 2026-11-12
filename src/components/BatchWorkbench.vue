<script setup>
// 全自动批量工作台（批量文件夹出图）
//
// 视觉与信息架构的唯一标准：prototypes/batch-workbench.html
//   左「素材来源」/ 中「全自动流水线」/ 右「预览与结果」+ 底部运行条 + 磨砂玻璃对比浮层
//
// 边界：
//   · 只做前端。后端接口按约定契约（见 src/api-batch.js 顶部注释），不改字段名
//   · 目录选择：Electron 33 的 File.path 已被移除，且渲染进程没桥接 webUtils，
//     所以「选择文件夹」只能拿到相对路径；拿不到绝对路径时退化为手填/粘贴路径 + 扫描。
//     一旦主进程以后桥接 window.desktop.getPathForFile，这里会自动接上（feature-detect）。
//   · 轮询：运行中 1.2s / 其余 3s，卸载清理；连续失败 5 次停表并把「刷新」露出来
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { store, IMAGE_MODELS, RESOLUTIONS, modelById, costOfModel, resolveSize } from "../store.js";
import { fetchMaterials } from "../api.js";
import {
  scanBatchDir,
  startBatch as apiStartBatch,
  fetchBatchState,
  pauseBatch,
  resumeBatch,
  cancelBatch,
  batchThumbUrl
} from "../api-batch.js";
import GlassCompare from "./GlassCompare.vue";

// ---------- 常量 ----------
const VAR_TOKENS = ["{文件名}", "{序号}", "{子文件夹}", "{模特}", "{场景}"];
const PRESET_KEY = "ai-canvas:batch-preset-v2"; // v2：size 字段语义改成"分辨率档位"，旧预设作废
const MAX_THUMBS = 60; // 左栏缩略图渲染上限（几百张时不至于把 DOM 撑爆）
const MAX_ROWS = 80; // 右栏对比列表渲染上限
const POLL_RUNNING = 1200;
const POLL_IDLE = 3000;

// ---------- 素材目录 ----------
const dirInput = ref("");
const dirEl = ref(null);
const folderInput = ref(null);
const root = ref(""); // 服务端归一化后的根目录（缩略图 & 启动批次都用它）
const files = ref([]);
const groups = ref([]);
const scanning = ref(false);
const recursive = ref(true);
const groupFilter = ref("");
const dropHot = ref(false);
const scanMeta = reactive({ total: 0, skipped: 0, truncated: false });

const folderName = computed(() => baseName(root.value) || "素材文件夹");
const scopedFiles = computed(() =>
  groupFilter.value ? files.value.filter((f) => groupOf(f) === groupFilter.value) : files.value
);
const visibleThumbs = computed(() => scopedFiles.value.slice(0, MAX_THUMBS));

// ---------- 批次状态 ----------
const job = ref(null);
const pollingStopped = ref(false);
const lastError = ref("");

const jobItems = computed(() => (Array.isArray(job.value?.items) ? job.value.items : []));
const statusMap = computed(() => {
  const map = {};
  for (const it of jobItems.value) map[it.rel] = it;
  return map;
});

// ---------- 参数 ----------
const params = reactive({
  promptTemplate: "把图中的衣服穿到{模特}身上，{场景}，柔和自然光，商业级成片，针织纹理清晰",
  model: store.imageModel,
  ratio: store.imageRatio,
  size: store.imageResolution,
  count: 1,
  refImages: [],
  outputDir: "",
  naming: "{原名}_{序号}",
  keepStructure: true,
  skipDone: true,
  concurrency: 2
});
const autoMode = ref(true);

const modelGroups = computed(() => {
  const map = new Map();
  for (const m of IMAGE_MODELS) {
    if (!map.has(m.group)) map.set(m.group, []);
    map.get(m.group).push(m);
  }
  return [...map.entries()].map(([label, models]) => ({ label, models }));
});
const modelLabel = computed(() => modelById(params.model).label);
const ratioOptions = computed(() => modelById(params.model).ratios || ["1:1"]);
const countOptions = computed(() => modelById(params.model).counts || [1]);

// 换模型时把「比例 / 张数」收进该模型支持的档位，避免提交后服务端拒绝
watch(
  () => params.model,
  () => {
    if (!ratioOptions.value.includes(params.ratio)) params.ratio = ratioOptions.value[0];
    if (!countOptions.value.includes(params.count)) params.count = countOptions.value[0];
  }
);

// ---------- 进度 / 统计 ----------
const stats = computed(() => {
  const j = job.value;
  if (j) {
    const total = Number(j.total) || 0;
    const done = Number(j.done) || 0;
    const failed = Number(j.failed) || 0;
    const running = Number(j.running) || 0;
    const pending = Number.isFinite(j.pending) ? Number(j.pending) : Math.max(0, total - done - failed - running);
    return { total, done, failed, running, pending };
  }
  const s = { total: scopedFiles.value.length, done: 0, failed: 0, running: 0, pending: 0 };
  for (const f of scopedFiles.value) {
    const st = statusMap.value[f.rel]?.status || "pending";
    if (st === "done") s.done += 1;
    else if (st === "error") s.failed += 1;
    else if (st === "running") s.running += 1;
    else s.pending += 1;
  }
  return s;
});

const pct = computed(() => {
  const { done, total } = stats.value;
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
});

/** 预计剩余：用已完成项的平均耗时 × 剩余张数 ÷ 并发数（不猜服务端内部排队） */
const etaText = computed(() => {
  const items = jobItems.value.filter((i) => i.status === "done" && Number(i.ms) > 0);
  const remain = stats.value.total - stats.value.done - stats.value.failed;
  if (!items.length || remain <= 0) return "—";
  const avg = items.reduce((a, b) => a + Number(b.ms || 0), 0) / items.length;
  const conc = Math.max(1, Number(job.value?.params?.concurrency) || Number(params.concurrency) || 1);
  const sec = (avg * remain) / conc / 1000;
  if (sec < 60) return `${Math.max(1, Math.ceil(sec))} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} 分 ${s} 秒` : `${m} 分`;
});

const rateText = computed(() => {
  const items = jobItems.value.filter((i) => i.status === "done" && Number(i.ms) > 0);
  if (!items.length) return "";
  const avg = items.reduce((a, b) => a + Number(b.ms || 0), 0) / items.length;
  const conc = Math.max(1, Number(job.value?.params?.concurrency) || Number(params.concurrency) || 1);
  const perMin = avg > 0 ? (60000 / avg) * conc : 0;
  return perMin ? `${perMin.toFixed(1)} 张/分钟` : "";
});

const estimateCost = computed(() => {
  const n = scopedFiles.value.length || stats.value.total || 0;
  return n * costOfModel(params.model);
});

// ---------- 右栏视图 / 对比浮层 ----------
const rightMode = ref("compare"); // compare | result
const glassOpen = ref(false);
const glassIndex = ref(0);

const rows = computed(() => {
  if (!jobItems.value.length) return [];
  const byRel = new Map(files.value.map((f) => [f.rel, f]));
  return jobItems.value.map((it) => {
    const f = byRel.get(it.rel);
    return {
      rel: it.rel,
      name: f?.name || baseName(it.rel),
      group: f ? groupOf(f) : "",
      status: it.status || "pending",
      ms: Number(it.ms) || 0,
      error: it.error || "",
      outputs: Array.isArray(it.outputs) ? it.outputs : [],
      before: root.value ? batchThumbUrl(root.value, it.rel) : ""
    };
  });
});

const visibleRows = computed(() => rows.value.slice(0, MAX_ROWS));
const resultRows = computed(() => rows.value.filter((r) => r.outputs.length));

const glassItems = computed(() =>
  rows.value
    .filter((r) => r.outputs.length)
    .map((r) => ({
      rel: r.rel,
      name: r.name,
      before: r.before,
      after: r.outputs[0]?.url || "",
      named: r.outputs[0]?.named || "",
      ms: r.ms,
      status: r.status,
      meta: `${jobModelLabel.value} · ${jobRatio.value} · ${jobCount.value} 张${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ""}`
    }))
);

const jobModelLabel = computed(() => modelById(job.value?.params?.model || params.model).label);
const jobRatio = computed(() => job.value?.params?.ratio || params.ratio);
const jobCount = computed(() => job.value?.params?.count ?? params.count);

watch(
  () => glassItems.value.length,
  (n) => {
    if (glassIndex.value > n - 1) glassIndex.value = Math.max(0, n - 1);
  }
);

// ---------- 目录选择 ----------
function baseName(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function toWin(p) {
  return String(p || "").replace(/\//g, "\\");
}

function dirname(p) {
  const s = toWin(p).replace(/\\+$/, "");
  const i = s.lastIndexOf("\\");
  return i > 0 ? s.slice(0, i) : s;
}

/** 单个 File 的绝对路径：老 Electron 有 File.path；新版本需要主进程桥接 webUtils */
function absolutePathOf(file) {
  if (!file) return "";
  const direct = String(file.path || "");
  if (direct) return direct;
  try {
    const bridge = typeof window !== "undefined" ? window.desktop : null;
    if (bridge && typeof bridge.getPathForFile === "function") {
      return String(bridge.getPathForFile(file) || "");
    }
  } catch {
    /* 桥接抛错就当拿不到 */
  }
  return "";
}

/**
 * 由所选文件反推「所选文件夹」的绝对路径。
 * webkitdirectory 会给出 webkitRelativePath = "所选文件夹/子目录/文件名"，
 * 用「首个文件的绝对路径 - 这段相对路径」正好剩下来所选文件夹的绝对路径。
 */
function folderFromFileList(list) {
  const file = list && list[0];
  if (!file) return "";
  const abs = toWin(absolutePathOf(file));
  const rel = toWin(file.webkitRelativePath || "");
  if (abs && rel && abs.toLowerCase().endsWith(rel.toLowerCase())) {
    const dir = abs.slice(0, abs.length - rel.length).replace(/\\+$/, "");
    if (dir) return dir;
  }
  return abs ? dirname(abs) : "";
}

function focusDir() {
  nextTick(() => dirEl.value?.focus?.());
}

function pickFolder() {
  folderInput.value?.click?.();
}

async function onFolderPicked(e) {
  const list = Array.from(e.target?.files || []);
  if (e.target) e.target.value = ""; // 允许连续选同一个文件夹
  if (!list.length) return;
  const guess = folderFromFileList(list);
  if (guess) {
    dirInput.value = guess;
    await onScan();
    return;
  }
  const top = String(list[0].webkitRelativePath || "").split("/")[0];
  if (!dirInput.value && top) dirInput.value = top;
  ElMessage.warning(
    `已读到 ${list.length} 个文件，但当前窗口拿不到「${top || "所选文件夹"}」的完整路径。请把文件夹路径粘贴到下面的输入框（例如 E:\\出图\\春装）再点「扫描」。`
  );
  focusDir();
}

function onDrop(e) {
  dropHot.value = false;
  const list = Array.from(e.dataTransfer?.files || []);
  if (!list.length) {
    ElMessage.info("没读到文件。拖「文件夹」进来时请改用手填路径（Electron 新版不把文件夹路径交给渲染进程），或直接点「选择文件夹」。");
    return;
  }
  const guess = folderFromFileList(list);
  if (guess) {
    dirInput.value = guess;
    onScan();
    return;
  }
  ElMessage.warning("拖进来的文件没有绝对路径，无法直接扫描。请把文件夹路径粘贴到下面的输入框再点「扫描」。");
  focusDir();
}

// ---------- 扫描 ----------
async function onScan() {
  const dir = dirInput.value.trim();
  if (!dir) {
    ElMessage.warning("先选择或粘贴素材文件夹的绝对路径");
    focusDir();
    return;
  }
  if (scanning.value) return;
  scanning.value = true;
  lastError.value = "";
  try {
    const body = await scanBatchDir(dir, recursive.value);
    root.value = body.root || dir;
    dirInput.value = root.value;
    files.value = (body.files || []).map((f) => ({
      ...f,
      name: f.name || baseName(f.rel),
      group: f.group || groupOf(f)
    }));
    groups.value = Array.isArray(body.groups) ? body.groups : [];
    scanMeta.total = Number(body.total) || files.value.length;
    scanMeta.skipped = Number(body.skipped) || 0;
    scanMeta.truncated = Boolean(body.truncated);
    groupFilter.value = "";

    if (!files.value.length) {
      ElMessage.warning("这个文件夹里没找到图片（支持 jpg / png / webp / bmp）");
    } else {
      ElMessage.success(
        `扫描到 ${files.value.length} 张图片${groups.value.length ? ` · ${groups.value.length} 个分组` : ""}${
          scanMeta.skipped ? ` · 跳过 ${scanMeta.skipped} 个非图片` : ""
        }`
      );
    }
    if (scanMeta.truncated) {
      ElMessage.warning("文件太多，服务端只返回了一部分；本批只处理列出来的这些。");
    }
    await refreshState({ silent: true });
  } catch (e) {
    lastError.value = e?.message || "";
    ElMessage.error(e?.message || "扫描失败");
  } finally {
    scanning.value = false;
  }
}

function groupOf(f) {
  if (f?.group) return f.group;
  const rel = String(f?.rel || "").replace(/\\/g, "/");
  const i = rel.lastIndexOf("/");
  return i > 0 ? rel.slice(0, i) : "";
}

// ---------- 轮询 ----------
let timer = null;
let disposed = false;
let failures = 0;

function applyState(nextJob) {
  job.value = nextJob || null;
}

async function refreshState({ silent = false } = {}) {
  try {
    const body = await fetchBatchState();
    applyState(body.job);
    failures = 0;
    lastError.value = "";
    if (pollingStopped.value) {
      pollingStopped.value = false;
      schedulePoll();
    }
    return body.job;
  } catch (e) {
    if (!silent) {
      lastError.value = e?.message || "";
      ElMessage.error(e?.message || "读取批量进度失败");
    }
    throw e;
  }
}

function schedulePoll() {
  if (disposed) return;
  clearTimeout(timer);
  const running = job.value?.state === "running";
  timer = setTimeout(pollTick, running ? POLL_RUNNING : POLL_IDLE);
}

async function pollTick() {
  if (disposed) return;
  try {
    const body = await fetchBatchState();
    applyState(body.job);
    failures = 0;
    lastError.value = "";
  } catch (e) {
    failures += 1;
    lastError.value = e?.message || "";
    if (failures === 1) {
      ElMessage.error(e?.message || "读取批量进度失败");
    } else if (failures >= 5) {
      pollingStopped.value = true;
      ElMessage.warning("批量进度连续读取失败，已暂停自动刷新。修好连接后点「刷新进度」再继续。");
      return; // 不再排下一轮，避免刷屏
    }
  }
  if (!pollingStopped.value) schedulePoll();
}

function resumePolling() {
  pollingStopped.value = false;
  failures = 0;
  pollTick();
}

// ---------- 参考素材 ----------
const matLoading = ref(false);
const matOpen = ref(false);
const matDirty = ref(false);

const materialGroups = computed(() => {
  const cats = store.materials?.categories || [];
  return cats
    .map((c) => ({
      id: c.id,
      label: c.label || c.id,
      images: (c.files || []).filter(
        (f) => f.kind === "image" || /\.(png|jpe?g|webp|bmp|gif)$/i.test(String(f.url || ""))
      )
    }))
    .filter((g) => g.images.length);
});

const allMaterialImages = computed(() => materialGroups.value.flatMap((g) => g.images));

async function ensureMaterials() {
  if (matLoading.value) return;
  if (materialGroups.value.length) return;
  matLoading.value = true;
  try {
    const data = await fetchMaterials();
    if (data?.categories) store.materials = data;
  } catch {
    // 素材库不可用不阻塞批量：参考图本来就是可选项
  } finally {
    matLoading.value = false;
    matDirty.value = true;
  }
}

function categoryOn(g) {
  return g.images.length > 0 && g.images.every((i) => params.refImages.includes(i.url));
}

function toggleCategory(g) {
  const urls = g.images.map((i) => i.url);
  if (categoryOn(g)) {
    params.refImages = params.refImages.filter((u) => !urls.includes(u));
  } else {
    params.refImages = [...new Set([...params.refImages, ...urls])];
  }
}

function toggleRef(url) {
  if (params.refImages.includes(url)) {
    params.refImages = params.refImages.filter((u) => u !== url);
  } else {
    params.refImages = [...params.refImages, url];
  }
}

function removeRef(url) {
  params.refImages = params.refImages.filter((u) => u !== url);
}

function openMaterialPicker() {
  matOpen.value = true;
  void ensureMaterials();
}

// ---------- 提示词变量 ----------
const promptEl = ref(null);

function insertVar(token) {
  const ta = promptEl.value;
  const text = params.promptTemplate;
  if (!ta) {
    params.promptTemplate = text + token;
    return;
  }
  const start = Number.isFinite(ta.selectionStart) ? ta.selectionStart : text.length;
  const end = Number.isFinite(ta.selectionEnd) ? ta.selectionEnd : start;
  params.promptTemplate = text.slice(0, start) + token + text.slice(end);
  nextTick(() => {
    ta.focus();
    const pos = start + token.length;
    try {
      ta.setSelectionRange(pos, pos);
    } catch {
      /* 极端情况下（输入框被重建）忽略 */
    }
  });
}

// ---------- 自动匹配预览 ----------
const previewRows = computed(() => {
  const list = scopedFiles.value.slice(0, 3);
  return list.map((f, i) => {
    const ref = params.refImages.length ? params.refImages[i % params.refImages.length] : "";
    return {
      rel: f.rel,
      name: f.name || baseName(f.rel),
      ref: ref ? baseName(ref) : "无参考图",
      refIndex: ref ? (i % params.refImages.length) + 1 : 0,
      out: previewNaming(f, i)
    };
  });
});

function previewNaming(f, i) {
  const raw = String(f.name || baseName(f.rel));
  const ext = (raw.match(/\.([a-z0-9]{1,6})$/i) || [])[1] || "";
  const base = ext ? raw.slice(0, -(ext.length + 1)) : raw;
  const map = {
    "{文件名}": raw,
    "{原名}": base,
    "{序号}": String(i + 1),
    "{子文件夹}": groupOf(f),
    "{模特}": params.refImages.length ? `参考${(i % params.refImages.length) + 1}` : "模特",
    "{场景}": "场景"
  };
  let out = params.naming || "{原名}_{序号}";
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  // 模板里没写扩展名就补原扩展名，避免用户看到「A_1」不知道最终是什么文件
  if (!/\.[a-z0-9]{1,6}$/i.test(out) && ext) out = `${out}.${ext}`;
  return out;
}

// ---------- 启动 / 暂停 / 续跑 / 取消 ----------
const busy = ref(false);
const starting = ref(false);

const stateLabel = computed(() => {
  const s = job.value?.state;
  if (s === "running") return "运行中";
  if (s === "paused") return "已暂停";
  if (s === "done") return "已完成";
  if (s === "cancelled") return "已取消";
  return "待开始";
});

const primaryLabel = computed(() => {
  const s = job.value?.state;
  if (s === "running") return "暂停";
  if (s === "paused") return "继续";
  if (s === "done") return "再跑一批";
  if (s === "cancelled") return "重新开始";
  const n = scopedFiles.value.length;
  if (!n) return "开始全自动";
  const remain = stats.value.total - stats.value.done - stats.value.failed;
  if (params.skipDone && stats.value.done > 0) return `开始全自动 · 续跑剩余 ${Math.max(0, remain)} 张`;
  return `开始全自动 · ${n} 张`;
});

function toggleAuto() {
  autoMode.value = !autoMode.value;
  if (autoMode.value) {
    // 全自动 = 按子文件夹分组输出 + 跳过已完成 + 默认命名，省得用户逐项设
    params.keepStructure = true;
    params.skipDone = true;
    if (!params.naming) params.naming = "{原名}_{序号}";
  }
}

async function onPrimary() {
  const s = job.value?.state;
  if (s === "running") return onPause();
  if (s === "paused") return onResume();
  return onStart();
}

/**
 * 最终送给 /api/generate 的像素尺寸。
 *
 * 三种输入都要能吃下：
 *   · "2K" / "4K"        —— 分辨率档位（正常路径），按比例换算
 *   · "2048x1536"        —— 已经是像素（旧预设里存过），原样用
 *   · 其它/空             —— 退 2048 长边，别让整批因为一个字段失败
 */
function pickSize() {
  const raw = String(params.size || "").trim();
  if (/^\d{2,4}x\d{2,4}$/.test(raw)) return raw;
  return resolveSize(raw || "2K", params.ratio);
}
async function onStart() {
  if (busy.value || starting.value) return;
  if (!root.value) {
    ElMessage.warning("还没有可用的素材文件夹：选好文件夹或粘贴路径后先点「扫描」");
    focusDir();
    return;
  }
  const list = scopedFiles.value;
  if (!list.length) {
    ElMessage.warning("当前范围里没有可处理的图片");
    return;
  }
  const prompt = params.promptTemplate.trim();
  if (!prompt) {
    ElMessage.warning("先写一句提示词模板，例如「把衣服穿到{模特}身上」");
    return;
  }

  starting.value = true;
  try {
    const body = await apiStartBatch({
      dir: root.value,
      files: list.map((f) => f.rel),
      params: {
        promptTemplate: prompt,
        model: params.model,
        ratio: params.ratio,
        // /api/generate 要像素（2048x1536），不是"2K"档位名；统一用全局 resolveSize 换算
        size: pickSize(),
        count: Number(params.count) || 1,
        refImages: params.refImages.slice(),
        outputDir: params.outputDir.trim() || undefined,
        naming: params.naming.trim() || undefined,
        keepStructure: Boolean(params.keepStructure),
        skipDone: Boolean(params.skipDone),
        concurrency: Number(params.concurrency) || 1
      }
    });
    applyState(body.job || null);
    ElMessage.success(`已开始全自动：本次 ${body.job?.total ?? list.length} 张`);
    // start 只回 {id,total,state}，立刻拉一次完整状态，右侧进度才不会是空的
    await refreshState({ silent: true }).catch(() => {});
    failures = 0;
    pollingStopped.value = false;
    schedulePoll();
  } catch (e) {
    ElMessage.error(e?.message || "启动批量失败");
  } finally {
    starting.value = false;
  }
}

async function onPause() {
  if (busy.value) return;
  busy.value = true;
  try {
    const body = await pauseBatch();
    if (body.job) applyState(body.job);
    ElMessage.success("已暂停，可以随时继续");
    schedulePoll();
  } catch (e) {
    ElMessage.error(e?.message || "暂停失败");
  } finally {
    busy.value = false;
  }
}

async function onResume() {
  if (busy.value) return;
  busy.value = true;
  try {
    const body = await resumeBatch();
    if (body.job) applyState(body.job);
    ElMessage.success("已继续");
    pollingStopped.value = false;
    schedulePoll();
  } catch (e) {
    ElMessage.error(e?.message || "继续失败");
  } finally {
    busy.value = false;
  }
}

async function onCancel() {
  if (busy.value) return;
  try {
    await ElMessageBox.confirm(
      "取消后本批还没跑的图不会继续，已生成的图会留在输出目录里。确定取消吗？",
      "取消这一批",
      { confirmButtonText: "取消这一批", cancelButtonText: "继续跑", type: "warning" }
    );
  } catch {
    return; // 用户点了「继续跑」
  }
  busy.value = true;
  try {
    const body = await cancelBatch();
    if (body.job) applyState(body.job);
    ElMessage.success("已取消");
    schedulePoll();
  } catch (e) {
    ElMessage.error(e?.message || "取消失败");
  } finally {
    busy.value = false;
  }
}

// ---------- 结果 / 下载 ----------
function openGlass(rel) {
  if (!glassItems.value.length) {
    ElMessage.info("还没有已完成的结果，等第一张跑完再看对比");
    return;
  }
  const i = glassItems.value.findIndex((x) => x.rel === rel);
  glassIndex.value = i >= 0 ? i : 0;
  glassOpen.value = true;
}

function openRow(row) {
  if (row.status === "error") {
    ElMessage.error(`这张失败了：${row.error || "服务端没有给出原因"}`);
    return;
  }
  if (!row.outputs.length) {
    ElMessage.info(`「${row.name}」还没有结果`);
    return;
  }
  openGlass(row.rel);
}

function openLargeCompare() {
  if (!resultRows.value.length) {
    ElMessage.info("还没有已完成的结果");
    return;
  }
  openGlass(resultRows.value[0].rel);
}

function triggerDownload(url, name) {
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  if (name) a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function onDownloadOne(item) {
  if (!item?.after) return;
  triggerDownload(item.after, item.named || item.name);
}

async function onDownloadAll() {
  const list = glassItems.value;
  if (!list.length) {
    ElMessage.warning("还没有已完成的结果可以下载");
    return;
  }
  ElMessage.info(`开始下载 ${list.length} 张…`);
  for (const it of list) {
    triggerDownload(it.after, it.named || it.name);
    await new Promise((r) => setTimeout(r, 160));
  }
}

function onRetryOne(item) {
  ElMessage.info(
    `「${item?.name || "这张"}」的单张重跑还没接后端：可以先"取消"，再打开「跳过已完成」重新开始 —— 只会补跑没完成的那些。`
  );
}

// ---------- 预设 ----------
function savePreset() {
  try {
    localStorage.setItem(
      PRESET_KEY,
      JSON.stringify({
        params: {
          promptTemplate: params.promptTemplate,
          model: params.model,
          ratio: params.ratio,
          size: pickSize(),
          count: params.count,
          refImages: params.refImages.slice(),
          outputDir: params.outputDir,
          naming: params.naming,
          keepStructure: params.keepStructure,
          skipDone: params.skipDone,
          concurrency: params.concurrency
        },
        autoMode: autoMode.value
      })
    );
    ElMessage.success("已存为预设，下次进批量工作台会自动带出来");
  } catch {
    ElMessage.error("预设保存失败：本地存储不可用");
  }
}

function restorePreset() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(PRESET_KEY) || "null");
  } catch {
    saved = null;
  }
  if (!saved || typeof saved !== "object") return;
  const p = saved.params || {};
  for (const key of Object.keys(params)) {
    if (key in p && p[key] != null) params[key] = p[key];
  }
  if (Array.isArray(p.refImages)) params.refImages = p.refImages.slice();
  if (typeof saved.autoMode === "boolean") autoMode.value = saved.autoMode;
  // 预设里可能有已经下线的模型 id，回落到当前全局模型，避免下拉框空白
  if (!IMAGE_MODELS.some((m) => m.id === params.model)) params.model = store.imageModel;
}

// ---------- 生命周期 ----------
onMounted(async () => {
  restorePreset();
  schedulePoll();
  await pollTick();
  void ensureMaterials();
});

onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
</script>

<template>
  <div class="bw">
    <input
      ref="folderInput"
      class="bw-hidden"
      type="file"
      webkitdirectory
      directory
      multiple
      @change="onFolderPicked"
    />

    <div class="bw-workspace">
      <!-- ==================== 左：素材来源 ==================== -->
      <section class="bw-col bw-col-left">
        <div class="bw-card">
          <header class="bw-card-hd">
            <span class="bw-hd-title">素材来源</span>
            <span class="bw-hd-sub">拖文件夹进来就行</span>
            <span class="bw-hd-right">
              <button
                type="button"
                class="bw-icon-btn"
                title="重新扫描"
                :disabled="!dirInput || scanning"
                @click="onScan"
              >
                <el-icon><Refresh /></el-icon>
              </button>
            </span>
          </header>

          <div class="bw-card-bd">
            <div
              class="bw-drop"
              :class="{ hot: dropHot }"
              @click="pickFolder"
              @dragover.prevent="dropHot = true"
              @dragleave="dropHot = false"
              @drop.prevent="onDrop"
            >
              <div class="bw-drop-icon"><el-icon><Plus /></el-icon></div>
              <div class="bw-drop-title">把文件夹 / 多张图片拖到这里</div>
              <div class="bw-drop-sub">
                自动扫描子文件夹 · 自动跳过非图片<br />
                参考图在批次内按顺序轮换
              </div>
              <div class="bw-drop-actions" @click.stop>
                <button type="button" class="bw-btn lime" @click="pickFolder">选择文件夹</button>
                <button type="button" class="bw-btn ghost" @click="focusDir">粘贴路径</button>
              </div>
            </div>

            <div class="bw-dirbar">
              <input
                ref="dirEl"
                v-model="dirInput"
                class="bw-input"
                placeholder="E:\出图\春装（也可以直接粘贴文件夹路径）"
                spellcheck="false"
                @keyup.enter="onScan"
              />
              <button type="button" class="bw-btn" :disabled="scanning" @click="onScan">
                <el-icon v-if="!scanning"><Search /></el-icon>
                <el-icon v-else class="bw-spin"><Loading /></el-icon>
                <span>{{ scanning ? "扫描中" : "扫描" }}</span>
              </button>
            </div>
            <label class="bw-check">
              <input v-model="recursive" type="checkbox" />
              包含子文件夹
              <span v-if="scanMeta.skipped" class="bw-check-note">已跳过 {{ scanMeta.skipped }} 个非图片</span>
            </label>

            <div v-if="groups.length" class="bw-tree">
              <button type="button" class="bw-folder" :class="{ on: !groupFilter }" @click="groupFilter = ''">
                <el-icon><FolderOpened /></el-icon>
                <span class="bw-folder-name">{{ folderName }}</span>
                <span class="bw-folder-cnt">{{ files.length }}</span>
              </button>
              <button
                v-for="g in groups"
                :key="g.name"
                type="button"
                class="bw-folder sub"
                :class="{ on: groupFilter === g.name }"
                :title="`只跑「${g.name || '根目录'}」`"
                @click="groupFilter = g.name"
              >
                <el-icon><Folder /></el-icon>
                <span class="bw-folder-name">{{ g.name || "根目录" }}</span>
                <span class="bw-folder-cnt">{{ g.count }}</span>
              </button>
            </div>

            <div v-if="visibleThumbs.length" class="bw-thumbs">
              <div
                v-for="f in visibleThumbs"
                :key="f.rel"
                class="bw-thumb"
                :class="`is-${statusMap[f.rel]?.status || 'pending'}`"
                :title="`${f.name}\n${f.rel}`"
              >
                <img
                  v-if="root"
                  :src="batchThumbUrl(root, f.rel)"
                  :alt="f.name"
                  loading="lazy"
                  @error="(e) => e.target.classList.add('is-broken')"
                />
                <div v-else class="bw-thumb-fallback">{{ (f.ext || "img").toUpperCase() }}</div>
                <span class="bw-thumb-st">
                  <el-icon v-if="statusMap[f.rel]?.status === 'done'"><Check /></el-icon>
                  <el-icon v-else-if="statusMap[f.rel]?.status === 'running'" class="bw-spin"><Loading /></el-icon>
                  <el-icon v-else-if="statusMap[f.rel]?.status === 'error'"><Close /></el-icon>
                  <template v-else>{{ scopedFiles.indexOf(f) + 1 }}</template>
                </span>
              </div>
            </div>
            <p v-if="scopedFiles.length > MAX_THUMBS" class="bw-hint">
              仅显示前 {{ MAX_THUMBS }} 张（共 {{ scopedFiles.length }} 张），不影响成批处理。
            </p>

            <div v-if="files.length || job" class="bw-stats">
              <span class="ok">完成 <b>{{ stats.done }}</b></span>
              <span class="run">进行 <b>{{ stats.running }}</b></span>
              <span>待处理 <b>{{ stats.pending }}</b></span>
              <span class="err">失败 <b>{{ stats.failed }}</b></span>
            </div>
            <p v-else class="bw-empty">
              还没有素材。选择文件夹（或在上面粘贴绝对路径）后点「扫描」，这里会按子文件夹分组列出来。
            </p>
          </div>
        </div>
      </section>

      <!-- ==================== 中：全自动流水线 ==================== -->
      <section class="bw-col bw-col-mid">
        <div class="bw-card">
          <header class="bw-card-hd">
            <span class="bw-hd-title">全自动流水线</span>
            <span class="bw-hd-sub">一次设定，整批跑完</span>
            <span class="bw-hd-right">
              <button type="button" class="bw-btn ghost" @click="savePreset">
                <el-icon><Collection /></el-icon>
                存为预设
              </button>
            </span>
          </header>

          <div class="bw-card-bd">
            <div class="bw-auto">
              <div class="bw-auto-txt">
                <b>全自动</b>：统一模型与参数、参考图轮换、按子文件夹分组输出，跑完自动停在结果上
              </div>
              <button
                type="button"
                class="bw-switch"
                :class="{ on: autoMode }"
                role="switch"
                :aria-checked="autoMode"
                title="全自动"
                @click="toggleAuto"
              />
            </div>

            <div class="bw-pipeline">
              <!-- 1. 参考素材 -->
              <div class="bw-step" :class="{ on: params.refImages.length > 0 }">
                <div class="bw-step-hd">
                  <span class="bw-step-no">1</span>
                  <span class="bw-step-title">参考素材</span>
                  <span class="bw-step-note">
                    {{ params.refImages.length ? `${params.refImages.length} 张 · 批次内轮换` : "可选 · 不选就是纯文生图" }}
                  </span>
                </div>
                <div class="bw-step-bd">
                  <div class="bw-row">
                    <button
                      v-for="g in materialGroups"
                      :key="g.id"
                      type="button"
                      class="bw-chip"
                      :class="{ on: categoryOn(g) }"
                      @click="toggleCategory(g)"
                    >
                      {{ g.label }} · {{ g.images.length }} 张
                      <span v-if="categoryOn(g)" class="bw-badge">轮换</span>
                    </button>
                    <button type="button" class="bw-chip" @click="openMaterialPicker">
                      <el-icon><Plus /></el-icon>
                      添加
                    </button>
                    <span v-if="!materialGroups.length" class="bw-chip-note">
                      {{ matLoading ? "素材库读取中…" : "素材库里还没有图片" }}
                    </span>
                  </div>

                  <div v-if="params.refImages.length" class="bw-refs">
                    <div v-for="(url, i) in params.refImages" :key="url" class="bw-ref" :title="url">
                      <img :src="url" alt="" />
                      <button type="button" class="bw-ref-x" title="移出" @click="removeRef(url)">
                        <el-icon><Close /></el-icon>
                      </button>
                      <span class="bw-ref-n">{{ i + 1 }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 2. 提示词模板 -->
              <div class="bw-step" :class="{ on: params.promptTemplate.trim().length > 0 }">
                <div class="bw-step-hd">
                  <span class="bw-step-no">2</span>
                  <span class="bw-step-title">提示词模板</span>
                  <span class="bw-step-note">变量会自动替换</span>
                </div>
                <div class="bw-step-bd">
                  <textarea
                    ref="promptEl"
                    v-model="params.promptTemplate"
                    class="bw-textarea"
                    rows="3"
                    placeholder="例如：把图中的衣服穿到{模特}身上，{场景}，柔和自然光，商业级成片"
                  />
                  <div class="bw-vars">
                    <button
                      v-for="t in VAR_TOKENS"
                      :key="t"
                      type="button"
                      class="bw-var"
                      :title="`插入 ${t}`"
                      @click="insertVar(t)"
                    >
                      {{ t }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- 3. 模型与参数 -->
              <div class="bw-step" :class="{ on: Boolean(params.model) }">
                <div class="bw-step-hd">
                  <span class="bw-step-no">3</span>
                  <span class="bw-step-title">模型与参数</span>
                  <span class="bw-step-note">全批统一</span>
                </div>
                <div class="bw-step-bd">
                  <div class="bw-row">
                    <el-select v-model="params.model" class="bw-select bw-select-model" size="small" popper-class="bw-select-pop">
                      <el-option-group v-for="g in modelGroups" :key="g.label" :label="g.label">
                        <el-option v-for="m in g.models" :key="m.id" :label="m.label" :value="m.id" />
                      </el-option-group>
                    </el-select>
                    <el-select v-model="params.count" class="bw-select bw-select-sm" size="small" popper-class="bw-select-pop">
                      <el-option v-for="c in countOptions" :key="c" :label="`${c} 张`" :value="c" />
                    </el-select>
                    <el-select v-model="params.ratio" class="bw-select bw-select-sm" size="small" popper-class="bw-select-pop">
                      <el-option v-for="r in ratioOptions" :key="r" :label="r" :value="r" />
                    </el-select>
                    <el-select v-model="params.size" class="bw-select bw-select-sm" size="small" popper-class="bw-select-pop">
                      <el-option v-for="r in RESOLUTIONS" :key="r" :label="r" :value="r" />
                    </el-select>
                  </div>
                  <p class="bw-step-hint">
                    单价 {{ costOfModel(params.model) }} 算力/次 · 本批估算
                    <b>{{ estimateCost }}</b> 算力
                  </p>
                </div>
              </div>

              <!-- 4. 输出与命名 -->
              <div class="bw-step" :class="{ on: Boolean(params.naming) }">
                <div class="bw-step-hd">
                  <span class="bw-step-no">4</span>
                  <span class="bw-step-title">输出与命名</span>
                  <span class="bw-step-note">{{ params.keepStructure ? "保持子文件夹结构" : "全部平铺到输出目录" }}</span>
                </div>
                <div class="bw-step-bd">
                  <div class="bw-row">
                    <label class="bw-field">
                      <span class="bw-field-label">命名</span>
                      <input v-model="params.naming" class="bw-input" placeholder="{原名}_{序号}" spellcheck="false" />
                    </label>
                    <label class="bw-field">
                      <span class="bw-field-label">并发</span>
                      <el-select v-model="params.concurrency" class="bw-select bw-select-sm" size="small" popper-class="bw-select-pop">
                        <el-option v-for="n in [1, 2, 3, 4]" :key="n" :label="`${n} 路`" :value="n" />
                      </el-select>
                    </label>
                  </div>
                  <label class="bw-field bw-field-wide">
                    <span class="bw-field-label">输出目录</span>
                    <input
                      v-model="params.outputDir"
                      class="bw-input"
                      placeholder="留空 = 默认 outputs/batch-<批次号>"
                      spellcheck="false"
                    />
                  </label>
                  <div class="bw-row bw-toggles">
                    <label class="bw-check">
                      <input v-model="params.keepStructure" type="checkbox" />
                      保留原文件夹结构
                    </label>
                    <label class="bw-check">
                      <input v-model="params.skipDone" type="checkbox" />
                      跳过已完成
                    </label>
                  </div>
                </div>
              </div>

              <!-- 自动匹配预览 -->
              <div class="bw-step bw-step-preview">
                <div class="bw-step-hd">
                  <span class="bw-step-no info">i</span>
                  <span class="bw-step-title">自动匹配预览</span>
                  <span class="bw-step-note">前 3 张 · 跑之前先看规则对不对</span>
                </div>
                <div class="bw-step-bd">
                  <div v-if="!previewRows.length" class="bw-hint">扫描到素材后，这里会用本地规则推演命名与参考图配对。</div>
                  <div v-for="p in previewRows" :key="p.rel" class="bw-match">
                    <span class="bw-match-in" :title="p.rel">{{ p.name }}</span>
                    <span class="bw-match-arrow">→</span>
                    <span class="bw-match-ref">
                      {{ p.refIndex ? `参考#${p.refIndex}` : "无参考图" }}
                      <span class="bw-match-refname">{{ p.ref }}</span>
                    </span>
                    <span class="bw-match-out" :title="p.out">{{ p.out }}</span>
                  </div>
                  <p class="bw-step-hint">
                    参考图为本地推算（按顺序轮换）。真正的替换与配对以服务端为准。
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ==================== 右：预览与结果 ==================== -->
      <section class="bw-col bw-col-right">
        <div class="bw-card">
          <header class="bw-card-hd">
            <span class="bw-hd-title">预览与结果</span>
            <span class="bw-hd-sub">原图 / 结果 对比</span>
            <span class="bw-hd-right">
              <button type="button" class="bw-icon-btn" title="下载全部已完成" :disabled="!glassItems.length" @click="onDownloadAll">
                <el-icon><Download /></el-icon>
              </button>
              <button type="button" class="bw-icon-btn" title="打开大图对比" :disabled="!glassItems.length" @click="openLargeCompare">
                <el-icon><FullScreen /></el-icon>
              </button>
            </span>
          </header>

          <div class="bw-card-bd">
            <div class="bw-progress">
              <div class="bw-ring" :style="{ '--bw-pct': pct + '%' }">
                <i>{{ pct }}%</i>
              </div>
              <div class="bw-prog-meta">
                <div class="bw-prog-line">
                  <span class="bw-state" :class="`is-${job?.state || 'idle'}`">{{ stateLabel }}</span>
                  <span>已完成 <b>{{ stats.done }}</b> / {{ stats.total || scopedFiles.length || 0 }}</span>
                </div>
                <div class="bw-prog-line">
                  失败 <b :class="{ danger: stats.failed > 0 }">{{ stats.failed }}</b>
                  · 预计还需 <b>{{ etaText }}</b>
                  <template v-if="rateText"> · {{ rateText }}</template>
                </div>
              </div>
            </div>

            <div class="bw-viewtabs">
              <button type="button" class="bw-viewtab" :class="{ on: rightMode === 'compare' }" @click="rightMode = 'compare'">
                对比列表
              </button>
              <button type="button" class="bw-viewtab" :class="{ on: rightMode === 'result' }" @click="rightMode = 'result'">
                只看结果
              </button>
              <button type="button" class="bw-viewtab" @click="openLargeCompare">大图对比</button>
            </div>

            <div v-if="!rows.length" class="bw-right-empty">
              <el-icon><PictureFilled /></el-icon>
              <p>扫描素材并开始后，这里会逐张显示「原图 | 结果」。</p>
            </div>

            <div v-else class="bw-pairs">
              <template v-if="rightMode === 'compare'">
                <button
                  v-for="row in visibleRows"
                  :key="row.rel"
                  type="button"
                  class="bw-pair"
                  :class="{ pending: !row.outputs.length && row.status !== 'error', failed: row.status === 'error' }"
                  @click="openRow(row)"
                >
                  <div class="bw-cell">
                    <span class="bw-tag">原图</span>
                    <img v-if="row.before" :src="row.before" alt="" loading="lazy" @error="(e) => e.target.classList.add('is-broken')" />
                    <div v-else class="bw-cell-ph">无预览</div>
                  </div>
                  <div class="bw-cell">
                    <span class="bw-tag result">结果</span>
                    <img
                      v-if="row.outputs.length"
                      :src="row.outputs[0].url"
                      alt=""
                      loading="lazy"
                      @error="(e) => e.target.classList.add('is-broken')"
                    />
                    <div v-else class="bw-cell-ph">
                      <template v-if="row.status === 'error'">失败</template>
                      <template v-else-if="row.status === 'running'">生成中…</template>
                      <template v-else>等待生成</template>
                    </div>
                  </div>
                  <div class="bw-pair-meta">
                    <span class="bw-pair-name" :title="row.rel">{{ row.name }}</span>
                    <!-- 失败时把原因直接摊在这里：只写"失败"用户不知道是没配密钥、
                         还是模型不支持参考图，只能逐张点开猜。 -->
                    <span
                      class="bw-pair-rt"
                      :class="{ 'is-error': row.status === 'error' }"
                      :title="row.error || ''"
                    >
                      <template v-if="row.status === 'error'">{{ row.error || "失败" }}</template>
                      <template v-else-if="row.ms">{{ (row.ms / 1000).toFixed(1) }}s</template>
                      <template v-else-if="row.status === 'running'">进行中</template>
                      <template v-else>排队中</template>
                    </span>
                  </div>
                </button>
              </template>

              <template v-else>
                <button
                  v-for="row in resultRows"
                  :key="row.rel"
                  type="button"
                  class="bw-single"
                  :title="row.name"
                  @click="openGlass(row.rel)"
                >
                  <img :src="row.outputs[0].url" alt="" loading="lazy" @error="(e) => e.target.classList.add('is-broken')" />
                  <span class="bw-single-meta">
                    <span class="bw-pair-name">{{ row.name }}</span>
                    <span class="bw-pair-rt">{{ row.ms ? (row.ms / 1000).toFixed(1) + "s" : "" }}</span>
                  </span>
                </button>
                <p v-if="!resultRows.length" class="bw-hint">还没有已完成的结果。</p>
              </template>
            </div>
            <p v-if="rows.length > MAX_ROWS" class="bw-hint">
              列表仅显示前 {{ MAX_ROWS }} 项（共 {{ rows.length }} 项），不影响后台继续跑。
            </p>
          </div>
        </div>
      </section>
    </div>

    <!-- ==================== 底部运行条 ==================== -->
    <div class="bw-runbar">
      <div class="bw-runbar-info">
        <span class="bw-runbar-title">批次 <b>{{ folderName }}</b></span>
        <span>· {{ scopedFiles.length || stats.total || 0 }} 张</span>
        <span>· 单张 {{ params.count }} 张图</span>
        <span>· 预计消耗 <b>{{ estimateCost }}</b> 算力</span>
        <span v-if="job?.current" class="bw-runbar-current" :title="job.current">
          · 正在跑 <b>{{ baseName(job.current) }}</b>
        </span>
        <span v-if="pollingStopped" class="bw-runbar-warn">
          · 进度刷新已暂停
          <button type="button" class="bw-link" @click="resumePolling">刷新进度</button>
        </span>
      </div>

      <div class="bw-runbar-actions">
        <button
          v-if="job?.state === 'running' || job?.state === 'paused'"
          type="button"
          class="bw-btn ghost"
          :disabled="busy"
          @click="onCancel"
        >
          取消
        </button>
        <button
          type="button"
          class="bw-btn lime bw-btn-primary"
          :disabled="busy || starting || scanning"
          @click="onPrimary"
        >
          <el-icon v-if="job?.state === 'running'"><VideoPause /></el-icon>
          <el-icon v-else-if="job?.state === 'paused'"><VideoPlay /></el-icon>
          <el-icon v-else><MagicStick /></el-icon>
          {{ starting ? "启动中…" : primaryLabel }}
        </button>
      </div>
    </div>

    <!-- 参考图选择（素材库） -->
    <el-dialog v-model="matOpen" title="从素材库挑参考图" width="720px" class="bw-mat-dialog">
      <div v-if="matLoading" class="bw-mat-loading">素材库读取中…</div>
      <div v-else-if="!allMaterialImages.length" class="bw-mat-empty">
        素材库里还没有图片。可以先把模特图 / 场景图上传到「素材库」，再回来这里轮换使用。
      </div>
      <div v-else class="bw-mat-grid">
        <button
          v-for="m in allMaterialImages"
          :key="m.url"
          type="button"
          class="bw-mat"
          :class="{ on: params.refImages.includes(m.url) }"
          :title="m.name"
          @click="toggleRef(m.url)"
        >
          <img :src="m.url" alt="" loading="lazy" />
          <span class="bw-mat-name">{{ m.name }}</span>
          <span v-if="params.refImages.includes(m.url)" class="bw-mat-check"><el-icon><Check /></el-icon></span>
        </button>
      </div>
      <template #footer>
        <div class="bw-mat-foot">
          <span class="bw-hint">已选 {{ params.refImages.length }} 张 · 批次内按顺序轮换</span>
          <button type="button" class="bw-btn lime" @click="matOpen = false">完成</button>
        </div>
      </template>
    </el-dialog>

    <GlassCompare
      :open="glassOpen"
      :items="glassItems"
      :index="glassIndex"
      @close="glassOpen = false"
      @update:index="(i) => (glassIndex = i)"
      @retry="onRetryOne"
      @download="onDownloadOne"
      @download-all="onDownloadAll"
    />
  </div>
</template>

<style scoped src="./batch-workbench.css"></style>
