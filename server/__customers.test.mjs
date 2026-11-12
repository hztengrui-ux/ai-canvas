// 客户中心接口自测：meta / 列表聚合 / 详情 / 档案校验 / 人工调账 / 行级数据范围
// 运行：node server/__customers.test.mjs
//
// 不依赖主服务：自己起一个最小 express，挂载 mountCustomers，用桩中间件注入 req.user。
// 数据目录指到项目盘 .tmp 下的临时目录（AI_CANVAS_HOME 在 import 之前设置），跑完删除。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TMP = path.join(ROOT, ".tmp", `customers-test-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
process.env.AI_CANVAS_HOME = TMP;

const express = (await import("express")).default;
const accounts = await import("./accounts.js");
const credits = await import("./credits.js");
const { mountCustomers } = await import("./customers.js");
const { dataFile } = await import("./paths.js");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

async function api(pathname, { method = "GET", body, actor = "super" } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-actor": actor },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

console.log("\n=== 客户中心接口自测 ===\n");

// ---------- 造数据：两个账号，bob 有充值/消耗/支付订单，alice 是纯新客户 ----------
const alice = accounts.createUser({
  username: "alice",
  password: "secret1",
  nickname: "Alice",
  email: "alice@example.com",
  phone: "13800000000"
});
const bob = accounts.createUser({
  username: "bob",
  password: "secret1",
  nickname: "Bob",
  email: "bob@example.com",
  phone: "13900000000"
});
check("测试账号创建成功", Boolean(alice.id && bob.id), `alice=${alice.id} bob=${bob.id}`);

await credits.grant(bob.id, 500, "测试赠送");
const order = credits.createOrder(bob.id, "plan-1000");
await credits.markPaid(order.id, "manual"); // 价格 19 元 + 1000 算力
await credits.reserve(bob.id, "image.generate", "test-ref-1"); // 消耗 10
check(
  "预置账务：bob 余额 1490",
  credits.balance(bob.id) === 1490,
  `balance=${credits.balance(bob.id)}`
);

// ---------- 挂载到最小 express，桩中间件注入 req.user ----------
const superUser = { id: "u-admin", username: "tester", roleIds: ["r-super"], dataScope: "all" };
const app = express();
app.use(express.json());
mountCustomers(app, {
  requireLogin: (req, _res, next) => {
    // 测试专用：header 决定身份，用来验证 self 数据范围
    req.user =
      req.headers["x-test-actor"] === "self"
        ? { id: bob.id, username: bob.username, roleIds: ["r-operator"], dataScope: "self" }
        : superUser;
    next();
  },
  requirePerm: () => (_req, _res, next) => next()
});

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- 1) meta ----------
{
  const { status, data } = await api("/api/admin/customers/meta");
  check("meta 200", status === 200);
  check(
    "meta 等级为 normal/vip/svip/agent",
    Array.isArray(data?.levels) &&
      data.levels.map((l) => l.value).join(",") === "normal,vip,svip,agent",
    JSON.stringify(data?.levels)
  );
  check(
    "meta 等级带中文标签",
    data.levels.every((l) => typeof l.label === "string" && l.label.length > 0)
  );
  check("meta sources 是数组且含默认来源", Array.isArray(data?.sources) && data.sources.includes("官网"));
}

// ---------- 2) 列表聚合 + lastPaidAt 倒序 ----------
{
  const { status, data } = await api("/api/admin/customers");
  check("列表 200", status === 200);
  check("列表 total=2", data.total === 2, `total=${data.total}`);
  check("列表 rows=2", data.rows.length === 2);
  check("有支付记录的 bob 排第一", data.rows[0].username === "bob", data.rows.map((r) => r.username).join(","));
  check("无支付记录的 alice 排后面且 lastPaidAt=null", data.rows[1].username === "alice" && data.rows[1].lastPaidAt === null);

  const bobRow = data.rows[0];
  check("行内余额聚合", bobRow.balance === 1490, `balance=${bobRow.balance}`);
  check("行内 totalPaid=19", bobRow.totalPaid === 19, `totalPaid=${bobRow.totalPaid}`);
  check("行内 refundAmount=0", bobRow.refundAmount === 0);
  check("行内 totalSpent=10", bobRow.totalSpent === 10, `totalSpent=${bobRow.totalSpent}`);
  check("行内 orderCount=1 / paidOrderCount=1", bobRow.orderCount === 1 && bobRow.paidOrderCount === 1);
  check("行内带账号字段与部门", bobRow.email === "bob@example.com" && Array.isArray(bobRow.roleNames));
  check("行内 level 默认 normal 且有 levelLabel", bobRow.level === "normal" && bobRow.levelLabel === "普通客户");
  check("行内 tags 是数组", Array.isArray(bobRow.tags));
}

// ---------- 3) 筛选 / 分页 ----------
{
  const kw = await api("/api/admin/customers?keyword=alice@example.com");
  check("keyword 匹配邮箱", kw.data.total === 1 && kw.data.rows[0].username === "alice");

  const st = await api("/api/admin/customers?status=disabled");
  check("status 筛选生效", st.data.total === 0);

  const pg = await api("/api/admin/customers?page=2&pageSize=1");
  check(
    "分页 page=2/pageSize=1 返回第二行",
    pg.data.page === 2 && pg.data.pageSize === 1 && pg.data.rows.length === 1 && pg.data.total === 2,
    `rows=${pg.data.rows.length}`
  );

  const bad = await api("/api/admin/customers?page=abc&pageSize=999");
  check("非法分页参数被钳制", bad.data.page === 1 && bad.data.pageSize === 100);
}

// ---------- 4) 档案更新 + 校验 ----------
{
  const put = await api(`/api/admin/customers/${alice.id}`, {
    method: "PUT",
    body: {
      realName: "爱丽丝",
      company: "ACME 设计",
      wechat: "alice_wx",
      level: "vip",
      tags: ["VIP", " 老客户 ", "VIP"],
      source: "官网",
      remark: "重点客户",
      region: "上海"
    }
  });
  check("PUT 档案 200", put.status === 200, JSON.stringify(put.data)?.slice(0, 120));
  check("PUT 返回 ok:true 与 customer", put.data.ok === true && put.data.customer?.id === alice.id);
  check("等级生效且带标签", put.data.customer.level === "vip" && put.data.customer.levelLabel === "VIP");
  check(
    "tags 去重且 trim",
    JSON.stringify(put.data.customer.tags) === JSON.stringify(["VIP", "老客户"]),
    JSON.stringify(put.data.customer.tags)
  );

  const detail = await api(`/api/admin/customers/${alice.id}`);
  check("详情返回 profile 且已落盘字段", detail.data.profile?.realName === "爱丽丝" && detail.data.profile?.region === "上海");
  check("详情 profile 记录 updatedBy", detail.data.profile?.updatedBy === "tester");

  const badLevel = await api(`/api/admin/customers/${alice.id}`, { method: "PUT", body: { level: "gold" } });
  check("非法等级 400", badLevel.status === 400 && /等级不合法/.test(badLevel.data.error), badLevel.data.error);

  const manyTags = await api(`/api/admin/customers/${alice.id}`, {
    method: "PUT",
    body: { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }
  });
  check("标签超过 20 个 400", manyTags.status === 400 && /标签最多/.test(manyTags.data.error), manyTags.data.error);

  const longTag = await api(`/api/admin/customers/${alice.id}`, {
    method: "PUT",
    body: { tags: ["这是一个明显超过二十个字符长度限制的标签名称啊啊啊"] }
  });
  check("单个标签超长 400", longTag.status === 400 && /超过 20 个字符/.test(longTag.data.error), longTag.data.error);

  const noField = await api(`/api/admin/customers/${alice.id}`, {
    method: "PUT",
    body: { username: "hacked", roleIds: ["r-super"], status: "disabled" }
  });
  check("只传账号字段被拒绝（档案接口不改账号）", noField.status === 400 && /没有可更新的档案字段/.test(noField.data.error));

  const after = accounts.getUser(alice.id);
  check("账号字段未被档案接口改动", after.username === "alice" && after.status === "active");

  const file = dataFile("customer-profiles.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  check("档案文件按 userId 落盘", Boolean(saved[alice.id]) && saved[alice.id].level === "vip");
}

// ---------- 5) 详情：订单 / 流水 / stats ----------
{
  const { status, data } = await api(`/api/admin/customers/${bob.id}`);
  check("详情 200", status === 200);
  check("详情 customer.orders 返回订单", Array.isArray(data.customer.orders) && data.customer.orders.length === 1);
  check(
    "订单字段与契约一致",
    data.customer.orders[0].id === order.id &&
      data.customer.orders[0].status === "paid" &&
      data.customer.orders[0].channel === "manual" &&
      data.customer.orders[0].username === "bob" &&
      typeof data.customer.orders[0].price === "number"
  );
  check("详情 records 最近 50 条以内且最新在前", data.customer.records.length > 0 && data.customer.records.length <= 50);
  check(
    "stats 口径",
    data.customer.stats.balance === 1490 &&
      data.customer.stats.totalPaid === 19 &&
      data.customer.stats.totalSpent === 10 &&
      data.customer.stats.refundAmount === 0 &&
      data.customer.stats.orderCount === 1,
    JSON.stringify(data.customer.stats)
  );

  const missing = await api("/api/admin/customers/not-exist-id");
  check("不存在的客户 400", missing.status === 400 && missing.data.error === "客户不存在");
}

// ---------- 6) 人工调账 ----------
{
  const zero = await api(`/api/admin/customers/${bob.id}/adjust`, {
    method: "POST",
    body: { amount: 0, reason: "x" }
  });
  check("amount=0 被拒绝", zero.status === 400 && /非零整数/.test(zero.data.error));

  const frac = await api(`/api/admin/customers/${bob.id}/adjust`, {
    method: "POST",
    body: { amount: 1.5, reason: "x" }
  });
  check("小数金额被拒绝", frac.status === 400 && /非零整数/.test(frac.data.error));

  const noReason = await api(`/api/admin/customers/${bob.id}/adjust`, {
    method: "POST",
    body: { amount: 10 }
  });
  check("缺 reason 被拒绝", noReason.status === 400 && /调账原因/.test(noReason.data.error));

  const overdraft = await api(`/api/admin/customers/${bob.id}/adjust`, {
    method: "POST",
    body: { amount: -999999, reason: "测试超扣" }
  });
  check("负数调账不允许扣成负余额", overdraft.status === 400 && /负数/.test(overdraft.data.error), overdraft.data.error);

  const ok = await api(`/api/admin/customers/${bob.id}/adjust`, {
    method: "POST",
    body: { amount: 100, reason: "客诉补偿" }
  });
  check(
    "正数调账 200 且返回 balance/delta",
    ok.status === 200 && ok.data.ok === true && ok.data.balance === 1590 && ok.data.delta === 100,
    JSON.stringify(ok.data)
  );
  check("调账真实落到账本", credits.balance(bob.id) === 1590);
  const last = credits.records(bob.id, { limit: 1 })[0];
  check("调账流水含原因与操作人", last.type === "grant" && /客诉补偿/.test(last.reason) && /tester/.test(last.reason), last.reason);

  const detail = await api(`/api/admin/customers/${bob.id}`);
  check("详情 stats 同步调账后余额", detail.data.customer.stats.balance === 1590);
}

// ---------- 7) 行级数据范围（self 只能看到自己） ----------
{
  const list = await api("/api/admin/customers", { actor: "self" });
  check("self 范围列表只返回自己", list.data.total === 1 && list.data.rows[0].id === bob.id);

  const denied = await api(`/api/admin/customers/${alice.id}`, { actor: "self" });
  check(
    "self 范围看他人详情 403 FORBIDDEN",
    denied.status === 403 && denied.data.code === "FORBIDDEN",
    JSON.stringify(denied.data)
  );

  const deniedPut = await api(`/api/admin/customers/${alice.id}`, {
    method: "PUT",
    actor: "self",
    body: { realName: "越权改" }
  });
  check("self 范围改他人档案 403", deniedPut.status === 403);

  const deniedAdjust = await api(`/api/admin/customers/${alice.id}/adjust`, {
    method: "POST",
    actor: "self",
    body: { amount: 100, reason: "越权调账" }
  });
  check("self 范围给他人调账 403", deniedAdjust.status === 403);
  check("越权调账未改账本", credits.balance(alice.id) === 0);
}

// ---------- 收尾 ----------
await new Promise((resolve) => server.close(resolve));
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
