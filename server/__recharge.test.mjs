/**
 * 充值中心后台 + 自动管理：自测脚本
 * ------------------------------------------------------------------
 * 覆盖（全部用临时 AI_CANVAS_HOME，绝不碰真实数据）：
 *  1. 订单列表 / 筛选 / 分页 / summary
 *  2. 人工补单（幂等、算力入账）
 *  3. 统计（today / range / byChannel / byStatus / trend 补零 / topCustomers）
 *  4. 主动查单：已支付短路、模块缺失返回 400「聚合支付未配置」而不是崩溃
 *  5. 退款（扣回算力、余额不足错误透传、重复退款拒绝）
 *  6. 备注 / 套餐 GET+PUT
 *  7. 自动管理：配置区间校验、runOnce 过期关单、lastReport 持久化、
 *     聚合模块缺失时计入 errors、环境变量关闭定时器
 *  8. 权限码挂载 + 写操作审计落盘
 *
 * 运行：node server/__recharge.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在 import 任何项目模块之前设置：paths.js 在模块加载时计算 HOME
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-canvas-recharge-"));
process.env.AI_CANVAS_HOME = HOME;
process.env.AI_CANVAS_DISABLE_AUTOMATION = "1";

const express = (await import("express")).default;
const credits = await import("./credits.js");
const automation = await import("./recharge-automation.js");
const { mountRechargeAdmin } = await import("./recharge-admin.js");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ---------- 测试脚手架 ----------
function makeApp({ denyManage = false } = {}) {
  const app = express();
  app.use(express.json());
  const mountPerms = [];
  const requireLogin = (req, _res, next) => {
    req.user = { id: "u-admin", username: "op-admin", roleIds: ["r-super"], dataScope: "all" };
    next();
  };
  const requirePerm = (code) => {
    mountPerms.push(code);
    return (req, res, next) => {
      if (denyManage && code === "admin:recharge:manage") {
        return res.status(403).json({ error: "权限不足", code: "FORBIDDEN", need: code });
      }
      next();
    };
  };
  mountRechargeAdmin(app, { requirePerm, requireLogin });
  return { app, mountPerms };
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function api(base, pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function ordersFile() {
  return path.join(HOME, "recharge-orders.json");
}

/** 直接改订单落库字段（测试里用来伪造「老订单」「走过网关的订单」） */
function patchOrder(orderId, patch) {
  const data = JSON.parse(fs.readFileSync(ordersFile(), "utf8"));
  const order = data.orders.find((o) => o.id === orderId);
  Object.assign(order, patch);
  fs.writeFileSync(ordersFile(), JSON.stringify(data, null, 2));
}

function localDayKey() {
  const d = new Date();
  const pad = (n) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const main = makeApp();
const { server, base } = await listen(main.app);

// ============================================================
console.log("\n[1] 订单列表（空）");
{
  const r = await api(base, "/api/admin/recharge/orders");
  check("HTTP 200 且结构完整", r.status === 200 && Array.isArray(r.data.rows));
  check("total / page / pageSize 默认值", r.data.total === 0 && r.data.page === 1 && r.data.pageSize === 20);
  check("summary 全零", r.data.summary.count === 0 && r.data.summary.amount === 0 && r.data.summary.pending === 0);
}

// ============================================================
console.log("\n[2] 人工补单");
const o1 = credits.createOrder("u1", "plan-1000"); // 19 元 / 1000 算力
const o2 = credits.createOrder("u2", "plan-5000"); // 89 元 / 5500 算力
const paidResp = await api(base, `/api/admin/recharge/orders/${o2.id}/manual-paid`, {
  method: "POST",
  body: { reason: "客户线下转账" }
});
check(
  "补单成功并返回余额",
  paidResp.status === 200 && paidResp.data.ok === true && paidResp.data.balance === 5500,
  JSON.stringify(paidResp.data).slice(0, 160)
);
check(
  "订单状态 / 通道 / 金额",
  paidResp.data.order.status === "paid" &&
    paidResp.data.order.channel === "manual" &&
    paidResp.data.order.price === 89 &&
    paidResp.data.order.total === 5500
);
check("算力真的入账", credits.balance("u2") === 5500);

const again = await api(base, `/api/admin/recharge/orders/${o2.id}/manual-paid`, {
  method: "POST",
  body: { reason: "重复点击" }
});
check("重复补单幂等", again.status === 200 && again.data.already === true);
check("重复补单不重复发算力", credits.balance("u2") === 5500);

const missing = await api(base, "/api/admin/recharge/orders/ord-not-exist/manual-paid", {
  method: "POST",
  body: {}
});
check("不存在的订单返回 400", missing.status === 400 && typeof missing.data.error === "string");

// ============================================================
console.log("\n[3] 列表筛选 / 分页 / summary");
{
  const paid = await api(base, "/api/admin/recharge/orders?status=paid");
  check("按状态筛选", paid.data.total === 1 && paid.data.rows[0].id === o2.id);
  check(
    "summary 只统计筛选结果",
    paid.data.summary.amount === 89 &&
      paid.data.summary.count === 1 &&
      paid.data.summary.paid === 1 &&
      paid.data.summary.pending === 0
  );

  const byUser = await api(base, "/api/admin/recharge/orders?userId=u1");
  check("按 userId 筛选", byUser.data.total === 1 && byUser.data.rows[0].id === o1.id);

  const byKeyword = await api(base, "/api/admin/recharge/orders?keyword=u2");
  check("keyword 匹配用户名", byKeyword.data.total === 1 && byKeyword.data.rows[0].userId === "u2");

  const byRange = await api(base, `/api/admin/recharge/orders?from=${Date.now() + 60000}`);
  check("from 时间戳过滤", byRange.data.total === 0);
  const byRangeTo = await api(base, `/api/admin/recharge/orders?to=${Date.now() + 60000}`);
  check("to 时间戳过滤", byRangeTo.data.total === 2);

  const page2 = await api(base, "/api/admin/recharge/orders?page=2&pageSize=1");
  check("分页", page2.data.total === 2 && page2.data.rows.length === 1 && page2.data.page === 2);

  const all = await api(base, "/api/admin/recharge/orders");
  check("未筛选 summary 包含 pending", all.data.summary.pending === 1 && all.data.summary.paid === 1);
}

// ============================================================
console.log("\n[4] 充值统计");
{
  const r = await api(base, "/api/admin/recharge/stats?days=7");
  check("trend 连续 7 天", r.data.trend.length === 7);
  check("trend 最后一天是今天", r.data.trend[6].date === localDayKey(), r.data.trend[6].date);
  check("trend 其余天补零", r.data.trend.slice(0, 6).every((d) => d.amount === 0 && d.count === 0));
  check("trend 今天金额", r.data.trend[6].amount === 89 && r.data.trend[6].count === 1);
  check(
    "range 金额 / 人数",
    r.data.range.amount === 89 && r.data.range.count === 1 && r.data.range.paidUsers === 1
  );
  check("today / yesterday", r.data.today.amount === 89 && r.data.yesterday.amount === 0);
  check(
    "byChannel 分组",
    r.data.byChannel.some((x) => x.channel === "manual" && x.amount === 89 && x.count === 1)
  );
  check(
    "byStatus 分组",
    r.data.byStatus.some((x) => x.status === "pending" && x.count === 1) &&
      r.data.byStatus.some((x) => x.status === "paid" && x.count === 1)
  );
  check(
    "topCustomers",
    r.data.topCustomers.length === 1 &&
      r.data.topCustomers[0].userId === "u2" &&
      r.data.topCustomers[0].totalPaid === 89
  );
  check("range.refundAmount 初始为 0", r.data.range.refundAmount === 0);
}

// ============================================================
console.log("\n[5] 主动查单（聚合支付模块缺失时不崩）");
{
  const paidSync = await api(base, `/api/admin/recharge/orders/${o2.id}/sync`, { method: "POST" });
  check(
    "已支付订单短路",
    paidSync.status === 200 && paidSync.data.paid === true && /已支付/.test(paidSync.data.reason || "")
  );

  const pendingSync = await api(base, `/api/admin/recharge/orders/${o1.id}/sync`, { method: "POST" });
  check(
    "模块缺失返回 400「聚合支付未配置」",
    pendingSync.status === 400 && pendingSync.data.error === "聚合支付未配置",
    JSON.stringify(pendingSync.data)
  );
  const stillPending = await api(base, "/api/admin/recharge/orders?status=pending");
  check("查单失败不改订单状态", stillPending.data.rows.some((r) => r.id === o1.id));
}

// ============================================================
console.log("\n[6] 订单备注");
{
  const r = await api(base, `/api/admin/recharge/orders/${o1.id}/note`, {
    method: "POST",
    body: { note: "客户说稍后支付" }
  });
  check(
    "备注成功",
    r.status === 200 && r.data.order.notes.length === 1 && r.data.order.notes[0].note === "客户说稍后支付"
  );
  const empty = await api(base, `/api/admin/recharge/orders/${o1.id}/note`, {
    method: "POST",
    body: { note: "   " }
  });
  check("空备注 400", empty.status === 400);
}

// ============================================================
console.log("\n[7] 退款");
{
  const r = await api(base, `/api/admin/recharge/orders/${o2.id}/refund`, {
    method: "POST",
    body: { reason: "客户要求退款" }
  });
  check(
    "退款成功并扣回算力",
    r.status === 200 &&
      r.data.ok === true &&
      r.data.order.status === "refunded" &&
      r.data.deducted === 5500 &&
      r.data.balance === 0,
    JSON.stringify(r.data).slice(0, 200)
  );
  check("退款后余额归零", credits.balance("u2") === 0);

  const againRefund = await api(base, `/api/admin/recharge/orders/${o2.id}/refund`, {
    method: "POST",
    body: {}
  });
  check("重复退款 400", againRefund.status === 400 && typeof againRefund.data.error === "string");

  const paidAfterRefund = await api(base, `/api/admin/recharge/orders/${o2.id}/manual-paid`, {
    method: "POST",
    body: {}
  });
  check("已退款订单不能补单", paidAfterRefund.status === 400 && /退款/.test(paidAfterRefund.data.error));

  // 余额不足：先把算力花掉一部分再退
  const o3 = credits.createOrder("u3", "plan-1000");
  await api(base, `/api/admin/recharge/orders/${o3.id}/manual-paid`, { method: "POST", body: {} });
  await credits.adjust("u3", -600, "测试扣减");
  const poor = await api(base, `/api/admin/recharge/orders/${o3.id}/refund`, { method: "POST", body: {} });
  check(
    "余额不足时透传错误原文",
    poor.status === 400 && /余额不足/.test(poor.data.error || ""),
    JSON.stringify(poor.data)
  );

  const afterRefundStats = await api(base, "/api/admin/recharge/stats?days=7");
  check("退款金额进入统计", afterRefundStats.data.range.refundAmount === 89);
  check(
    "byStatus 出现 refunded",
    afterRefundStats.data.byStatus.some((x) => x.status === "refunded" && x.count === 1)
  );
}

// ============================================================
console.log("\n[8] 套餐改价");
{
  const before = await api(base, "/api/admin/recharge/plans");
  check(
    "套餐含 total / perUnit",
    before.status === 200 &&
      before.data.rows.length === 4 &&
      before.data.rows[0].total === before.data.rows[0].credits + before.data.rows[0].bonus &&
      typeof before.data.rows[0].perUnit === "number"
  );

  const rows = before.data.rows.map((p) => ({
    id: p.id,
    credits: p.credits,
    bonus: p.bonus,
    price: p.price,
    label: p.label,
    hot: Boolean(p.hot)
  }));
  rows[0].price = 29.9;
  const saved = await api(base, "/api/admin/recharge/plans", { method: "PUT", body: { rows } });
  check("改价成功", saved.status === 200 && saved.data.ok === true && saved.data.rows[0].price === 29.9);

  const after = await api(base, "/api/admin/recharge/plans");
  check("改价已生效", after.data.rows[0].price === 29.9);

  const badEmpty = await api(base, "/api/admin/recharge/plans", { method: "PUT", body: { rows: [] } });
  check("空套餐列表 400", badEmpty.status === 400);

  const badId = await api(base, "/api/admin/recharge/plans", {
    method: "PUT",
    body: { rows: [{ id: "oops", credits: 1, bonus: 0, price: 1, label: "x" }] }
  });
  check("非法套餐 id 400", badId.status === 400);
}

// ============================================================
console.log("\n[9] 自动管理：配置");
{
  const r = await api(base, "/api/admin/recharge/automation");
  check(
    "默认配置",
    r.status === 200 &&
      r.data.config.enabled === true &&
      r.data.config.expireMinutes === 120 &&
      r.data.config.syncAfterSec === 180 &&
      r.data.config.syncBatch === 20 &&
      r.data.lastReport === null,
    JSON.stringify(r.data)
  );

  const saved = await api(base, "/api/admin/recharge/automation", {
    method: "PUT",
    body: { expireMinutes: 5, syncAfterSec: 60, syncBatch: 5 }
  });
  check(
    "部分更新配置",
    saved.status === 200 &&
      saved.data.config.expireMinutes === 5 &&
      saved.data.config.syncAfterSec === 60 &&
      saved.data.config.syncBatch === 5 &&
      saved.data.config.updatedAt > 0
  );

  const badMin = await api(base, "/api/admin/recharge/automation", {
    method: "PUT",
    body: { expireMinutes: 1 }
  });
  check("expireMinutes 越界 400", badMin.status === 400 && /expireMinutes/.test(badMin.data.error));

  const badType = await api(base, "/api/admin/recharge/automation", {
    method: "PUT",
    body: { syncBatch: "abc" }
  });
  check("syncBatch 非数字 400", badType.status === 400);

  const badEnabled = await api(base, "/api/admin/recharge/automation", {
    method: "PUT",
    body: { enabled: "yes" }
  });
  check("enabled 非布尔 400", badEnabled.status === 400);
}

// ============================================================
console.log("\n[10] 自动管理：runOnce");
{
  // 3 小时前创建、仍 pending 的订单 → 应被关单（当前 expireMinutes=5）
  const o5 = credits.createOrder("u5", "plan-1000");
  patchOrder(o5.id, { createdAt: Date.now() - 3 * 60 * 60 * 1000 });

  const run1 = await api(base, "/api/admin/recharge/automation/run", { method: "POST" });
  check(
    "runOnce 返回完整报告",
    run1.status === 200 &&
      run1.data.ok === true &&
      typeof run1.data.report.at === "number" &&
      run1.data.report.expired === 1 &&
      run1.data.report.paid === 0 &&
      Array.isArray(run1.data.report.errors),
    JSON.stringify(run1.data)
  );

  const auto = await api(base, "/api/admin/recharge/automation");
  check("lastReport 已持久化", auto.data.lastReport && auto.data.lastReport.expired === 1);
  check("配置未被报告写入破坏", auto.data.config.expireMinutes === 5);

  const run2 = await api(base, "/api/admin/recharge/automation/run", { method: "POST" });
  check("重复执行不会重复关单", run2.data.report.expired === 0);

  const expiredOrder = await api(base, "/api/admin/recharge/orders?userId=u5");
  check("订单状态确实是 expired", expiredOrder.data.rows[0].status === "expired");

  // 伪造一个「走过网关的 pending 订单」：聚合模块不存在时错误应计入报告而不是抛异常
  const o6 = credits.createOrder("u6", "plan-1000");
  patchOrder(o6.id, { channel: "aggregator", payMethod: "aggregator" });
  const run3 = await api(base, "/api/admin/recharge/automation/run", { method: "POST" });
  check(
    "聚合模块缺失计入 errors",
    run3.status === 200 && run3.data.report.errors.some((e) => /聚合支付未配置/.test(e)),
    JSON.stringify(run3.data.report)
  );
  check("查单失败不阻塞过期关单流程", run3.data.report.expired === 0);
}

// ============================================================
console.log("\n[11] 自动管理：定时器开关");
{
  const disabled = automation.startAutomation({ intervalMs: 5000 });
  check(
    "AI_CANVAS_DISABLE_AUTOMATION=1 不启动",
    disabled.started === false && disabled.reason === "disabled_by_env"
  );

  delete process.env.AI_CANVAS_DISABLE_AUTOMATION;
  const started = automation.startAutomation({ intervalMs: 5000 });
  check("可启动且幂等", started.started === true && automation.isAutomationStarted() === true);
  const second = automation.startAutomation({ intervalMs: 5000 });
  check("重复启动不叠加定时器", second.started === false && second.reason === "already_started");
  const stopped = automation.stopAutomation();
  check("可停止", stopped.stopped === true && automation.isAutomationStarted() === false);
  process.env.AI_CANVAS_DISABLE_AUTOMATION = "1";
}

// ============================================================
console.log("\n[12] 权限与审计");
{
  check(
    "挂载了 view / manage 权限码",
    main.mountPerms.includes("admin:recharge:view") && main.mountPerms.includes("admin:recharge:manage")
  );

  const denied = makeApp({ denyManage: true });
  const { server: s2, base: b2 } = await listen(denied.app);
  const read = await api(b2, "/api/admin/recharge/orders");
  check("有 view 可读订单", read.status === 200);
  const write = await api(b2, `/api/admin/recharge/orders/${o1.id}/note`, {
    method: "POST",
    body: { note: "越权尝试" }
  });
  check(
    "无 manage 写操作 403",
    write.status === 403 && write.data.code === "FORBIDDEN",
    JSON.stringify(write.data)
  );
  s2.closeAllConnections?.();
  s2.close();

  const auditDir = path.join(HOME, "audit");
  const text = fs.existsSync(auditDir)
    ? fs
        .readdirSync(auditDir)
        .map((f) => fs.readFileSync(path.join(auditDir, f), "utf8"))
        .join("\n")
    : "";
  check("人工补单写审计", /recharge\.order\.manual_paid/.test(text));
  check("退款写审计", /recharge\.order\.refund/.test(text));
  check("备注写审计", /recharge\.order\.note/.test(text));
  check("改价写审计", /recharge\.plans\.save/.test(text));
  check("自动管理写审计", /recharge\.automation\.(save|run)/.test(text));
}

// ============================================================
console.log(`\n充值后台自测：${pass} 项通过，${fail} 项失败\n`);
server.closeAllConnections?.();
server.close();
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
