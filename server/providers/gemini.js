// 闭源 · 国际：Gemini 图像生成（Nano Banana Pro / Nano Banana 2）

// 由「宽 x 高」反推最接近的画幅比例字符串
function toAspectRatio(size) {
  const m = String(size || "").match(/^(\d+)\s*[*x]\s*(\d+)$/i);
  if (!m) return "1:1";
  const w = Number(m[1]);
  const h = Number(m[2]);
  const ratio = w / h;
  const candidates = [
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["3:2", 3 / 2],
    ["2:3", 2 / 3],
    ["5:4", 5 / 4]
  ];
  let best = candidates[0];
  let min = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c[1] - ratio);
    if (d < min) {
      min = d;
      best = c;
    }
  }
  return best[0];
}

export async function generate({
  prompt, size = "1024x1024", n = 1,
  referenceImages = [], printArea = "auto", keepTexture = true,
  // model = 上游真实模型名（由 index.js 用 registry.apiIdOf 解析后传进来）。
  // 以前这里直接用配置里的 gemini.model，导致用户选哪个 Nano Banana 都发同一个模型名，
  // 而且官方接口只认 gemini-2.5-flash-image / gemini-3-pro-image-preview 这类 id，
  // 传 "nano-banana-pro" 会 404 —— 中转站又恰恰相反（它们可能就叫这个名字）。
  model: requestedModel = "",
  onProgress,
  signal = null
}) {
  const { loadConfig, getProviderKey } = await import("../config.js");
  const { loadReferences, withProductIntent } = await import("./refimage.js");
  const { gemini } = loadConfig();
  const apiKey = getProviderKey("gemini");
  if (!apiKey) throw new Error("未配置 Gemini API Key（设置 → 闭源 · 国际，用于 Nano Banana 系列）");

  const base = String(gemini.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const model = String(requestedModel || gemini.model || "").trim();
  if (!model) throw new Error("未指定 Gemini 图像模型（设置 → 模型 ID 映射 里填上游模型名）");
  const count = Math.min(Math.max(Number(n) || 1, 1), 4);
  const aspectRatio = toAspectRatio(size);

  // 图生图：参考图作为 inline_data part 与文本 part 并列放进同一个 contents[0]。
  // 注意字段是 inline_data / mime_type（下划线风格），且 data 是**裸 base64**，不是 data URI。
  const refs = referenceImages.length
    ? await loadReferences(referenceImages, { max: 8, onProgress })
    : [];
  const contentParts = [{ text: withProductIntent(prompt, refs, { printArea, keepTexture }) }];
  for (const r of refs) contentParts.push({ inline_data: { mime_type: r.mime, data: r.b64 } });
  if (refs.length && onProgress) onProgress(`图生图（${refs.length} 张参考图）…`);

  const images = [];
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) throw new Error("已取消");
    if (onProgress) onProgress(`正在请求 ${model}（${i + 1}/${count}）…`);

    const res = await fetch(
      `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: contentParts }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio }
          }
        })
      }
    );

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.error?.message || `Gemini 图像接口返回 ${res.status}`);
    }

    const parts = body?.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      const inline = part.inlineData || part.inline_data;
      const b64 = inline?.data;
      const mime = inline?.mimeType || inline?.mime_type || "image/png";
      if (b64) images.push({ url: `data:${mime};base64,${b64}` });
    }
  }

  if (!images.length) throw new Error("Gemini 未返回图像");
  if (onProgress) onProgress(`已生成 ${images.length} 张`);
  return images;
}
