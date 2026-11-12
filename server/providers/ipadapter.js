// ComfyUI IPAdapter 多图融合（G6）
//
// 2026-09-25 之前：多张参考图只有 names[0] 进了 LoadImage，其余白传。
// 用户选了 4 张图以为都参与生成，实际只有第一张生效 —— 这是"看着能用其实没用"的典型。
//
// 设计取舍（三条，都是被真实环境逼出来的）：
//
// 1. **绝不硬编码节点签名。** ComfyUI_IPAdapter_plus 每个大版本改名改参：
//    `IPAdapterApply`（老，不吃 model）/ `IPAdapter`（新，吃 model）/ `IPAdapterSimple` /
//    XLabs 的 `ApplyFluxIPAdapter`（weight 改叫 strength）。硬写一套参数 = 换个插件版本全线崩。
//    所以这里一律从 /object_info 读真实签名，按 input 名匹配、按 output 数组查端口索引。
//
// 2. **只挑「吃 model」的 apply 节点做链式串联。** 多图融合的实现方式是把
//    model → IPAdapter(图1) → IPAdapter(图2) → ... → KSampler 串成链。
//    老版 IPAdapterApply 没有 model 输入，串不起来（它输出的是独立的 patch model，
//    没法叠加），所以优先用带 model 的；实在没有才降级。
//
// 3. **按架构选 apply 节点。** SD1.5/SDXL 的 IPAdapter 生态成熟；而 Z-Image / Flux / Qwen
//    这类 DiT 用传统 IPAdapter 会直接报维度不匹配。这类 profile 只有检测到专用节点
//    （如 XLabs 的 ApplyFluxIPAdapter）才启用，否则诚实降级 —— 宁可少融合，不要跑一半报错。
import { loadConfig } from "../config.js";

/** 取某个节点的输入规格（required 优先，其次 optional） */
export function inputSpec(objectInfo, cls, key) {
  const node = objectInfo?.[cls];
  if (!node) return null;
  const req = node.input?.required || {};
  const opt = node.input?.optional || {};
  return key in req ? req[key] : key in opt ? opt[key] : null;
}

export function requiredKeys(objectInfo, cls) {
  return Object.keys(objectInfo?.[cls]?.input?.required || {});
}

/** 下拉/列表类型的可选值数组 */
export function listOption(objectInfo, cls, key) {
  const spec = inputSpec(objectInfo, cls, key);
  return Array.isArray(spec?.[0]) ? spec[0] : [];
}

/**
 * 从 object_info 的输出数组里按**类型名**查端口下标。
 * 不能直接写 [id, 0] —— UnifiedLoader 输出是 MODEL/IPADAPTER/CLIP_VISION 三口，
 * 下标写死必错。
 */
export function outIndex(objectInfo, cls, type) {
  const outs = objectInfo?.[cls]?.output || [];
  const normalized = outs.map((o) => (Array.isArray(o) ? o[0] : o));
  const i = normalized.indexOf(type);
  return i >= 0 ? i : 0;
}

/** 从 object_info 的输入 spec 推断一个安全默认值 */
export function defaultValueOf(spec) {
  if (!Array.isArray(spec)) return null;
  const [head, meta] = spec;
  if (Array.isArray(head)) {
    if (typeof meta?.default === "string" && head.includes(meta.default)) return meta.default;
    return head[0];
  }
  if (head === "INT" || head === "FLOAT") return typeof meta?.default === "number" ? meta.default : 0;
  if (head === "STRING") return typeof meta?.default === "string" ? meta.default : "";
  if (head === "BOOLEAN") return typeof meta?.default === "boolean" ? meta.default : false;
  return null;
}

// SD1.5 / SDXL 的标准 IPAdapter 生态
const SD_APPLIES = ["IPAdapter", "IPAdapterSimple", "IPAdapterApplyV2", "IPAdapterApply"];
// DiT 类（Flux / Z-Image / Qwen）专用：它的文本编码器和 SD 完全不是一路，
// 拿 SD 的 IPAdapter 直接插会维度不匹配。所以这里不把 SD_APPLIES 混进来。
const DIT_APPLIES = ["ApplyFluxIPAdapter", "IPAdapterApplyFlux", "IPAdapterApplyProtected"];
const LOADERS = ["IPAdapterModelLoader", "IPAdapterLoader"];
const CV_LOADERS = ["CLIPVisionLoader", "CLIPVisionLoaderModel"];
const DIT_PRESET = /flux|zimage|z_image|qwen/i;

function unavailable(reason) {
  return { available: false, reason, applyClass: "", loaderClass: "", unified: "", clipVisionClass: "" };
}

/**
 * 探测本机的 IPAdapter 能力。
 * @param {object} objectInfo GET /object_info 的原始返回
 * @param {{arch?: "unet"|"checkpoint"}} opts
 */
export function detectIPAdapter(objectInfo, opts = {}) {
  const info = objectInfo || {};
  if (!info || typeof info !== "object") return unavailable("无法读取 ComfyUI 节点清单");

  const arch = opts.arch === "unet" ? "unet" : "checkpoint";
  const canChain = (c) => {
    if (!info[c]) return false;
    const req = requiredKeys(info, c);
    return req.includes("model") && req.includes("image");
  };

  // 先看加载器：UnifiedLoader 的 preset 列表能反推出「这个插件认不认得当前架构」
  const unified = info.IPAdapterUnifiedLoader ? "IPAdapterUnifiedLoader" : "";
  const presets = unified ? listOption(info, unified, "preset") : [];

  let applyClass = (arch === "unet" ? DIT_APPLIES : SD_APPLIES).find(canChain) || "";

  // DiT 兜底：没有专用 apply 节点，但机器上躺着本架构的 preset
  //（如 ip-adapter-plus_flux_vit-h），说明这个插件版本是认得这类模型的。
  if (!applyClass && arch === "unet" && presets.some((p) => DIT_PRESET.test(p))) {
    applyClass = SD_APPLIES.find(canChain) || "";
  }

  if (!applyClass) {
    return arch === "unet"
      ? unavailable("当前是 DiT 类模型（Flux / Z-Image / Qwen），缺少专用融合节点或对应的 IPAdapter preset，已按单张参考图处理")
      : unavailable("未检测到 IPAdapter 节点（需安装 ComfyUI_IPAdapter_plus）");
  }

  const applyKeys = requiredKeys(info, applyClass);
  const needsIPAdapter = applyKeys.includes("ipadapter");
  const needsClipVision = applyKeys.includes("clip_vision");

  // ---- 模型加载：UnifiedLoader 的 preset 已在上面读过，这里只补非 Unified 的情况 ----
  let loaderClass = "";
  let ipadFiles = [];

  if (!unified) {
    loaderClass = LOADERS.find((c) => info[c]) || "";
    if (!loaderClass) return unavailable("未检测到 IPAdapter 模型加载节点");
    ipadFiles = listOption(info, loaderClass, "ipadapter_file");
    if (!ipadFiles.length) return unavailable("models/ipadapter 目录下没有模型文件");
  }

  // ---- CLIP Vision：UnifiedLoader 自带；否则要看机器上有没有 ----
  let clipVisionClass = "";
  let clipVisionModels = [];
  if (needsClipVision) {
    if (unified) {
      clipVisionClass = unified;
    } else {
      clipVisionClass = CV_LOADERS.find((c) => info[c]) || "";
      if (!clipVisionClass) return unavailable("缺少 CLIPVisionLoader 节点");
      clipVisionModels = listOption(info, clipVisionClass, "clip_name");
      if (!clipVisionModels.length) return unavailable("未放置 CLIP Vision 模型（models/clip_vision）");
    }
  }

  return {
    available: true,
    applyClass,
    loaderClass,
    unified,
    clipVisionClass,
    needsIPAdapter,
    needsClipVision,
    ipadFiles,
    presets,
    clipVisionModels,
    reason: ""
  };
}

/** 按 profile 挑一个最合适的 ipadapter 模型（SDXL 用 plus_sdxl，Flux 用 flux 专用） */
export function pickIPAdapterModel(cap, { profileId = "", preferred = "" } = {}) {
  const list = cap.unified ? cap.presets : cap.ipadFiles;
  if (!list.length) return "";
  if (preferred && list.includes(preferred)) return preferred;

  const kw = /flux/i.test(profileId) ? "flux" : /sd15|sd1\.5|sd_1/i.test(profileId) ? "sd15" : "plus";
  return list.find((f) => f.toLowerCase().includes(kw)) || list.find((f) => /plus/.test(f)) || list[0];
}

/** 多图权重递减：第一张最强，后面依次降，但不低于 0.3（再低等于没融合） */
export function weightsFor(count, base = 0.85, decay = 0.8, min = 0.3) {
  return Array.from({ length: Math.max(count, 0) }, (_, i) =>
    Number(Math.max(min, base * decay ** i).toFixed(3))
  );
}

/**
 * 把 IPAdapter 链插进 workflow，返回给 KSampler 用的最终 model 引用。
 * @returns {{modelOut: any[], nodes: string[], weights: number[], used: number}}
 */
export function appendIPAdapter({
  objectInfo,
  wf,
  capability,
  modelSrc,
  imageRefs = [],
  startId = 50,
  baseWeight = 0.85,
  ipadapterFile = "",
  clipVisionModel = ""
} = {}) {
  const cap = capability;
  if (!cap?.available || !imageRefs.length) {
    return { modelOut: modelSrc, nodes: [], weights: [], used: 0 };
  }
  const info = objectInfo || {};
  let cursor = Number(startId) || 50;
  const nextId = () => String(cursor++);
  const created = [];

  // ---- 1. 加载 ipadapter 模型（顺便可能顺出 clip vision） ----
  let baseModel = modelSrc;
  let ipadapterRef = null;
  let clipVisionRef = null;

  if (cap.unified) {
    const id = nextId();
    const req = info[cap.unified].input.required || {};
    const inputs = {};
    for (const k of Object.keys(req)) {
      if (k === "model") inputs.model = modelSrc;
      else if (k === "preset") inputs.preset = ipadapterFile || pickIPAdapterModel(cap);
      else inputs[k] = defaultValueOf(req[k]);
    }
    wf[id] = { class_type: cap.unified, inputs };
    created.push(id);
    baseModel = [id, outIndex(info, cap.unified, "MODEL")];
    ipadapterRef = [id, outIndex(info, cap.unified, "IPADAPTER")];
    clipVisionRef = [id, outIndex(info, cap.unified, "CLIP_VISION")];
  } else {
    if (cap.loaderClass && cap.needsIPAdapter) {
      const id = nextId();
      const req = info[cap.loaderClass].input.required || {};
      const inputs = {};
      for (const k of Object.keys(req)) {
        inputs[k] = k === "ipadapter_file" ? ipadapterFile || pickIPAdapterModel(cap) : defaultValueOf(req[k]);
      }
      wf[id] = { class_type: cap.loaderClass, inputs };
      created.push(id);
      ipadapterRef = [id, outIndex(info, cap.loaderClass, "IPADAPTER")];
    }
    if (cap.clipVisionClass && cap.needsClipVision) {
      const id = nextId();
      const req = info[cap.clipVisionClass].input.required || {};
      const inputs = {};
      for (const k of Object.keys(req)) {
        inputs[k] = k === "clip_name" ? clipVisionModel || cap.clipVisionModels[0] : defaultValueOf(req[k]);
      }
      wf[id] = { class_type: cap.clipVisionClass, inputs };
      created.push(id);
      clipVisionRef = [id, outIndex(info, cap.clipVisionClass, "CLIP_VISION")];
    }
  }

  // ---- 2. 每张图一个 apply 节点，model 串成链 ----
  const weights = weightsFor(imageRefs.length, baseWeight);
  let modelRef = baseModel;

  imageRefs.forEach((imgRef, i) => {
    const id = nextId();
    const req = info[cap.applyClass].input.required || {};
    const inputs = {};
    for (const k of Object.keys(req)) {
      if (k === "model") inputs.model = modelRef;
      else if (k === "ipadapter") inputs.ipadapter = ipadapterRef;
      else if (k === "clip_vision") inputs.clip_vision = clipVisionRef;
      else if (k === "image") inputs.image = imgRef;
      // XLabs 系列把权重叫 strength / amount，老节点叫 weight
      else if (k === "weight" || k === "strength" || k === "amount") inputs[k] = weights[i];
      else if (k === "start_at") inputs.start_at = 0;
      else if (k === "end_at") inputs.end_at = 1;
      else inputs[k] = defaultValueOf(req[k]);
    }
    wf[id] = { class_type: cap.applyClass, inputs };
    created.push(id);
    modelRef = [id, outIndex(info, cap.applyClass, "MODEL")];
  });

  return { modelOut: modelRef, nodes: created, weights, used: imageRefs.length };
}

/** 给用户看的降级文案（不是报错，是说明"现在是怎么处理的"） */
export function fallbackMessage(refCount, capability) {
  if (!refCount) return "";
  if (capability?.available) return "";
  const reason = capability?.reason || "未知原因";
  return `已上传 ${refCount} 张参考图，本次仅取第一张作底图：${reason}。多图融合可在设置里指定 IPAdapter 模型后再试。`;
}

/** 从 config 读用户手动指定的模型（留了人工兜底，别让用户被自动探测锁死） */
export function configuredModels() {
  const c = loadConfig()?.comfyui || {};
  return {
    ipadapterFile: c.ipadapterModel || "",
    clipVisionModel: c.clipVisionModel || ""
  };
}
