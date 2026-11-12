// 手机端（微信小程序）路由
//
// 全部挂在 /api/m/ 下，刻意与桌面端 /api/ 分开：
//   1. 一眼能看出"这条是手机在用"，日志与限流好分开看；
//   2. 桌面端有的接口不适合手机（/api/session 会发机器令牌、/api/tasks 只给本机），
//      手机上要的是另一份投影；
//   3. 将来做公网/云托管时，只需给 /api/m/* 单独加一层网关策略。
//
// 鉴权：登录拿 m_ 令牌，之后每个请求带 X-AI-Canvas-Token。
// 令牌在 security.js 里被额外校验器接住，accounts.currentUser(token) 解析成真实用户，
// 所以下面的 req.user / 权限判断与桌面端完全同源，RBAC 不打折。
import fs from "node:fs";
import path from "node:path";
import express from "express";
import crypto from "node:crypto";

import * as mobile from "./mobile.js";
import * as jobs from "./mobile-jobs.js";
import * as accounts from "./accounts.js";
import * as credits from "./credits.js";
import * as gateway from "./gateway.js";
import * as skills from "./skills.js";
import * as lineage from "./lineage.js";
import * as tasks from "./tasks.js";
import * as brand from "./brand.js";
import * as audit from "./audit.js";
import * as payments from "./payments.js";
import { outputsDir } from "./config.js";
import { lanAddresses } from "./ports.js";
import { MOBILE_MODE, mutationToken } from "./security.js";

/** "看图"一次最多取多少条血缘记录 */
const SCAN_LIMIT = 500;
/** 单页上限 */
const PAGE_LIMIT = 60;

function clientCtx(req, username) {
  return {
    username: username || req.user?.username || "-",
    ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim(),
    ua: req.headers["user-agent"] || ""
  };
}

/** 只保留手机端需要的品牌字段（不要把整份品牌配置倒给小程序） */
function brandView() {
  const b = brand.current();
  return {
    key: b.key,
    appName: b.appName,
    shortName: b.shortName,
    slogan: b.slogan,
    primary: b.primary,
    logo: b.logo,
    creditName: b.creditName
  };
}

function isSuper(user) {
  return Boolean(user && (user.role === "admin" || user.roleNames?.includes("超级管理员")));
}

const VIDEO_EXT = new Set(["mp4", "webm", "mov", "avi", "mkv"]);

function extOf(file) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(String(file || ""));
  return m ? m[1].toLowerCase() : "";
}

/**
 * 「我生成的图/视频」列表。
 *
 * 数据源用 lineage.listAll() 而不是自己扫目录：
 *   outputs 目录里混着**上传的参考图**（没有血缘），扫目录还得逐个读 sidecar 判断，
 *   而血缘层本来就已经"按 createdAt 倒序 + 出错跳过"整理好了，直接用。
 */
function listMine(user) {
  const entries = lineage.listAll(SCAN_LIMIT);
  const dir = outputsDir();
  const rows = [];
  for (const e of entries) {
    if (!e?.file) continue;
    // 别人的产出不给看（超管除外）—— 同机多账号时这是硬边界
    if (e.userId && e.userId !== user?.id && !isSuper(user)) continue;
    const full = path.join(dir, e.file);
    let size = 0;
    let mtime = Date.parse(e.createdAt || "") || 0;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      // 血缘还在、图被删了：跳过，别给前端一个必然 404 的 URL
      continue;
    }
    rows.push({
      file: e.file,
      url: e.url || `/outputs/${e.file}`,
      size,
      mtime: Math.round(mtime),
      isVideo: VIDEO_EXT.has(extOf(e.file)),
      prompt: e.prompt || "",
      cost: Number(e.cost) || 0,
      owner: e.username || "",
      // 项目归属：桌面端生成时上报，老图没有 → 空字符串（前端归到「未归属项目」）
      projectId: e.projectId || "",
      projectName: e.projectName || ""
    });
  }
  return rows;
}

/** 本地时区的 YYYY-MM-DD（不能用 toISOString，那是 UTC，晚上 8 点后就串天了） */
function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 筛选 + 聚合。
 * filters 里的计数**始终基于未筛选的全量**：否则用户点掉一个 chip，别的 chip 数字跟着跳，
 * 看着像 bug。
 */
function filterOutputs(all, { from, to, project }) {
  const projects = new Map();
  const days = new Map();
  for (const r of all) {
    const pid = r.projectId || "";
    const p = projects.get(pid) || { id: pid, name: r.projectName || "", count: 0 };
    p.count += 1;
    if (!p.name && r.projectName) p.name = r.projectName;
    projects.set(pid, p);
    const k = dayKey(r.mtime);
    days.set(k, (days.get(k) || 0) + 1);
  }
  // 项目排序：有名字的在前，按数量倒序；「未归属」永远排最后
  const projectRows = [...projects.values()].sort((a, b) => {
    if (!a.id !== !b.id) return a.id ? -1 : 1;
    return b.count - a.count;
  });
  const dayRows = [...days.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));

  const wantProject = String(project || "");
  const rows = all.filter((r) => {
    if (Number.isFinite(from) && r.mtime < from) return false;
    if (Number.isFinite(to) && r.mtime >= to) return false;
    if (wantProject === "__none") return !r.projectId;
    if (wantProject) return r.projectId === wantProject;
    return true;
  });

  return { rows, filters: { projects: projectRows, days: dayRows } };
}

/** 活跃任务里「属于我」的那些（超管看全部） */
function myActiveTasks(user) {
  return tasks
    .snapshot()
    .filter((t) => t.state === "running")
    .filter((t) => !t.userId || t.userId === user?.id || isSuper(user))
    .map((t) => ({
      id: t.id,
      kind: t.kind || "image",
      state: "running",
      startedAt: t.startedAt || 0
    }));
}

export function mountMobile(app, { rateLimit, selfBase }) {
  // ---------- 登录 ----------
  app.post("/api/m/auth/login", rateLimit, (req, res) => {
    const { username, password } = req.body || {};
    if (!accounts.hasAccounts()) {
      return res.status(409).json({
        error: "这台电脑还没创建管理员，请先在电脑端完成初始化，再用同一个账号在手机登录",
        code: "NO_ACCOUNTS"
      });
    }
    const ctx = clientCtx(req);
    const r = mobile.login({ username, password, ip: ctx.ip, ua: ctx.ua });
    if (!r.ok) {
      // 锁定用 423，其余凭据错误统一 401 —— 不区分"账号不存在"与"密码错"，
      // 否则等于对外提供一个用户名枚举接口。
      const status = r.code === "LOCKED" ? 423 : 401;
      audit.record("mobile.login.failed", { username: String(username || "-"), code: r.code }, ctx);
      return res.status(status).json({ error: r.error, code: r.code });
    }
    audit.record("mobile.login", { username: r.user.username }, clientCtx(req, r.user.username));
    res.json({ ok: true, token: r.token, expiresIn: r.expiresIn, user: r.user, brand: brandView() });
  });

  // ---------- 退出 ----------
  app.post("/api/m/auth/logout", (req, res) => {
    const token = req.headers["x-ai-canvas-token"];
    const done = mobile.logout(typeof token === "string" ? token : "");
    audit.record("mobile.logout", { ok: done }, clientCtx(req));
    res.json({ ok: true });
  });

  // 之后的接口都要登录（与桌面端同一口径）
  const needLogin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "请先登录", code: "LOGIN_REQUIRED" });
    next();
  };

  // ---------- 联调信息：手机上该填哪个地址 ----------
  // 桌面端设置页读它来显示「手机端联调地址」。
  // 没有这条，用户只能自己去 ipconfig 里翻（还有一堆虚拟网卡），填错就以为功能坏了。
  app.get("/api/m/info", needLogin, (req, res) => {
    const port = Number(process.env.PORT || 0) || 0;
    const ips = lanAddresses();
    res.json({
      ok: true,
      enabled: MOBILE_MODE,
      bind: process.env.AI_CANVAS_BIND || "127.0.0.1",
      port,
      urls: port ? ips.map((ip) => `http://${ip}:${port}`) : [],
      hint: MOBILE_MODE
        ? ""
        : "当前只监听本机，手机连不上。请关掉应用，用「启动-手机联调.bat」重新打开。"
    });
  });

  // ---------- 首屏一次拿全 ----------
  app.get("/api/m/bootstrap", needLogin, async (req, res) => {
    const userId = req.user.id;
    await credits.ensureSignupGrant(userId);
    const catalog = gateway.catalog({});
    const imageCost = Number(credits.COST_TABLE?.["image.generate"]?.cost || 10);
    res.json({
      ok: true,
      brand: brandView(),
      me: {
        user: {
          id: req.user.id,
          username: req.user.username,
          nickname: req.user.nickname,
          roleNames: req.user.roleNames || []
        },
        balance: credits.balance(userId),
        creditName: brand.current().creditName || "算力"
      },
      skills: skills.listSkills({}).map((s) => ({
        id: s.id,
        label: s.label,
        desc: s.desc,
        icon: s.icon,
        available: s.available !== false
      })),
      models: (catalog.models || []).map((m) => ({
        id: m.id,
        label: m.label,
        provider: m.provider,
        kind: m.kind,
        cost: Number(m.cost) || imageCost,
        maxCount: m.maxCount || 4,
        hasKey: Boolean(m.hasKey)
      })),
      costs: { image: imageCost },
      server: { version: process.env.AI_CANVAS_VERSION || "0.2.0", mobile: true }
    });
  });

  // ---------- 首页聚合 ----------
  app.get("/api/m/home", needLogin, async (req, res) => {
    const userId = req.user.id;
    await credits.ensureSignupGrant(userId);
    const all = listMine(req.user);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = all.filter((r) => r.mtime >= todayStart.getTime()).length;
    const active = myActiveTasks(req.user);
    res.json({
      ok: true,
      balance: credits.balance(userId),
      creditName: brand.current().creditName || "算力",
      activeTasks: active.length,
      stats: { outputsTotal: all.length, todayCount },
      recent: all.slice(0, 6)
    });
  });

  // ---------- 进度（桌面端发起的任务也在这里） ----------
  app.get("/api/m/tasks", needLogin, (req, res) => {
    const rows = myActiveTasks(req.user);
    res.json({ ok: true, count: rows.length, rows });
  });

  // ---------- 看图（分页 + 筛选） ----------
  app.get("/api/m/outputs", needLogin, (req, res) => {
    const offset = Math.max(0, Math.round(Number(req.query.offset) || 0));
    const limit = Math.min(Math.max(1, Math.round(Number(req.query.limit) || 24)), PAGE_LIMIT);
    // from/to 用 Number.isFinite 判断：空字符串不能当成 0（会变成"1970 年以后"，
    // 看着对，其实把 from 当成没传的反面——这类"静默生效"的默认值最难查）
    const rawFrom = req.query.from === undefined || req.query.from === "" ? null : Number(req.query.from);
    const rawTo = req.query.to === undefined || req.query.to === "" ? null : Number(req.query.to);
    const from = rawFrom === null ? null : Number.isFinite(rawFrom) ? Math.round(rawFrom) : NaN;
    const to = rawTo === null ? null : Number.isFinite(rawTo) ? Math.round(rawTo) : NaN;
    const out = filterOutputs(listMine(req.user), {
      from,
      to,
      project: String(req.query.project || "")
    });
    const rows = out.rows.slice(offset, offset + limit);
    res.json({
      ok: true,
      total: out.rows.length,
      offset,
      hasMore: offset + rows.length < out.rows.length,
      filters: out.filters,
      rows
    });
  });

  // ---------- 上传参考图（原始字节，不是 multipart） ----------
  // 小程序用 wx.request({ data: arrayBuffer }) 发；wx.uploadFile 只能发 multipart，
  // 而桌面端的 /api/upload 收的是 raw body，所以这里保持同一套（少一层 multer 依赖）。
  app.post(
    "/api/m/upload",
    needLogin,
    rateLimit,
    express.raw({ type: ["image/*", "video/*"], limit: "30mb" }),
    (req, res) => {
      if (!req.body?.length) return res.status(400).json({ error: "没有收到图片数据" });
      const ctype = String(req.headers["content-type"] || "image/png");
      const sub = ctype.split("/")[1] || "png";
      const ext = sub.replace(/[^a-z0-9]/gi, "").slice(0, 5) || "png";
      const file = `${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}.${ext}`;
      fs.writeFileSync(path.join(outputsDir(), file), req.body);
      res.json({ ok: true, url: `/outputs/${file}` });
    }
  );

  // ---------- 出图：提交 ----------
  app.post("/api/m/jobs", needLogin, rateLimit, async (req, res) => {
    const userId = req.user.id;
    await credits.ensureSignupGrant(userId);

    // 粗校验：明显不够就别建作业。
    // 真正的预扣/退款在 /api/generate 内部（gateway.reserveFor），这里只是提前给个明确提示。
    const unit = Number(credits.COST_TABLE?.["image.generate"]?.cost || 10);
    const n = Math.min(Math.max(Math.round(Number(req.body?.n) || 1), 1), 4);
    const need = unit * n;
    const bal = credits.balance(userId);
    if (bal < need) {
      return res.status(400).json({
        error: `算力不足：本次预计需要 ${need} 点，当前余额 ${bal} 点`,
        code: "INSUFFICIENT_CREDITS",
        need,
        balance: bal
      });
    }

    const token = String(req.headers["x-ai-canvas-token"] || "");
    const r = jobs.create({
      userId,
      token,
      payload: { ...(req.body || {}), n },
      selfBase,
      balance: bal,
      isSuper: isSuper(req.user)
    });
    if (!r.ok) return res.status(400).json({ error: r.error, code: r.code });
    audit.record("mobile.job.created", { jobId: r.job.id, n }, clientCtx(req));
    res.json({ ok: true, job: r.job });
  });

  // ---------- 出图：查进度 ----------
  app.get("/api/m/jobs/:id", needLogin, (req, res) => {
    const job = jobs.get(req.params.id, req.user.id, isSuper(req.user));
    if (!job) return res.status(404).json({ error: "作业不存在或已过期", code: "NOT_FOUND" });
    res.json({ ok: true, job });
  });

  // ---------- 出图：取消 ----------
  app.post("/api/m/jobs/:id/cancel", needLogin, rateLimit, async (req, res) => {
    const r = await jobs.cancel(req.params.id, req.user.id, {
      selfBase,
      isSuper: isSuper(req.user)
    });
    if (!r.ok) return res.status(400).json({ error: r.error, code: r.code });
    audit.record("mobile.job.canceled", { jobId: String(req.params.id) }, clientCtx(req));
    res.json({ ok: true });
  });

  // ---------- 改密码（改完踢掉其它设备） ----------
  app.post("/api/m/auth/password", needLogin, rateLimit, (req, res) => {
    const token = String(req.headers["x-ai-canvas-token"] || "");
    try {
      accounts.changePassword({
        token,
        oldPassword: req.body?.oldPassword,
        newPassword: req.body?.newPassword
      });
      // 改完密码还把旧设备留在登录态，等于改了个寂寞
      const kicked = accounts.killOtherSessions(req.user.id, token);
      audit.record("mobile.password.changed", { kicked }, clientCtx(req, req.user.username));
      res.json({ ok: true, kicked });
    } catch (err) {
      res.status(400).json({ error: err.message || "修改失败" });
    }
  });

  // ============================================================
  // 充值（手机端）
  //
  // 能力边界先说清楚：小程序里做**真实支付**必须有商户号 + 小程序 AppID，
  // 服务端走 JSAPI 下单再调 wx.requestPayment。当前没有凭证，所以这一版：
  //   · 套餐/订单/余额全部可见可操作；
  //   · 沙箱模式能完整走到账（走的是和真实网关**完全相同**的回调链路）；
  //   · 一旦配了真实凭证，手机端明确提示"请到电脑端支付"，不假装能付。
  // ============================================================

  /** 订单投影：只给手机端需要的字段，不把 userId/payMethod 之类内部字段倒出去 */
  function orderView(o, planMap) {
    const plan = planMap.get(o.planId) || {};
    return {
      id: o.id,
      planId: o.planId,
      planLabel: plan.label || o.planId,
      price: Number(o.price) || 0,
      credits: Number(o.credits) || 0,
      bonus: Number(o.bonus) || 0,
      status: o.status || "pending",
      createdAt: Number(o.createdAt) || 0,
      paidAt: Number(o.paidAt) || 0
    };
  }

  app.get("/api/m/recharge", needLogin, async (req, res) => {
    const userId = req.user.id;
    await credits.ensureSignupGrant(userId);
    const plans = credits.listPlans();
    const planMap = new Map(plans.map((p) => [p.id, p]));
    const st = payments.payStatus();
    res.json({
      ok: true,
      balance: credits.balance(userId),
      creditName: brand.current().creditName || "算力",
      plans: plans.map((p) => ({
        id: p.id,
        label: p.label,
        price: p.price,
        credits: p.credits,
        bonus: p.bonus,
        total: p.total,
        hot: Boolean(p.hot)
      })),
      status: {
        mode: st.mode,
        sandbox: Boolean(st.sandbox),
        hint: st.hint || "",
        // 渠道：小程序内真正能用的是"沙箱模拟"；真实微信支付需要商户号（未接入）
        channels: [
          { id: "wechat", label: "微信支付", ready: Boolean(st.configured?.wechat) },
          { id: "alipay", label: "支付宝", ready: Boolean(st.configured?.alipay) }
        ]
      },
      orders: credits.listOrders(userId).slice(0, 10).map((o) => orderView(o, planMap))
    });
  });

  app.post("/api/m/recharge/orders", needLogin, rateLimit, (req, res) => {
    try {
      // 只认 planId：价格与算力一律以服务端套餐表为准，
      // 客户端传 price/credits 一概不采信（否则就是改价漏洞）。
      const order = credits.createOrder(req.user.id, String(req.body?.planId || ""));
      audit.record(
        "mobile.recharge.order.created",
        { order: order.id, plan: order.planId, price: order.price },
        clientCtx(req)
      );
      const planMap = new Map(credits.listPlans().map((p) => [p.id, p]));
      res.json({ ok: true, order: orderView(order, planMap) });
    } catch (err) {
      res.status(400).json({ error: err.message || "下单失败" });
    }
  });

  app.post("/api/m/recharge/orders/:id/pay", needLogin, rateLimit, async (req, res) => {
    const userId = req.user.id;
    const order = credits.listOrders(userId).find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "订单不存在" });
    if (order.status === "paid") return res.status(400).json({ error: "订单已支付" });
    if (order.status === "cancelled") return res.status(400).json({ error: "订单已取消" });

    const st = payments.payStatus();
    if (!st.sandbox) {
      // 真实支付：小程序内需要 JSAPI 下单，当前未接入。宁可说清楚，也不要给个必然失败的二维码。
      return res.status(501).json({
        code: "PAY_IN_MINIAPP_UNSUPPORTED",
        error: "小程序内支付需商户号 + JSAPI 下单；当前版本请到电脑端完成支付（订单号已保留，可在电脑端继续付）"
      });
    }
    res.json({ ok: true, sandbox: true, hint: "沙箱模式：点「模拟支付」即刻到账（演示用，不产生真实交易）" });
  });

  // 模拟支付：仅沙箱可用。
  // 实现上不复刻一套加算力逻辑，而是**自调桌面端那条 simulate-paid 接口** ——
  // 它会用沙箱私钥签一张回调票据，再走与真实网关完全相同的 handleCallback
  //（验签 → 金额核对 → 幂等），所以演示路径上三道闸一样生效。
  app.post("/api/m/recharge/orders/:id/simulate-paid", needLogin, rateLimit, async (req, res) => {
    const userId = req.user.id;
    if (!payments.payStatus().sandbox) {
      return res.status(403).json({ error: "已配置真实支付，模拟支付已关闭", code: "SANDBOX_ONLY" });
    }
    const order = credits.listOrders(userId).find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: "订单不存在" });
    if (order.status === "paid") return res.status(400).json({ error: "订单已支付" });
    if (order.status === "cancelled") return res.status(400).json({ error: "订单已取消" });

    const token = String(req.headers["x-ai-canvas-token"] || "");
    try {
      const r = await fetch(
        `${selfBase}/api/recharge/orders/${encodeURIComponent(order.id)}/simulate-paid`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-AI-Canvas-Token": token,
            // 受保护写接口：服务端内部自调要补主进程注入的变更令牌（见 mobile-jobs 同款注释）
            ...(mutationToken() ? { "X-AI-Canvas-Mutation-Token": mutationToken() } : {})
          },
          body: "{}"
        }
      );
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        return res.status(r.status).json({ error: data?.error || "模拟支付失败", code: data?.code });
      }
    } catch (err) {
      return res.status(502).json({ error: `模拟支付调用失败：${err.message || err}` });
    }

    const fresh = credits.listOrders(userId).find((o) => o.id === order.id) || order;
    const planMap = new Map(credits.listPlans().map((p) => [p.id, p]));
    audit.record("mobile.recharge.simulated", { order: order.id }, clientCtx(req));
    res.json({ ok: true, order: orderView(fresh, planMap), balance: credits.balance(userId) });
  });

  app.post("/api/m/recharge/orders/:id/cancel", needLogin, rateLimit, (req, res) => {
    try {
      const order = credits.cancelOrder(req.user.id, req.params.id);
      const planMap = new Map(credits.listPlans().map((p) => [p.id, p]));
      audit.record("mobile.recharge.order.canceled", { order: order.id }, clientCtx(req));
      res.json({ ok: true, order: orderView(order, planMap) });
    } catch (err) {
      res.status(400).json({ error: err.message || "取消失败" });
    }
  });

  console.log("[ai-canvas] 手机端接口已挂载：/api/m/*（生成由服务端代跑，取消会回滚预扣）");
}
