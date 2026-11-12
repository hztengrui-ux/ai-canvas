// 模型注册表 —— 模型网关的「能力 / 计价 / 限额」真源
//
// 为什么需要它（Sprint 1）：
//   之前 /api/generate 只知道「provider」，不知道「模型」：
//     · 模型能力（支持哪些尺寸、能出几张、能接几张参考图）散落在前端 store.js
//     · 价格是全局一个数（COST_TABLE["image.generate"] = 10），按次不论模型
//     · 谁服务哪个模型只有前端清楚，服务端只是被动收 provider 字段
//   结果是「界面能选什么」和「服务端允许什么」两套真相，加模型必须两边改且容易跑偏。
//
// 本模块只做三件事：**注册、解析路由、校验入参**。不碰网络、不碰账本。
//
// ⚠️ 两个刻意的设计取舍（都为了不破坏现网行为）：
//   1. 未注册的模型一律走「宽松路径」：不校验能力、按 action 基价计费、记一条 diagnostic。
//      因为历史调用（含测试）会传 wanx2.1-t2i-turbo / Z-Image Turbo 这类后端原始模型名，
//      它们不在前端模型清单里。严格拒绝会让现网和回归全线报错 —— 网关应该是「认识就管，
//      不认识就放行并留痕」，而不是把不认识的一律拒掉。
//   2. 能力限制默认「不填即不限」：sizes 为空数组 = 只校验尺寸格式；maxRefImages 为 0 = 不限。
//      这些是产品口径（各家模型到底能接几张参考图），不该由我拍脑袋定；
//      填上数字即刻生效（服务端与 /api/models 同步下发），并有测试覆盖该机制。
import { COST_TABLE } from "../credits.js";

export const KIND_IMAGE = "image";
export const KIND_VIDEO = "video";

/** 计费动作：kind → 账本动作（价格由 credits.COST_TABLE 提供，模型可覆盖） */
export const ACTION_OF_KIND = {
  [KIND_IMAGE]: "image.generate",
  [KIND_VIDEO]: "video.generate"
};

/** 尺寸合法形状：1024x1024、768x1344 等 */
const SIZE_PATTERN = /^(\d{2,5})\s*x\s*(\d{2,5})$/i;
export const SIZE_MIN = 64;
export const SIZE_MAX = 4096;

/**
 * 模型清单。
 *
 * 字段说明：
 *   id           —— 前端模型选择器使用的 id（必须与 src/store.js IMAGE_MODELS 对齐）
 *   provider     —— 服务端 PROVIDERS 的键（决定请求打到哪个 provider 模块）
 *   apiId        —— **上游真实模型名**（发到对方接口的那个字符串）。
 *                   与 id 分开的原因：界面上叫「Nano Banana Pro」很好懂，
 *                   但 Google 的接口只认 gemini-3-pro-image-preview；
 *                   而中转站/聚合 API 往往又是另一套名字（如 google/gemini-3-pro-image）。
 *                   所以这里给"官方默认值"，用户在设置里填的覆盖值优先
 *                   （config.models[id] = "任意上游名字"），见 apiIdOf()。
 *   kind         —— image | video
 *   modes        —— t2i（文生图）| i2i（图生图）| video（视频）
 *   label/group  —— 展示用（group 沿用「付费 · 国际 / 国内 / 免费 · 本地」口径）
 *   tab          —— 供应商分栏 id（与前端 MODEL_PROVIDER_TABS 对齐）
 *   cost         —— null = 用计入费表的基价；填数字 = 该模型的差异化单价（改这一列即生效）
 *   sizes        —— [] = 不限制具体尺寸（只校验格式）；否则白名单
 *   maxCount     —— 单次最多几张（0 = 不限）；仍受 AI_CANVAS_MAX_PER_BATCH 约束
 *   maxRefImages —— 最多接几张参考图（0 = 不限）
 */
export const MODELS = [
  {
    id: "nano-banana-pro",
    apiId: "gemini-3-pro-image-preview",
    provider: "gemini",
    kind: KIND_IMAGE,
    modes: ["t2i", "i2i"],
    label: "Nano Banana Pro",
    group: "付费 · 国际",
    tab: "google",
    cost: null,
    sizes: [],
    maxCount: 10,
    maxRefImages: 8,
    tagline: "商业成片 · 高保真"
  },
  // Nano Banana 2.1（2026-10-23 用户要求补上）
  //
  // 说明：Google 官方目前公布的图像模型名是 gemini-2.5-flash-image（Nano Banana 2）
  // 与 gemini-3-pro-image-preview（Nano Banana Pro），并没有字面上的 "2.1"。
  // 用户大概率是从中转站看到的型号，所以这里：
  //   · 默认 apiId 先按 gemini-2.5-flash-image 走（多数聚合 API 接受这个名）；
  //   · 真正的上游名请在「设置 → 模型 ID 覆盖」里填，改完立即生效（apiIdOf 优先读用户覆盖）；
  //   · 若上游返回 404 / 型号不存在，错误会原样透出，提示用户去改这一项。
  {
    id: "nano-banana-2.1",
    apiId: "gemini-2.5-flash-image",
    provider: "gemini",
    kind: KIND_IMAGE,
    modes: ["t2i", "i2i"],
    label: "Nano Banana 2.1",
    group: "付费 · 国际",
    tab: "google",
    cost: null,
    sizes: [],
    maxCount: 10,
    maxRefImages: 3,
  },
  {
    id: "nano-banana-2",
    apiId: "gemini-2.5-flash-image",
    provider: "gemini",
    kind: KIND_IMAGE,
    modes: ["t2i", "i2i"],
    label: "Nano Banana 2",
    group: "付费 · 国际",
    tab: "google",
    cost: null,
    sizes: [],
    maxCount: 10,
    maxRefImages: 8,
    tagline: "商业成片 · 均衡"
  },
  {
    id: "gpt-image-2",
    apiId: "gpt-image-2",
    provider: "openai",
    kind: KIND_IMAGE,
    modes: ["t2i", "i2i"],
    label: "GPT Image 2",
    group: "付费 · 国际",
    tab: "openai",
    cost: null,
    sizes: [],
    maxCount: 10,
    maxRefImages: 8,
    tagline: "创意设计 · 灵感表达"
  },
  {
    id: "gpt-image-2.5",
    apiId: "gpt-image-2.5",
    provider: "openai",
    kind: KIND_IMAGE,
    modes: ["t2i", "i2i"],
    label: "GPT Image 2.5",
    group: "付费 · 国际",
    tab: "openai",
    cost: null,
    sizes: [],
    maxCount: 10,
    maxRefImages: 8,
    tagline: "创意设计 · 细节增强"
  },
  {
    id: "wanxiang",
    apiId: "wanx2.1-t2i-turbo",
    // 2026-10-23：用户要求界面不再展示「通义万相」。
    // 只标 hidden 而不是删除：老项目里存着这个 model id，删了会让历史任务解析不到模型
    // （网关的「未注册模型宽松路径」虽然能兜，但计费/能力校验会退化成基价，不再可预测）。
    hidden: true,
    provider: "wanxiang",
    kind: KIND_IMAGE,
    modes: ["t2i", "i2i"],
    label: "通义万相 2.1 Turbo",
    group: "付费 · 国内",
    tab: "aichange",
    cost: null,
    sizes: [],
    maxCount: 10,
    maxRefImages: 3,
    tagline: "电商主图 · 中文理解"
  },
  {
    id: "jiemeng",
    apiId: "doubao-seedream-4-0",
    provider: "jiemeng",
    kind: KIND_IMAGE,
    modes: ["t2i", "i2i"],
    label: "即梦 Seedream 4.0",
    group: "付费 · 国内",
    tab: "aichange",
    cost: null,
    sizes: [],
    maxCount: 10,
    maxRefImages: 4,
    tagline: "人像模特 · 风格化"
  },
  {
    id: "comfyui",
    apiId: "",
    // 2026-10-23：同上，界面不再展示本地 ComfyUI 模型（能力仍在，老项目照旧）
    hidden: true,
    provider: "comfyui",
    kind: KIND_IMAGE,
    modes: ["t2i", "i2i"],
    label: "Flux-2-Klein（本地 ComfyUI）",
    group: "免费 · 本地",
    tab: "aichange",
    cost: null,
    sizes: [],
    maxCount: 10,
    maxRefImages: 4,
    tagline: "本地算力 · 零调用费"
  },
  {
    id: "seedream-5-pro",
    apiId: "doubao-seedream-5-0-pro",
    provider: "jiemeng",
    kind: KIND_IMAGE,
    modes: ["t2i", "i2i"],
    label: "豆包 Seedream 5.0 Pro",
    group: "付费 · 国内",
    tab: "aichange",
    cost: null,
    sizes: [],
    maxCount: 10,
    maxRefImages: 14,
    tagline: "中文最强 · 多图融合"
  },
  {
    id: "wanx2.1-t2v-turbo",
    apiId: "wanx2.1-t2v-turbo",
    provider: "wanxiang",
    kind: KIND_VIDEO,
    modes: ["video"],
    label: "通义万相 2.1 文生视频 Turbo",
    group: "付费 · 国内",
    tab: "aichange",
    cost: null,
    sizes: [],
    maxCount: 1,
    maxRefImages: 1,
    tagline: "文生视频 · 快速"
  }
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/**
 * 解析「这次该把哪个模型名发给上游」。
 *
 * 三级优先（这是能接中转站/聚合 API 的关键）：
 *   1. 用户在设置里填的覆盖值（config.models[id]）—— 中转站的模型名千奇百怪，
 *      "google/gemini-3-pro-image"、"doubao-seed-2-1-pro" 只有用户自己知道；
 *   2. 注册表里的官方默认 apiId；
 *   3. 兜底用 id 本身（未注册模型走这条，保持原有的宽松行为）。
 *
 * @param {string|object} idOrModel 模型 id 或注册表对象
 * @param {Record<string,string>} [overrides] config.models
 */
/**
 * 对外可见的模型（hidden 的不下发）。
 *
 * 为什么要有这个概念：2026-10-23 用户要求界面去掉「通义万相」「本地 ComfyUI」，
 * 但直接删注册表会让老项目里的 model id 变成"未注册"，计费与能力校验退化成基价。
 * 所以用 hidden 标记"内部仍在、界面不展示"，并把「可见」这件事收敛到一个函数，
 * 网关、接口、测试都从这里取值，避免各处各写一遍 filter。
 */
export function visibleModels({ kind } = {}) {
  // 走 listModels 而不是直接 filter MODELS：listModels 会补 action / effectiveCost，
  // 少了这两项，/api/models 下发的单价就是 undefined（界面显示"undefined 算力/次"）。
  return listModels({ kind }).filter((m) => !m.hidden);
}

export function apiIdOf(idOrModel, overrides = {}) {
  const model = typeof idOrModel === "string" ? getModel(idOrModel) : idOrModel;
  const id = typeof idOrModel === "string" ? String(idOrModel || "").trim() : String(model?.id || "");
  const map = overrides && typeof overrides === "object" ? overrides : {};
  const custom = map[id];
  if (typeof custom === "string" && custom.trim()) return custom.trim();
  if (model && typeof model.apiId === "string" && model.apiId.trim()) return model.apiId.trim();
  return id;
}

/** 注册表只读视图（浅拷贝，防止调用方就地改到注册表） */
export function listModels({ kind, provider } = {}) {
  return MODELS.filter((m) => (!kind || m.kind === kind) && (!provider || m.provider === provider)).map((m) => ({
    ...m,
    action: ACTION_OF_KIND[m.kind] || "",
    effectiveCost: modelCost(m)
  }));
}

export function getModel(id) {
  return BY_ID.get(String(id || "")) || null;
}

export function modelsOf(provider) {
  return listModels({ provider });
}

/** 某 provider 在某类目下的默认模型（用于请求未带 model 时兜底） */
export function defaultModelFor(provider, kind = KIND_IMAGE) {
  return MODELS.find((m) => m.provider === provider && m.kind === kind) || null;
}

/** 模型单价：显式 cost 优先，否则用计入费表的基价 */
export function modelCost(model) {
  if (!model) return 0;
  const action = ACTION_OF_KIND[model.kind] || "";
  if (typeof model.cost === "number" && Number.isFinite(model.cost) && model.cost >= 0) return model.cost;
  return COST_TABLE[action]?.cost ?? 0;
}

/**
 * 解析「这次请求该用哪个 provider、哪个模型、多少钱」。
 *
 * @param {{provider?: string, model?: string, kind?: string}} input
 * @returns {{
 *   provider: string, model: object|null, registered: boolean,
 *   action: string, cost: number, kind: string, diagnostics: string[]
 * }}
 */
export function resolveRoute({ provider = "", model = "", kind = KIND_IMAGE } = {}) {
  const diagnostics = [];
  const id = String(model || "").trim();
  const registeredModel = id ? getModel(id) : null;

  let resolvedProvider = String(provider || "").trim();
  if (registeredModel) {
    // 注册表对已知模型是权威：provider 以注册表为准。
    // 调用方显式给了不一致的 provider → 记一条 diagnostic，但不在这里报错，
    // 报错交给 validateRequest（它要返回结构化的错误码）。
    if (resolvedProvider && resolvedProvider !== registeredModel.provider) {
      diagnostics.push(`provider 与注册表不一致（请求 ${resolvedProvider} / 注册表 ${registeredModel.provider}）`);
    } else {
      resolvedProvider = registeredModel.provider;
    }
  } else if (!id) {
    // 未带 model：用该 provider 的默认模型补齐能力与计价依据
    const fallback = defaultModelFor(resolvedProvider, kind);
    if (fallback) {
      diagnostics.push(`未指定模型，按 ${resolvedProvider} 默认模型 ${fallback.id} 计费`);
      return {
        provider: resolvedProvider,
        model: fallback,
        registered: true,
        action: ACTION_OF_KIND[fallback.kind] || "",
        cost: modelCost(fallback),
        kind: fallback.kind,
        diagnostics
      };
    }
  } else {
    // 未注册模型：宽松路径（历史/后端原始模型名），按 action 基价计费并留痕
    diagnostics.push(`模型 ${id} 未注册，按基价计费且不做能力校验`);
  }

  const action = ACTION_OF_KIND[kind] || "";
  return {
    provider: resolvedProvider,
    model: registeredModel,
    registered: Boolean(registeredModel),
    action,
    cost: registeredModel ? modelCost(registeredModel) : (COST_TABLE[action]?.cost ?? 0),
    kind,
    diagnostics
  };
}

/** 尺寸字符串是否合法（形状 + 区间） */
export function isValidSize(size) {
  const s = String(size || "").trim();
  if (!s) return false;
  const m = SIZE_PATTERN.exec(s);
  if (!m) return false;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w >= SIZE_MIN && w <= SIZE_MAX && h >= SIZE_MIN && h <= SIZE_MAX;
}

/**
 * 校验入参是否满足模型能力。
 * 未注册模型直接放行（见文件头取舍 1）。
 *
 * @returns {{ok: boolean, code?: string, message?: string, count: number, diagnostics: string[]}}
 */
export function validateRequest(route, { size = "", n = 1, referenceCount = 0, mode = "" } = {}) {
  const diagnostics = [];
  const count = Math.max(1, Math.round(Number(n) || 1));

  if (!isValidSize(size)) {
    // 尺寸格式错误对任何模型都是硬错（"abc"/"0x0" 这种不可能被真实界面发出）
    return { ok: false, code: "INVALID_SIZE", message: `尺寸不合法：${size || "(空)"}`, count, diagnostics };
  }

  const model = route?.model;
  if (!model) return { ok: true, count, diagnostics }; // 宽松路径

  if (model.kind !== route.kind) {
    return {
      ok: false,
      code: "MODEL_KIND_MISMATCH",
      message: `模型 ${model.id} 类型为 ${model.kind}，不能用于 ${route.kind}`,
      count,
      diagnostics
    };
  }

  if (mode && Array.isArray(model.modes) && model.modes.length && !model.modes.includes(mode)) {
    return {
      ok: false,
      code: "MODE_NOT_SUPPORTED",
      message: `模型 ${model.id} 不支持 ${mode}（支持：${model.modes.join(" / ")}）`,
      count,
      diagnostics
    };
  }

  if (Array.isArray(model.sizes) && model.sizes.length && !model.sizes.includes(String(size).trim())) {
    return {
      ok: false,
      code: "SIZE_NOT_ALLOWED",
      message: `模型 ${model.id} 不支持尺寸 ${size}（可选：${model.sizes.join(" / ")}）`,
      count,
      diagnostics
    };
  }

  if (model.maxCount > 0 && count > model.maxCount) {
    return {
      ok: false,
      code: "COUNT_TOO_LARGE",
      message: `模型 ${model.id} 单次最多 ${model.maxCount} 张（请求 ${count}）`,
      count,
      diagnostics
    };
  }

  if (model.maxRefImages > 0 && referenceCount > model.maxRefImages) {
    return {
      ok: false,
      code: "TOO_MANY_REFERENCES",
      message: `模型 ${model.id} 最多接受 ${model.maxRefImages} 张参考图（请求 ${referenceCount}）`,
      count,
      diagnostics
    };
  }

  return { ok: true, count, diagnostics };
}
