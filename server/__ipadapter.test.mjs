/**
 * 第 12 套件：ComfyUI IPAdapter 多图融合（2026-09-25）
 * --------------------------------------------------------------------------
 * 这条要防的 bug 很具体：**用户选了 4 张参考图，实际只有第一张进了模型**。
 * 界面不报错、流程照走、钱照扣 —— 只是剩下 3 张白传了。这类"静默降级"
 * 必须靠结构断言锁住，肉眼 review 是看不出来的。
 *
 * 全程喂假的 /object_info，不依赖真实 ComfyUI：
 *   1. 能力探测：谁能用、谁不能用、为什么不能用（reason 要能给用户看）
 *   2. 端口寻址：按 output 名字查下标，不能写死 [id, 0]
 *   3. 链式结构：N 张图 → N 个 apply 节点，model 首尾相接
 *   4. 端到端：buildWorkflow 产出的图里 KSampler 的 model 必须指向融合链末端
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ipadapter-test-"));
process.env.AI_CANVAS_HOME = HOME;
process.env.AI_CANVAS_VAULT = "file";
process.env.AI_CANVAS_OUTPUTS = path.join(HOME, "outputs");

const IP = await import("./providers/ipadapter.js");
const { buildWorkflow } = await import("./providers/comfyui.js");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ---------- 假 /object_info ----------
// 字段结构照抄真实 ComfyUI：[规格] 第一项是类型或候选列表，第二项是约束
const nodeSpec = (required, output) => ({ input: { required, optional: {} }, output });

/** SDXL + 标准 IPAdapter_plus（新版 IPAdapter 带 model 输入） */
// 注意 SD_INFO 里的 IPAdapter **故意不带 clip_vision 输入**：新版 IPAdapter_plus 的
// IPADAPTER 对象本身就携带了 CLIP Vision，再单独喂一个反而是多余节点。
// 这两种形态在真实环境里都存在，所以下面另建 CV_INFO 覆盖「必须显式喂 CLIP Vision」的分支。
const SD_INFO = {
  ImageScale: nodeSpec({}, ["IMAGE"]),
  CheckpointLoaderSimple: nodeSpec({ ckpt_name: [["sd_xl_base_1.0.safetensors"]] }, ["MODEL", "CLIP", "VAE"]),
  IPAdapter: nodeSpec(
    {
      model: ["MODEL", {}],
      ipadapter: ["IPADAPTER", {}],
      image: ["IMAGE", {}],
      weight: ["FLOAT", { default: 1.0 }],
      start_at: ["FLOAT", { default: 0.0 }],
      end_at: ["FLOAT", { default: 1.0 }],
      weight_type: [["standard", "prompt is more important"], { default: "standard" }],
      combine_embeds: [["concat", "add", "average"], { default: "concat" }]
    },
    ["MODEL"]
  ),
  IPAdapterModelLoader: nodeSpec(
    { ipadapter_file: [["ip-adapter-plus_sdxl_vit-h.safetensors", "ip-adapter-plus-face_sdxl_vit-h.safetensors"], {}] },
    ["IPADAPTER"]
  ),
  CLIPVisionLoader: nodeSpec({ clip_name: [["CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"], {}] }, ["CLIP_VISION"])
};

/** 有些插件版本的 apply 节点要把 CLIP Vision 显式喂进去（这条分支也得能跑通） */
const { IPAdapter: _unusedSdApply, ...SD_INFO_BASE } = SD_INFO;
const CV_INFO = {
  ...SD_INFO_BASE,
  IPAdapterApplyV2: nodeSpec(
    {
      model: ["MODEL", {}],
      ipadapter: ["IPADAPTER", {}],
      clip_vision: ["CLIP_VISION", {}],
      image: ["IMAGE", {}],
      weight: ["FLOAT", { default: 1.0 }]
    },
    ["MODEL"]
  )
};

/** 只有老版 IPAdapterApply：它不吃 model，串不起来 */
const LEGACY_ONLY_INFO = {
  ImageScale: nodeSpec({}, ["IMAGE"]),
  // 只有 SD 场景会挑它，但没有 model 输入 → 必须判为不可用，否则永远只能融一张
  IPAdapterApply: nodeSpec(
    { ipadapter: ["IPADAPTER", {}], clip_vision: ["CLIP_VISION", {}], image: ["IMAGE", {}], weight: ["FLOAT", { default: 1 }] },
    ["MODEL"]
  ),
  IPAdapterModelLoader: nodeSpec({ ipadapter_file: [["ip-adapter-plus_sdxl_vit-h.safetensors"], {}] }, ["IPADAPTER"]),
  CLIPVisionLoader: nodeSpec({ clip_name: [["CLIP-ViT-H-14.safetensors"], {}] }, ["CLIP_VISION"])
};

/** UnifiedLoader 一步到位（自带 model / ipadapter / clip_vision 三出口） */
const UNIFIED_INFO = {
  ...SD_INFO,
  IPAdapterUnifiedLoader: nodeSpec(
    {
      model: ["MODEL", {}],
      preset: [["PLUS (high strength)", "PLUS FACE (portraits)", "LIGHT - SDXL (low strength)"], {}]
    },
    ["MODEL", "IPADAPTER", "CLIP_VISION"]
  )
};

/** XLabs Flux 专用：权重参数改叫 strength，不用 weight */
const FLUX_INFO = {
  ApplyFluxIPAdapter: nodeSpec(
    { model: ["MODEL", {}], ipadapter: ["IPADAPTER", {}], image: ["IMAGE", {}], strength: ["FLOAT", { default: 0.8 }] },
    ["MODEL"]
  ),
  IPAdapterUnifiedLoader: nodeSpec(
    { model: ["MODEL", {}], preset: [["ip-adapter-plus_flux_vit-h.safetensors"], {}] },
    ["MODEL", "IPADAPTER", "CLIP_VISION"]
  )
};

const SD_PROFILE = {
  id: "checkpoint",
  label: "SDXL Base",
  checkpoint: "sd_xl_base_1.0.safetensors",
  defaults: { steps: 24, cfg: 6.5, sampler: "euler", scheduler: "normal", negative: true }
};

console.log("\n[1] 能力探测");
{
  const cap = IP.detectIPAdapter(SD_INFO, { arch: "checkpoint" });
  check("SDXL 标准环境判定为可用", cap.available === true, JSON.stringify(cap.reason));
  check("选用带 model 输入的 IPAdapter 节点", cap.applyClass === "IPAdapter", cap.applyClass);
  check("识别出 IPADAPTER 模型加载器", cap.loaderClass === "IPAdapterModelLoader");
  // 新版 IPAdapter 的 IPADAPTER 对象自带 CLIP Vision，不需要再单独加载
  check("不需要 CLIP Vision 的版本不指定加载器", cap.clipVisionClass === "", cap.clipVisionClass);
  const cv = IP.detectIPAdapter(CV_INFO, { arch: "checkpoint" });
  check("需要 CLIP Vision 的版本识别出 CLIPVisionLoader", cv.clipVisionClass === "CLIPVisionLoader", cv.clipVisionClass);
  check("需要时才把可选模型列表读出来", cv.clipVisionModels.length === 1, String(cv.clipVisionModels.length));

  const legacy = IP.detectIPAdapter(LEGACY_ONLY_INFO, { arch: "checkpoint" });
  check("只有老版 IPAdapterApply（无 model 输入）时判为不可用", legacy.available === false);
  check("降级原因对人可读", /IPAdapter/.test(legacy.reason || ""), legacy.reason);

  const uni = IP.detectIPAdapter(UNIFIED_INFO, { arch: "checkpoint" });
  check("UnifiedLoader 场景可用", uni.available === true, uni.reason);
  check("UnifiedLoader 下读出 3 个 preset", uni.presets.length === 3, String(uni.presets.length));
}

console.log("\n[2] 缺件要挡住，且说清楚缺什么");
{
  const noModelInfo = { ...SD_INFO, IPAdapterModelLoader: nodeSpec({ ipadapter_file: [[]] }, ["IPADAPTER"]) };
  const a = IP.detectIPAdapter(noModelInfo, { arch: "checkpoint" });
  check("ipadapter 模型列表为空 → 不可用", a.available === false);
  check("原因点名 models/ipadapter", /ipadapter/i.test(a.reason), a.reason);

  const d = IP.detectIPAdapter(null, { arch: "checkpoint" });
  check("objectInfo 为 null 不抛异常", d.available === false);

  // 需要显式喂 CLIP Vision 的版本：缺了就得挡住
  const { CLIPVisionLoader: _cv, ...noCv } = CV_INFO;
  const e = IP.detectIPAdapter(noCv, { arch: "checkpoint" });
  check("需 CLIP Vision 的版本缺了加载器 → 不可用", e.available === false);
  check("原因点名 CLIPVisionLoader", /CLIPVisionLoader/.test(e.reason), e.reason);

  const noCvModel = { ...CV_INFO, CLIPVisionLoader: nodeSpec({ clip_name: [[]] }, ["CLIP_VISION"]) };
  const f = IP.detectIPAdapter(noCvModel, { arch: "checkpoint" });
  check("CLIP Vision 模型没放 → 不可用", f.available === false);
  check("原因点名 clip_vision 目录", /clip_vision/i.test(f.reason), f.reason);
}

console.log("\n[3] DiT 架构不许硬套 SD 的 IPAdapter");
{
  // Flux 机器上只有通用 IPAdapter（没有 flux preset）→ 不能用，否则维度不匹配直接跑崩
  const a = IP.detectIPAdapter(SD_INFO, { arch: "unet" });
  check("DiT 架构 + 只有 SD 通用节点 → 判为不可用", a.available === false);
  check("降级文案指明是 DiT 类模型", /DiT|Flux/.test(a.reason), a.reason);

  // 有 flux preset，说明这个插件版本认得 flux → 放行通用 apply 节点
  const withFluxPreset = {
    ...SD_INFO,
    IPAdapterUnifiedLoader: nodeSpec(
      { model: ["MODEL", {}], preset: [["ip-adapter-plus_flux_vit-h.safetensors"], {}] },
      ["MODEL", "IPADAPTER", "CLIP_VISION"]
    )
  };
  const b = IP.detectIPAdapter(withFluxPreset, { arch: "unet" });
  check("DiT + 存在本架构 preset → 放行融合", b.available === true, b.reason);

  const c = IP.detectIPAdapter(FLUX_INFO, { arch: "unet" });
  check("DiT 专用节点 ApplyFluxIPAdapter 可用", c.available === true, c.reason);
  check("专用节点被选中而非通用节点", c.applyClass === "ApplyFluxIPAdapter", c.applyClass);
}

console.log("\n[4] 端口寻址不能写死下标");
{
  const info = UNIFIED_INFO;
  check("UnifiedLoader 的 MODEL 口是 0", IP.outIndex(info, "IPAdapterUnifiedLoader", "MODEL") === 0);
  check("UnifiedLoader 的 IPADAPTER 口是 1", IP.outIndex(info, "IPAdapterUnifiedLoader", "IPADAPTER") === 1);
  check("UnifiedLoader 的 CLIP_VISION 口是 2", IP.outIndex(info, "IPAdapterUnifiedLoader", "CLIP_VISION") === 2);
  check("查不到的类型安全回退到 0（不越界）", IP.outIndex(info, "IPAdapterUnifiedLoader", "INSIGHTFACE") === 0);
}

console.log("\n[5] 多图权重递减但不失力");
{
  const w = IP.weightsFor(4);
  check("张数对应权重个数", w.length === 4);
  check("权重严格递减", w[0] > w[1] && w[1] > w[2] && w[2] > w[3], JSON.stringify(w));
  check("最低权重保底 0.3（再低等于没融合）", w[3] >= 0.3, String(w[3]));
  check("首张权重不低于 0.8（太弱没效果）", w[0] >= 0.8, String(w[0]));
  check("单张就是基准值", IP.weightsFor(1)[0] === 0.85);
}

console.log("\n[6] 链式结构：N 张图 → N 个 apply，model 首尾相接");
{
  const cap = IP.detectIPAdapter(SD_INFO, { arch: "checkpoint" });
  const wf = {};
  const imageRefs = [["40", 0], ["43", 0], ["44", 0]];
  const out = IP.appendIPAdapter({
    objectInfo: SD_INFO,
    wf,
    capability: cap,
    modelSrc: ["4", 0],
    imageRefs,
    startId: 50
  });
  check("产出了 3 个 apply 节点", out.used === 3, String(out.used));
  const applies = Object.keys(wf).filter((k) => wf[k].class_type === "IPAdapter");
  check("workflow 里 IPAdapter 类型节点为 3 个", applies.length === 3, String(applies.length));
  check("存在 IPADAPTER 模型加载节点", Object.values(wf).some((n) => n.class_type === "IPAdapterModelLoader"));
  check("ipadapter_file 被真的填进去了", Object.values(wf).some((n) => n.class_type === "IPAdapterModelLoader" && n.inputs.ipadapter_file));
  // 新版 IPAdapter 的 IPADAPTER 对象自带 CLIP Vision，多挂一个 CLIPVisionLoader 是废节点
  check("不需要 CLIP Vision 的版本不生成多余节点", !Object.values(wf).some((n) => n.class_type === "CLIPVisionLoader"));

  // 链的起点应该接外部传入的 model
  const firstApply = wf[applies[0]] || wf["50"];
  const chainIds = Object.keys(wf).filter((k) => wf[k].class_type === "IPAdapter").sort();
  check("第一个 apply 的 model 接的是原始 model", String(wf[chainIds[0]].inputs.model) === "4,0", String(wf[chainIds[0]].inputs.model));
  check("第二个 apply 的 model 接第一个 apply 的输出", wf[chainIds[1]].inputs.model[0] === chainIds[0], String(wf[chainIds[1]].inputs.model));
  check("第三个 apply 的 model 接第二个 apply 的输出", wf[chainIds[2]].inputs.model[0] === chainIds[1], String(wf[chainIds[2]].inputs.model));
  check("返回的 modelOut 指向链末端", out.modelOut[0] === chainIds[2], String(out.modelOut));

  // 每张图都必须被引用到，不能有图白传
  const usedImageRefs = Object.values(wf)
    .filter((n) => n.class_type === "IPAdapter")
    .map((n) => String(n.inputs.image));
  check("3 张参考图全部被引用", imageRefs.every((r) => usedImageRefs.includes(String(r))), JSON.stringify(usedImageRefs));

  // 反过来：apply 节点要 CLIP Vision 时，必须真的把它加载出来并接上
  const cvCap = IP.detectIPAdapter(CV_INFO, { arch: "checkpoint" });
  const cvWf = {};
  IP.appendIPAdapter({ objectInfo: CV_INFO, wf: cvWf, capability: cvCap, modelSrc: ["4", 0], imageRefs, startId: 50 });
  const cvNode = Object.values(cvWf).find((n) => n.class_type === "CLIPVisionLoader");
  check("需要 CLIP Vision 时生成了加载节点", Boolean(cvNode));
  check("加载节点的 clip_name 不是空值", Boolean(cvNode?.inputs?.clip_name), JSON.stringify(cvNode?.inputs));
  const cvApplies = Object.keys(cvWf).filter((k) => cvWf[k].class_type === "IPAdapterApplyV2");
  check("每个 apply 都接到了同一个 CLIP Vision", cvApplies.every((k) => Boolean(cvWf[k].inputs.clip_vision)), String(cvApplies.length));

  const noCap = IP.appendIPAdapter({ objectInfo: SD_INFO, wf: {}, capability: { available: false }, modelSrc: ["4", 0], imageRefs });
  check("能力不可用时原样返回 model，不偷偷半融合", String(noCap.modelOut) === "4,0" && noCap.used === 0);
}

console.log("\n[7] 端到端：buildWorkflow 产出的图必须真的接上融合链");
{
  const cap = IP.detectIPAdapter(SD_INFO, { arch: "checkpoint" });
  const names = ["a.png", "b.png", "c.png", "d.png"];
  const wf = buildWorkflow(SD_PROFILE, {
    prompt: "a knit sweater",
    width: 1024,
    height: 1024,
    steps: 24,
    cfg: 6.5,
    sampler: "euler",
    scheduler: "normal",
    seed: 42,
    imageNames: names,
    denoise: 0.75,
    hasImageScale: false,
    objectInfo: SD_INFO,
    ipadapter: cap
  });

  const loadImages = Object.values(wf).filter((n) => n.class_type === "LoadImage");
  check("4 张参考图都有 LoadImage 节点", loadImages.length === 4, String(loadImages.length));
  check("每张图的 LoadImage 都指向各自的图片", names.every((n) => Object.values(wf).some((x) => x.class_type === "LoadImage" && x.inputs.image === n)));

  const applies = Object.keys(wf).filter((k) => wf[k].class_type === "IPAdapter");
  check("融合链有 4 个 apply 节点", applies.length === 4, String(applies.length));

  // 关键：KSampler 拿到的 model 必须是链的末端，而不是原始的 checkpoint 输出
  const ksampler = wf["3"];
  check("KSampler 的 model 不是直连 checkpoint", String(ksampler.inputs.model) !== "4,0", String(ksampler.inputs.model));
  check("KSampler 的 model 指向某个 IPAdapter 节点", applies.includes(String(ksampler.inputs.model[0])), String(ksampler.inputs.model));

  // 底图仍然走 VAEEncode（构图/纹理靠它）
  check("第一张图仍作为 img2img 底图", wf["42"]?.class_type === "VAEEncode" && String(wf["42"].inputs.pixels) === "40,0", String(wf["42"]?.inputs?.pixels));
  check("存在 SaveImage 出口", Object.values(wf).some((n) => n.class_type === "SaveImage"));
}

console.log("\n[8] 不该启用的时候坚决不启用");
{
  // 单张参考图：底图通路已经完整表达了它，再叠 IPAdapter 是重复同一张图
  const cap = IP.detectIPAdapter(SD_INFO, { arch: "checkpoint" });
  const one = buildWorkflow(SD_PROFILE, {
    prompt: "x", width: 1024, height: 1024, steps: 24, cfg: 6.5, sampler: "euler", scheduler: "normal", seed: 1,
    imageNames: ["only.png"], hasImageScale: false, objectInfo: SD_INFO, ipadapter: cap
  });
  check("单张参考图不插入 IPAdapter 节点", !Object.values(one).some((n) => n.class_type === "IPAdapter"));
  check("单张时 KSampler 直连 checkpoint", String(one["3"].inputs.model) === "4,0", String(one["3"].inputs.model));

  // 能力不可用：必须干净降级，不能半途出错也不能静默白传
  const broken = buildWorkflow(SD_PROFILE, {
    prompt: "x", width: 1024, height: 1024, steps: 24, cfg: 6.5, sampler: "euler", scheduler: "normal", seed: 1,
    imageNames: ["a.png", "b.png"], hasImageScale: false, objectInfo: SD_INFO, ipadapter: { available: false }
  });
  check("能力不可用时仍保留全部 LoadImage（图已上传就别浪费）", Object.values(broken).filter((n) => n.class_type === "LoadImage").length === 2);
  check("能力不可用时 model 安全回落", String(broken["3"].inputs.model) === "4,0", String(broken["3"].inputs.model));
  check("降级时 SaveImage 链路完整", Boolean(broken["8"] && broken["9"]));
}

console.log("\n[9] 给用户看的话要能读");
{
  check("可用时不产生降级提示", IP.fallbackMessage(3, { available: true }) === "");
  const msg = IP.fallbackMessage(3, { available: false, reason: "缺少 CLIPVisionLoader 节点" });
  check("降级提示说清上传了几张", /3 张/.test(msg), msg);
  check("降级提示带上真实原因", /CLIPVisionLoader/.test(msg), msg);
  check("降级提示给出下一步", /设置|再试/.test(msg), msg);
  check("没有参考图时不啰嗦", IP.fallbackMessage(0, { available: false }) === "");
}

console.log(`\n  通过 ${pass} 项，失败 ${fail} 项`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
