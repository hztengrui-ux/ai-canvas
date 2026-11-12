// 第三方模型 API 连通性自检（provider probe）
//
// 为什么单独做一层，而不是让用户"先生成一张图看看通不通"：
//   1. 生成要花钱、要排队，自检不该产生任何算力消耗；
//   2. 出错信息现在散在各 provider 的 generate 里（"未配置 Key"/"HTTP 401"/"fetch failed"），
//      用户拿到的是堆栈，不是"该改哪个输入框"；
//   3. 设置页允许"先测试、满意再保存"—— 测试用的是表单里当前的 Key/地址/模型，
//      不落盘、不覆盖已保存的配置（除非用户点保存）。
//
// 各家的自检方式（都选免费、可判定的一步）：
//   openai / gemini / jiemeng → GET {baseUrl}/models 列模型（顺便校验模型名是否可见）
//   llm                      → POST {baseUrl}/chat/completions，max_tokens=1（约等于免费）
//   comfyui                  → 复用 providers/comfyui.js 的 status()（本地 /system_stats）
//
// 返回统一结构，前端只按 code/message/hints 渲染，不再自己翻译错误：
//   { ok, provider, label, baseUrl, model, latencyMs, code, message, hints[], models? }
//
// 注意：这个接口会向请求里给的 baseUrl 发请求（本地 ComfyUI 必须允许 127.0.0.1），
// 所以只在"本机可信"的前提下开放（见 index.js 的 guard：Host/Origin 白名单 + 本机会话）。

import { loadConfig, getProviderKey } from "../config.js";
import { apiIdOf } from "../models/registry.js";
import { status as comfyuiStatus } from "./comfyui.js";

/** 支持自检的 provider（顺序即前端展示顺序） */
export const PROBE_TARGETS = ["openai", "gemini", "jiemeng", "llm", "comfyui"];

const LABELS = {
  openai: "OpenAI · GPT Image",
  gemini: "Gemini · Nano Banana",
  jiemeng: "火山方舟 · 即梦 Seedream",
  llm: "语义处理 · LLM",
  comfyui: "本地 ComfyUI"
};

// 与 config.js 的默认值保持一致（用户没保存过配置时，自检也要有个合理目标）
const DEFAULTS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-image-2" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "nano-banana-pro" },
  jiemeng: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedream-4-0" },
  llm: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-2-1-pro" },
  comfyui: { baseUrl: "http://127.0.0.1:8188", model: "" }
};

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 12000;

// ---------- 基础工具（导出给单测用，不依赖网络） ----------

/**
 * 规范化 baseUrl：去尾部斜杠、只允许 http/https、不允许把账号密码写进 URL。
 * @returns {string}
 */
export function normalizeBaseUrl(raw, fallback = "") {
  const value = String(raw == null ? "" : raw).trim() || String(fallback || "").trim();
  if (!value) throw new Error("API 地址为空（例如 https://api.openai.com/v1）");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("API 地址格式不对，要写完整 URL（例如 https://api.openai.com/v1）");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API 地址只支持 http:// 或 https://");
  }
  if (url.username || url.password) {
    throw new Error("API 地址里不要带账号密码，Key 请填在「API Key」那一栏");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** 从各家的模型列表响应里抽出模型 id（OpenAI 用 data[].id，Gemini 用 models[].name） */
export function pickModelIds(payload) {
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  return list
    .map((item) => (typeof item === "string" ? item : String(item?.id || item?.name || "")))
    .filter(Boolean)
    .map((id) => id.replace(/^models\//, ""));
}

/** HTTP 状态码 → 面向用户的一句话 + 机器可读的 code */
export function classifyHttpStatus(status) {
  if (status === 401) return { code: "AUTH", message: "API Key 无效或已过期（HTTP 401）" };
  if (status === 403) return { code: "FORBIDDEN", message: "Key 能识别，但没有权限访问该接口或模型（HTTP 403）" };
  if (status === 404) return { code: "PATH", message: "地址返回 404，多半是 API 地址路径不对（OpenAI 兼容一般以 /v1 结尾）" };
  if (status === 405) return { code: "PATH", message: "该地址不接受这个请求方法（HTTP 405），检查 API 地址是否指向了正确的接口根路径" };
  if (status === 429) return { code: "RATE", message: "被上游限流（HTTP 429），稍后再试" };
  if (status >= 500) return { code: "UPSTREAM", message: `上游服务异常（HTTP ${status}）` };
  return { code: "HTTP", message: `上游返回 HTTP ${status}` };
}

/** 按错误类型给"下一步该改哪里"的建议（前端直接当清单展示） */
export function hintsFor(code, ctx = {}) {
  const model = ctx.model || "当前模型";
  switch (code) {
    case "NO_KEY":
      return ["在设置里填入该厂商的 API Key 并保存；也可以在这里填完直接「测试连接」，测试不会保存 Key"];
    case "AUTH":
      return [
        "检查 Key 是否复制完整（前后空格、换行会一起复制进去）",
        "确认 Key 没过期、没被重置；走中转站时要用中转站自己的 Key",
      ];
    case "FORBIDDEN":
      return [
        `该 Key 可能没开通「${model}」的权限，去厂商控制台确认模型已开通`,
        "走中转站时确认分组/渠道允许这个模型",
      ];
    case "PATH":
      return [
        "官方默认值：OpenAI https://api.openai.com/v1、Gemini https://generativelanguage.googleapis.com/v1beta、方舟 https://ark.cn-beijing.volces.com/api/v3",
        "中转站要照抄它文档里的地址；常见错误是漏了 /v1 或多写了一段路径",
      ];
    case "MODEL":
      return [
        `「${model}」在上游不存在或未开通`,
        "界面的模型 id 与上游真实名不同时，请在「模型 ID 覆盖」里填上游名字（中转站尤其常见）",
      ];
    case "PARAM":
      return ["请求参数被上游拒绝，检查模型名/参数是否匹配（中转站常把图片模型和对话模型混在一起）"];
    case "RATE":
      return ["等几十秒再试；并发任务多时先停掉批量任务"];
    case "NETWORK":
      return [
        "确认本机网络能访问该域名（公司网络/代理可能需要放行）",
        "本地 ComfyUI 要确认已启动，地址默认 http://127.0.0.1:8188",
      ];
    case "TIMEOUT":
      return ["网络慢或代理没生效，先重试一次；一直超时就换直连或换中转站地址"];
    case "UPSTREAM":
      return ["上游自己出问题了，与本地配置无关，过一会儿再试"];
    default:
      return [];
  }
}

// ---------- 内部：一次带超时的 JSON 请求 ----------

async function requestJson(url, init, timeoutMs) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = String(error?.cause?.code || error?.code || error?.message || error);
    const timeout =
      error?.name === "TimeoutError" ||
      error?.name === "AbortError" ||
      /timeout|timed out/i.test(cause);
    return { network: true, timeout, cause, latencyMs: Date.now() - started };
  }
  const text = await res.text().catch(() => "");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return {
    network: false,
    ok: res.ok,
    status: res.status,
    body,
    text: String(text || "").slice(0, 800),
    latencyMs: Date.now() - started
  };
}

/** 把网络层失败统一成结果对象 */
function networkFailure(ctx, r) {
  const code = r.timeout ? "TIMEOUT" : "NETWORK";
  return {
    ...ctx,
    ok: false,
    code,
    latencyMs: r.latencyMs,
    message: r.timeout
      ? `请求超时（${ctx.timeoutMs}ms 内没响应）`
      : `连不上 ${ctx.baseUrl}（${r.cause}）`,
    hints: hintsFor(code, ctx)
  };
}

/** 上游错误体里通常有可读原因（如 model not found / invalid api key），尽量带出来 */
function upstreamDetail(r) {
  const raw =
    r.body?.error?.message ||
    r.body?.error?.code ||
    r.body?.message ||
    r.body?.msg ||
    r.text ||
    "";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 220);
}

// ---------- 各 provider 的探测 ----------

function baseContext(provider, { baseUrl, model, modelRaw, apiKey, timeoutMs }) {
  return {
    provider,
    label: LABELS[provider] || provider,
    baseUrl,
    model,
    modelRaw,
    apiKey,
    timeoutMs
  };
}

/** 列模型型探测：openai / gemini / jiemeng */
async function probeModelList(ctx, { google = false } = {}) {
  const url = `${ctx.baseUrl}/models`;
  const headers = google ? { "x-goog-api-key": ctx.apiKey } : { Authorization: `Bearer ${ctx.apiKey}` };
  const r = await requestJson(url, { method: "GET", headers }, ctx.timeoutMs);
  if (r.network) return networkFailure(ctx, r);

  if (r.ok) {
    const ids = pickModelIds(r.body);
    // gemini 的模型名可能带 models/ 前缀（pickModelIds 已剥），这里再宽松匹配一次。
    // 同时认「界面 id」和「解析后的上游名」：界面写 nano-banana-pro，上游可能叫
    // gemini-3-pro-image-preview，两者任一命中都算可见。
    const wanted = ctx.model;
    const wantedRaw = ctx.modelRaw;
    const hit = (id) =>
      (wanted && (id === wanted || id.endsWith(`/${wanted}`))) ||
      (wantedRaw && (id === wantedRaw || id.endsWith(`/${wantedRaw}`)));
    const matched = ids.length ? ids.some(hit) : null;
    const shown = ids.length && matched === false && wantedRaw && wantedRaw !== wanted ? `${wanted}（界面名 ${wantedRaw}）` : wanted;
    const hints = [];
    if (matched === false) {
      hints.push(`Key 有效，但可见模型列表里没有「${shown}」：可能没开通，或需要在「模型 ID 覆盖」里填上游真实名`);
    }
    return {
      ...ctx,
      ok: true,
      code: "OK",
      latencyMs: r.latencyMs,
      message:
        `连通正常（${r.latencyMs}ms）` +
        (ids.length ? `，可见 ${ids.length} 个模型` : "，但没有拿到模型列表") +
        (matched === false ? `；未发现「${shown}」` : ""),
      hints,
      models: { count: ids.length, matched, sample: ids.slice(0, 10) }
    };
  }

  const c = classifyHttpStatus(r.status);
  const detail = upstreamDetail(r);
  return {
    ...ctx,
    ok: false,
    code: c.code,
    latencyMs: r.latencyMs,
    message: detail ? `${c.message}：${detail}` : c.message,
    hints: hintsFor(c.code, ctx)
  };
}

/** 对话型探测：llm（真发一次 max_tokens=1，确认 Key + 模型 + 地址三者都对） */
async function probeChat(ctx) {
  const r = await requestJson(
    `${ctx.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.apiKey}` },
      body: JSON.stringify({
        model: ctx.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0
      })
    },
    ctx.timeoutMs
  );
  if (r.network) return networkFailure(ctx, r);

  if (r.ok) {
    const reply = String(
      r.body?.choices?.[0]?.message?.content || r.body?.output_text || ""
    ).trim();
    return {
      ...ctx,
      ok: true,
      code: "OK",
      latencyMs: r.latencyMs,
      message: `连通正常（${r.latencyMs}ms），「${ctx.model}」回了 1 个 token${reply ? `（${reply.slice(0, 20)}）` : ""}`,
      hints: []
    };
  }

  const c = classifyHttpStatus(r.status);
  const detail = upstreamDetail(r);
  // 400/404 且错误体里提到模型 → 归为 MODEL，方便前端给"模型 ID 覆盖"的建议
  const looksModel = /model/i.test(detail) && /(not|unknown|invalid|no such|不存在|未开通)/i.test(detail);
  const code = looksModel ? "MODEL" : c.code === "PATH" && r.status === 400 ? "PARAM" : c.code;
  const message =
    r.status === 400 || r.status === 404
      ? `请求被上游拒绝（HTTP ${r.status}）${detail ? `：${detail}` : ""}`
      : detail
        ? `${c.message}：${detail}`
        : c.message;
  return { ...ctx, ok: false, code, latencyMs: r.latencyMs, message, hints: hintsFor(code, ctx) };
}

/** 火山方舟（即梦）没有稳定的模型列表接口：先试 /models，404 时退化成一次 1-token 对话验证 Key */
async function probeJiemeng(ctx) {
  const listed = await probeModelList(ctx);
  if (listed.ok || listed.code !== "PATH") return listed;

  const chat = await probeChat({
    ...ctx,
    model: "doubao-seed-2-1-pro",
    note: "方舟没有稳定的模型列表接口，这里用 1 个 token 的对话请求验证 Key"
  });
  return {
    ...chat,
    provider: ctx.provider,
    label: ctx.label,
    model: ctx.model,
    hints: chat.ok
      ? [
          "Key 已通过验证（用方舟语言模型探活）；图片模型「" + ctx.model + "」的权限请以一次真实生成为准",
        ]
      : chat.hints
  };
}

/** 本地 ComfyUI：优先复用 provider 的 status()（能列出可用模型）；用户填了别的地址时直接探 /system_stats */
async function probeComfyUI(ctx, { overrideBase = false } = {}) {
  // 前端填了自定义地址：不能动已保存的配置，直接对那个地址发一次 /system_stats
  if (overrideBase) {
    const r = await requestJson(`${ctx.baseUrl}/system_stats`, { method: "GET" }, ctx.timeoutMs);
    if (r.network) return networkFailure(ctx, r);
    if (r.ok) {
      return {
        ...ctx,
        ok: true,
        code: "OK",
        latencyMs: r.latencyMs,
        message: `ComfyUI 已连通（${r.latencyMs}ms，${ctx.baseUrl}）`,
        hints: [] // 自定义地址拿不到 object_info 明细，模型清单留给启动后的生成流程校验
      };
    }
    const c = classifyHttpStatus(r.status);
    return { ...ctx, ok: false, code: c.code, latencyMs: r.latencyMs, message: c.message, hints: hintsFor(c.code, ctx) };
  }

  try {
    const st = await comfyuiStatus();
    const profiles = Array.isArray(st.profiles) ? st.profiles : [];
    if (st.ok) {
      return {
        ...ctx,
        baseUrl: st.baseUrl || ctx.baseUrl,
        ok: true,
        code: "OK",
        message: `ComfyUI 已连通：${profiles.length} 套可用文生图模型${profiles.length ? `（${profiles.map((p) => p.id).slice(0, 3).join(" / ")}）` : ""}`,
        hints: profiles.length ? [] : ["ComfyUI 里还没有可用的 checkpoint/unet+vae+clip 组合，先去装一套"]
      };
    }
    return {
      ...ctx,
      baseUrl: st.baseUrl || ctx.baseUrl,
      ok: false,
      code: "NETWORK",
      message: `ComfyUI 不可达：${st.error || "未知原因"}`,
      hints: ["确认 ComfyUI 已启动（默认 http://127.0.0.1:8188）", "如果改了端口，把地址填成对应的 http://127.0.0.1:<端口>"]
    };
  } catch (error) {
    return {
      ...ctx,
      ok: false,
      code: "NETWORK",
      message: `ComfyUI 探测失败：${error?.message || error}`,
      hints: ["确认 ComfyUI 已启动，并且本机防火墙放行该端口"]
    };
  }
}

// ---------- 对外入口 ----------

/**
 * 探测单个 provider。
 *
 * @param {string} provider openai / gemini / jiemeng / llm / comfyui
 * @param {{baseUrl?: string, model?: string, apiKey?: string, timeoutMs?: number}} [override]
 *   覆盖值只用于本次探测：前端"测试连接"用它验证尚未保存的表单内容。
 * @returns {Promise<object>} 统一结构，ok=false 也不抛异常（方便前端逐条渲染）
 */
export async function probeProvider(provider, override = {}) {
  const result = await runProbe(provider, override);
  // 回给前端的对象里不能带 Key（哪怕只是回显）：页面 JS 与 DevTools 都能读到。
  if (result && typeof result === "object") {
    delete result.apiKey;
    delete result.timeoutMs;
  }
  return result;
}

async function runProbe(provider, override = {}) {
  const name = String(provider || "").trim();
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(MIN_TIMEOUT_MS, Number(override.timeoutMs) || DEFAULT_TIMEOUT_MS)
  );

  if (!PROBE_TARGETS.includes(name)) {
    return {
      ok: false,
      provider: name,
      label: LABELS[name] || name,
      baseUrl: "",
      model: "",
      code: "UNSUPPORTED",
      message: `暂不支持自检「${name || "(空)"}」`,
      hints: [`当前支持：${PROBE_TARGETS.join(" / ")}`]
    };
  }

  const cfg = loadConfig() || {};
  const def = DEFAULTS[name] || {};
  const saved = cfg[name] || {};

  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(override.baseUrl || saved.baseUrl, def.baseUrl);
  } catch (error) {
    return {
      ok: false,
      provider: name,
      label: LABELS[name],
      baseUrl: String(override.baseUrl || saved.baseUrl || ""),
      model: "",
      code: "PATH",
      message: error.message,
      hints: hintsFor("PATH")
    };
  }

  // 界面上的模型 id（如 nano-banana-pro）与上游真实名字可能不同，按注册表/遮罩表解析
  const rawModel = String(override.model || saved.model || def.model || "").trim();
  const model = rawModel && name !== "comfyui" ? apiIdOf(rawModel, cfg.models || {}) : rawModel;

  // apiKey 的三种语义（前端"测试连接"要能区分）：
  //   undefined → 用已保存的 Key（表单显示掩码时就是这种情况）
  //   null / "" → 明确"这次不用 Key"（用户清空了输入框，应报 NO_KEY 而不是偷偷用旧 Key）
  //   非空字符串 → 用这个值（用户刚改了还没保存）
  const hasKeyOverride = Object.prototype.hasOwnProperty.call(override, "apiKey");
  const overrideKey = hasKeyOverride ? String(override.apiKey ?? "").trim() : "";
  const ctx = baseContext(name, {
    baseUrl,
    model,
    modelRaw: rawModel,
    apiKey: hasKeyOverride ? overrideKey : getProviderKey(name),
    timeoutMs
  });

  if (name === "comfyui") return probeComfyUI(ctx, { overrideBase: Boolean(override.baseUrl) });

  if (!ctx.apiKey) {
    return {
      ...ctx,
      ok: false,
      code: "NO_KEY",
      message: "还没填写 API Key",
      hints: hintsFor("NO_KEY", ctx)
    };
  }

  if (name === "llm") return probeChat(ctx);
  if (name === "gemini") return probeModelList(ctx, { google: true });
  if (name === "jiemeng") return probeJiemeng(ctx);
  return probeModelList(ctx);
}
