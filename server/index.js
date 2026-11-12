import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadConfig, saveConfig, maskedConfig, outputsDir, materialDir, newId,
  MATERIAL_CATEGORIES, setProviderKey, PROVIDER_KEYS
} from "./config.js";
import {
  guard, securityHeaders, sessionHandler, rateLimit, mutationGuard,
  acquireSlot, releaseSlot, budgetExceeded, budgetRemaining, bumpUsage, securityStatus,
  readLocalToken, isLocalHost, setExtraTokenVerifier, isMobileHost, isLoopbackIp, MOBILE_MODE,
  // 文件批量：服务端自调 /api/generate 时要用本机回环 + 变更令牌（见 selfAuthHeaders）
  localToken, mutationToken
} from "./security.js";
import { derivePorts, lanAddresses } from "./ports.js";
import { vaultStatus } from "./vault.js";
import * as accounts from "./accounts.js";
import * as audit from "./audit.js";
import * as rbac from "./rbac.js";
import { mountAdmin } from "./admin.js";
import { mountCustomers } from "./customers.js";
import { mountRechargeAdmin } from "./recharge-admin.js";
import { mountPaymentAdmin } from "./payment-admin.js";
import { startAutomation } from "./recharge-automation.js";
import * as templates from "./templates.js";
import * as credits from "./credits.js";
import * as payments from "./payments.js";
import * as brand from "./brand.js";
import * as upstream from "./upstream.js";
import * as batch from "./batch.js";
import * as filebatch from "./filebatch.js";
import * as tasks from "./tasks.js";
import * as mats from "./materials.js";
import * as lineage from "./lineage.js";
import * as gateway from "./gateway.js";
import * as mobile from "./mobile.js";
import { mountMobile } from "./mobile-routes.js";
import { compilePrompt } from "./prompt/compiler.js";
import * as skills from "./skills.js";
import * as wanxiang from "./providers/wanxiang.js";
import * as jiemeng from "./providers/jiemeng.js";
import * as openai from "./providers/openai.js";
import * as gemini from "./providers/gemini.js";
import * as comfyui from './providers/comfyui.js';
import { probeProvider } from "./providers/probe.js";
import * as textai from './textai.js';
import { apiIdOf } from './models/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");

// 端口要早于「手机端路由挂载」确定（手机端出图会自调本机 /api/generate，需要知道自己的地址）。
// 命名加 SELF_ 前缀是为了不跟文件底部的启动块混淆。
const SELF_PORT = process.env.PORT || derivePorts().backend;
const SELF_BASE = `http://127.0.0.1:${SELF_PORT}`;

// ---------- 安全层（必须在 body 解析之前） ----------
app.use(securityHeaders);
// 变更令牌门放在 Host/Origin 之前：写操作先过令牌，缺令牌直接 403，不进业务逻辑
app.use(mutationGuard);
app.use(guard);

app.use(
  express.json({
    limit: "4mb",
    // 微信 V3 回调验签需要「原始请求体」逐字节比对，
    // 解析后再 JSON.stringify 会因空格/键序变化导致验签失败。
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    }
  })
);
// 第三方聚合支付（易支付/虎皮椒）回调是 form-urlencoded 表单，需要单独解析。
// 必须保留 rawBody（验签用），所以同样在 verify 里抓一份。
app.use(
  express.urlencoded({
    extended: false,
    limit: "1mb",
    verify: (req, _res, buf) => {
      if (!req.rawBody) req.rawBody = buf.toString("utf8");
    }
  })
);

const PROVIDERS = { wanxiang, jiemeng, openai, gemini, comfyui };

// ---------- 会话 ----------
app.get("/api/session", sessionHandler);

// ---------- 账号与登录 ----------
// 免登录白名单：本地令牌本身已是「防跨站」层，这几条用于建立账号会话
const AUTH_PUBLIC = new Set([
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
  // 支付回调：来自支付网关服务器，没有用户会话。
  // 安全性由回调验签保证（见 payments.js），不依赖登录态。
  "/api/recharge/callback/wechat",
  "/api/recharge/callback/alipay",
  "/api/recharge/callback/sandbox",
  "/api/recharge/callback/aggregator",
  // 支付通道状态：充值弹窗要读，只暴露「是否已配置」，无敏感信息
  "/api/recharge/pay-status",
  // 品牌配置：登录页要读，无敏感信息
  "/api/brand",
  // 手机端登录：此时还没有任何令牌。安全性由「账号密码 + 失败锁定 + 限流」保证。
  // 注意只豁免这一条：登录成功后拿到的 m_ 令牌走正常的 requireLogin。
  "/api/m/auth/login"
]);

function auditCtx(req, user) {
  return {
    username: user || "-",
    ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim(),
    ua: req.headers["user-agent"] || ""
  };
}

// 已有账号时，其余接口必须登录
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  if (req.path === "/api/session" || AUTH_PUBLIC.has(req.path)) return next();
  if (!accounts.hasAccounts()) return next(); // 还没建账号 → 保持单机免登录
  const token = readLocalToken(req);
  const user = accounts.currentUser(token);
  if (!user) {
    audit.record("security.blocked", { path: req.path, reason: "未登录访问" }, auditCtx(req));
    return res.status(401).json({ error: "请先登录", code: "LOGIN_REQUIRED" });
  }
  req.user = user;
  next();
});

// ---------- 手机端令牌接线 ----------
// security.js 的 guard 只认「机器令牌」；手机端用的是 m_ 会话令牌。
// 这里把校验器注册进去：令牌有效 ⇔ accounts 里真有这条会话。
// 必须在任何请求进来之前注册（本文件在 listen 之前执行，满足）。
setExtraTokenVerifier((token) => Boolean(mobile.resolve(token)));

// 手机端接口（/api/m/*）。放在登录中间件之后，req.user 已经就绪。
mountMobile(app, { rateLimit, selfBase: SELF_BASE });

// ---------- 权限校验（RBAC 接口级） ----------
function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "请先登录", code: "LOGIN_REQUIRED" });
  next();
}

// 跟 /api/auth/perms 保持同一口径，别两处各写一套判断
const isSuper = (user) => Boolean(user?.roleIds?.includes("r-super"));

function requirePerm(code) {
  return (req, res, next) => {
    if (!rbac.hasPermission(req.user, code)) {
      audit.record(
        "security.blocked",
        { path: req.path, reason: `缺少权限 ${code}` },
        auditCtx(req, req.user?.username)
      );
      return res.status(403).json({ error: "权限不足", code: "FORBIDDEN", need: code });
    }
    next();
  };
}

// 当前登录者的权限清单（前端据此刻画入口，后端仍强制校验）
app.get("/api/auth/perms", requireLogin, (req, res) => {
  res.json({
    perms: req.user.roleIds?.includes("r-super") ? rbac.ALL_CODES : req.user.perms || [],
    roleIds: req.user.roleIds || [],
    dataScope: req.user.dataScope || "all"
  });
});

// 运营系统
mountAdmin(app, { requirePerm, requireLogin });
// 客户中心（账号 + 消费聚合 + 档案 + 人工调账）
mountCustomers(app, { requirePerm, requireLogin });
// 充值中心（订单/统计/补单/退款/改价/自动管理）
mountRechargeAdmin(app, { requirePerm, requireLogin });
// 支付通道配置（微信/支付宝直连 + 第三方聚合）
mountPaymentAdmin(app, { requirePerm, requireLogin });

// ============================================================
// 模板（服务端下发，运营可自助改，不用重新构建发版）
// ============================================================
app.get("/api/templates", (req, res) => {
  res.json({
    categories: templates.CATEGORIES,
    rows: templates.listEnabled(req.query.category),
    grouped: templates.grouped()
  });
});

// 模板反哺：把画布上的整套节点 + 连线存成模板（对应 SynMew 的 template_save_from_project）
app.get("/api/templates/:id/graph", (req, res) => {
  const t = templates.get(req.params.id);
  if (!t) return res.status(404).json({ error: "模板不存在" });
  if (!t.graph || !Array.isArray(t.graph.nodes)) return res.status(404).json({ error: "该模板没有节点图" });
  res.json({ id: t.id, name: t.name, graph: t.graph });
});

app.post("/api/templates/from-project", requireLogin, (req, res) => {
  const { id, name, desc, category, preview, graph } = req.body || {};
  try {
    const t = templates.saveFromProject(
      { id, name, desc, category, preview, graph },
      { userId: userIdOf(req), username: req.user?.username || "" }
    );
    audit.record("template.from_project", { id: t.id, name: t.name, nodes: t.graph?.nodes?.length || 0 }, auditCtx(req, req.user?.username));
    res.json({ ok: true, template: t });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

// ============================================================
// 算力账户（账：credit 是消耗品，与「钱」分开建模）
// ============================================================
function userIdOf(req) {
  return (req.user && req.user.id) || "local";
}

app.get("/api/credits/balance", requireLogin, async (req, res) => {
  const userId = userIdOf(req);
  // 首次访问自动发放新用户赠送
  await credits.ensureSignupGrant(userId);
  res.json({ balance: credits.balance(userId) });
});

app.get("/api/credits/records", requireLogin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ rows: credits.records(userIdOf(req), { limit, type: req.query.type }) });
});

// 计费表：前端用来在按钮上显示「本次消耗 X 算力」
app.get("/api/credits/costs", (req, res) => {
  res.json({ rows: credits.COST_TABLE, signupGrant: credits.SIGNUP_GRANT });
});

// 对账（管理员）：余额必须等于流水求和
app.get("/api/credits/reconcile", requirePerm("admin:dashboard:view"), (req, res) => {
  res.json(credits.reconcile());
});

// ============================================================
// 充值（钱）
// ============================================================
app.get("/api/recharge/plans", (req, res) => {
  res.json({ rows: credits.listPlans() });
});

app.get("/api/recharge/orders", requireLogin, (req, res) => {
  res.json({ rows: credits.listOrders(userIdOf(req)) });
});

app.post("/api/recharge/orders", requireLogin, (req, res) => {
  try {
    const order = credits.createOrder(userIdOf(req), req.body && req.body.planId);
    audit.record(
      "recharge.order.created",
      { plan: order.planId, price: order.price },
      auditCtx(req, req.user.username)
    );
    res.json({ ok: true, order });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/recharge/orders/:id/cancel", requireLogin, (req, res) => {
  try {
    res.json({ ok: true, order: credits.cancelOrder(userIdOf(req), req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 支付回调。
// 生产环境这里必须校验支付网关签名，不能像现在这样由前端直接调用，
// 否则可以伪造支付请求白嫖算力。
// ---------- 支付状态 ----------
// ---------- 品牌（白标） ----------
// ---------- 语义处理（LLM：豆包 2.1 / 任意 OpenAI 兼容中转站） ----------
// 只做"文字上的事"：优化提示词、提炼卖点、翻英文提示词。
// 刻意**不由前端传 system 消息** —— 否则前端等于拿到一个任意 LLM 代理，账单会失控。
app.post("/api/ai/semantic", requireLogin, rateLimit, async (req, res) => {
  const task = String(req.body?.task || "").trim();
  const text = String(req.body?.text || "").trim();
  if (!textai.hasTask(task)) {
    return res.status(400).json({ error: `不支持的任务：${task || "(空)"}`, code: "UNSUPPORTED_TASK" });
  }
  if (!text) return res.status(400).json({ error: "内容不能为空", code: "EMPTY_TEXT" });
  if (text.length > textai.MAX_INPUT_CHARS) {
    return res
      .status(400)
      .json({ error: `内容过长（上限 ${textai.MAX_INPUT_CHARS} 字）`, code: "TEXT_TOO_LONG" });
  }
  try {
    const r = await textai.run(task, text, { context: req.body?.context || {} });
    audit.record(
      "ai.semantic",
      { task, model: r.model, chars: text.length, tokens: r.usage?.totalTokens || 0 },
      auditCtx(req, req.user.username)
    );
    res.json({ ok: true, task, result: r.text, model: r.model, usage: r.usage });
  } catch (err) {
    const msg = String(err?.message || err);
    // "未配置…" 属于配置缺失（503），其它（上游报错/超时）算网关错误（502）
    const notConfigured = /未配置/.test(msg);
    res.status(notConfigured ? 503 : 502).json({
      error: msg,
      code: notConfigured ? "LLM_NOT_CONFIGURED" : "LLM_FAILED"
    });
  }
});

app.get("/api/brand", (req, res) => {
  res.json(brand.current());
});

app.get("/api/recharge/pay-status", (req, res) => {
  res.json(payments.payStatus());
});

// ---------- 发起支付：返回二维码 ----------
// 注意：这里只「创建支付单」，不加算力。加算力必须等回调验签通过。
app.post("/api/recharge/orders/:id/pay", requireLogin, async (req, res) => {
  try {
    const userId = userIdOf(req);
    const order = credits.listOrders(userId).find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "订单不存在" });
    if (order.status === "paid") return res.status(400).json({ error: "订单已支付" });
    if (order.status === "cancelled") return res.status(400).json({ error: "订单已取消" });

    // 前端选的是「微信 / 支付宝」；聚合支付的类型名是 wxpay / alipay，这里统一映射。
    // 直连网关（微信/支付宝）本身就知道自己是谁，payMethod 只对聚合支付生效。
    const channel = String(req.body?.channel || "").trim().toLowerCase();
    const payMethod = channel === "wechat" || channel === "wxpay" ? "wxpay" : channel === "alipay" ? "alipay" : "";
    const pay = await payments.createPayment(payMethod ? { ...order, payMethod } : order);
    audit.record("recharge.pay.created", { order: order.id, gateway: pay.gateway }, auditCtx(req, req.user.username));
    res.json({ ok: true, gateway: pay.gateway, qrCode: pay.qrCode, payUrl: pay.payUrl || "", sandbox: Boolean(pay.sandbox) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================================
// 支付回调 —— 这是「加算力」的唯一合法入口
//
// 安全约束（缺一不可）：
//   1. 必须验签（防伪造）
//   2. 必须校验金额与订单一致（防改价）
//   3. 必须幂等（markPaid 内部已实现，重复回调不会重复发放）
//   4. 不挂 requireLogin —— 回调来自支付网关服务器，没有用户会话
// ============================================================
async function handleCallback(gateway, req, res) {
  try {
    // 取参：易支付的异步通知既可能是 POST 表单，也可能是 GET query；
    // 只有 body 为空时才回退到 query，避免 custom 协议按 rawBody 验签时被多余字段干扰。
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const params = Object.keys(body).length ? body : { ...(req.query || {}) };
    const v = await payments.verifyCallback({
      gateway,
      rawBody: req.rawBody || "",
      headers: req.headers,
      params
    });

    if (!v.ok) {
      audit.record("recharge.callback.rejected", { gateway, reason: v.reason }, auditCtx(req, "-"));
      // 支付网关要求返回失败标识，它会重试；聚合/易支付只认纯文本 fail
      if (gateway === "aggregator") return res.status(400).type("text").send("fail");
      return res.status(400).json({ code: "FAIL", message: v.reason });
    }

    const order = credits.findOrder(v.outTradeNo);
    if (!order) {
      return res.status(404).json({ code: "FAIL", message: "订单不存在" });
    }

    // 金额校验：回调金额必须与订单一致
    const expectCents = Math.round(order.price * 100);
    if (v.amount && v.amount !== expectCents) {
      audit.record(
        "recharge.callback.amount_mismatch",
        { gateway, order: order.id, expect: expectCents, got: v.amount },
        auditCtx(req, "-")
      );
      return res.status(400).json({ code: "FAIL", message: "金额不匹配" });
    }

    if (v.tradeState && !["SUCCESS", "TRADE_SUCCESS", "TRADE_FINISHED"].includes(v.tradeState)) {
      return res.json({ code: "SUCCESS", message: "已接收（非成功态，忽略）" });
    }

    const r = await credits.markPaid(order.id, gateway);
    audit.record(
      "recharge.order.paid",
      { order: order.id, gateway, credits: order.credits + order.bonus },
      auditCtx(req, "-")
    );

    // 微信要求返回 200 + 空体；支付宝/第三方聚合（易支付、虎皮椒）要求纯文本 "success"
    if (gateway === "alipay" || gateway === "aggregator") return res.type("text").send("success");
    return res.json({ code: "SUCCESS", message: "成功", balance: r.balance });
  } catch (err) {
    audit.record("recharge.callback.error", { gateway, error: err.message }, auditCtx(req, "-"));
    return res.status(500).json({ code: "FAIL", message: err.message });
  }
}

// ⚠️ 2026-10-14 修复：前端「模拟支付成功」以前调用的是一个**根本不存在的**
//    /api/recharge/orders/:id/paid（服务端从未实现）→ 充值弹窗点支付必 404，
//    同时那段前端代码自述「前端直接标记已付等于允许伪造支付」。
//    正确做法：演示也必须走**真实的回调链路**（验签 → 金额校验 → 幂等 → 到账），
//    只是由服务端自己用沙箱私钥签发一张回调票据（sandboxNotifyHeaders）。
//    安全边界：仅在未配置任何真实支付凭证（sandbox 模式）下开放；
//    一旦填了商户号/AppId，此接口直接 403，真实回调只能来自支付网关服务器。
app.post("/api/recharge/orders/:id/simulate-paid", requireLogin, (req, res, next) => {
  if (!payments.payStatus().sandbox) {
    return res.status(403).json({ error: "已配置真实支付，模拟支付已关闭" });
  }
  const userId = userIdOf(req);
  const order = credits.listOrders(userId).find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "订单不存在" });
  if (order.status === "paid") return res.status(400).json({ error: "订单已支付" });
  if (order.status === "cancelled") return res.status(400).json({ error: "订单已取消" });

  // 用沙箱私钥签发回调票据，再走与真实网关**完全相同**的 handleCallback。
  // 这样验签、金额校验、幂等三道闸在演示路径上同样生效，不留后门。
  const payloadObj = { out_trade_no: order.id, total: order.price };
  const headers = payments.sandboxNotifyHeaders(order);
  req.headers = {
    ...req.headers,
    "x-sandbox-payload": headers["x-sandbox-payload"],
    "x-sandbox-signature": headers["x-sandbox-signature"]
  };
  req.rawBody = JSON.stringify(payloadObj);
  audit.record("recharge.sandbox.simulated", { order: order.id }, auditCtx(req, req.user.username));
  return handleCallback("sandbox", req, res);
});

app.post("/api/recharge/callback/wechat", (req, res) => handleCallback("wechat", req, res));
app.post("/api/recharge/callback/alipay", (req, res) => handleCallback("alipay", req, res));

// 第三方聚合支付回调（易支付/蓝兔/虎皮椒/自建聚合）。
// 安全性同样由 payments.verifyCallback 里的验签保证；provider 从本地配置读取，
// 绝不信任回调里自报的 provider。
app.post("/api/recharge/callback/aggregator", (req, res) => handleCallback("aggregator", req, res));

// 沙箱回调：仅在未配置任何支付凭证时开放，用于本地/内网演示
app.post("/api/recharge/callback/sandbox", (req, res, next) => {
  if (!payments.payStatus().sandbox) {
    return res.status(403).json({ error: "已配置真实支付，沙箱回调已关闭" });
  }
  return handleCallback("sandbox", req, res, next);
});

// 账号状态：是否需要初始化 / 当前登录者
app.get("/api/auth/status", (req, res) => {
  const token = readLocalToken(req);
  const user = accounts.currentUser(token);
  res.json({
    hasAccounts: accounts.hasAccounts(),
    loggedIn: Boolean(user),
    user: user || null,
    sessionCount: accounts.sessionCount()
  });
});

// 首次初始化管理员
app.post("/api/auth/setup", (req, res) => {
  try {
    if (accounts.hasAccounts()) {
      return res.status(400).json({ error: "管理员已存在，请直接登录" });
    }
    const { username, password } = req.body || {};
    const user = accounts.createUser({ username, password, role: "admin" });
    audit.record("auth.user.created", { username: user.username, role: user.role }, auditCtx(req, user.username));
    const result = accounts.login({
      // 注意：auditCtx 里也有 username 字段，必须先展开再显式赋值，否则会被覆盖
      ...auditCtx(req, user.username),
      username,
      password,
      localToken: readLocalToken(req)
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/auth/login", rateLimit, (req, res) => {
  const { username, password } = req.body || {};
  // 默认记住：桌面端每次开机都要重新登录很烦；显式传 remember:false 才用 12 小时短会话
  const remember = req.body?.remember !== false;
  const ctx = auditCtx(req, username);
  const result = accounts.login({
    // 先展开上下文，再显式给出凭据，避免同名键被覆盖
    ...ctx,
    username,
    password,
    localToken: readLocalToken(req),
    remember
  });

  if (result.ok) {
    audit.record("auth.login", { username: result.user.username }, ctx);
  } else if (result.code === "LOCKED") {
    audit.record("auth.locked", { username, reason: result.error }, ctx);
  } else {
    audit.record("auth.login.failed", { username, reason: result.error }, ctx);
  }
  res.status(result.ok ? 200 : 401).json(result);
});

app.post("/api/auth/logout", (req, res) => {
  const token = readLocalToken(req);
  const user = accounts.currentUser(token);
  accounts.logout(token);
  audit.record("auth.logout", { username: user?.username || "-" }, auditCtx(req, user?.username));
  res.json({ ok: true });
});

app.post("/api/auth/password", (req, res) => {
  try {
    const token = readLocalToken(req);
    const user = accounts.currentUser(token);
    accounts.changePassword({
      token,
      oldPassword: req.body?.oldPassword,
      newPassword: req.body?.newPassword
    });
    audit.record("auth.password.changed", { username: user?.username || "-" }, auditCtx(req, user?.username));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- 安全记录 ----------
app.get("/api/audit", (req, res) => {
  res.json({
    events: audit.query({
      limit: Math.min(Number(req.query.limit) || 100, 500),
      level: String(req.query.level || ""),
      type: String(req.query.type || ""),
      days: Math.min(Number(req.query.days) || 7, 30)
    })
  });
});

app.get("/api/audit/stats", (req, res) => {
  res.json(audit.stats(Math.min(Number(req.query.days) || 7, 30)));
});

app.get("/api/security", (req, res) => {
  const { token, ...safe } = securityStatus();
  res.json({ ...safe, vault: vaultStatus() });
});

// ---------- 设置 ----------
app.get("/api/settings", (req, res) => res.json(maskedConfig()));

app.put("/api/settings", (req, res) => {
  const patch = {};
  const current = loadConfig();
  for (const key of PROVIDER_KEYS) {
    const incoming = req.body?.[key];
    if (!incoming || typeof incoming !== "object") continue;
    const next = { ...incoming };
    const apiKey = next.apiKey;
    delete next.apiKey;
    // 空值或掩码 => 保持原密钥；有真实值 => 写进保险箱；null => 清除
    if (apiKey === null) setProviderKey(key, "");
    else if (typeof apiKey === "string" && apiKey.trim() && !apiKey.includes("****")) {
      setProviderKey(key, apiKey.trim());
    }
    patch[key] = { ...current[key], ...next };
  }
  if (req.body?.limits) patch.limits = { ...current.limits, ...req.body.limits };
  // 模型 ID 覆盖表：{"界面模型 id": "上游真实模型名"}。空字符串表示"清除覆盖、回到官方默认"。
  if (req.body?.models && typeof req.body.models === "object") {
    const cleaned = {};
    for (const [id, name] of Object.entries(req.body.models)) {
      const key = String(id || "").trim();
      if (!key) continue;
      const val = String(name == null ? "" : name).trim();
      if (val) cleaned[key] = val;
      else cleaned[key] = ""; // 空 = 显式清除（saveConfig 合并时会覆盖成空串，apiIdOf 会忽略空串）
    }
    patch.models = { ...(current.models || {}), ...cleaned };
  }
  saveConfig(patch);
  audit.record(
    "settings.changed",
    { providers: Object.keys(patch).filter((k) => k !== "limits") },
    auditCtx(req, req.user?.username)
  );
  res.json(maskedConfig());
});

// ---------- 模型 API 连通性自检 ----------
//
// 为什么要有：设置页填完 Key/地址/模型名后，用户只能"先生成一张图试试"才知道通不通，
// 而生成要扣算力、要排队、要等几十秒。这里做一次免费探测（列模型 / 1-token 对话），
// 把"Key 错、地址错、模型没开通、网络不通"分别翻译成一句话 + 该改哪个输入框。
//
// body: { provider, baseUrl?, model?, apiKey? }
//   —— 覆盖项只用于本次探测、不落盘，前端可以拿表单里还没保存的值来试。
//   apiKey 语义：不传 = 用已保存的 Key；传 null/"" = 本次不用 Key（用户清空了输入框，应报 NO_KEY）。
//
// 限流单独一档（120 次/分钟）：一次「一键自检」会连打 5 个 provider，
// 再加反复试错，通用的 30 次/分钟会把正常用户挡在门外。
let probeWindow = { ts: 0, n: 0 };
function probeRateLimit(req, res, next) {
  const now = Date.now();
  if (now - probeWindow.ts > 60_000) probeWindow = { ts: now, n: 0 };
  probeWindow.n += 1;
  if (probeWindow.n > 120) {
    return res.status(429).json({ ok: false, code: "RATE", message: "自检请求过于频繁，请稍后再试" });
  }
  next();
}

app.post("/api/providers/probe", probeRateLimit, async (req, res) => {
  const provider = String(req.body?.provider || "").trim();
  try {
    const override = {
      baseUrl: req.body?.baseUrl,
      model: req.body?.model
    };
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "apiKey")) {
      override.apiKey = req.body.apiKey;
    }
    const result = await probeProvider(provider, override);
    audit.record(
      "provider.probe",
      { provider, ok: result.ok, code: result.code },
      auditCtx(req, req.user?.username)
    );
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      provider,
      code: "INTERNAL",
      message: `自检出错：${error?.message || error}`,
      hints: ["这不是配置问题，把这段文字发给开发者即可"]
    });
  }
});

// ---------- 版本与更新 ----------
const CURRENT_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.1.0";
  }
})();

function cmpVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function readUpdateFeed() {
  // 更新源优先级：环境变量 UPDATE_FEED_JSON > 本地 update-feed.json
  if (process.env.UPDATE_FEED_JSON) {
    try {
      return JSON.parse(process.env.UPDATE_FEED_JSON);
    } catch { /* ignore */ }
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "update-feed.json"), "utf8"));
  } catch {
    return null;
  }
}

app.get("/api/version", (_req, res) => {
  const feed = readUpdateFeed();
  const latest = feed?.latest || CURRENT_VERSION;
  res.json({
    current: CURRENT_VERSION,
    latest,
    hasUpdate: cmpVersion(latest, CURRENT_VERSION) > 0,
    notes: feed?.notes || "",
    size: feed?.size || 0,
    releasedAt: feed?.releasedAt || "",
    autoCheck: feed?.autoCheck !== false
  });
});

app.get("/api/comfyui/status", async (req, res) => {
  res.json(await comfyui.status());
});

// ---------- 生成（SSE：所有失败也走事件，避免前端悬挂） ----------
function openStream(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return {
    send,
    fail: (message) => {
      send("error", { error: message });
      res.end();
    }
  };
}

// 单批张数上限：模型侧一次最多出 4 张。
// 要 10 张由客户端分批编排（见 /api/batch/*），服务端不再需要编排器。
const MAX_PER_BATCH = Number(process.env.AI_CANVAS_MAX_PER_BATCH || 4);

app.post("/api/generate", rateLimit, async (req, res) => {
  // provider 用 let：模型网关允许「只给 model 不给 provider」，由注册表决定路由
  let {
    provider, prompt, negativePrompt, size = "1024x1024", n = 1,
    steps, cfg, seed, model = "", referenceImages, remark = "",
    strength = 0, printArea = "auto", keepTexture = true,
    batchId = "", batchIndex = 0, taskId = ""
  } = req.body || {};
  const { send, fail } = openStream(res);

  // 只给 model 不给 provider 时，由模型注册表决定路由（Sprint 1 模型网关）。
  // 注意：未知 provider 仍然照旧拒绝（__not_exist__ 这类入参必须继续报错），
  // 所以这里只在「provider 为空 + 模型已注册」时才改写。
  if (!PROVIDERS[provider]) {
    const routed = gateway.planGenerate({ provider: "", model, kind: "image", size, n: 1 });
    if (routed.model && PROVIDERS[routed.provider]) provider = routed.provider;
  }
  if (!PROVIDERS[provider]) return fail(`未知提供方 ${provider}`);
  if (!prompt || !String(prompt).trim()) return fail("提示词不能为空");

  const nSafe = Math.min(Math.max(Math.round(Number(n) || 1), 1), MAX_PER_BATCH);
  const chargeUser = req.user?.id || "local";
  const referenceList = Array.isArray(referenceImages) ? referenceImages.filter(Boolean) : [];

  // ---- 模型网关：能力校验 + 计价（Sprint 1）----
  // 刻意放在 acquireSlot() **之前**：校验失败绝不能占用并发槽。
  // 这与 __fixes 里修的「余额为 0 连点两次锁死所有人」是同一类缺陷，
  // 只是触发点从「算力不足」换成了「模型能力不符」。
  const plan = gateway.planGenerate({
    provider,
    model,
    kind: "image",
    size,
    n: nSafe,
    referenceImages: referenceList,
    mode: referenceList.length ? "i2i" : "t2i"
  });
  if (!plan.ok) return fail(plan.message);

  if (budgetExceeded()) return fail(`已达今日生成上限，剩余额度 ${budgetRemaining()} 次`);
  if (!acquireSlot()) return fail("同时进行的生成任务过多，请等前一个完成后再试");

  // ⚠️ 2026-10-14 修复（并发槽泄漏 → 未授权全局 DoS）：
  // acquireSlot() 一旦成功，就必须在所有退出路径上 releaseSlot()。
  // 早期实现在「算力不足」处直接 `return fail(...)`，而 try/finally 从扣费之后才开始，
  // 于是那次请求的槽位永远不会归还：任意一个余额为 0 的账号连发 2 次生成
  // （maxConcurrent=2）就能把全局 inFlight 顶满，此后**所有人**的生成都被拒，
  // 只能重启进程。现在把「签名 → 命中缓存 → 预扣」整段都纳入 try，finally 统一释放；
  // 只有 acquireSlot 自身失败（没拿到槽）才提前返回。
  try {
    // ---- 上游签名幂等：同输入 → 同 refId ----
    // 只有影响模型输出的字段进签名；remark（备注）等一律排除，
    // 所以「改个备注再重跑」不会重复扣费。
    const sig = upstream.upstreamSignature({
      kind: "image",
      provider, model, prompt, negativePrompt, size,
      n: nSafe, steps, cfg, seed, referenceImages
    });
    const refId = sig || newId(); // 入参不足时退回随机 id，绝不共享同一个 refId

    // ① 命中结果缓存 → 零扣费直接返回（缓存按 userId 隔离，不会命中别人的结果）
    const cached = upstream.cacheGet(sig, chargeUser);
    if (cached) {
      audit.record(
        "generate.cache_hit",
        {
          provider, model, signature: upstream.shortSig(sig),
          count: cached.items.length, savedCost: cached.savedCost, batchId, batchIndex
        },
        auditCtx(req, req.user?.username)
      );
      send("progress", { text: `命中历史结果，本次不扣算力（省 ${cached.savedCost} 点）` });
      send("done", {
        images: cached.items,
        cost: 0,
        savedCost: cached.savedCost,
        cached: true,
        signature: sig,
        balance: credits.balance(chargeUser)
      });
      return res.end();
    }

    // ② 缓存已被清理，但账本里这条已正式消费过 → 重跑但不预扣
    const replay = credits.findConsumed(chargeUser, refId);

    // ---- 扣费：预扣 → 提交 / 回滚 ----
    // 生成前先扣，失败退回。避免「失败了还扣钱」——这是用户投诉第一来源。
    // reserve 自身带 refId 幂等：同一条重跑不会重复扣费。
    const reserved = replay
      ? { ok: true, cost: 0, balance: credits.balance(chargeUser), reserved: false, replay: true }
      : await gateway.reserveFor(chargeUser, plan, refId);
    if (!reserved.ok) {
      return fail(`算力不足：本次需要 ${reserved.need} 点，当前余额 ${reserved.balance} 点，请先充值`);
    }

    // 服务端登记这个任务：前端取消时才能真正停上游（ComfyUI 会调 /interrupt），
    // 否则只是断开本地连接，GPU 照跑、预扣的点数照扣 —— 用户会以为「取消了还扣钱」。
    const task = taskId
      ? tasks.register(taskId, { userId: chargeUser, kind: "image", refId, provider })
      : null;

    try {
      if (replay) send("progress", { text: "检测到相同任务已付费，本次重跑不再扣算力" });
      else if (reserved.duplicate) send("progress", { text: "检测到同一任务已在生成中，本次不重复扣费" });
      // 网关诊断（「模型未注册，按基价计费」「未指定模型，按默认模型计费」等）如实上报：
      // 静默按某个猜测执行，是排障时最贵的沉默。
      for (const note of plan.diagnostics) send("progress", { text: note });
      // P0-0：参考图终于真的传给模型了。之前只把文件名拼进提示词文本，
      // 模型压根没见过那张毛衫图 —— 商品一致性、印花区域这些都无从谈起。
      //
      // 2026-10-23：模型名要分「界面 id」和「上游真实名字」两层。
      //   registry 里 id/apiId 分离；用户设置里的 config.models[id] 优先级最高。
      //   这样才能同时吃官方 id（gemini-3-pro-image-preview）和中转站自定义名。
      const upstreamModel = apiIdOf(String(model || ""), loadConfig().models || {});
      const images = await PROVIDERS[provider].generate({
      model: upstreamModel,
      prompt: String(prompt).trim(),
      negativePrompt,
      size,
      n: nSafe,
      steps,
      cfg,
      seed,
      referenceImages: Array.isArray(referenceImages) ? referenceImages : [],
      strength: Number(strength) || 0,
      printArea: String(printArea || "auto"),
      onProgress: (text) => send("progress", { text }),
      // 取消信号：一路传到 provider 的 fetch，让上游请求真的断掉
      signal: task?.controller.signal,
      // provider 自己的清理钩子（ComfyUI 用这个注册 /interrupt 停 GPU）
      registerCancel: taskId ? (fn) => tasks.onCancel(taskId, fn) : null,
      taskId: taskId || ""
    });
    // 落地到本地 outputs，避免远程 URL 过期
    const saved = [];
    const dir = outputsDir();
    for (const img of images) {
      try {
        const buf = Buffer.from(await (await fetch(img.url)).arrayBuffer());
        const file = `${newId()}.png`;
        fs.writeFileSync(path.join(dir, file), buf);
        // E6 血缘：趁参数还在手边，立刻把「这张图是怎么来的」写在它旁边。
        // 晚了就没了 —— 三周后想复现这张图时，谁也记不清当时填了什么。
        // 注意：同一批多张时 provider 内部的种子是它自己随的，这里记的是
        // 请求传入的那颗，所以第 2 张起 seed 可能为空 —— 界面如实显示「未提供」即可。
        const entry = lineage.record(file, {
          provider, model, prompt, negativePrompt, size, steps, cfg, seed,
          strength, printArea, keepTexture,
          references: Array.isArray(referenceImages) ? referenceImages : [],
          cost: reserved.cost, taskId, batchId, batchIndex,
          nodeId: String(req.body?.nodeId || ""),
          projectId: String(req.body?.projectId || ""),
          userId: chargeUser, username: req.user?.username || "", remark
        });
        saved.push({ url: `/outputs/${file}`, remoteUrl: img.url, lineageId: entry?.id || "" });
      } catch {
        saved.push({ url: img.url, remoteUrl: img.url }); // ComfyUI 直链等情况保留原 URL
      }
    }
    // 生成成功：确认扣费（replay 场景没有预扣，commit 会安全跳过）
    await gateway.commitFor(chargeUser, plan, refId);
    bumpUsage("image");
    // 写入上游签名缓存，下次同输入直接命中
    upstream.cachePut(sig, {
      items: saved, cost: reserved.cost, provider, model, userId: chargeUser, kind: "image"
    });
    audit.record(
      "generate.image",
      {
        provider, model: req.body?.model || "", count: saved.length, size,
        cost: reserved.cost, signature: upstream.shortSig(sig),
        replay: Boolean(replay), batchId, batchIndex
      },
      auditCtx(req, req.user?.username)
    );
    send("done", {
      images: saved,
      cost: reserved.cost,
      cached: false,
      replay: Boolean(replay),
      signature: sig,
      balance: reserved.balance,
      // 网关信息（附加字段，界面可选用）：这次到底用了哪个模型、是否走了注册表。
      // 前端目前不读，但排障与后续「按模型显示单价」都要靠它。
      model: plan.model?.id || String(req.body?.model || ""),
      provider: plan.provider || provider,
      registered: plan.registered
    });
  } catch (error) {
    // 用户取消不是「失败」：文案要区分开，否则任务条上写着「失败」，
    // 用户会以为模型出错，实际是他自己点的取消。
    const canceled = Boolean(task?.canceled) || error?.name === "AbortError";
    // 生成失败：退回算力。
    // 只有真的预扣过才回滚 —— replay / duplicate 场景回滚会把别人的预扣重复退掉。
    const rb = reserved.reserved
      ? await gateway.rollbackFor(chargeUser, plan, refId, reserved.txId)
      : { refunded: 0 };
    // 带上 signature：线上排障时能直接比对该任务的签名，判断为何没命中缓存
    send("error", {
      error: canceled ? "已取消" : error.message || String(error),
      canceled,
      refunded: rb.refunded || 0,
      signature: sig
    });
  } finally {
    if (taskId) tasks.unregister(taskId);
    res.end();
  }
  } finally {
    // 外层 finally：无论走缓存命中、算力不足、生成成功或抛异常，槽位一律归还。
    // 这是「余额为 0 的账号连点两次就把所有人锁死」那个 DoS 的根治点。
    releaseSlot();
  }
});

// ---------- 技能库（Sprint 2）----------
// 技能定义（输入参数 / 推荐模型 / 提示词链 / 建议节点图）由服务端下发，
// 前端只负责渲染与铺画布 —— 这样加技能不用改前端、也不会两处各写一份参数定义。
app.get("/api/skills", (req, res) => {
  res.json({ skills: skills.listSkills({ category: req.query?.category, kind: req.query?.kind }) });
});

// 技能执行计划：参数 → 编译后的提示词 + 选定模型 + 成本 + 建议节点/连线。
// 纯计算（不扣费、不落盘），所以放在生成之前让用户可以反复预览。
app.post("/api/skills/plan", rateLimit, (req, res) => {
  const body = req.body || {};
  const plan = skills.skillPlan(String(body.id || ""), body.params || {});
  if (!plan.ok) {
    return res.status(400).json({ ok: false, code: plan.code, error: plan.message });
  }
  res.json(plan);
});

// ---------- 模型目录（模型网关下发：能力 / 单价 / 密钥状态） ----------
// 前端模型选择器读它就能拿到服务端权威的单价与限额，不必再各写一份。
// 放在与 /api/settings 同级的鉴权口径下（有账号时需登录），避免把配置状态裸露给未登录页面。
app.get("/api/models", (req, res) => {
  const kind = req.query?.kind === "video" ? "video" : undefined;
  res.json(gateway.catalog({ kind }));
});

// ---------- 提示词编译（参考图 + 原话 + 画幅 + 槽位 → 可直接执行的指令） ----------
// 纯计算：不扣费、不落盘、不调上游，所以可以放在「生成前预览」里反复调用。
// 编译语义见 server/prompt/compiler.js 头部注释（角色锚点 / 不变量 / 边界 / 画幅 / 注入防御）。
app.post("/api/prompt/compile", rateLimit, (req, res) => {
  const body = req.body || {};
  try {
    const compiled = compilePrompt({
      raw: body.raw,
      references: body.references,
      ratio: body.ratio,
      slots: body.slots
    });
    res.json({ ok: true, ...compiled });
  } catch (error) {
    // 纯函数理论上不抛；真抛了也不能把 500 原样糊到界面上
    res.status(400).json({ ok: false, error: error.message || "提示词编译失败" });
  }
});

// ============================================================
// 任务取消 —— 真取消（2026-09-25）
// ------------------------------------------------------------
// 以前前端点「取消」只 abort 本地 fetch：服务端那条请求继续跑完，
// GPU 继续算，预扣的算力照 commit。用户看到的就是「取消了还扣钱」。
// 现在取消会：① 调 provider 钩子停上游（ComfyUI /interrupt）② 断上游连接
// ③ 让 generate 的 catch 走回滚，把预扣的点数退回去。
// ============================================================
app.post("/api/tasks/cancel", rateLimit, async (req, res) => {
  const { taskId } = req.body || {};
  if (!taskId) return res.json({ ok: false, error: "缺少 taskId" });

  const r = await tasks.cancel(taskId, "user");
  if (!r.ok) return res.json(r);

  audit.record(
    "task.cancel",
    { taskId: String(taskId).slice(0, 16), already: Boolean(r.already) },
    auditCtx(req, req.user?.username)
  );
  res.json(r);
});

/** 排障用：当前挂着的任务。只给本机开，不暴露给网络。 */
app.get("/api/tasks", (req, res) => {
  if (!isLocalHost(req.ip) && !isLocalHost(req.headers["x-forwarded-for"] || "")) {
    return res.status(403).json({ ok: false, error: "仅本机可用" });
  }
  res.json({ ok: true, active: tasks.activeCount(), items: tasks.snapshot() });
});

// ============================================================
// 批量进度（落盘）—— 服务端只存文件，不做编排
// ============================================================

/**
 * 服务端自调 /api/generate 时用的鉴权头。
 * 为什么优先用调用方的 Cookie/Token 而不是机器令牌：
 *   算力是记在「令牌所属账号」上的，用机器令牌会把这批图的费用记到本机 local 账号，
 *   用户在自己账号里就看不到扣费记录 —— 手机端作业当初就是踩过这个坑才改成透传用户令牌。
 */
function selfAuthHeaders(req) {
  const cookie = String(req.headers?.cookie || "");
  const token = String(req.headers?.["x-ai-canvas-token"] || "");
  const mutation = typeof mutationToken === "function" ? mutationToken() : "";
  return { cookie, token: token || localToken(), mutation };
}

// ---------- 文件批量工作台（一个文件夹 → 每个文件跑一次流水线） ----------
// 与 /api/batch 的区别：那边是「一段提示词出 N 张图」，这里是「一个文件一条流水线」。
app.post("/api/batch/scan", requireLogin, rateLimit, (req, res) => {
  try {
    const result = filebatch.scan({ dir: req.body?.dir, recursive: req.body?.recursive !== false });
    audit.record("batch.scan", { root: result.root, total: result.total }, auditCtx(req, req.user.username));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err), code: err?.code || "SCAN_FAILED" });
  }
});

// 源图/结果缩略图：只允许访问扫描根目录内的文件（resolveInside 兜底防穿越）
app.get("/api/batch/fs", requireLogin, (req, res) => {
  try {
    const root = String(req.query?.root || "");
    const rel = String(req.query?.rel || "");
    if (!root) return res.status(400).json({ error: "缺少 root", code: "NO_ROOT" });
    const abs = filebatch.resolveInside(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) return res.status(400).json({ error: "不是文件" });
    res.setHeader("Content-Type", filebatch.mimeOf(abs));
    res.setHeader("Cache-Control", "private, max-age=120");
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    res.status(404).json({ error: String(err?.message || err), code: err?.code || "NOT_FOUND" });
  }
});

app.post("/api/batch/start", requireLogin, rateLimit, (req, res) => {
  try {
    const out = filebatch.start({
      dir: req.body?.dir,
      files: req.body?.files,
      params: req.body?.params || {},
      selfBase: SELF_BASE,
      auth: selfAuthHeaders(req),
      outputsRoot: outputsDir()
    });
    audit.record("batch.start", { job: out.job.id, total: out.job.total }, auditCtx(req, req.user.username));
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err), code: err?.code || "START_FAILED" });
  }
});

app.get("/api/batch/state", requireLogin, (_req, res) => {
  res.json(filebatch.state());
});

app.post("/api/batch/pause", requireLogin, rateLimit, (req, res) => {
  try {
    res.json(filebatch.pause());
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err), code: err?.code || "PAUSE_FAILED" });
  }
});

app.post("/api/batch/resume", requireLogin, rateLimit, (req, res) => {
  try {
    res.json(filebatch.resume({ selfBase: SELF_BASE, auth: selfAuthHeaders(req) }));
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err), code: err?.code || "RESUME_FAILED" });
  }
});

app.post("/api/batch/cancel", requireLogin, rateLimit, (req, res) => {
  try {
    const out = filebatch.cancel();
    audit.record("batch.cancel", { job: out.job.id }, auditCtx(req, req.user.username));
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err), code: err?.code || "CANCEL_FAILED" });
  }
});

app.post("/api/batch", rateLimit, (req, res) => {
  const { id, total, perBatch, label, payload } = req.body || {};
  if (!id) return res.status(400).json({ error: "缺少 batchId" });
  try {
    res.json({ ok: true, batch: batch.create({ id, total, perBatch, label, payload }) });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

app.put("/api/batch/:id", rateLimit, (req, res) => {
  const { index, status, images, error } = req.body || {};
  try {
    const data = batch.update(req.params.id, { index, status, images, error });
    if (!data) return res.status(404).json({ error: "批量任务不存在" });
    res.json({ ok: true, batch: data });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

app.get("/api/batch", (_req, res) => {
  res.json({ rows: batch.list(), root: batch.root() });
});

app.get("/api/batch/:id", (req, res) => {
  const data = batch.get(req.params.id);
  if (!data) return res.status(404).json({ error: "批量任务不存在" });
  res.json({ batch: data, images: batch.results(req.params.id) });
});

app.delete("/api/batch/:id", (req, res) => {
  res.json(batch.remove(req.params.id));
});

// 生成缓存（上游签名命中用）—— 设置页可查看 / 清理
app.get("/api/cache/status", requirePerm("admin:dashboard:view"), (_req, res) => {
  res.json(upstream.cacheStats());
});

app.delete("/api/cache", requirePerm("admin:dashboard:view"), (_req, res) => {
  res.json(upstream.cacheClear());
});

// ---------- 本地图片上传 ----------
app.post("/api/upload", rateLimit, express.raw({ type: "image/*", limit: "30mb" }), (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: "无图片数据" });
  const ext = (req.headers["content-type"].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "") || "png";
  const file = `${newId()}.${ext}`;
  fs.writeFileSync(path.join(outputsDir(), file), req.body);
  res.json({ url: `/outputs/${file}` });
});

// ---------- 素材库 ----------
const MATERIAL_TYPES = {
  image: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"],
  video: [".mp4", ".webm", ".mov", ".avi", ".mkv"],
  audio: [".mp3", ".wav", ".aac", ".flac", ".ogg", ".m4a"]
};

// 上传 MIME 白名单，挡住 type: () => true 的全放行
const UPLOAD_MIME = /^(image\/(png|jpe?g|webp|gif|bmp)|video\/(mp4|webm|quicktime|x-msvideo|x-matroska)|audio\/(mpeg|wav|x-wav|aac|flac|ogg|mp4))$/;

function kindOf(ext) {
  for (const [kind, exts] of Object.entries(MATERIAL_TYPES)) {
    if (exts.includes(ext.toLowerCase())) return kind;
  }
  return null;
}

app.get("/api/materials", (req, res) => {
  const root = materialDir();
  const categories = MATERIAL_CATEGORIES.map((cat) => {
    const dir = path.join(root, cat.id);
    let files = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => kindOf(path.extname(f)))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return {
            name: f,
            url: `/materials/${cat.id}/${encodeURIComponent(f)}`,
            kind: kindOf(path.extname(f)),
            size: st.size,
            mtime: st.mtimeMs
          };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { /* 目录为空 */ }
    return { ...cat, files: mats.decorate(files) };
  });
  res.json({ categories, root, tagGroups: mats.TAG_GROUPS });
});

// 素材打标签：颜色 / 品类 / 季节 / SKU（口径见 materials.js）
app.patch("/api/materials/tags", rateLimit, (req, res) => {
  const { url, tags } = req.body || {};
  const p = mats.parseMaterialUrl(url);
  if (!p) return res.status(400).json({ error: "素材路径不合法" });
  const saved = mats.setTags(p.cat, p.file, tags);
  if (!saved) return res.status(500).json({ error: "标签保存失败（磁盘不可写？）" });
  res.json({ ok: true, url, tags: saved });
});

// 删除素材：文件与标签一起清，只清一半都会留下垃圾
app.delete("/api/materials", rateLimit, (req, res) => {
  const url = req.query.url || req.body?.url;
  const p = mats.parseMaterialUrl(url);
  if (!p) return res.status(400).json({ error: "素材路径不合法" });
  const r = mats.removeMaterial(p.cat, p.file);
  if (!r.ok) return res.status(400).json({ error: r.error });
  audit.record("material.remove", { cat: p.cat, file: p.file }, auditCtx(req, req.user?.username));
  res.json({ ok: true });
});

// 上传素材到指定分类：/api/materials/upload?category=clothing
app.post(
  "/api/materials/upload",
  rateLimit,
  express.raw({
    type: (req) => UPLOAD_MIME.test(String(req.headers["content-type"] || "").split(";")[0].trim()),
    limit: "200mb"
  }),
  (req, res) => {
    if (!req.body?.length) return res.status(415).json({ error: "不支持的文件类型，仅接受图片 / 视频 / 音频" });
    const category = req.query.category;
    const cat = MATERIAL_CATEGORIES.find((c) => c.id === category);
    if (!cat) return res.status(400).json({ error: `未知分类 ${category}` });
    const ext = (path.extname(req.query.name || "") || `.${(req.headers["content-type"] || "").split("/")[1] || "bin"}`)
      .replace(/[^a-z0-9.]/gi, "")
      .toLowerCase();
    if (!kindOf(ext)) return res.status(400).json({ error: `不支持的素材类型 ${ext}` });
    const file = `${newId()}${ext}`;
    const dir = path.join(materialDir(), cat.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), req.body);
    res.json({ url: `/materials/${cat.id}/${encodeURIComponent(file)}`, name: file, kind: kindOf(ext) });
  }
);

// ---------- 视频生成（万相） ----------
app.post("/api/generate-video", rateLimit, async (req, res) => {
  const {
    prompt, firstFrame, resolution = "720p", duration = 5, model = "", remark = ""
  } = req.body || {};
  const { send, fail } = openStream(res);

  if (!prompt || !String(prompt).trim()) return fail("视频画面描述不能为空");

  const chargeUser = req.user?.id || "local";
  const provider = "wanxiang"; // 视频目前只有万相一家
  const frameList = firstFrame ? [firstFrame].filter(Boolean) : [];

  // ---- 模型网关（视频与图片同源，Sprint 1）----
  // 分辨率是 "720p"/"1080p" 这种口径，网关校验的是像素尺寸字符串，
  // 所以这里如实映射一次，而不是编一个占位值 —— 校验本身也要是真的。
  const pixelSize = resolution === "1080p" ? "1920x1080" : "1280x720";
  const plan = gateway.planGenerate({
    provider,
    model,
    kind: "video",
    size: pixelSize,
    n: 1,
    referenceImages: frameList,
    mode: "video"
  });
  if (!plan.ok) return fail(plan.message);

  if (budgetExceeded()) return fail(`已达今日生成上限，剩余额度 ${budgetRemaining()} 次`);
  if (!acquireSlot()) return fail("同时进行的生成任务过多，请等前一个完成后再试");

  // ⚠️ 2026-10-14 修复：与 /api/generate 同源的并发槽泄漏。
  // acquireSlot() 成功后所有退出路径都必须 releaseSlot()，否则余额不足两次
  // 就会把全局 inFlight 顶满，锁死所有人的生成。整段纳入 try，finally 统一释放。
  try {
    // 与图片同源的幂等：同输入（prompt + 首帧 + 分辨率 + 时长）→ 同 refId
    // 改备注、改任务名不影响签名，因此重跑不重复扣费。
    const sig = upstream.upstreamSignature({
      kind: "video", provider, model, prompt, firstFrame, resolution, duration
    });
    const refId = sig || newId();

    const cached = upstream.cacheGet(sig, chargeUser);
    if (cached) {
      audit.record(
        "generate.cache_hit",
        {
          provider, model, kind: "video", signature: upstream.shortSig(sig),
          count: cached.items.length, savedCost: cached.savedCost
        },
        auditCtx(req, req.user?.username)
      );
      send("progress", { text: `命中历史结果，本次不扣算力（省 ${cached.savedCost} 点）` });
      send("done", {
        videos: cached.items,
        cost: 0,
        savedCost: cached.savedCost,
        cached: true,
        signature: sig,
        balance: credits.balance(chargeUser)
      });
      return res.end();
    }

    const replay = credits.findConsumed(chargeUser, refId);
    const reserved = replay
      ? { ok: true, cost: 0, balance: credits.balance(chargeUser), reserved: false, replay: true }
      : await gateway.reserveFor(chargeUser, plan, refId);
    if (!reserved.ok) {
      return fail(`算力不足：本次需要 ${reserved.need} 点，当前余额 ${reserved.balance} 点，请先充值`);
    }

    try {
      if (replay) send("progress", { text: "检测到相同任务已付费，本次重跑不再扣算力" });
      else if (reserved.duplicate) send("progress", { text: "检测到同一任务已在生成中，本次不重复扣费" });
      const videos = await wanxiang.generateVideo({
        prompt: String(prompt).trim(),
        firstFrame,
        resolution,
        duration,
        onProgress: (text) => send("progress", { text })
      });
    // 落地本地
    const saved = [];
    for (const v of videos) {
      try {
        const buf = Buffer.from(await (await fetch(v.url)).arrayBuffer());
        const file = `${newId()}.mp4`;
        fs.writeFileSync(path.join(outputsDir(), file), buf);
        saved.push({ url: `/outputs/${file}`, remoteUrl: v.url });
      } catch {
        saved.push({ url: v.url, remoteUrl: v.url });
      }
    }
    await gateway.commitFor(chargeUser, plan, refId);
    bumpUsage("video");
    upstream.cachePut(sig, {
      items: saved, cost: reserved.cost, provider, model, userId: chargeUser, kind: "video"
    });
    audit.record(
      "generate.video",
      {
        provider, model, count: saved.length, resolution, duration,
        cost: reserved.cost, signature: upstream.shortSig(sig), replay: Boolean(replay)
      },
      auditCtx(req, req.user?.username)
    );
    send("done", {
      videos: saved,
      cost: reserved.cost,
      cached: false,
      replay: Boolean(replay),
      signature: sig,
      balance: reserved.balance
    });
  } catch (error) {
    const rb = reserved.reserved
      ? await gateway.rollbackFor(chargeUser, plan, refId, reserved.txId)
      : { refunded: 0 };
    send("error", {
      error: error.message || String(error),
      refunded: rb.refunded || 0,
      signature: sig
    });
  } finally {
    res.end();
  }
  } finally {
    // 外层 finally：与图片路由同理，槽位必须无条件归还
    releaseSlot();
  }
});

// ---------- E6 资产血缘 ----------
// 血缘里有 prompt、花费、用户 id，不该被静态目录白白公开。
// 这里在静态服务之前把 sidecar 拦掉，只能通过下面的鉴权 API 读。
app.use("/outputs", (req, res, next) => {
  if (req.path.toLowerCase().endsWith(lineage.META_SUFFIX)) {
    return res.status(403).json({ error: "血缘请通过 /api/outputs/meta 查询" });
  }
  next();
});

app.get("/api/outputs/meta", requireLogin, (req, res) => {
  const file = String(req.query.file || "");
  if (!file) return res.status(400).json({ error: "缺少 file 参数" });
  const entry = lineage.read(file); // 内部已做路径穿越校验
  if (!entry) return res.json({ ok: true, entry: null, summary: lineage.summarize(null) });
  // 别人的血缘不给看 —— 同一台机器多账号时这是硬边界
  if (entry.userId && entry.userId !== req.user?.id && !isSuper(req.user)) {
    return res.status(403).json({ error: "无权查看该资产的来源" });
  }
  res.json({ ok: true, entry, summary: lineage.summarize(entry) });
});

app.get("/api/outputs/lineage", requireLogin, (req, res) => {
  const taskId = String(req.query.taskId || "");
  if (!taskId) return res.status(400).json({ error: "缺少 taskId 参数" });
  const rows = lineage
    .readByTask(taskId)
    .filter((e) => !e.userId || e.userId === req.user?.id || isSuper(req.user));
  res.json({ ok: true, rows, count: rows.length });
});

// ---------- 静态 ----------
app.use("/outputs", express.static(outputsDir(), { maxAge: "7d" }));
app.use("/materials", express.static(materialDir(), { maxAge: "1d" }));

/**
 * 把「打包后在 asar 里」的路径改写成 app.asar.unpacked 下的真实磁盘路径。
 *
 * ⚠️ 2026-10-18 真实事故：Electron 33 在 ELECTRON_RUN_AS_NODE 模式下（本服务的子进程就是），
 *   fs.existsSync / statSync / readFileSync 读 asar 内部路径都正常，
 *   但 fs.createReadStream **会抛 ENOENT**（"xxx not found in app.asar"）。
 *   而 express.static 与 SPA 回退全是流式读，于是打包版客户端一打开就是
 *   「页面 404 / 窗口标题 Error」，日志里只有一行 server ENOENT，极易误判成路径写错。
 *
 * 配套改动：
 *   · electron-builder.config.cjs 里 asarUnpack: ["dist/**", "config/**"]（解包成真实文件）
 *   · 这里把路径改写过去（找不到 unpacked 目录就保持原样，开发态无副作用）
 */
function realPath(p) {
  const m = /^(.*app\.asar)[\\/](.+)$/.exec(p);
  if (!m) return p;
  const unpacked = path.join(`${m[1]}.unpacked`, m[2]);
  return fs.existsSync(unpacked) ? unpacked : p;
}

const dist = realPath(path.join(__dirname, "..", "dist"));
if (fs.existsSync(dist)) {
  // ⚠️ 2026-10-15：默认的 express.static 给的是 `Cache-Control: public, max-age=0`，
  // 于是每个带 hash 的资源每次启动都要回源做一次 304 校验 —— 桌面端虽然走本机回环，
  // 但首屏要发 8 个请求就发 8 次校验，纯属浪费；Web/远程访问时更明显。
  //
  // 正确策略（按可缓存性分开）：
  //   - /assets/ 下的文件名**自带内容 hash**（index-Cr7jZ1UX.js）→ 内容变了文件名就变，
  //     所以可以永久缓存，用 immutable 连"回源校验"都省掉。
  //   - index.html 绝不能长缓存：它是"指针"，必须每次拿到最新的 bundle 引用，
  //     否则用户会一直加载旧版本（这正是 vite.config.js 里 emptyOutDir 那条注释踩过的坑）。
  //   - brand/cases/templates 这些图没有 hash，给 7 天并允许 stale-while-revalidate。
  app.use(
    express.static(dist, {
      setHeaders(res, filePath) {
        const rel = path.relative(dist, filePath).split(path.sep).join("/");
        if (rel.startsWith("assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (rel === "index.html" || rel.endsWith("/index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else {
          res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
        }
      }
    })
  );
}

// 未显式指定端口时按品牌派生：aichange 仍是 5181（老用户无感），
// 其它品牌落到各自端口段，多实例并存不互抢（见 ports.js）。
// 端口在文件顶部已算好（SELF_PORT），手机端出图要自调本机接口，必须提前知道。
const PORT = SELF_PORT;
// 默认只监听本机；公网/容器部署时设 AI_CANVAS_BIND=0.0.0.0
const BIND = process.env.AI_CANVAS_BIND || "127.0.0.1";

app.listen(PORT, BIND, () => {
  console.log(`[ai-canvas] server  http://${BIND === "0.0.0.0" ? "127.0.0.1" : BIND}:${PORT}`);
  if (MOBILE_MODE) {
    const ips = lanAddresses();
    if (BIND === "127.0.0.1") {
      console.log(`[ai-canvas] ⚠️ 手机端模式已开，但服务只监听 127.0.0.1 —— 手机连不上。`);
      console.log(`[ai-canvas]    请加环境变量 AI_CANVAS_BIND=0.0.0.0 后重启。`);
    } else {
      console.log(`[ai-canvas] 手机端：小程序里填下面任一地址（手机要连同一个 WiFi）`);
      for (const ip of ips) console.log(`[ai-canvas]    http://${ip}:${PORT}`);
      if (!ips.length) console.log(`[ai-canvas]    （没找到私有网段地址，检查网络）`);
      console.log(`[ai-canvas] 手机端：/api/session 只发给本机，局域网设备拿不到机器令牌`);
    }
  }
  console.log(`[ai-canvas] 密钥存储：${vaultStatus().label}（${vaultStatus().fileCount ?? "-"} 条）`);
  const cacheSwept = upstream.sweep();
  const cs = upstream.cacheStats();
  console.log(
    `[ai-canvas] 结果缓存：${cs.alive}/${cs.total} 条可用（已累计免扣 ${cs.savedCost} 点）` +
    (cacheSwept.removed ? `，本次清理失效 ${cacheSwept.removed} 条` : "")
  );
  const swept = batch.sweep(7);
  if (swept) console.log(`[ai-canvas] 清理过期批量进度：${swept} 个`);
  // 上次进程留下的 running 批次统一标成 interrupted：客户端据此给出「续跑」入口，
  // 而不是永远停在「运行中」这种假状态（服务端不持有跨进程任务状态）。
  const staleBatches = batch.recoverStale();
  if (staleBatches) console.log(`[ai-canvas] 标记中断批次：${staleBatches} 个（可在批量面板续跑）`);
  // 悬空预扣回收：上次进程被杀时，catch 里的退费没机会跑，钱会永远卡在预扣里。
  // 只回收 30 分钟前、且没被任何退费/结算收口的预扣（正在跑的任务不受影响）。
  const staleHolds = credits.recoverStale();
  if (staleHolds.count) {
    console.log(`[ai-canvas] 回收悬空预扣：${staleHolds.count} 笔，退回 ${staleHolds.refunded} 算力`);
  }
  console.log(`[ai-canvas] 安全层：Host 校验 / Origin 校验 / 会话令牌 / 限流 / 预算熔断 已启用`);
  console.log(
    `[ai-canvas] 访问控制：${accounts.hasAccounts() ? "账号登录" : "尚未创建账号（首屏引导初始化）"}`
  );
  const s = securityStatus();
  if (s.embedMode) {
    console.log(`[ai-canvas] 嵌入模式：允许 ${s.embedOrigins.join(", ")}`);
  }
  console.log(
    `[ai-canvas] 变更令牌门：${s.mutationEnforced ? "已启用（写接口强制携带 X-AI-Canvas-Mutation-Token）" : "未启用（浏览器/开发态）"}`
  );
  audit.sweep();
  rbac.pruneTokens();
  const migrated = accounts.migrateUsers();
  if (migrated) console.log(`[ai-canvas] 账号字段迁移：${migrated} 条`);
  audit.record("app.started", { port: String(PORT), bind: BIND, embed: s.embedMode });
  // 充值自动管理：超时关单 + 主动查单补单（30s 首轮延迟，避免和启动自检抢 IO）
  startAutomation();
});
