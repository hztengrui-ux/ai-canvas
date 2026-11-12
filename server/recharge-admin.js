// 充值中心后台接口（运营）
//
// 分工（接口契约见 reports/ops-backend-2026-11-05/接口契约.md 第 2 节）：
//  - payments.js 负责「支付网关」（下单 / 验签回调），本模块不碰支付协议；
//  - credits.js 负责「账」和「订单」的落库，补单 / 退款 / 改价都必须走它的函数；
//  - payment-aggregator.js 负责聚合支付查单，本模块**动态 import**：模块缺失时
//    返回 400「聚合支付未配置」，而不是让服务报 500 或直接崩。
//
// 金额对外一律「元、2 位小数」，算力一律整数点。
import * as credits from "./credits.js";
import * as accounts from "./accounts.js";
import * as audit from "./audit.js";
import * as automation from "./recharge-automation.js";

const VIEW = "admin:recharge:view";
const MANAGE = "admin:recharge:manage";
const MAX_PAGE_SIZE = 100;

// 状态中文标签：错误提示与前端展示统一口径（订单里仍存英文枚举）
const STATUS_LABELS = {
  pending: "待支付",
  paid: "已支付",
  cancelled: "已取消",
  expired: "已过期",
  refunded: "已退款"
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未知";
}

// ---------- 通用小工具 ----------
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function ctx(req, user) {
  return {
    username: user?.username || "-",
    ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim(),
    ua: req.headers["user-agent"] || ""
  };
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** userId → 账号档案（订单里只存 userId，用户名/昵称实时关联；账号删了退化为 userId） */
function userIndex() {
  const map = new Map();
  try {
    for (const u of accounts.listUsersFull()) map.set(u.id, u);
  } catch {
    /* 账号文件损坏不影响订单查询：退化为只显示 userId */
  }
  return map;
}

/** 订单对外结构（契约固定字段，不多不少） */
function decorate(order, users) {
  if (!order) return null;
  const u = users?.get(order.userId);
  const creditsN = Math.round(Number(order.credits) || 0);
  const bonusN = Math.round(Number(order.bonus) || 0);
  return {
    id: order.id,
    userId: order.userId,
    username: u?.username || order.userId || "",
    nickname: u?.nickname || u?.username || order.userId || "",
    planId: order.planId || "",
    credits: creditsN,
    bonus: bonusN,
    total: creditsN + bonusN,
    price: round2(order.price),
    status: order.status || "pending",
    channel: order.channel || "",
    payMethod: order.payMethod || "",
    createdAt: Number(order.createdAt) || 0,
    paidAt: order.paidAt || null,
    expiredAt: order.expiredAt || null,
    refund: order.refund || null,
    notes: Array.isArray(order.notes) ? order.notes : []
  };
}

// ---------- 统计（days 天，趋势补零） ----------
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 在「天」粒度上加减（用 setDate，跨月/跨年都正确） */
function shiftDay(midnightTs, delta) {
  const d = new Date(midnightTs);
  d.setDate(d.getDate() + delta);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地日期键（运营看的是本地自然日，不用 UTC，否则凌晨 0~8 点会算错天） */
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function buildStats(days) {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const yesterdayStart = shiftDay(todayStart, -1);
  const rangeStart = shiftDay(todayStart, -(days - 1));

  const users = userIndex();
  const orders = credits.listAllOrders();

  // 金额口径：以「支付时间」为准（paidAt 缺失的老数据回退 createdAt）
  const paidTs = (o) => Number(o.paidAt) || Number(o.createdAt) || 0;
  const refundTs = (o) => Number(o.refund?.at) || paidTs(o);
  const priceOf = (o) => Number(o.price) || 0;
  const sumPrice = (rows) => round2(rows.reduce((s, o) => s + priceOf(o), 0));

  const paidOrders = orders.filter((o) => o.status === "paid");
  const between = (ts, from, to) => ts >= from && (to === undefined || ts < to);
  const paidWindow = (from, to) => {
    const rows = paidOrders.filter((o) => between(paidTs(o), from, to));
    return { amount: sumPrice(rows), count: rows.length };
  };

  const today = paidWindow(todayStart);
  const yesterday = paidWindow(yesterdayStart, todayStart);

  const rangePaid = paidOrders.filter((o) => paidTs(o) >= rangeStart);
  const rangeRefunded = orders.filter((o) => o.status === "refunded" && refundTs(o) >= rangeStart);
  const range = {
    amount: sumPrice(rangePaid),
    count: rangePaid.length,
    refundAmount: round2(rangeRefunded.reduce((s, o) => s + (Number(o.refund?.amount) || priceOf(o)), 0)),
    paidUsers: new Set(rangePaid.map((o) => o.userId)).size
  };

  // byChannel：区间内已支付金额按通道分组（手动补单 channel=manual，沙箱=sandbox）
  const channelMap = new Map();
  for (const o of rangePaid) {
    const channel = o.channel || "unknown";
    const g = channelMap.get(channel) || { channel, amount: 0, count: 0 };
    g.amount += priceOf(o);
    g.count += 1;
    channelMap.set(channel, g);
  }
  const byChannel = [...channelMap.values()]
    .map((g) => ({ ...g, amount: round2(g.amount) }))
    .sort((a, b) => b.amount - a.amount || b.count - a.count);

  // byStatus：区间内**创建**的订单按状态计数（含 pending/cancelled/expired，运营要看积压）
  const STATUS_ORDER = ["pending", "paid", "cancelled", "expired", "refunded"];
  const statusMap = new Map();
  for (const o of orders) {
    if ((Number(o.createdAt) || 0) < rangeStart) continue;
    const status = o.status || "pending";
    statusMap.set(status, (statusMap.get(status) || 0) + 1);
  }
  const byStatus = [...statusMap.entries()]
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => {
      const ia = STATUS_ORDER.indexOf(a.status);
      const ib = STATUS_ORDER.indexOf(b.status);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  // trend：连续 days 天补零，最后一天是今天
  const bucketMap = new Map();
  for (const o of paidOrders) {
    const ts = paidTs(o);
    if (ts < rangeStart) continue;
    const key = dayKey(ts);
    const g = bucketMap.get(key) || { amount: 0, count: 0 };
    g.amount += priceOf(o);
    g.count += 1;
    bucketMap.set(key, g);
  }
  const trend = [];
  for (let i = 0; i < days; i++) {
    const key = dayKey(shiftDay(rangeStart, i));
    const g = bucketMap.get(key);
    trend.push({ date: key, amount: g ? round2(g.amount) : 0, count: g ? g.count : 0 });
  }

  // topCustomers：区间内实付金额 Top10
  const customerMap = new Map();
  for (const o of rangePaid) {
    const userId = o.userId || "";
    const g = customerMap.get(userId) || { userId, totalPaid: 0, orderCount: 0 };
    g.totalPaid += priceOf(o);
    g.orderCount += 1;
    customerMap.set(userId, g);
  }
  const topCustomers = [...customerMap.values()]
    .sort((a, b) => b.totalPaid - a.totalPaid)
    .slice(0, 10)
    .map((c) => {
      const u = users.get(c.userId);
      return {
        userId: c.userId,
        nickname: u?.nickname || u?.username || c.userId,
        totalPaid: round2(c.totalPaid),
        orderCount: c.orderCount
      };
    });

  return { today, yesterday, range, byChannel, byStatus, trend, topCustomers };
}

// ---------- 挂载 ----------
export function mountRechargeAdmin(app, { requirePerm, requireLogin } = {}) {
  if (typeof requirePerm !== "function" || typeof requireLogin !== "function") {
    throw new Error("mountRechargeAdmin 需要 requirePerm / requireLogin 两个中间件");
  }

  // 支持 async 处理器：credits.markPaid / refundOrder / queryOrder 都是异步的
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (res.headersSent) return;
      const raw = Number(err?.status);
      const status = raw >= 400 && raw <= 599 ? raw : 400;
      res.status(status).json({ error: err?.message || "操作失败" });
    }
  };

  const log = (req, action, detail = {}) =>
    audit.record("admin.action", { action, ...detail }, ctx(req, req.user));

  const bodyOf = (req) => (req.body && typeof req.body === "object" ? req.body : {});

  // ============================================================
  // 订单列表（筛选 + 分页 + 汇总）
  // ============================================================
  app.get(
    "/api/admin/recharge/orders",
    requireLogin,
    requirePerm(VIEW),
    wrap((req) => {
      const { status = "", userId = "", keyword = "" } = req.query;
      const users = userIndex();
      let rows = credits.listAllOrders().map((o) => decorate(o, users));

      if (status) rows = rows.filter((r) => r.status === String(status));
      if (userId) rows = rows.filter((r) => r.userId === String(userId));

      const kw = String(keyword || "").trim().toLowerCase();
      if (kw) {
        rows = rows.filter(
          (r) =>
            r.id.toLowerCase().includes(kw) ||
            r.username.toLowerCase().includes(kw) ||
            r.nickname.toLowerCase().includes(kw)
        );
      }

      // from/to：毫秒时间戳，按 createdAt 闭区间过滤（空串表示不限）
      const fromRaw = String(req.query.from ?? "").trim();
      const fromTs = Number(fromRaw);
      if (fromRaw !== "" && Number.isFinite(fromTs)) rows = rows.filter((r) => r.createdAt >= fromTs);
      const toRaw = String(req.query.to ?? "").trim();
      const toTs = Number(toRaw);
      if (toRaw !== "" && Number.isFinite(toTs)) rows = rows.filter((r) => r.createdAt <= toTs);

      const page = Math.max(1, Math.round(Number(req.query.page) || 1));
      const pageSize = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, Math.round(Number(req.query.pageSize) || 20))
      );

      // 汇总针对「筛选后的全量」，不受分页影响
      const summary = {
        amount: round2(rows.filter((r) => r.status === "paid").reduce((s, r) => s + r.price, 0)),
        count: rows.length,
        pending: rows.filter((r) => r.status === "pending").length,
        paid: rows.filter((r) => r.status === "paid").length,
        refunded: rows.filter((r) => r.status === "refunded").length
      };

      return {
        rows: rows.slice((page - 1) * pageSize, page * pageSize),
        total: rows.length,
        page,
        pageSize,
        summary
      };
    })
  );

  // ============================================================
  // 充值统计
  // ============================================================
  app.get(
    "/api/admin/recharge/stats",
    requireLogin,
    requirePerm(VIEW),
    wrap((req) => {
      const raw = Math.round(Number(req.query.days) || 30);
      const days = Math.min(365, Math.max(1, raw));
      return buildStats(days);
    })
  );

  // ============================================================
  // 人工补单
  // ============================================================
  app.post(
    "/api/admin/recharge/orders/:id/manual-paid",
    requireLogin,
    requirePerm(MANAGE),
    wrap(async (req) => {
      const order = credits.getOrder(req.params.id);
      if (!order) throw httpError(400, "订单不存在");
      // 已支付幂等：运营连点两次不能重复发算力
      if (order.status === "paid") return { ok: true, already: true };
      if (order.status !== "pending") {
        throw httpError(400, `订单状态为「${statusLabel(order.status)}」，不能人工补单`);
      }

      const reason = String(bodyOf(req).reason || "").slice(0, 200);
      const r = await credits.markPaid(order.id, "manual");
      log(req, "recharge.order.manual_paid", {
        order: order.id,
        userId: order.userId,
        price: round2(order.price),
        credits: Math.round(Number(order.credits) || 0) + Math.round(Number(order.bonus) || 0),
        reason
      });

      return { ok: true, order: decorate(credits.getOrder(order.id), userIndex()), balance: r.balance };
    })
  );

  // ============================================================
  // 主动查单（聚合支付）
  // ============================================================
  app.post(
    "/api/admin/recharge/orders/:id/sync",
    requireLogin,
    requirePerm(MANAGE),
    wrap(async (req) => {
      const order = credits.getOrder(req.params.id);
      if (!order) throw httpError(400, "订单不存在");
      if (order.status === "paid") {
        return { ok: true, paid: true, order: decorate(order, userIndex()), reason: "订单已支付" };
      }
      // 只查待支付：已取消/已过期/已退款的订单再查单没有意义，也防止把过期单救活
      if (order.status !== "pending") {
        return {
          ok: true,
          paid: false,
          order: decorate(order, userIndex()),
          reason: `订单状态为「${statusLabel(order.status)}」，无需查单`
        };
      }

      // 动态 import：聚合支付模块由支付通道开发并行维护，可能还不存在。
      // 缺失 / 未配置一律 400「聚合支付未配置」，不能 500，更不能把进程带崩。
      let aggregator = null;
      try {
        aggregator = await import("./payment-aggregator.js");
      } catch {
        aggregator = null;
      }
      if (!aggregator || typeof aggregator.queryOrder !== "function") {
        throw httpError(400, "聚合支付未配置");
      }
      if (typeof aggregator.isConfigured === "function") {
        let configured = true;
        try {
          configured = Boolean(aggregator.isConfigured());
        } catch {
          configured = false;
        }
        if (!configured) throw httpError(400, "聚合支付未配置");
      }

      let result;
      try {
        result = await aggregator.queryOrder(order.id);
      } catch (err) {
        throw httpError(400, `查单失败：${err?.message || err}`);
      }
      if (!result || typeof result !== "object") {
        throw httpError(400, "查单失败：聚合支付未返回结果");
      }
      if (!result.paid) {
        return {
          ok: true,
          paid: false,
          order: decorate(credits.getOrder(order.id), userIndex()),
          reason: result.reason || result.tradeState || "支付平台显示未支付"
        };
      }

      // 金额校验（分）：查单金额必须与订单一致，防「低价单冒充高价单」入账
      const expectCents = Math.round(Number(order.price) * 100);
      const gotCents = Number(result.amount);
      if (Number.isFinite(gotCents) && gotCents > 0 && gotCents !== expectCents) {
        throw httpError(
          400,
          `查单金额与订单不一致（期望 ${expectCents} 分，实际 ${gotCents} 分）`
        );
      }

      // 查单期间回调可能已入账：复核最新状态，markPaid 自身也有幂等
      const fresh = credits.getOrder(order.id);
      if (!fresh || fresh.status !== "pending") {
        return {
          ok: true,
          paid: fresh?.status === "paid",
          order: fresh ? decorate(fresh, userIndex()) : null,
          reason: "订单状态已变化"
        };
      }

      const r = await credits.markPaid(order.id, "aggregator");
      log(req, "recharge.order.sync_paid", {
        order: order.id,
        userId: order.userId,
        price: round2(order.price),
        credits: Math.round(Number(order.credits) || 0) + Math.round(Number(order.bonus) || 0),
        tradeNo: result.tradeNo || ""
      });

      return {
        ok: true,
        paid: true,
        order: decorate(credits.getOrder(order.id), userIndex()),
        reason: "查单确认已支付并完成入账"
      };
    })
  );

  // ============================================================
  // 退款（钱退回由通道线下/原路完成，这里负责扣回算力 + 留痕）
  // ============================================================
  app.post(
    "/api/admin/recharge/orders/:id/refund",
    requireLogin,
    requirePerm(MANAGE),
    wrap(async (req) => {
      const order = credits.getOrder(req.params.id);
      if (!order) throw httpError(400, "订单不存在");
      const reason = String(bodyOf(req).reason || "").slice(0, 200);
      const actor = req.user?.username || "-";

      // 余额不足等业务错误：透传 credits 的错误原文，接口层不改写
      const r = await credits.refundOrder(order.id, { reason, actor });

      log(req, "recharge.order.refund", {
        order: order.id,
        userId: order.userId,
        amount: round2(order.price),
        credits: Math.round(Number(order.credits) || 0) + Math.round(Number(order.bonus) || 0),
        reason
      });

      return {
        ok: true,
        order: decorate(credits.getOrder(order.id), userIndex()),
        balance: r.balance,
        deducted: r.deducted
      };
    })
  );

  // ============================================================
  // 订单备注（只改订单，不动账）
  // ============================================================
  app.post(
    "/api/admin/recharge/orders/:id/note",
    requireLogin,
    requirePerm(MANAGE),
    wrap((req) => {
      const order = credits.getOrder(req.params.id);
      if (!order) throw httpError(400, "订单不存在");
      const note = String(bodyOf(req).note || "").trim();
      if (!note) throw httpError(400, "备注不能为空");

      const updated = credits.noteOrder(order.id, note, req.user?.username || "-");
      log(req, "recharge.order.note", { order: order.id, userId: order.userId, note: note.slice(0, 200) });
      return { ok: true, order: decorate(updated, userIndex()) };
    })
  );

  // ============================================================
  // 套餐改价
  // ============================================================
  app.get(
    "/api/admin/recharge/plans",
    requireLogin,
    requirePerm(VIEW),
    wrap(() => ({ rows: credits.listPlans() }))
  );

  app.put(
    "/api/admin/recharge/plans",
    requireLogin,
    requirePerm(MANAGE),
    wrap((req) => {
      // 校验（id 格式 / 价格 > 0 / 算力 > 0）全部在 credits.savePlans 里，这里只透传
      const rows = Array.isArray(bodyOf(req).rows) ? bodyOf(req).rows : [];
      const out = credits.savePlans(rows);
      log(req, "recharge.plans.save", {
        count: out.length,
        rows: out.map((p) => ({ id: p.id, price: p.price, credits: p.credits, bonus: p.bonus }))
      });
      return { ok: true, rows: out };
    })
  );

  // ============================================================
  // 自动管理（配置 + 立即执行）
  // ============================================================
  app.get(
    "/api/admin/recharge/automation",
    requireLogin,
    requirePerm(VIEW),
    wrap(() => ({
      config: automation.getConfig(),
      lastReport: automation.getLastReport()
    }))
  );

  app.put(
    "/api/admin/recharge/automation",
    requireLogin,
    requirePerm(MANAGE),
    wrap((req) => {
      const src = bodyOf(req);
      const patch = {};
      for (const key of ["enabled", "expireMinutes", "syncAfterSec", "syncBatch"]) {
        if (Object.prototype.hasOwnProperty.call(src, key)) patch[key] = src[key];
      }
      // 区间校验在 automation.saveConfig 里（5~1440 / 30~3600 / 1~100），失败抛 400
      const config = automation.saveConfig(patch);
      log(req, "recharge.automation.save", {
        enabled: config.enabled,
        expireMinutes: config.expireMinutes,
        syncAfterSec: config.syncAfterSec,
        syncBatch: config.syncBatch
      });
      return { ok: true, config };
    })
  );

  app.post(
    "/api/admin/recharge/automation/run",
    requireLogin,
    requirePerm(MANAGE),
    wrap(async (req) => {
      // 手动触发不受 config.enabled 限制：运营点了「立即执行」就是要跑一轮
      const report = await automation.runOnce({ source: "manual", actor: req.user?.username || "-" });
      log(req, "recharge.automation.run", {
        expired: report.expired,
        synced: report.synced,
        paid: report.paid,
        errors: report.errors.length
      });
      return { ok: true, report };
    })
  );
}
