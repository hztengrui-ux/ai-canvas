// 模型网关 —— 生成请求的「唯一入口判断」
//
// 职责边界（刻意保持很薄）：
//   1. 路由：由 model_id 解析出该用哪个 provider（注册表权威），拿不准时沿用请求里的 provider
//   2. 计价：单价 = 模型注册表的 cost（null 则回落计入费表基价）
//   3. 校验：尺寸格式 / 模型能力 / 张数 / 参考图数，返回结构化错误码（不抛异常）
//   4. 额度三段式：把「预扣 → 提交 / 回滚」收敛成三个函数，让调用方不必记住账本细节
//   5. 目录下发：/api/models 用的清单（含单价与「密钥是否已配置」）
//
// 不做的事：不调 provider、不落盘产物、不写血缘、不管 SSE —— 那些仍在 index.js 的路由里，
// 因为它们的失败语义与 HTTP 传输耦合（比如「用户取消」不是「失败」）。网关只负责
// 「这次请求合不合法、该找谁、花多少钱」，这样它才能被纯函数测试覆盖。
import * as credits from "./credits.js";
import { getProviderKey, loadConfig } from "./config.js";
import {
  ACTION_OF_KIND,
  KIND_IMAGE,
  KIND_VIDEO,
  listModels,
  resolveRoute,
  validateRequest,
  visibleModels
} from "./models/registry.js";

/** provider → 是否已配置密钥（comfyui 是本地服务，不需要密钥，恒为 true） */
export function providerKeyStatus(provider) {
  if (provider === "comfyui") return true;
  try {
    return Boolean(getProviderKey(provider));
  } catch {
    return false;
  }
}

/** provider → 当前生效的模型名（来自 config.json，界面上要显示「实际打给上游的是哪个模型」） */
export function configuredModel(provider) {
  try {
    const c = loadConfig();
    return String(c?.[provider]?.model || "");
  } catch {
    return "";
  }
}

/**
 * 规划一次生成：路由 + 计价 + 校验。
 *
 * @param {object} input { provider, model, kind, size, n, referenceImages, mode }
 * @returns {{
 *   ok: boolean, code?: string, message?: string,
 *   provider: string, model: object|null, registered: boolean,
 *   action: string, cost: number, count: number, diagnostics: string[]
 * }}
 */
export function planGenerate(input = {}) {
  const kind = input.kind === KIND_VIDEO ? KIND_VIDEO : KIND_IMAGE;
  const route = resolveRoute({ provider: input.provider, model: input.model, kind });
  const references = Array.isArray(input.referenceImages) ? input.referenceImages : [];
  const check = validateRequest(route, {
    size: input.size,
    n: input.n,
    referenceCount: references.filter(Boolean).length,
    mode: input.mode || ""
  });

  const diagnostics = [...route.diagnostics, ...check.diagnostics, ...(check.diagnostics ? [] : [])];
  if (!check.ok) {
    return {
      ok: false,
      code: check.code,
      message: check.message,
      provider: route.provider,
      model: route.model,
      registered: route.registered,
      action: route.action,
      cost: route.cost,
      count: check.count,
      diagnostics
    };
  }
  return {
    ok: true,
    provider: route.provider,
    model: route.model,
    registered: route.registered,
    action: route.action || ACTION_OF_KIND[kind] || "",
    cost: route.cost,
    count: check.count,
    diagnostics
  };
}

// ---------- 额度三段式 ----------

/** 第一步：预扣（幂等；余额不足返回 ok:false） */
export function reserveFor(userId, plan, refId) {
  return credits.reserveAmount(userId, plan.action, refId, plan.cost);
}

/** 第二步：提交（生成成功） */
export function commitFor(userId, plan, refId) {
  return credits.commit(userId, plan.action, refId);
}

/** 第三步：回滚（生成失败/取消） */
export function rollbackFor(userId, plan, refId, reserveTxId = "") {
  return credits.rollback(userId, refId, reserveTxId);
}

/**
 * 额度概览：给「余额不足」提示用。
 * @param {string} userId
 * @param {{provider?: string, model?: string}} [hint] 用于估算「还能生成几次」
 */
export function quota(userId, hint = {}) {
  const plan = planGenerate({ ...hint, size: hint.size || "1024x1024", n: 1 });
  const perRun = plan.cost || 1;
  const balance = credits.balance(userId);
  return {
    balance,
    unitCost: plan.cost,
    unitAction: plan.action,
    remainingRuns: Math.floor(balance / perRun),
    model: plan.model?.id || "",
    registered: plan.registered
  };
}

/**
 * 模型目录（/api/models 的载荷）：注册表 + 单价 + 密钥状态 + 当前配置模型。
 * @param {{kind?: string}} [options]
 */
export function catalog({ kind, brandConfigured } = {}) {
  // hidden 的模型不对外下发（界面不再展示），但内部仍能解析、仍能接老项目 —— 见 registry 注释
  const models = visibleModels({ kind }).map((m) => ({
    id: m.id,
    label: m.label,
    group: m.group,
    tab: m.tab,
    provider: m.provider,
    kind: m.kind,
    modes: m.modes,
    cost: m.effectiveCost,
    maxCount: m.maxCount,
    maxRefImages: m.maxRefImages,
    tagline: m.tagline,
    hasKey: providerKeyStatus(m.provider),
    configuredModel: configuredModel(m.provider)
  }));
  return {
    models,
    actions: ACTION_OF_KIND,
    baseCost: planGenerate({ provider: "wanxiang", model: "wanxiang", size: "1024x1024", n: 1 }).cost,
    providersWithKey: [...new Set(models.filter((m) => m.hasKey).map((m) => m.provider))],
    brandConfigured: Boolean(brandConfigured)
  };
}
