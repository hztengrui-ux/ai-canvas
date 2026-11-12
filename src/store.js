import { reactive } from "vue";

let nextId = 1;

// ---------- 技能入口（左侧栏「技能」分组） ----------
// ⚠️ 2026-10-14 修复（8 个技能入口空转）：
// 这些入口以前只 `store.activeSkill = id; store.route = "studio"` —— 点了只是跳到
// 创作台，**不铺任何工作流**，用户面对一张空画布，期望直接落空。
// 现在给能对上已有工作流的技能接上 workflow（点一下就真铺出节点图）；
// 确实没有对应能力的（一键高清 / 局部编辑 / 买家秀）如实标 available:false，
// 界面置灰并说明原因，而不是让用户点了没反应。
// 详细口径见 `node src/__skills.test.mjs`。
export const SKILLS = [
  { id: "txt2img", label: "AI 文生图", desc: "输入描述，直接生成创意图片", icon: "MagicStick", workflow: "image-generate", available: true },
  { id: "replicate", label: "爆款复刻", desc: "复刻爆款风格，批量生成同款新图", icon: "CopyDocument", workflow: "style-reference", available: true },
  { id: "detail", label: "详情页制作", desc: "提炼卖点生成商品详情页", icon: "Document", workflow: "detail-page", available: true },
  { id: "template", label: "使用模板", desc: "复用成熟版式，快速产出成套图片", icon: "Grid", workflow: "image-replica", available: true },
  { id: "sketch", label: "画稿生图", desc: "从线稿或参考图生成渲染图", icon: "EditPen", workflow: "custom-scene", available: true },
  {
    id: "upscale",
    label: "一键高清",
    desc: "图片超分放大，细节增强",
    icon: "ZoomIn",
    workflow: "",
    available: false,
    reason: "超分模型尚未接入",
    // 「还没接入」不能只告诉用户"不行"，得给一条现在就能走的路。
    // 点进来看到原因 + 替代做法，比一个灰掉的死按钮有用得多。
    alternative: "在结果图工具条里点「本地 2× 放大」（不消耗算力）"
  },
  {
    id: "inpaint",
    label: "局部编辑",
    desc: "涂抹区域进行局部重绘",
    icon: "Brush",
    workflow: "",
    available: false,
    reason: "局部重绘（inpaint）后端尚未接入",
    alternative: "从「AI 文生图」重新出一张，或在画布上用「自定义场景」加参考图重画"
  },
  {
    id: "buyer",
    label: "买家秀",
    desc: "生成真实场景产品展示图",
    icon: "Picture",
    workflow: "",
    available: false,
    reason: "买家秀模板尚未接入",
    alternative: "在「使用模板」里挑一个场景模板，或用「爆款复刻」上传参考图仿拍"
  }
];

// ---------- 模型配置（模型-参数联动） ----------
// 三类模型并存：付费·国际 / 付费·国内 / 免费·本地
export const MODEL_GROUPS = ["付费 · 国际", "付费 · 国内", "免费 · 本地"];

const RATIOS_5 = ["1:1", "4:3", "3:4", "16:9", "9:16"];
const RATIOS_8 = [...RATIOS_5, "5:4", "3:2", "2:3"];

export const IMAGE_MODELS = [
  // 付费 · 国际
  { id: "nano-banana-pro", label: "Nano Banana Pro", group: "付费 · 国际", provider: "gemini", keyName: "gemini", ratios: RATIOS_8, counts: [1, 2, 4, 8, 10] },
  { id: "nano-banana-2", label: "Nano Banana 2", group: "付费 · 国际", provider: "gemini", keyName: "gemini", ratios: RATIOS_8, counts: [1, 2, 4, 8, 10] },
  // 2026-10-23：用户要求补「谷歌 2.1」。上游真实型号名不公开，默认名可在设置里覆盖。
  { id: "nano-banana-2.1", label: "Nano Banana 2.1", group: "付费 · 国际", provider: "gemini", keyName: "gemini", ratios: RATIOS_8, counts: [1, 2, 4, 8, 10] },
  { id: "gpt-image-2", label: "GPT Image 2", group: "付费 · 国际", provider: "openai", keyName: "openai", ratios: RATIOS_5, counts: [1, 2, 4, 8, 10] },
  { id: "gpt-image-2.5", label: "GPT Image 2.5", group: "付费 · 国际", provider: "openai", keyName: "openai", ratios: RATIOS_5, counts: [1, 2, 4, 8, 10] },

  // 付费 · 国内
  // 2026-10-23：用户要求去掉「通义万相」与「本地 ComfyUI」两个模型（界面不再可选）。
  // 服务端注册表仍保留它们（标了 hidden），老项目/老接口照旧可用。
  { id: "jiemeng", label: "即梦 Seedream 4.0", group: "付费 · 国内", provider: "jiemeng", keyName: "jiemeng", ratios: RATIOS_8, counts: [1, 2, 3, 4, 8, 10] },
  // 2026-10-23：豆包 Seedream 5.0 Pro（中文多图融合）。注意它与「豆包 2.1」不是一回事：
  // 2.1 是语言模型（做提示词/卖点），Seedream 才是出图。上游模型名可在设置里覆盖。
  { id: "seedream-5-pro", label: "豆包 Seedream 5.0 Pro", group: "付费 · 国内", provider: "jiemeng", keyName: "jiemeng", ratios: RATIOS_8, counts: [1, 2, 3, 4, 8, 10] },

  // 免费 · 本地

];

export function modelById(id) {
  return IMAGE_MODELS.find((m) => m.id === id) || IMAGE_MODELS[0];
}

// ---------- 模型选择器的「供应商分栏」（2026-10-14 新增） ----------
// 参考设计里顶部是三家供应商分栏（OpenAI / Google / aichange），每张模型卡
// 带一行「创意设计 · 灵感表达」的能力说明和「x 算力/张」的单价。
//
// 注意：这里只加「展示层归类」，**不动 model.group**。
// model.group 是「付费 · 国际 / 国内 / 免费 · 本地」的计费口径，
// 属性面板 InspectorPanel 的 optgroup 还在用它，改它会连带影响那边。
export const MODEL_PROVIDER_TABS = [
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google" },
  // 2026-10-23：用户要求把供应商分栏 "aichange" 改成品牌名「跨多多」（id 不改，避免动映射表）
  // 2026-10-23 二次调整：这个分栏装的是国内模型（Seedream / 即梦），
  // 用公司品牌名当分栏名会让人以为"跨多多自研模型"，改成类目名「优质国产」。
  { id: "aichange", label: "优质国产" }
];

// 供应商 → 模型。aichange 是「多供应商聚合通道」：国内云端与本地 ComfyUI 都归它。
export const PROVIDER_OF_MODEL = {
  "gpt-image-2": "openai",
  "gpt-image-2.5": "openai",
  "nano-banana-pro": "google",
  "nano-banana-2": "google",
  "nano-banana-2.1": "google",
  "jiemeng": "aichange",
  "seedream-5-pro": "aichange"
};

/** 某个模型属于哪个供应商分栏 */
export function providerOf(modelId) {
  return PROVIDER_OF_MODEL[modelId] || "aichange";
}

/** 某个分栏下的模型清单（保持 IMAGE_MODELS 的原始顺序） */
export function modelsOfProvider(providerId) {
  return IMAGE_MODELS.filter((m) => providerOf(m.id) === providerId);
}

// 模型能力说明（模型卡上那行小字）。缺省时回退到计费口径的文案。
export const MODEL_TAGLINE = {
  "gpt-image-2": "创意设计 · 灵感表达",
  "gpt-image-2.5": "创意设计 · 细节增强",
  "nano-banana-pro": "商业成片 · 高保真",
  "nano-banana-2": "商业成片 · 均衡",
  "nano-banana-2.1": "新版 · 中转站可覆盖",

  "jiemeng": "人像模特 · 风格化",
  "seedream-5-pro": "中文最强 · 多图融合"
};
export function taglineOf(modelId) {
  const m = modelById(modelId);
  return MODEL_TAGLINE[modelId] || m.group || "";
}

// ---------- 单价（算力）----------
// ⚠️ 必须与服务端计费表一致，否则界面上的价格会和实际扣费对不上。
// 服务端 server/credits.js COST_TABLE["image.generate"] = 10，且是**按次**计费
// （与张数 n 无关，见 server/index.js 的预扣逻辑）。所以这里如实显示「算力/次」，
// 不写「/张」—— 那会在 n>1 时变成假价格。
// 也不做模型差异化定价：服务端目前没有按模型定价的表，编一个假价格比不显示更糟。
export const COST_PER_GENERATION = 10;

// ---------- 服务端权威价格（Sprint 1 模型网关）----------
// 背景：上面那条注释说「不做模型差异化定价，因为服务端没有按模型定价的表」。
// 现在服务端有了（server/models/registry.js），所以界面改为**优先读服务端**：
//   · 拉到了  → 用服务端下发的单价（按模型），界面与实际扣费同源
//   · 拉不到  → 回落到 COST_PER_GENERATION（等价于改造前的行为，离线/开发态不受影响）
// 这条回落是刻意的：拿不到权威数据时，宁可显示一个已知与服务端基价一致的旧值，
// 也不显示空白或「--」（那会让用户以为免费）。
export const serverModelCost = reactive({});

/** 拉取服务端模型目录（能力 + 单价 + 密钥状态）。失败不抛：界面照常可用。 */
export async function loadServerModels() {
  try {
    const { fetchModels } = await import("./api.js");
    const data = await fetchModels();
    for (const m of data?.models || []) {
      if (m && typeof m.id === "string" && Number.isFinite(m.cost)) serverModelCost[m.id] = m.cost;
    }
    return data;
  } catch {
    return null; // 静默：价格回落，功能不受影响
  }
}

/** 某个模型的单价（服务端优先，回落基价） */
export function costOfModel(modelId = "") {
  const fromServer = serverModelCost[modelId];
  return Number.isFinite(fromServer) ? fromServer : COST_PER_GENERATION;
}

/**
 * 模型卡右侧那行单价文案。
 * @param {string} [modelId] 传了就用该模型的服务端单价；不传保持旧行为（基价）
 */
export function costLabelOf(modelId = "") {
  return `${costOfModel(modelId)} 算力/次`;
}


// 分辨率档位（长边像素）——与参考工具一致的 2K / 4K
export const RESOLUTIONS = ["2K", "4K"];
const LONG_EDGE = { "2K": 2048, "4K": 4096 };

// 由「分辨率 + 比例」算出实际尺寸
export function resolveSize(resolution, ratio) {
  const [w, h] = String(ratio || "1:1").split(":").map(Number);
  const long = LONG_EDGE[resolution] || LONG_EDGE["2K"];
  if (!w || !h) return `${long}x${long}`;
  return w >= h
    ? `${long}x${Math.round((long * h) / w)}`
    : `${Math.round((long * w) / h)}x${long}`;
}

// 兼容旧调用：按 2K 长边换算
export const RATIO_SIZE = {
  "1:1": "2048x2048",
  "4:3": "2048x1536",
  "3:4": "1536x2048",
  "16:9": "2048x1152",
  "9:16": "1152x2048",
  "5:4": "2048x1638",
  "3:2": "2048x1365",
  "2:3": "1365x2048"
};

export const VIDEO_OPTIONS = {
  models: ["万相 · 3.0", "万相 · 2.5", "万相 · 2.1"],
  resolutions: ["720p", "1080p"],
  modes: ["自动", "流畅", "高清"],
  durations: ["5s", "10s"]
};

// 参考输入上限（对齐原工具）
export const REF_LIMITS = {
  images: 10,
  videos: 5,
  audios: 5
};

export const store = reactive({
  // routing
  route: "home",
  activeSkill: "txt2img",

  // 界面主题：prism / aurora / atelier / momentum（明暗另算）
  theme: "prism",
  // 界面主题（夜间模式）
  darkMode: false,

  // 画布模式：free = 无限画布自由创作；batch = 批量节点操作
  canvasMode: "free",
  // 批量面板是否展开（仅在 batch 模式下有意义）
  batchDockOpen: true,
  // 批量执行中的行状态：[{ id, prompt, state, msg }]（BatchDock 维护，供任务条显示）
  batchRows: [],

  // 当前项目名
  projectName: "未命名项目",

  // 项目持久化（E7 / F4）：三态保存指示 + 当前项目 id
  currentProjectId: `proj-${Date.now().toString(36)}`,
  saveState: "idle", // idle | saving | saved | error
  saveError: "",
  lastSavedAt: 0,
  // 待恢复的画布图（启动时由 project.bootstrap 写入，NodeCanvas 挂载后消费）
  pendingRestore: null,

  // 结果资产库（审阅视图数据源，持久化到 localStorage）
  assets: [],

  // 后台任务条（C4）：{id, kind, label, status, text, progress, cost, savedCost, images, ts}
  tasks: [],
  // 底部任务条是否展开
  taskBarOpen: false,

  // 当前选中的画布节点（右侧属性栏数据源）
  selection: [],

  // 项目列表（本地维护）
  projects: [
    { id: "proj-tutorial", name: "新手教程", updatedAt: "2026-09-09", thumbs: [] },
    { id: "proj-1", name: "Untitled", updatedAt: "2026-09-10", thumbs: [] }
  ],

  // 首页选定的工作流（进入创作台后自动铺设）
  pendingWorkflow: "",
  // 技能面板铺图用：直接给「模板对象」（由 src/skill-graph.js 从技能计划转换而来），
  // 与 pendingWorkflow（内置模板 id）区分开 —— 两者消费方式不同，混在一个字段里会很难查。
  pendingWorkflowGraph: null,
  // 选定的「我的模板」id（画布存下来的，进创作台后拉节点图铺开）
  pendingTemplateId: "",
  pendingTemplateName: "",
  // 首页输入的文字（带入画布提示词节点）
  pendingPrompt: "",
  // 创作台当前激活的工具/子工作流
  activeTool: "",
  activeSubTool: "",

  // 素材库
  materialPanelOpen: false,
  materialSearch: "",
  materials: { categories: [], root: "" },

  // 视频节点参数（截图顶部参数行）
  videoModel: "万相 · 3.0",
  videoResolution: "1080p",
  videoMode: "自动",
  videoDuration: "5s",

  // 全局图片生成设置（顶部栏模型设置面板）
  // 2026-10-23：默认模型不能指向已下线（hidden）的 wanxiang，
  // 否则新铺出来的提示词节点，模型下拉框是**空白**的（值不在选项里）。
  imageModel: "seedream-5-pro",
  imageResolution: "2K", // 2K / 4K
  imageRatio: "3:4", // 默认画幅比例（节点内可单独调整）

  // 设置
  settings: null,
  comfyStatus: null,

  // 算力
  credits: 0,

  // 当前登录用户（由 App.vue 在登录/启动时写入）
  user: null,

  // 顶栏搜索关键词（跳到模板库时带上）
  searchKeyword: "",

  // 品牌配置（白标，服务端下发）
  brand: null,

  // 服务端下发的模板（不再硬编码）
  templates: [],
  templateCategories: [],

  // 算力余额（服务端账本，前端只读展示）
  balance: 0,
  costTable: {},

  // 生成状态
  generating: false,
  history: [],

  // 节点画布统计
  flowNodeCount: 0
});

export function startSkill(skillId) {
  store.activeSkill = skillId;
  store.route = "studio";
}

/**
 * 技能入口的统一入口：跳到创作台 + （能对上工作流时）真铺出节点图。
 *
 * 返回 { ok, reason }：
 *   ok:false + reason  → 该技能尚未接入，调用方应如实提示，不要假装成功。
 *
 * 2026-10-14：以前技能只调 startSkill()，点了只会跳到一张空画布。
 */
export function launchSkill(skillId) {
  const skill = SKILLS.find((s) => s.id === skillId);
  if (!skill) return { ok: false, reason: "未知技能" };

  // ⚠️ 顺序很重要：先判"能不能用"，再改状态。
  // 以前是先 store.route = "studio" 再返回失败 —— 于是点一个"即将上线"的技能，
  // 界面先跳走、再弹一句提示，用户看到的是"切到了创作台但什么都没有"。
  // 现在不跳了，原因和替代做法由调用方直接展示。
  if (skill.available === false || !skill.workflow) {
    return {
      ok: false,
      unavailable: true,
      label: skill.label,
      reason: skill.reason || "该技能尚未接入",
      alternative: skill.alternative || ""
    };
  }

  store.activeSkill = skill.id;
  store.route = "studio";

  // 交给画布：NodeCanvas 挂载/监听到 pendingWorkflow 后会铺出整套节点
  store.pendingWorkflow = skill.workflow;
  return { ok: true, workflow: skill.workflow };
}

export function newFlowId(prefix = "n") {
  return `${prefix}${nextId++}`;
}

/**
 * 用模板对象铺画布（Sprint 2 技能面板）。
 *
 * 与 launchSkill 的分工：
 *   launchSkill     —— 按 id 取内置 WORKFLOWS 模板
 *   launchSkillGraph —— 直接给模板对象（技能计划由服务端下发，前端转换得来）
 * 两者最终都进 NodeCanvas 的同一个铺图入口 applyWorkflowGraph。
 */
export function launchSkillGraph(template, { label = "" } = {}) {
  if (!template || !Array.isArray(template.nodes) || !template.nodes.length) {
    return { ok: false, reason: "该技能还没有可铺的节点图" };
  }
  store.route = "studio";
  store.pendingWorkflowGraph = label ? { ...template, label } : template;
  return { ok: true, label: label || template.label || "" };
}

/**
 * ⚠️ 2026-10-14 修复（恢复画布后节点 id 重复）：
 * nextId 是模块级计数器，只在加载时初始化为 1。而 restoreGraph() 是**保留原 id**
 * 把上次的画布装回来的 —— 于是「启动时恢复画布 → 再新建节点」必然撞 id
 * （newFlowId("p") 给出 "p1"，而恢复出来的图里已经有 "p1"），轻则节点被覆盖、
 * 重则整张图渲染错乱。
 *
 * 修法：恢复/导入任何带 id 的图之后，调用这个函数把计数器抬到「已有 id 的最大序号 + 1」。
 * 传节点数组或任意 id 字符串数组都可以；解析不出序号的 id（如 UUID）直接忽略。
 *
 * @param {Array<string|{id?:string}>} idsOrNodes
 */
export function bumpFlowId(idsOrNodes = []) {
  let max = nextId - 1;
  for (const item of idsOrNodes) {
    const raw = typeof item === "string" ? item : item?.id;
    if (raw == null) continue;
    // 取字符串末尾的连续数字：p12 → 12、e3 → 3、n7x → 忽略
    const m = /(\d+)$/.exec(String(raw));
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  nextId = max + 1;
  return nextId;
}

// 跨组件桥接（不用 reactive，避免函数被代理）
// NodeCanvas 挂载时注册，对话抽屉等外部组件调用
export const bridge = {
  // 把文字写入画布上的「画面描述」节点，返回是否成功
  setPrompt: null,
  // 手动触发一次更新检查
  checkUpdate: null,
  // 铺开指定工作流（供嵌入桥调用）
  applyWorkflow: null,

  // ---- 以下供右侧属性栏 / 底部任务条 / 审阅视图 调用 ----
  // 读取当前选中节点（返回原始 node 引用，只读用途）
  getSelected: null,
  // 批量改选中节点的 data：patchSelected({ count: 4 })
  patchSelected: null,
  // 把选中节点编成一个作品组
  groupSelection: null,
  // 解散选中节点所在的组
  ungroupSelection: null,
  // 重跑某个执行节点
  rerunNode: null,
  // 取消某个任务
  cancelTask: null,
  // 请求立刻保存
  requestSave: null,
  // 定位到某个节点（审阅视图「在画布中显示」）
  focusNode: null,
  // 删除选中节点
  removeSelected: null,

  // ---- 批量节点模式（2026-09-25 新增）----
  // 批量面板：把一组提示词铺成节点，返回生成的执行节点 id 数组
  batchFromPrompts: null,
  // 批量面板：串行运行指定（或当前选中）的执行节点
  runBatchNodes: null,
  // 批量面板：中断当前批量
  cancelBatch: null,
  // 批量模式：把画布节点按网格重新排布
  tidyGrid: null,
  // 读取当前选中节点 id
  getSelectedIds: null,
  // 设置选中节点
  setSelectedIds: null
};

// ============================================================
// 后台任务条（C4）
// ============================================================
let taskSeq = 1;

export function pushTask(task) {
  const t = {
    id: `t${taskSeq++}`,
    status: "running", // running | done | error | canceled
    progress: 0,
    text: "",
    ts: Date.now(),
    ...task
  };
  store.tasks.unshift(t);
  if (store.tasks.length > 40) store.tasks.length = 40;
  // ⚠️ 不再自动展开任务面板：以前每起一个任务就把底部横条弹出来，
  // 用户在画布上干活时被反复顶开 —— 现在顶栏入口显示转圈/徽标就够了，
  // 面板只在他自己点的时候出现。
  return t.id;
}

export function updateTask(id, patch) {
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
}

export function finishTask(id, patch = {}) {
  updateTask(id, { status: "done", progress: 100, ...patch });
  // 这里以前会在"全部结束 3 秒后自动收起面板"。现在面板是用户主动点开的，
  // 自动收起只会在人家正在看的时候把它关掉 —— 所以取消了自动收/自动开。
}

/**
 * 清除任务条里**所有已结束**的任务（完成 / 失败 / 已取消），只留进行中的。
 *
 * ⚠️ 文案与行为必须一致：以前按钮写「清除已完成」，实际连失败一起清 ——
 * 用户看到 3 个失败任务、点了一个写着"已完成"的按钮，既不敢点也不知道点了会怎样。
 * 现在按钮文案是动态的（见 TaskBar），这里保持"清掉所有已结束"的语义。
 */
export function clearFinishedTasks() {
  store.tasks = store.tasks.filter((t) => t.status === "running");
}

/** 只清失败任务（保留已完成的结果与进行中的任务） */
export function clearFailedTasks() {
  store.tasks = store.tasks.filter((t) => t.status !== "error");
}

/**
 * **仅供界面预览/截图**：灌一批有代表性的任务（进行中 / 重复失败 / 已完成）。
 * 由 `?demo=tasks` 触发，正常使用永远不会走到。
 *
 * 为什么需要它：任务面板最容易出错的地方是"有任务时长什么样"，
 * 而这一状态在无头浏览器里很难自然造出来（要真的跑一次失败）。
 * 前几次界面 bug（空面板、错误条）都是靠截图抓到的，所以这个入口值得留着。
 */
export function seedDemoTasks() {
  store.tasks = [];
  pushTask({ label: "文生图 · 豆包 Seedream 5.0 Pro", status: "running", text: "生成中…", cost: 10 });
  pushTask({ label: "豆包 Seedream 5.0 Pro × 1 张", status: "error", cost: 10, refunded: 10, text: "Invalid API-key provided." });
  pushTask({ label: "豆包 Seedream 5.0 Pro × 1 张", status: "error", cost: 10, refunded: 10, text: "Invalid API-key provided." });
  pushTask({ label: "豆包 Seedream 5.0 Pro × 1 张", status: "error", cost: 10, refunded: 10, text: "Invalid API-key provided." });
  const done = pushTask({ label: "白底图 · 4 张", status: "running", text: "生成中…", cost: 10 });
  finishTask(done, { images: [{ url: "/brand/logo-mark.png" }, { url: "/brand/logo-mark.png" }], savedCost: 30 });
  store.taskBarOpen = true;
}

/**
 * 移除单条已结束的任务（任务条上那一行的 ×）。
 * 进行中的任务不允许被这样移除 —— 那会让用户以为任务被取消了，
 * 实际后台还在跑并扣费。要停就跑"取消"。
 */
export function dismissTask(id) {
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, reason: "任务不存在" };
  if (t.status === "running") return { ok: false, reason: "进行中的任务不能直接移除，请先取消" };
  store.tasks = store.tasks.filter((x) => x.id !== id);
  return { ok: true };
}

// 将生成结果记录到首页"最近生成"
export function pushHistory(entry) {
  store.history.unshift({
    time: new Date().toLocaleTimeString(),
    status: entry.ok ? "done" : "error",
    ...entry
  });
  if (store.history.length > 30) store.history.pop();
}

// ============================================================
// 工具箱与工作流模板（对齐参考工具 AI Change）
// 点左侧工具 → 在画布一次性铺出整套工作流节点 + 自动连线
// ============================================================

export const TOOLS = [
  {
    id: "ai-clothes",
    label: "AI换衣",
    icon: "UserFilled",
    options: [
      { id: "clothes-model", label: "服装图模特图换衣" },
      { id: "style-reference", label: "参考风格换衣" },
      { id: "clothes-model-pose", label: "服装图模特图换衣+姿势裂变" },
      { id: "fixed-face-bg-pose", label: "固定面部、背景、参考姿势换衣" },
      { id: "pose-split", label: "姿势裂变" }
    ]
  },
  {
    id: "product-design",
    label: "图生图",
    icon: "PictureFilled",
    options: [
      { id: "custom-scene", label: "自由创作" },
      { id: "smart-generation", label: "智能创作" }
    ]
  },
  {
    id: "image-generate",
    label: "文生图",
    icon: "MagicStick",
    direct: "image-generate"
  },
  {
    id: "detail-page",
    label: "详情页制作",
    icon: "Document",
    options: [
      { id: "detail-page", label: "详情页制作" },
      { id: "image-replica", label: "图片复刻" }
    ]
  },
  {
    id: "ai-video",
    label: "AI视频",
    icon: "VideoCameraFilled",
    options: [
      { id: "ai-video", label: "视频生成" },
      { id: "ai-video-replica", label: "视频复刻" }
    ]
  }
];

// ---- 节点构造小工具（坐标相对，applyWorkflow 时统一偏移） ----
const nUpload = (key, x, y, data) => ({ key, type: "product", x, y, data });
const nStyle = (key, x, y, data = {}) => ({ key, type: "style", x, y, data });
const nPrompt = (key, x, y) => ({ key, type: "prompt", x, y, data: {} });
const nExec = (key, x, y) => ({ key, type: "executor", x, y, data: {} });
const nVideo = (key, x, y) => ({ key, type: "reference", x, y, data: {} });

// 连线格式：[from, to, sourceHandle, targetHandle]
const L = (from, to, sh, th) => [from, to, sh, th];

/**
 * 工作流模板集合。
 * nodes: { key, type, x, y, data }
 * edges: [fromKey, toKey, sourceHandle, targetHandle]
 */
export const WORKFLOWS = {
  // ---------- AI换衣 ----------
  "clothes-model": {
    label: "服装图模特图换衣",
    tool: "ai-clothes",
    nodes: [
      nUpload("outfit", 0, 0, { title: "服装图", role: "outfit" }),
      nUpload("model", 190, 0, { title: "模特图", role: "model" }),
      nStyle("style", 380, 0, { optional: true, uploadText: "点击上传风格图" }),
      nPrompt("prompt", 0, 285),
      nExec("exec", 600, 210)
    ],
    edges: [
      L("outfit", "exec", "product", "product"),
      L("model", "exec", "product", "product"),
      L("style", "exec", "style", "style"),
      L("prompt", "exec", "prompt", "prompt")
    ]
  },
  "style-reference": {
    label: "参考风格换衣",
    tool: "ai-clothes",
    nodes: [
      nUpload("outfit", 0, 0, { title: "服装图", role: "outfit" }),
      nStyle("style", 380, 0, { optional: false, uploadText: "点击上传风格图" }),
      nPrompt("prompt", 0, 285),
      nExec("exec", 600, 210)
    ],
    edges: [
      L("outfit", "exec", "product", "product"),
      L("style", "exec", "style", "style"),
      L("prompt", "exec", "prompt", "prompt")
    ]
  },
  "clothes-model-pose": {
    label: "服装图模特图换衣+姿势裂变",
    tool: "ai-clothes",
    nodes: [
      nUpload("outfit", 0, 0, { title: "服装图", role: "outfit" }),
      nUpload("model", 190, 0, { title: "模特图", role: "model" }),
      nPrompt("prompt", 0, 285),
      nExec("exec", 600, 210)
    ],
    edges: [
      L("outfit", "exec", "product", "product"),
      L("model", "exec", "product", "product"),
      L("prompt", "exec", "prompt", "prompt")
    ]
  },
  "fixed-face-bg-pose": {
    label: "固定面部、背景、参考姿势换衣",
    tool: "ai-clothes",
    nodes: [
      nUpload("outfit", 0, 0, { title: "服装图", role: "outfit" }),
      nUpload("model", 190, 0, { title: "模特图", role: "model" }),
      nStyle("style", 380, 0, { optional: true, uploadText: "点击上传参考姿势图" }),
      nPrompt("prompt", 0, 285),
      nExec("exec", 600, 210)
    ],
    edges: [
      L("outfit", "exec", "product", "product"),
      L("model", "exec", "product", "product"),
      L("style", "exec", "style", "style"),
      L("prompt", "exec", "prompt", "prompt")
    ]
  },
  "pose-split": {
    label: "姿势裂变",
    tool: "ai-clothes",
    nodes: [
      nUpload("model", 0, 0, { title: "模特图", role: "model" }),
      nPrompt("prompt", 0, 285),
      nExec("exec", 600, 210)
    ],
    edges: [
      L("model", "exec", "product", "product"),
      L("prompt", "exec", "prompt", "prompt")
    ]
  },

  // ---------- 图生图 ----------
  "custom-scene": {
    label: "自由创作",
    tool: "product-design",
    nodes: [
      nUpload("ref", 0, 0, { title: "参考图", role: "reference" }),
      nPrompt("prompt", 0, 285),
      nExec("exec", 600, 210)
    ],
    edges: [
      L("ref", "exec", "product", "product"),
      L("prompt", "exec", "prompt", "prompt")
    ]
  },
  "smart-generation": {
    label: "智能创作",
    tool: "product-design",
    nodes: [
      nUpload("ref", 0, 0, { title: "参考图", role: "reference" }),
      nPrompt("prompt", 0, 285),
      nExec("exec", 600, 210)
    ],
    edges: [
      L("ref", "exec", "product", "product"),
      L("prompt", "exec", "prompt", "prompt")
    ]
  },

  // ---------- 文生图 ----------
  "image-generate": {
    label: "文生图",
    tool: "image-generate",
    nodes: [nPrompt("prompt", 0, 0), nExec("exec", 620, 60)],
    edges: [L("prompt", "exec", "prompt", "prompt")]
  },

  // ---------- 详情页制作 ----------
  "detail-page": {
    label: "详情页制作",
    tool: "detail-page",
    nodes: [
      nUpload("product", 0, 0, { title: "产品图", role: "product" }),
      nPrompt("prompt", 0, 285),
      nExec("exec", 600, 210)
    ],
    edges: [
      L("product", "exec", "product", "product"),
      L("prompt", "exec", "prompt", "prompt")
    ]
  },
  "image-replica": {
    label: "图片复刻",
    tool: "detail-page",
    nodes: [
      nUpload("ref", 0, 0, { title: "参考图", role: "reference" }),
      nPrompt("prompt", 0, 285),
      nExec("exec", 600, 210)
    ],
    edges: [
      L("ref", "exec", "product", "product"),
      L("prompt", "exec", "prompt", "prompt")
    ]
  },

  // ---------- AI视频 ----------
  "ai-video": {
    label: "视频生成",
    tool: "ai-video",
    nodes: [nVideo("video", 0, 0)],
    edges: []
  },
  "ai-video-replica": {
    label: "视频复刻",
    tool: "ai-video",
    nodes: [nVideo("video", 0, 0)],
    edges: []
  }
};

// 首页快捷任务（对话式入口的 chips）
export const HOME_TASKS = [
  { id: "clothes-model", label: "AI换衣", icon: "UserFilled", hot: true },
  { id: "custom-scene", label: "图片编辑", icon: "PictureFilled" },
  { id: "smart-generation", label: "智能创作", icon: "MagicStick" },
  { id: "detail-page", label: "详情页制作", icon: "Document" },
  { id: "ai-video", label: "AI视频", icon: "VideoCameraFilled" }
];
