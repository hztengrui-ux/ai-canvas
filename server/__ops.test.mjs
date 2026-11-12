/**
 * 运营后台端到端：客户中心 + 充值中心（自动管理）+ 第三方聚合支付
 * ------------------------------------------------------------------
 * 这一套跑的是**真实 server/index.js**（和用户实际使用完全同一条链路），
 * 不是单独 mount 某个模块，所以能抓到「模块本身没问题、但接线漏了」的缺陷：
 *   1. 机器令牌 → 超管初始化 → 登录态切换
 *   2. 客户中心：列表/详情/档案/人工调账/数据范围字段
 *   3. 充值中心：订单、统计、补单、退款、备注、套餐改价、自动管理
 *   4. 聚合支付：配置落盘 → payStatus 切换到 aggregator → 签名回调入账 →
 *      伪造签名/篡改金额被拒 → 权限码生效
 *
 * 隔离：临时 AI_CANVAS_HOME 放在项目盘 .tmp 下，结束必删；不碰 ~/.ai-canvas。
 * 运行：node server/__ops.test.mjs   （独立可跑，也由 scripts/run-tests.mjs 调度）
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP_ROOT = path.join(ROOT, ".tmp");
fs.mkdirSync(TMP_ROOT, { recursive: true });
const HOME = fs.mkdtempSync(path.join(TMP_ROOT, "ops-test-"));

// paths.js 在模块加载时读取 AI_CANVAS_HOME，必须在 import 项目模块之前设置
process.env.AI_CANVAS_HOME = HOME;
process.env.AI_CANVAS_VAULT = "file";
process.env.AI_CANVAS_DISABLE_AUTOMATION = "1";

const { signParams } = await import("./payment-aggregator.js");

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

function pickPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const PORT = await pickPort();
const BASE = `http://127.0.0.1:${PORT}`;

// 服务端日志写文件而不是管道：受限沙箱里 pipe stdio 会 spawn EPERM
const LOG = path.join(HOME, "server.log");
const logFd = fs.openSync(LOG, "w");
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  stdio: ["ignore", logFd, logFd],
  env: {
    ...process.env,
    AI_CANVAS_HOME: HOME,
    AI_CANVAS_OUTPUTS: path.join(HOME, "outputs"),
    AI_CANVAS_MATERIALS: path.join(HOME, "materials"),
    AI_CANVAS_VAULT: "file",
    AI_CANVAS_DISABLE_AUTOMATION: "1",
    PORT: String(PORT)
  }
});

async function waitUp() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/session`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

if (!(await waitUp())) {
  console.error("服务端启动失败：\n" + fs.readFileSync(LOG, "utf8"));
  server.kill("SIGKILL");
  process.exit(1);
}

// ---------- 测试脚手架 ----------
let TOKEN = "";
async function api(pathname, { method = "GET", body, token, form } = {}) {
  const headers = { "X-AI-Canvas-Token": token === undefined ? TOKEN : token };
  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${pathname}`, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

/**
 * 切换登录身份。
 *
 * 为什么不是「每个用户一个 token」：桌面端的安全模型是**一台机器一枚令牌**
 * （security.js 只认本机令牌 / 手机端 m_ 令牌），accounts.login 把会话直接绑在
 * 这枚令牌上。所以同一进程里换用户 = 用同一枚令牌重新登录，服务端会话被覆盖。
 * 浏览器多用户要等云端化 P1（见 reports/cloud-migration-2026-11-05），
 * 本测试按桌面端真实行为来：切身份 → 干活 → 切回去。
 */
async function as(username, password) {
  const r = await api("/api/auth/login", { method: "POST", body: { username, password } });
  if (!r.data?.ok) console.log(`  ! 登录 ${username} 失败：${r.status} ${r.text.slice(0, 120)}`);
  return r.data?.ok === true;
}
async function asBoss() {
  return as("boss", "boss8888");
}
async function asCust() {
  return as("cust1", "cust123456");
}

const cleanup = () => {
  try {
    server.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  try {
    fs.closeSync(logFd);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

// ============================================================
console.log("\n[A] 初始化：机器令牌 + 超管 + 客户账号");
// ============================================================
const sess = await api("/api/session", { token: "" });
TOKEN = sess.data?.token || "";
check("拿到本机会话令牌", Boolean(TOKEN), `status=${sess.status}`);

const setup = await api("/api/auth/setup", {
  method: "POST",
  body: { username: "boss", password: "boss8888" }
});
check("超管初始化成功", setup.data?.ok === true, `status=${setup.status} ${setup.text.slice(0, 120)}`);
const BOSS_TOKEN = TOKEN;

const created = await api("/api/admin/accounts", {
  method: "POST",
  body: { username: "cust1", password: "cust123456", nickname: "客户一号" }
});
const CUST_ID = created.data?.user?.id || "";
check("创建测试客户账号", created.status === 200 && Boolean(CUST_ID), `status=${created.status}`);

const visitor = await api("/api/admin/accounts", {
  method: "POST",
  body: { username: "visitor", password: "visit123456", nickname: "只读访客", roleIds: ["r-designer"] }
});
check("创建设计师账号（无运营权限）", visitor.status === 200 && Boolean(visitor.data?.user?.id), `status=${visitor.status}`);

const custLoginOk = await asCust();
check("客户账号可登录", custLoginOk);

// ============================================================
console.log("\n[B] 消费端：下单 → 沙箱支付 → 到账（真实回调链路）");
// ============================================================
let order1Id = "";
let order2Id = "";
{
  // 新用户赠送是「首次读余额」时落账的，先显式触发，后面的余额断言才是确定的
  const signup = await api("/api/credits/balance");
  check("新用户赠送 500 到账", signup.data?.balance === 500, `balance=${signup.data?.balance}`);

  const order = await api("/api/recharge/orders", {
    method: "POST",
    body: { planId: "plan-1000" }
  });
  order1Id = order.data?.order?.id || "";
  check("客户端创建订单", Boolean(order1Id), `status=${order.status} ${order.text.slice(0, 120)}`);

  const pay = await api(`/api/recharge/orders/${order1Id}/pay`, {
    method: "POST",
    body: { channel: "wechat" }
  });
  check(
    "申请支付凭证：未配置时为 sandbox",
    pay.status === 200 && pay.data?.gateway === "sandbox" && pay.data?.sandbox === true,
    `status=${pay.status} gateway=${pay.data?.gateway}`
  );

  const paid = await api(`/api/recharge/orders/${order1Id}/simulate-paid`, {
    method: "POST",
    body: { payMethod: "wechat" }
  });
  check("沙箱模拟支付到账（500 + 1000）", paid.status === 200 && paid.data?.balance === 1500, `balance=${paid.data?.balance}`);

  // 第二笔保持 pending，后面给运营做人工补单 / 退款
  const o2 = await api("/api/recharge/orders", { method: "POST", body: { planId: "plan-1000" } });
  order2Id = o2.data?.order?.id || "";
  check("客户创建第二笔订单（待支付）", Boolean(order2Id));

  // 切回管理员，后续都在后台视角
  check("切回超管身份", await asBoss());
}

// ============================================================
console.log("\n[C] 客户中心");
// ============================================================
{
  const list = await api("/api/admin/customers?keyword=cust1&page=1&pageSize=20");
  const row = (list.data?.rows || [])[0] || null;
  check("客户列表可读且命中 cust1", list.status === 200 && row?.username === "cust1", `status=${list.status}`);
  check("列表带算力余额", row?.balance === 1500, `balance=${row?.balance}`);
  check("列表带累计实付金额", row?.totalPaid === 19, `totalPaid=${row?.totalPaid}`);
  // orderCount 含待支付（B 阶段建了 2 笔），paidOrderCount 只算已付
  check(
    "列表带订单数/已付订单数",
    row?.orderCount === 2 && row?.paidOrderCount === 1,
    `orderCount=${row?.orderCount} paid=${row?.paidOrderCount}`
  );
  check("列表带最近支付时间", typeof row?.lastPaidAt === "number" && row.lastPaidAt > 0, `lastPaidAt=${row?.lastPaidAt}`);
  check("列表带等级默认 normal", row?.level === "normal" && Boolean(row?.levelLabel), `level=${row?.level}`);

  const meta = await api("/api/admin/customers/meta");
  check(
    "meta 返回四级等级",
    meta.status === 200 && (meta.data?.levels || []).length === 4,
    `levels=${JSON.stringify(meta.data?.levels)}`
  );
  check("meta 返回来源枚举", Array.isArray(meta.data?.sources) && meta.data.sources.length > 0);

  const detail = await api(`/api/admin/customers/${CUST_ID}`);
  check("客户详情含档案/流水/统计", detail.status === 200 && Boolean(detail.data?.customer) && Boolean(detail.data?.profile));
  check("详情统计余额正确", detail.data?.customer?.stats?.balance === 1500, `stats=${JSON.stringify(detail.data?.customer?.stats)}`);
  check("详情流水含本次充值", (detail.data?.customer?.records || []).length >= 1);

  const upd = await api(`/api/admin/customers/${CUST_ID}`, {
    method: "PUT",
    body: {
      realName: "张三",
      company: "某某科技有限公司",
      wechat: "zhangsan_wx",
      level: "vip",
      tags: ["重点客户", "华东"],
      source: "manual",
      remark: "测试客户",
      region: "上海"
    }
  });
  check("档案可编辑", upd.status === 200 && upd.data?.customer?.level === "vip", `status=${upd.status} ${upd.text.slice(0, 120)}`);

  const badLevel = await api(`/api/admin/customers/${CUST_ID}`, { method: "PUT", body: { level: "unknown" } });
  check("非法等级被拒", badLevel.status >= 400, `status=${badLevel.status}`);

  const adj1 = await api(`/api/admin/customers/${CUST_ID}/adjust`, {
    method: "POST",
    body: { amount: 500, reason: "活动补偿" }
  });
  check("人工调账 +500", adj1.status === 200 && adj1.data?.balance === 2000, `balance=${adj1.data?.balance}`);

  const adj2 = await api(`/api/admin/customers/${CUST_ID}/adjust`, {
    method: "POST",
    body: { amount: -200, reason: "纠正多送" }
  });
  check("人工调账 -200", adj2.status === 200 && adj2.data?.balance === 1800, `balance=${adj2.data?.balance}`);

  const adj3 = await api(`/api/admin/customers/${CUST_ID}/adjust`, {
    method: "POST",
    body: { amount: -999999, reason: "扣成负数" }
  });
  check("调账不得扣成负数", adj3.status >= 400, `status=${adj3.status} ${adj3.text.slice(0, 100)}`);

  const adj4 = await api(`/api/admin/customers/${CUST_ID}/adjust`, { method: "POST", body: { amount: 0 } });
  check("调账金额 0 被拒", adj4.status >= 400);

  const outsider = await api("/api/admin/customers/no-such-user");
  check("不存在的客户返回 400", outsider.status === 400, `status=${outsider.status}`);
}

// ============================================================
console.log("\n[D] 充值中心：订单 / 统计 / 补单 / 退款 / 备注");
// ============================================================
{
  const orders = await api("/api/admin/recharge/orders?keyword=cust1&page=1&pageSize=20");
  check("后台订单列表可读", orders.status === 200 && (orders.data?.rows || []).length >= 1, `status=${orders.status}`);
  check("订单列表带 summary", Boolean(orders.data?.summary) && typeof orders.data.summary.amount === "number");
  // 列表按时间倒序：第一行是待支付的 order2，渠道字段看已支付那笔
  const paidRow = (orders.data?.rows || []).find((r) => r.id === order1Id) || {};
  check(
    "订单行带渠道字段",
    ["wechat", "sandbox"].includes(paidRow.channel),
    `channel=${paidRow.channel} status=${paidRow.status}`
  );

  const stats = await api("/api/admin/recharge/stats?days=7");
  check("统计接口可读", stats.status === 200 && Boolean(stats.data?.today), `status=${stats.status}`);
  check("今日订单数 ≥ 1", (stats.data?.today?.count || 0) >= 1, `today=${JSON.stringify(stats.data?.today)}`);
  check("趋势补齐 7 天", (stats.data?.trend || []).length === 7, `len=${(stats.data?.trend || []).length}`);
  check("渠道分布非空", (stats.data?.byChannel || []).length >= 1);

  const manual = await api(`/api/admin/recharge/orders/${order2Id}/manual-paid`, {
    method: "POST",
    body: { reason: "线下转账，财务确认" }
  });
  check("人工补单入账", manual.status === 200 && manual.data?.balance === 2800, `status=${manual.status} balance=${manual.data?.balance}`);

  const manualAgain = await api(`/api/admin/recharge/orders/${order2Id}/manual-paid`, {
    method: "POST",
    body: { reason: "重复补单" }
  });
  check("补单幂等（already）", manualAgain.status === 200 && manualAgain.data?.already === true, `${manualAgain.text.slice(0, 120)}`);

  const note = await api(`/api/admin/recharge/orders/${order2Id}/note`, {
    method: "POST",
    body: { note: "客户已开发票" }
  });
  check(
    "订单备注可写",
    note.status === 200 && (note.data?.order?.notes || []).some((x) => x.note === "客户已开发票"),
    `status=${note.status}`
  );

  const refund = await api(`/api/admin/recharge/orders/${order2Id}/refund`, {
    method: "POST",
    body: { reason: "重复购买，原路退回" }
  });
  check(
    "退款扣回算力",
    refund.status === 200 && refund.data?.deducted === 1000 && refund.data?.balance === 1800,
    `status=${refund.status} ${refund.text.slice(0, 140)}`
  );

  const refundAgain = await api(`/api/admin/recharge/orders/${order2Id}/refund`, {
    method: "POST",
    body: { reason: "再退一次" }
  });
  check("重复退款被拒", refundAgain.status >= 400, `status=${refundAgain.status}`);

  const ordersAfter = await api(`/api/admin/recharge/orders?keyword=cust1`);
  const refundedRow = (ordersAfter.data?.rows || []).find((r) => r.id === order2Id);
  check("订单状态变为 refunded", refundedRow?.status === "refunded", `status=${refundedRow?.status}`);
  check("退款金额记录在订单上", refundedRow?.refund?.amount === 19, `refund=${JSON.stringify(refundedRow?.refund)}`);
}

// ============================================================
console.log("\n[E] 套餐改价 + 自动管理");
// ============================================================
{
  const plans = await api("/api/admin/recharge/plans");
  const rows = plans.data?.rows || [];
  check("后台可读套餐", plans.status === 200 && rows.length === 4 && rows.every((r) => r.total >= r.credits), `len=${rows.length}`);

  const nextRows = rows.map((r) => (r.id === "plan-1000" ? { ...r, price: 21 } : r));
  const saved = await api("/api/admin/recharge/plans", { method: "PUT", body: { rows: nextRows } });
  check("套餐改价保存", saved.status === 200, `status=${saved.status} ${saved.text.slice(0, 120)}`);

  const again = await api("/api/admin/recharge/plans");
  check("改价后立即可读", (again.data?.rows || []).find((r) => r.id === "plan-1000")?.price === 21);

  const pub = await api("/api/recharge/plans");
  check("客户端套餐同步新价", (pub.data?.rows || []).find((r) => r.id === "plan-1000")?.price === 21);

  const badPlans = await api("/api/admin/recharge/plans", {
    method: "PUT",
    body: { rows: [{ id: "plan-1000", credits: 0, price: 21 }] }
  });
  check("非法套餐被拒（credits=0）", badPlans.status >= 400, `status=${badPlans.status}`);

  const auto = await api("/api/admin/recharge/automation");
  check("自动管理配置可读", auto.status === 200 && Boolean(auto.data?.config), `status=${auto.status}`);

  const autoSaved = await api("/api/admin/recharge/automation", {
    method: "PUT",
    body: { expireMinutes: 60, syncAfterSec: 120 }
  });
  check(
    "自动管理配置可写",
    autoSaved.status === 200 && autoSaved.data?.config?.expireMinutes === 60,
    `status=${autoSaved.status}`
  );

  const badAuto = await api("/api/admin/recharge/automation", { method: "PUT", body: { expireMinutes: 1 } });
  check("自动管理非法区间被拒", badAuto.status >= 400, `status=${badAuto.status}`);

  const run = await api("/api/admin/recharge/automation/run", { method: "POST" });
  check(
    "自动管理可立即执行并返回报告",
    run.status === 200 && Boolean(run.data?.report) && typeof run.data.report.expired === "number",
    `status=${run.status} ${run.text.slice(0, 120)}`
  );
}

// ============================================================
console.log("\n[F] 第三方聚合支付：配置 → 生效 → 签名回调入账 → 拒绝伪造");
// ============================================================
let order3Id = "";
let order4Id = "";
let order5Id = "";
{
  const saved = await api("/api/admin/payment/channels", {
    method: "PUT",
    body: {
      provider: "aggregator",
      aggregator: {
        provider: "epay",
        gateway: `http://127.0.0.1:${PORT}`,
        pid: "1001",
        key: "epay-test-key-9f2c",
        notifyBaseUrl: `http://127.0.0.1:${PORT}`,
        returnBaseUrl: "",
        methods: ["wxpay", "alipay"]
      }
    }
  });
  check("聚合支付配置保存成功", saved.status === 200, `status=${saved.status} ${saved.text.slice(0, 160)}`);

  const channels = await api("/api/admin/payment/channels");
  check(
    "通道状态显示聚合已配置",
    channels.status === 200 && channels.data?.channels?.aggregator?.configured === true,
    `status=${channels.status}`
  );
  check("密钥只回显 keySet", channels.data?.channels?.aggregator?.keySet === true);
  check("响应体不含明文密钥", !channels.text.includes("epay-test-key-9f2c"));

  const payStatus = await api("/api/recharge/pay-status", { token: "" });
  check(
    "公开支付状态自动切到 aggregator",
    payStatus.status === 200 && payStatus.data?.mode === "aggregator" && payStatus.data?.sandbox === false,
    `mode=${payStatus.data?.mode}`
  );
  check("支付提示包含聚合", String(payStatus.data?.hint || "").includes("聚合"), `hint=${payStatus.data?.hint}`);
  check("公开状态不回显密钥", !payStatus.text.includes("epay-test-key-9f2c"));

  // 切到客户身份：下单 / 支付 / 查询余额都是消费端视角
  check("切到客户身份下单", await asCust());

  // 用聚合通道下单一笔（改价后 plan-1000 = 21 元）
  const o3 = await api("/api/recharge/orders", { method: "POST", body: { planId: "plan-1000" } });
  order3Id = o3.data?.order?.id || "";
  check("聚合模式下订单价格为改价后的 21", o3.data?.order?.price === 21, `price=${o3.data?.order?.price}`);
  check(
    "改价不影响订单算力（1000 / 赠送 0）",
    o3.data?.order?.credits === 1000 && o3.data?.order?.bonus === 0,
    `credits=${o3.data?.order?.credits} bonus=${o3.data?.order?.bonus}`
  );

  const payTry = await api(`/api/recharge/orders/${order3Id}/pay`, {
    method: "POST",
    body: { channel: "alipay" },
  });
  // 易支付是「拼好 submit.php 地址交给浏览器打开」，createPayment 阶段不依赖上游可达；
  // 因此这里断言返回收银台地址，而不是断言失败。
  check(
    "聚合支付返回收银台地址",
    payTry.status === 200 && String(payTry.data?.payUrl || "").includes("submit.php"),
    `status=${payTry.status} payUrl=${String(payTry.data?.payUrl || "").slice(0, 120)}`
  );
  const pendingList = await api("/api/recharge/orders", {});
  check(
    "未收到回调前订单仍是 pending",
    (pendingList.data?.rows || []).find((r) => r.id === order3Id)?.status === "pending"
  );

  // 手工构造一封合法的 epay 异步通知（签名算法与生产完全一致）
  const params = {
    pid: "1001",
    trade_no: "EPAY20261105001",
    out_trade_no: order3Id,
    type: "alipay",
    name: "算力充值",
    money: "21.00",
    trade_status: "TRADE_SUCCESS"
  };
  const { sign } = signParams(params, "epay");
  const notify = await api("/api/recharge/callback/aggregator", {
    method: "POST",
    form: { ...params, sign, sign_type: "MD5" },
    token: ""
  });
  check(
    "合法签名回调回纯文本 success",
    notify.status === 200 && notify.text.trim() === "success",
    `status=${notify.status} body=${notify.text.slice(0, 120)}`
  );

  const bal = await api("/api/credits/balance", {});
  check("回调后算力到账（1800 + 1000）", bal.data?.balance === 2800, `balance=${bal.data?.balance}`);

  const detail = await api(`/api/recharge/orders/${order3Id}`, { token: "" });
  void detail; // 客户端没有单查接口，用列表确认
  const list = await api("/api/recharge/orders", {});
  const paidOrder = (list.data?.rows || []).find((r) => r.id === order3Id);
  check("订单状态为 paid 且渠道为 aggregator", paidOrder?.status === "paid", `status=${paidOrder?.status}`);
  check("订单记录支付渠道", ["aggregator", "alipay"].includes(paidOrder?.channel) || paidOrder?.payMethod === "aggregator", `channel=${paidOrder?.channel}`);

  // 伪造签名：必须拒绝
  const o4 = await api("/api/recharge/orders", { method: "POST", body: { planId: "plan-1000" } });
  order4Id = o4.data?.order?.id || "";
  const fake = {
    pid: "1001",
    trade_no: "EPAY20261105002",
    out_trade_no: order4Id,
    type: "alipay",
    name: "算力充值",
    money: "21.00",
    trade_status: "TRADE_SUCCESS"
  };
  const badNotify = await api("/api/recharge/callback/aggregator", {
    method: "POST",
    form: { ...fake, sign: "0".repeat(32), sign_type: "MD5" },
    token: ""
  });
  check("伪造签名回调被拒", badNotify.status >= 400 && badNotify.text.trim() === "fail", `status=${badNotify.status} body=${badNotify.text.slice(0, 80)}`);
  const bal2 = await api("/api/credits/balance", {});
  check("伪造回调未加算力", bal2.data?.balance === 2800, `balance=${bal2.data?.balance}`);

  // 篡改金额：签名合法但金额与订单不一致
  const o5 = await api("/api/recharge/orders", { method: "POST", body: { planId: "plan-1000" } });
  order5Id = o5.data?.order?.id || "";
  const cheap = {
    pid: "1001",
    trade_no: "EPAY20261105003",
    out_trade_no: order5Id,
    type: "alipay",
    name: "算力充值",
    money: "0.01",
    trade_status: "TRADE_SUCCESS"
  };
  const cheapSign = signParams(cheap, "epay").sign;
  const cheapNotify = await api("/api/recharge/callback/aggregator", {
    method: "POST",
    form: { ...cheap, sign: cheapSign, sign_type: "MD5" },
    token: ""
  });
  check("金额被篡改的回调被拒", cheapNotify.status >= 400, `status=${cheapNotify.status} body=${cheapNotify.text.slice(0, 100)}`);
  const bal3 = await api("/api/credits/balance", {});
  check("篡改金额未加算力", bal3.data?.balance === 2800, `balance=${bal3.data?.balance}`);

  // 非成功态：签名合法但 trade_status=WAIT_BUYER_PAY，不应入账
  const waitParams = { ...fake, out_trade_no: order5Id, money: "21.00", trade_status: "WAIT_BUYER_PAY" };
  const waitSign = signParams(waitParams, "epay").sign;
  const waitNotify = await api("/api/recharge/callback/aggregator", {
    method: "POST",
    form: { ...waitParams, sign: waitSign, sign_type: "MD5" },
    token: ""
  });
  const order5After = (await api("/api/recharge/orders", {})).data?.rows?.find((r) => r.id === order5Id);
  check(
    "非成功态回调不入账",
    waitNotify.status === 200 && order5After?.status === "pending",
    `status=${waitNotify.status} order=${order5After?.status}`
  );

  // 配置回退到自动模式（回超管身份操作），避免影响后续套件
  check("切回超管恢复支付模式", await asBoss());
  await api("/api/admin/payment/channels", { method: "PUT", body: { provider: "" } });
}

// ============================================================
console.log("\n[G] 权限矩阵：运营 / 设计师");
// ============================================================
{
  check("切到运营身份", await asCust());
  const opCustomers = await api("/api/admin/customers");
  check("运营可读客户列表", opCustomers.status === 200, `status=${opCustomers.status}`);
  const opPayView = await api("/api/admin/payment/channels");
  check("运营可读支付通道（只读）", opPayView.status === 200, `status=${opPayView.status}`);
  const opPayConfig = await api("/api/admin/payment/channels", { method: "PUT", body: { provider: "sandbox" } });
  check("运营不可改支付配置", opPayConfig.status === 403, `status=${opPayConfig.status}`);

  check("切到设计师身份", await as("visitor", "visit123456"));
  const dCustomers = await api("/api/admin/customers");
  check("设计师不可读客户列表", dCustomers.status === 403, `status=${dCustomers.status}`);
  const dPayment = await api("/api/admin/payment/channels");
  check("设计师不可读支付通道", dPayment.status === 403, `status=${dPayment.status}`);
  const dAutomation = await api("/api/admin/recharge/automation/run", { method: "POST" });
  check("设计师不可执行自动管理", dAutomation.status === 403, `status=${dAutomation.status}`);
}

// ============================================================
console.log("\n[H] 审计：运营动作已落盘");
// ============================================================
{
  check("切回超管读审计", await asBoss());
  const logs = await api("/api/admin/logs?limit=200");
  const rows = logs.data?.events || [];
  const actions = rows.map((r) => r.detail?.action || "").filter(Boolean);
  check("审计可读", logs.status === 200 && rows.length > 0, `status=${logs.status} events=${rows.length}`);
  check(
    "包含支付配置审计",
    actions.includes("payment.channel.save"),
    `actions=${[...new Set(actions)].slice(0, 12).join(",")}`
  );
  check(
    "包含充值后台审计",
    actions.some((a) => a.startsWith("recharge.")),
    `actions=${[...new Set(actions)].slice(0, 12).join(",")}`
  );
  check(
    "审计不含明文密钥",
    !logs.text.includes("epay-test-key-9f2c"),
    "日志里出现了明文密钥"
  );
}

// ============================================================
cleanup();

console.log("\n════════════════════════════════════");
console.log(`运营后台端到端：${pass} 通过 / ${fail} 失败`);
console.log("════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
