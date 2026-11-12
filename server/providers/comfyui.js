// ComfyUI 本地工作流（自动探测模型类型，支持 Z-Image / Flux2-Klein / Qwen-Image / SD checkpoint）
// API 文档: https://docs.comfy.org/tutorials/api/overview
//
// 2026-09-25 P0-0：新增真实图生图通路。
// 之前这里只发文本 prompt —— 用户上传的毛衫图从未进入模型，
// 「保留杏色底色 + 印花区域 + 针织纹理」根本做不到。
// 现在：本地文件 → ComfyUI /upload/image → LoadImage + VAEEncode → KSampler(denoise=强度)
import { loadConfig } from "../config.js";
import { sleep } from "../tasks.js";
// 路径校验 / 体积上限 / 读取统一走 refimage.js，跟四家云端 provider 同一套规则，
// 免得本地通道和云端通道两套标准（同一个 url 一边拦住一边放行是真实会发生的事故）。
import { resolveLocalFile, loadReferences } from "./refimage.js";
// G6：多参考图融合。单独拆文件是为了能脱离 ComfyUI 进程单测 ——
// 它全是纯函数，喂一份假的 /object_info 就能验工作流结构。
import { detectIPAdapter, appendIPAdapter, configuredModels, fallbackMessage } from "./ipadapter.js";

async function api(baseUrl, pathname, init) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${pathname}`, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ComfyUI ${pathname} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ---------- 模型档案（按已验证的组合构建标准文生图工作流） ----------
// KSampler/CLIP 组合来自本机 ComfyUI 生产工作流的验证值
const find = (list, needle) => (list || []).find((n) => n.toLowerCase().includes(needle));
const preferExact = (list, exactSub) => (list || []).find((n) => n.toLowerCase() === exactSub) || find(list, exactSub);

function buildProfiles(objectInfo) {
  const unets = objectInfo?.UNETLoader?.input?.required?.unet_name?.[0] || [];
  const vaes = objectInfo?.VAELoader?.input?.required?.vae_name?.[0] || [];
  const clips = objectInfo?.CLIPLoader?.input?.required?.clip_name?.[0] || [];
  const ckpts = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];

  const profiles = [];

  // Z-Image Turbo（Qwen3-4B 文本编码器）
  {
    const unet = preferExact(unets, "z_image_turbo_bf16.safetensors") || find(unets, "z_image_turbo");
    const vae = find(vaes, "z_image_vae");
    const clip = find(clips, "qwen_3_4b");
    if (unet && vae && clip) {
      profiles.push({
        id: "z-image-turbo",
        label: "Z-Image Turbo",
        available: true,
        defaults: { steps: 8, cfg: 1, sampler: "euler", scheduler: "simple", negative: true },
        unet, vae, clip, clipType: "qwen_image", sampling: { type: "ModelSamplingAuraFlow", shift: 3 }
      });
    }
  }

  // Flux 2 Klein（Qwen3-8B 文本编码器）
  {
    const unet = preferExact(unets, "flux-2-klein-9b-fp8.safetensors") || find(unets, "flux-2-klein");
    const vae = find(vaes, "flux2-vae.safetensors") || find(vaes, "flux2-vae") || find(vaes, "flux2");
    const clip = find(clips, "qwen_3_8b_fp8mixed-f4cf7be12a9a.safetensors") || find(clips, "qwen_3_8b") || find(clips, "qwen_3_4b");
    if (unet && vae && clip) {
      profiles.push({
        id: "flux-2-klein",
        label: "Flux 2 Klein",
        available: true,
        defaults: { steps: 8, cfg: 1, sampler: "dpmpp_sde_gpu", scheduler: "sgm_uniform", negative: true },
        unet, vae, clip, clipType: "qwen_image", sampling: null
      });
    }
  }

  // Qwen-Image 2.5.12（Qwen2.5-VL 文本编码器 + Lightning 加速 LoRA）
  {
    const unet = preferExact(unets, "qwen_image_2512_fp8_e4m3fn.safetensors") || find(unets, "qwen_image_2512");
    const vae = preferExact(vaes, "qwen_image_vae.safetensors") || find(vaes, "qwen_image_vae");
    const clip = preferExact(clips, "qwen_2.5_vl_7b_fp8_scaled.safetensors") || find(clips, "qwen_2.5_vl");
    const loras = objectInfo?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0] || [];
    const lightning = find(loras, "lightning-4steps");
    if (unet && vae && clip) {
      profiles.push({
        id: "qwen-image-2512",
        label: lightning ? "Qwen-Image 2.5.12 ⚡Lightning" : "Qwen-Image 2.5.12",
        available: true,
        defaults: { steps: lightning ? 8 : 25, cfg: 1, sampler: "euler", scheduler: "simple", negative: true },
        unet, vae, clip, clipType: "qwen_image",
        sampling: { type: "ModelSamplingAuraFlow", shift: 3 },
        lora: lightning ? { name: lightning, strength: 1 } : null
      });
    }
  }

  // 传统 SD1.5/SDXL checkpoint
  if (ckpts.length) {
    profiles.push({
      id: "checkpoint",
      label: `Checkpoint（${ckpts[0].slice(0, 24)}…）`,
      available: true,
      defaults: { steps: 24, cfg: 6.5, sampler: "euler", scheduler: "normal", negative: true },
      checkpoint: ckpts[0]
    });
  }

  return profiles;
}

/** 把一张图上传到 ComfyUI 的 input 目录（multipart /upload/image） */
async function uploadToComfy(baseUrl, buf, fileName) {
  const safe = String(fileName || "ref.png").replace(/[^A-Za-z0-9._-]/g, "_");
  const form = new FormData();
  form.append("image", new Blob([buf], { type: "application/octet-stream" }), safe);
  form.append("overwrite", "true");

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/upload/image`, { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ComfyUI 图片上传失败 HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
  const json = await res.json().catch(() => ({}));
  return json.name || safe;
}

/**
 * 准备参考图：先经 refimage.loadReferences 读盘/下载，再逐张上传到 ComfyUI。
 * 返回 ComfyUI input 目录里的文件名数组。
 */
async function prepareReferenceImages(baseUrl, refs = [], onProgress) {
  const loaded = await loadReferences(refs, { max: 4, onProgress }); // 上限 4 张，超了只是浪费带宽
  const names = [];

  for (let i = 0; i < loaded.length; i++) {
    const { buf, name } = loaded[i];
    onProgress?.(`上传参考图 ${i + 1}/${loaded.length}（${name}）…`);
    try {
      names.push(await uploadToComfy(baseUrl, buf, name));
    } catch (e) {
      // 单张上传失败不阻断：至少还能退回文生图
      onProgress?.(`参考图 ${name} 上传失败：${e.message}`);
    }
  }
  return names;
}

function buildWorkflow(profile, opts) {
  const {
    prompt, negativePrompt, width, height, steps, cfg, sampler, scheduler, seed,
    imageNames = [], denoise = 1, hasImageScale = false,
    objectInfo = null, ipadapter = null
  } = opts;
  const wf = {};
  // 第一张仍然是 img2img 的底图（构图/纹理靠它），从第二张起走 IPAdapter 语义融合
  const mainImage = imageNames[0] || "";
  const useDenoise = mainImage ? Math.min(Math.max(Number(denoise) || 0.75, 0.05), 1) : 1;

  /**
   * 建 LoadImage（可选的 ImageScale），返回该图可供下游引用的 [nodeId, port]。
   * 多张时额外图片从 43 号往上排，避开 40/41/42 这三口已被底图占用的编号。
   */
  let extraId = 43;
  const loadRef = (name, { needScale = false } = {}) => {
    const id = needScale ? "40" : String(extraId++);
    wf[id] = { class_type: "LoadImage", inputs: { image: name } };
    let px = [id, 0];
    if (needScale && hasImageScale) {
      wf["41"] = {
        class_type: "ImageScale",
        inputs: { image: px, upscale_method: "lanczos", width, height, crop: "center" }
      };
      px = ["41", 0];
    }
    return px;
  };

  /**
   * 多图融合：把 model 串成 IPAdapter 链。条件不满足就原样返回 model。
   * 只在 ≥2 张时启用 —— 单张已经被底图通路完整表达了，再叠 IPAdapter 只会重复同图。
   */
  const fuseModel = (modelSrc, imageRefs) => {
    if (!ipadapter?.available || imageRefs.length < 2 || !objectInfo) return modelSrc;
    const cfgModels = configuredModels();
    const out = appendIPAdapter({
      objectInfo,
      wf,
      capability: ipadapter,
      modelSrc,
      imageRefs,
      startId: 50,
      ipadapterFile: cfgModels.ipadapterFile,
      clipVisionModel: cfgModels.clipVisionModel
    });
    return out.used ? out.modelOut : modelSrc;
  };

  // 所有参考图先依次 LoadImage；第一张兼作 VAEEncode 的输入
  let imageRefs = [];
  let mainPx = null;
  if (imageNames.length) {
    mainPx = loadRef(mainImage, { needScale: true });
    imageRefs = [mainPx].concat(imageNames.slice(1).map((n) => loadRef(n)));
  }

  if (profile.checkpoint) {
    // ---- 传统 checkpoint 工作流 ----
    wf["4"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: profile.checkpoint } };
    wf["6"] = { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } };
    wf["7"] = { class_type: "CLIPTextEncode", inputs: { text: negativePrompt || "bad quality, lowres, watermark", clip: ["4", 1] } };

    let latent;
    if (mainPx) {
      wf["42"] = { class_type: "VAEEncode", inputs: { pixels: mainPx, vae: ["4", 2] } };
      latent = ["42", 0];
    } else {
      wf["5"] = { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } };
      latent = ["5", 0];
    }

    const model = fuseModel(["4", 0], imageRefs);
    wf["3"] = {
      class_type: "KSampler",
      inputs: {
        seed, steps, cfg, sampler_name: sampler, scheduler, denoise: useDenoise,
        model, positive: ["6", 0], negative: ["7", 0], latent_image: latent
      }
    };
    wf["8"] = { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } };
    wf["9"] = { class_type: "SaveImage", inputs: { filename_prefix: "ai_canvas", images: ["8", 0] } };
    return wf;
  }

  // ---- UNET 架构工作流（Z-Image / Flux2 / Qwen-Image）----
  let modelSrc;
  wf["10"] = { class_type: "UNETLoader", inputs: { unet_name: profile.unet, weight_dtype: "default" } };
  modelSrc = ["10", 0];

  if (profile.lora) {
    wf["11"] = { class_type: "LoraLoaderModelOnly", inputs: { lora_name: profile.lora.name, strength_model: profile.lora.strength, model: modelSrc } };
    modelSrc = ["11", 0];
  }

  if (profile.sampling) {
    wf["12"] = { class_type: profile.sampling.type, inputs: { model: modelSrc, shift: profile.sampling.shift } };
    modelSrc = ["12", 0];
  }

  wf["20"] = { class_type: "CLIPLoader", inputs: { clip_name: profile.clip, type: profile.clipType, device: "default" } };
  wf["21"] = { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["20", 0] } };
  wf["22"] = { class_type: "CLIPTextEncode", inputs: { text: negativePrompt || "", clip: ["20", 0] } };
  wf["23"] = { class_type: "VAELoader", inputs: { vae_name: profile.vae } };

  let latent;
  if (mainPx) {
    wf["42"] = { class_type: "VAEEncode", inputs: { pixels: mainPx, vae: ["23", 0] } };
    latent = ["42", 0];
  } else {
    wf["24"] = { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } };
    latent = ["24", 0];
  }

  const model = fuseModel(modelSrc, imageRefs);
  wf["30"] = {
    class_type: "KSampler",
    inputs: {
      seed, steps, cfg, sampler_name: sampler, scheduler, denoise: useDenoise,
      model, positive: ["21", 0], negative: ["22", 0], latent_image: latent
    }
  };
  wf["31"] = { class_type: "VAEDecode", inputs: { samples: ["30", 0], vae: ["23", 0] } };
  wf["32"] = { class_type: "SaveImage", inputs: { filename_prefix: "ai_canvas", images: ["31", 0] } };
  return wf;
}

/** 方便测试直接验工作流结构（生产入口仍是 generate） */
export { buildWorkflow };

export async function status() {
  const { comfyui } = loadConfig();
  try {
    const info = await api(comfyui.baseUrl, "/object_info");
    const profiles = buildProfiles(info);
    const selected = comfyui.profile || profiles[0]?.id || "";
    const sel = profiles.find((p) => p.id === selected);
    // 多图融合能不能用是随架构变的：SD 生态成熟，DiT（Flux/Z-Image/Qwen）得有专用节点。
    // 所以这里不能笼统回答"有/没有"，必须绑定当前选中的模型来讲。
    const ipadapter = detectIPAdapter(info, { arch: sel?.checkpoint ? "checkpoint" : "unet" });
    return {
      ok: true,
      baseUrl: comfyui.baseUrl,
      profiles,
      selected,
      ipadapter
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl: comfyui.baseUrl,
      profiles: [],
      selected: "",
      ipadapter: { available: false, reason: error.message },
      error: error.message
    };
  }
}

export async function generate({
  prompt, negativePrompt, size, n, steps, cfg,
  referenceImages = [], strength = 0, printArea = "auto", keepTexture = true,
  onProgress,
  signal = null, registerCancel = null
}) {
  const { comfyui } = loadConfig();
  const [width, height] = size.toLowerCase().split("x").map(Number);

  // 取消钩子：ComfyUI 靠 /interrupt 真正停 GPU。
  // 光 abort 掉我们这条 fetch 没用 —— ComfyUI 会照常把这张图算完，
  // 队列也还占着，用户点的「取消」等于没点。
  let currentPromptId = "";
  registerCancel?.(async () => {
    try {
      await fetch(`${comfyui.baseUrl.replace(/\/$/, "")}/interrupt`, { method: "POST" });
      return { ok: true, interrupted: currentPromptId };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  const st = await status();
  if (!st.ok) throw new Error(`ComfyUI 不可达（${st.error}）。请确认本地 ComfyUI 已启动（${comfyui.baseUrl}）。`);
  if (!st.profiles.length) {
    throw new Error("ComfyUI 中未发现可用的文生图模型组（需要 unet+vae+clip 或 checkpoint）");
  }
  const profile = st.profiles.find((p) => p.id === comfyui.profile) || st.profiles[0];
  const d = profile.defaults;
  const useSteps = steps || d.steps;
  const useCfg = cfg || d.cfg;

  // ---- P0-0：把参考图真正送进 ComfyUI ----
  const base = comfyui.baseUrl.replace(/\/$/, "");
  const refNames = referenceImages.length
    ? await prepareReferenceImages(base, referenceImages, onProgress)
    : [];

  // object_info 一次拉够：ImageScale 探测和 IPAdapter 能力判断都要用。
  // 改之前这里 status() 已经拉过一次、下面又拉一次 —— 等于每次生成为一个
  // 动辄几 MB 的 JSON 付两次往返。合并掉。
  let objectInfo = {};
  try {
    objectInfo = await api(base, "/object_info");
  } catch {
    objectInfo = {};
  }
  const hasImageScale = Boolean(objectInfo?.ImageScale);

  // 多图融合能力必须绑当前 profile 的架构判断：SD/SDXL 生态成熟，
  // DiT（Flux / Z-Image / Qwen）得有专用节点才敢插，否则直接跑崩。
  const ipadapter = detectIPAdapter(objectInfo, {
    arch: profile.checkpoint ? "checkpoint" : "unet"
  });
  const fused = refNames.length > 1 && ipadapter.available;

  // 用户选了 N 张图，就得告诉他实际几张生效 —— 悄悄丢掉几张是最难受的体验
  if (refNames.length > 1) {
    onProgress?.(
      fused
        ? `已上传 ${refNames.length} 张参考图，启用 IPAdapter 多图融合（权重逐张递减）`
        : fallbackMessage(refNames.length, ipadapter)
    );
  }
  // 保留纹理 / 印花区域 → 体现在重绘强度与提示词权重上
  let useDenoise = Number(strength) > 0 ? Number(strength) : 0.75;
  if (keepTexture === false) useDenoise = Math.min(1, useDenoise + 0.15);
  if (printArea === "full") useDenoise = Math.min(1, useDenoise + 0.1);

  const hasRef = refNames.length > 0;
  const results = [];
  for (let i = 0; i < n; i++) {
    if (onProgress) {
      onProgress(
        hasRef
          ? `ComfyUI ${profile.label} · ${fused ? "多图融合" : "图生图"} 第 ${i + 1}/${n} 张（强度 ${useDenoise}）…`
          : `ComfyUI ${profile.label} · 第 ${i + 1}/${n} 张（${useSteps} 步）…`
      );
    }
    const workflow = buildWorkflow(profile, {
      prompt,
      negativePrompt,
      width,
      height,
      steps: useSteps,
      cfg: useCfg,
      sampler: d.sampler,
      scheduler: d.scheduler,
      seed: Math.floor(Math.random() * 1e15),
      // 全部参考图都送进去：第一张当底图，其余由 IPAdapter 链融合
      imageNames: refNames,
      denoise: useDenoise,
      hasImageScale,
      objectInfo,
      ipadapter
    });
    if (signal?.aborted) throw new Error("已取消");
    const queued = await api(comfyui.baseUrl, "/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow, client_id: "ai-canvas" }),
      signal
    });
    const promptId = queued?.prompt_id;
    if (!promptId) throw new Error("ComfyUI 未返回 prompt_id");
    // 记住当前 prompt_id：/interrupt 停的是「正在跑的那个」，
    // 万一将来要做精确中断，这里就是抓手
    currentPromptId = promptId;

    const deadline = Date.now() + 10 * 60 * 1000;
    let done = false;
    while (Date.now() < deadline && !done) {
      await sleep(1500, signal); // 取消后立刻醒，不用再等满 1.5 秒
      if (signal?.aborted) throw new Error("已取消");
      const history = await api(comfyui.baseUrl, `/history/${promptId}`, { signal }).catch(() => ({}));
      const entry = history?.[promptId];
      if (entry) {
        if (entry.status?.status_str === "error") {
          const msgs = Object.values(entry.status?.messages || {}).flat().join("; ");
          throw new Error(`ComfyUI 执行出错: ${msgs.slice(0, 160)}`);
        }
        for (const node of Object.values(entry.outputs || {})) {
          for (const img of node.images || []) {
            const params = new URLSearchParams({
              filename: img.filename,
              subfolder: img.subfolder || "",
              type: img.type || "output"
            });
            results.push({ url: `${comfyui.baseUrl.replace(/\/$/, "")}/view?${params}` });
            done = true;
          }
        }
      }
    }
    if (!done) throw new Error("ComfyUI 生成超时");
  }
  return results;
}
