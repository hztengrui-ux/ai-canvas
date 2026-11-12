// 闭源 · 国际：OpenAI 兼容的 Images API（GPT Image 系列）
// 只要把 baseUrl 指到任意 OpenAI 兼容网关即可复用
//
// 两条通路：
//   文生图 → POST /v1/images/generations（JSON）
//   图生图 → POST /v1/images/edits（multipart/form-data，字段 image 可重复，最多 16 张）
// 注意 /generations 不收图片，带参考图时必须换端点，否则参考图会被静默丢弃。

export async function generate({
  prompt, size = "1024x1024", n = 1,
  referenceImages = [], strength = 0, printArea = "auto", keepTexture = true,
  onProgress,
  signal = null
}) {
  const { loadConfig, getProviderKey } = await import("../config.js");
  const { loadReferences, withProductIntent } = await import("./refimage.js");
  const { openai } = loadConfig();
  const apiKey = getProviderKey("openai");
  if (!apiKey) throw new Error("未配置 OpenAI API Key（设置 → 闭源 · 国际，用于 GPT Image 系列）");

  const base = String(openai.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = openai.model || "gpt-image-2";
  const count = Math.min(Math.max(Number(n) || 1, 1), 4);

  if (onProgress) onProgress(`正在请求 ${model}…`);

  const refs = referenceImages.length
    ? await loadReferences(referenceImages, { max: 8, onProgress })
    : [];

  let res;
  if (refs.length) {
    // multipart：不要手动设 Content-Type，boundary 要由运行时生成
    const form = new FormData();
    form.append("model", model);
    for (const r of refs) {
      // 必须是带 filename 的「文件」而不是裸 Blob，否则网关会当成字符串
      form.append("image", new Blob([r.buf], { type: r.mime }), r.name);
    }
    form.append("prompt", withProductIntent(prompt, refs, { printArea, keepTexture }));
    form.append("n", String(count));
    form.append("size", String(size).replace("*", "x"));
    form.append("quality", "auto");
    // 只有 GPT Image 有真实的一致性旋钮：input_fidelity。
    // 强度高 → high（尽量贴近原图），强度低 → low（放开让模型自由发挥）。
    if (Number(strength) > 0) {
      form.append("input_fidelity", Number(strength) >= 0.7 ? "high" : "low");
    }
    if (onProgress) onProgress(`图生图（${refs.length} 张参考图）…`);
    res = await fetch(`${base}/images/edits`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
  } else {
    res = await fetch(`${base}/images/generations`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        prompt,
        n: count,
        size: String(size).replace("*", "x")
      })
    });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message || `OpenAI 图像接口返回 ${res.status}`);
  }

  const items = Array.isArray(body?.data) ? body.data : [];
  if (!items.length) throw new Error("OpenAI 未返回图像");

  if (onProgress) onProgress(`已生成 ${items.length} 张`);

  return items.map((item) => {
    if (item.b64_json) {
      return { url: `data:image/png;base64,${item.b64_json}` };
    }
    return { url: item.url };
  });
}
