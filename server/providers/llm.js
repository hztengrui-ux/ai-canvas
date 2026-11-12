// 语义模型传输层（LLM）
//
// 为什么用 OpenAI 兼容的 /chat/completions，而不是各家原生协议：
//   · 火山方舟（Ark）本身就提供 OpenAI 兼容端点：
//       https://ark.cn-beijing.volces.com/api/v3/chat/completions
//   · 中转站/聚合 API 几乎都是 OpenAI 兼容的（这也是它们能"一个 key 通吃"的原因）
//   所以只要 baseUrl + model + key 可配，同一份代码既接官方也接聚合站。
//
// 与图像 provider 的区别：这里只返回**文本**，不需要落盘、不需要取消上游 GPU，
// 因此不注册 cancel 钩子（signal 直接透传给 fetch 即可）。

/** 把各家"content 可能是字符串也可能是数组"的差异抹平 */
function pickText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

export async function chat({ messages, temperature, maxTokens, signal, onProgress } = {}) {
  const { loadConfig, getProviderKey } = await import("../config.js");
  const { llm } = loadConfig();
  const apiKey = getProviderKey("llm");
  if (!apiKey) {
    throw new Error("未配置语义模型 API Key（设置 → 语义处理（豆包 2.1 / LLM）里填写）");
  }
  const base = String(llm.baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("未配置语义模型 API 地址（设置 → 语义处理）");
  const model = String(llm.model || "").trim();
  if (!model) throw new Error("未配置语义模型名称（设置 → 语义处理）");

  if (onProgress) onProgress(`正在调用 ${model}…`);

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : undefined,
      max_tokens: Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : undefined
    })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || `语义模型接口返回 ${res.status}`;
    throw new Error(msg);
  }

  const choice = body?.choices?.[0];
  const text = pickText(choice?.message).trim();
  if (!text) throw new Error("语义模型没有返回内容");

  return {
    text,
    model: body?.model || model,
    usage: {
      promptTokens: Number(body?.usage?.prompt_tokens) || 0,
      completionTokens: Number(body?.usage?.completion_tokens) || 0,
      totalTokens: Number(body?.usage?.total_tokens) || 0
    }
  };
}
