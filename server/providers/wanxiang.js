// 通义万相（阿里云百炼 DashScope）
//
// 两条通路，按「有没有参考图」自动分流：
//   ① 文生图  → /api/v1/services/aigc/text2image/image-synthesis（异步任务 + 轮询）
//   ② 图生图  → /api/v1/services/aigc/multimodal-generation/generation（同步，messages 带 image）
//
// 为什么必须分两条（这是查官方文档查出来的坑，不是拍脑袋）：
//   · 文生图 V2 版接口（wanx2.1-t2i-turbo / plus、wan2.2、wan2.5、wan2.6-t2i）
//     **input 里根本没有图片字段**，官方明确「不支持参考图/垫图」。
//     只有更老的 wanx-v1 才有 ref_img + ref_strength + ref_mode。
//   · 所以「万相 + 参考图」只能走 multimodal-generation，模型也要换成
//     wan2.6-image / wan2.7-image 这类支持图片输入的模型，而不是 t2i 系列。
//   · 另外负向提示词的位置两代协议不一样：
//       wan2.6 在 parameters.negative_prompt，旧版（wanx2.1 等）在 input.negative_prompt。
//     之前一律塞进 parameters，对 wanx2.1-t2i-turbo 是**静默失效**的。
// 文档:
//   https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference
//   https://help.aliyun.com/zh/model-studio/text-to-image-api-reference
import { sleep } from "../tasks.js";

const BASE = "https://dashscope.aliyuncs.com";

// wan2.6 起用新版协议（messages + parameters.negative_prompt）
function useNewProtocol(model) {
  return /^wan2\.[6-9]/.test(String(model || ""));
}

async function createTask({ apiKey, model, prompt, negativePrompt, size, n, signal = null }) {
  const newProtocol = useNewProtocol(model);
  const input = newProtocol
    ? { messages: [{ role: "user", content: [{ text: prompt }] }] }
    : {
        prompt,
        // 旧版协议的负向词在 input 下，写进 parameters 会被忽略（不报错，就是没效果）
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {})
      };

  const res = await fetch(
    `${BASE}/api/v1/services/aigc/text2image/image-synthesis`,
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({
        model,
        input,
        parameters: {
          size,
          n,
          ...(newProtocol && negativePrompt ? { negative_prompt: negativePrompt } : {})
        }
      })
    }
  );
  const body = await res.json();
  if (!res.ok || !body?.output?.task_id) {
    throw new Error(body?.message || `万相创建任务失败 HTTP ${res.status}`);
  }
  return body.output.task_id;
}

async function pollTask(apiKey, taskId, onProgress, signal = null) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000, signal); // 取消后立刻醒，不用睡满 2 秒
    if (signal?.aborted) throw new Error("已取消");
    const res = await fetch(`${BASE}/api/v1/tasks/${taskId}`, {
      signal,
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body = await res.json();
    const output = body?.output || {};
    if (output.task_status === "SUCCEEDED") {
      return (output.results || [])
        .filter((r) => r.url)
        .map((r) => ({ url: r.url }));
    }
    if (output.task_status === "FAILED" || output.task_status === "CANCELED") {
      throw new Error(output.message || "万相任务失败");
    }
    if (onProgress) onProgress(`万相任务 ${output.task_status} (${output.task_metrics?.TOTAL ?? "?"} 张)`);
  }
  throw new Error("万相任务超时");
}

// ---------- 图生图（multimodal-generation，同步） ----------
// 请求：input.messages[0].content = [{text}, {image: dataUri}, ...]
// 响应：output.choices[0].message.content[] 里的 image 字段（URL，24 小时有效）
// 万相最多吃 9 张参考图，这里取 6 张（再多对毛衫印花没意义，只是拖慢请求）。
const MAX_I2I_REFS = 6;

export async function createImageToImage({ apiKey, model, prompt, negativePrompt, size, n, refs, signal = null }) {
  const content = [{ text: prompt }];
  for (const r of refs) content.push({ image: r.dataUri });

  const res = await fetch(
    `${BASE}/api/v1/services/aigc/multimodal-generation/generation`,
    {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: "user", content }] },
        parameters: {
          size: String(size).replace("x", "*"),
          n,
          watermark: false,
          prompt_extend: true,
          ...(negativePrompt ? { negative_prompt: negativePrompt } : {})
        }
      })
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || body?.error?.message || `万相图生图失败 HTTP ${res.status}`);
  }

  // 同步返回：choices[].message.content[].image
  const parts = body?.output?.choices?.[0]?.message?.content || [];
  const urls = parts.map((p) => p?.image).filter(Boolean);

  // 兼容：万一网关把它转成了异步任务，就退回轮询（结果结构跟文生图一致）
  if (!urls.length && body?.output?.task_id) {
    return pollTask(apiKey, body.output.task_id, () => {}, signal);
  }
  if (!urls.length) throw new Error("万相图生图未返回图片");
  return urls.map((url) => ({ url }));
}

export async function generate({
  prompt, negativePrompt, size, n,
  referenceImages = [], strength = 0, printArea = "auto", keepTexture = true,
  onProgress,
  signal = null
}) {
  const { loadConfig, getProviderKey } = await import("../config.js");
  const { loadReferences, withProductIntent } = await import("./refimage.js");
  const { wanxiang } = loadConfig();
  const apiKey = getProviderKey("wanxiang");
  if (!apiKey) throw new Error("未配置通义万相 API Key（设置里填写 DashScope key）");

  const refs = referenceImages.length
    ? await loadReferences(referenceImages, { max: MAX_I2I_REFS, onProgress })
    : [];

  if (refs.length) {
    // 模型换成图生图模型：t2i 系列不支持图片输入，硬传会被拒
    const i2iModel = wanxiang.i2iModel || "wan2.6-image";
    if (onProgress) {
      onProgress(`万相图生图（${i2iModel}），携带 ${refs.length} 张参考图…`);
    }
    return createImageToImage({
      apiKey,
      model: i2iModel,
      prompt: withProductIntent(prompt, refs, { printArea, keepTexture }),
      negativePrompt,
      size,
      n,
      refs,
      signal
    });
  }

  const taskId = await createTask({
    apiKey,
    model: wanxiang.model,
    prompt,
    negativePrompt,
    size: size.replace("x", "*"),
    n,
    signal
  });
  if (onProgress) onProgress("万相任务已提交，排队中…");
  return pollTask(apiKey, taskId, onProgress, signal);
}

// ---------- 视频生成（万相 2.1 t2v / i2v） ----------
const VIDEO_RES = {
  "720p": "1280*720",
  "1080p": "1920*1080"
};

async function createVideoTask({ apiKey, model, prompt, firstFrame, resolution, duration }) {
  const input = { prompt };
  if (firstFrame && model.includes("i2v")) {
    input.img_url = firstFrame;
  }
  const res = await fetch(
    `${BASE}/api/v1/services/aigc/video-generation/video-synthesis`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({
        model,
        input,
        parameters: {
          size: VIDEO_RES[resolution] || VIDEO_RES["720p"],
          duration: Math.min(Math.max(Number(duration) || 5, 5), 10),
          prompt_extend: true
        }
      })
    }
  );
  const body = await res.json();
  if (!res.ok || !body?.output?.task_id) {
    throw new Error(body?.message || `万相视频任务创建失败 HTTP ${res.status}`);
  }
  return body.output.task_id;
}

async function pollVideoTask(apiKey, taskId, onProgress) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await fetch(`${BASE}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body = await res.json();
    const output = body?.output || {};
    if (output.task_status === "SUCCEEDED") {
      const url = output.video_url || output.video?.url;
      if (url) return [{ url, kind: "video" }];
      throw new Error("万相视频任务成功但未返回视频地址");
    }
    if (output.task_status === "FAILED" || output.task_status === "CANCELED") {
      throw new Error(output.message || "万相视频任务失败");
    }
    if (onProgress) onProgress(`万相视频任务 ${output.task_status}（${output.task_metrics?.TOTAL ?? "?"}%）`);
  }
  throw new Error("万相视频任务超时");
}

export async function generateVideo({ prompt, firstFrame, resolution = "720p", duration = 5, onProgress }) {
  const { loadConfig, getProviderKey } = await import("../config.js");
  const { wanxiang } = loadConfig();
  const apiKey = getProviderKey("wanxiang");
  if (!apiKey) throw new Error("未配置通义万相 API Key（设置里填写 DashScope key）");
  if (!prompt || !String(prompt).trim()) throw new Error("视频画面描述不能为空");

  // i2v：本地首帧图转 base64 data URI
  let frameUri = "";
  let model = wanxiang.videoModel || "wanx2.1-t2v-turbo";
  if (firstFrame) {
    const fs = await import("node:fs");
    const p = await import("node:path");
    const cwd = process.cwd();
    const local = p.join(cwd, firstFrame.url.replace(/^\//, ""));
    if (fs.existsSync(local)) {
      const buf = fs.readFileSync(local);
      const ext = p.extname(local).slice(1).toLowerCase() || "png";
      frameUri = `data:image/${ext};base64,${buf.toString("base64")}`;
      model = model.replace("t2v", "i2v");
    }
  }

  if (onProgress) onProgress("正在提交万相视频生成任务…");
  const taskId = await createVideoTask({ apiKey, model, prompt: String(prompt).trim(), firstFrame: frameUri, resolution, duration });
  if (onProgress) onProgress(`任务已提交（${model}），排队生成中…`);
  const videos = await pollVideoTask(apiKey, taskId, onProgress);
  return videos.map((v) => ({ ...v, model }));
}
