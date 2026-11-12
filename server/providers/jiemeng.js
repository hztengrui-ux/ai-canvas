// 即梦 / Seedream（火山方舟 Ark Images API）
// 即梦大模型已并入火山方舟 doubao-seedream 系列，用 Bearer Key 即可调用。
// 文档: https://www.volcengine.com/docs/82379/1541523
const BASE = "https://ark.cn-beijing.volces.com/api/v3";

// 方舟尺寸: 1024x1024 / 1280x720 / 720x1280 / 2048x2048(2K) 等
function toArkSize(size) {
  const [w, h] = size.toLowerCase().split("x").map(Number);
  if (w === h) return w >= 2048 ? "2K" : "1024x1024";
  if (w > h) return w >= 2048 ? "4K" : "1280x720";
  return "720x1280";
}

export async function generate({
  prompt, size, n, referenceImages = [], printArea = "auto", keepTexture = true, onProgress,
  // model = 上游真实模型名（index.js 用 registry.apiIdOf 解析后传入）。
  // 这样界面上「即梦 Seedream 4.0 / 豆包 Seedream 5.0 Pro」才能真正发到不同模型上；
  // 接中转站时用户填的名字也在这里生效。
  model: requestedModel = "",
  signal = null
}) {
  const { loadConfig, getProviderKey } = await import("../config.js");
  const { loadReferences, withProductIntent } = await import("./refimage.js");
  const { jiemeng } = loadConfig();
  const apiKey = getProviderKey("jiemeng");
  if (!apiKey) throw new Error("未配置火山方舟 API Key（设置里填写 Ark key，模型选 doubao-seedream 系列）");
  const model = String(requestedModel || jiemeng.model || "").trim();
  if (!model) throw new Error("未指定 Seedream 模型名（设置 → 模型 ID 映射 里填）");
  if (onProgress) onProgress("即梦/Seedream 生成中…");

  // 图生图：官方 `image` 字段支持 URL 或 base64（data:image/png;base64,...）。
  // 我们一律发 data URI —— 本机 /outputs/xxx.png 公网拉不到，发 URL 必然超时。
  // 单图传字符串、多图传数组（doubao-seedream-4.0/4.5/5.0 支持多图融合，上限 14 张）。
  const refs = referenceImages.length
    ? await loadReferences(referenceImages, { max: 6, onProgress })
    : [];
  const image = refs.length === 1 ? refs[0].dataUri : refs.length > 1 ? refs.map((r) => r.dataUri) : undefined;
  if (refs.length > 1 && onProgress) {
    onProgress(`即梦多图融合：${refs.length} 张参考图`);
  }

  const finalPrompt = withProductIntent(prompt, refs, { printArea, keepTexture });

  const results = [];
  // 方舟 n 参数部分模型不支持，逐张并发
  const tasks = Array.from({ length: n }, () =>
    fetch(`${BASE}/images/generations`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        prompt: finalPrompt,
        size: toArkSize(size),
        response_format: "url",
        watermark: false,
        ...(image ? { image } : {})
      })
    }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message || `即梦生成失败 HTTP ${res.status}`);
      return body;
    })
  );
  const bodies = await Promise.all(tasks);
  for (const body of bodies) {
    for (const item of body?.data || []) {
      if (item.url) results.push({ url: item.url });
    }
  }
  if (!results.length) throw new Error("即梦未返回图片");
  return results;
}
