// 算力账户与充值
//
// 设计要点（对标 AI Change 的 /api/app/credits + /api/app/recharge）：
//  1. 「账」和「钱」分开建模 —— credits 是消耗品，recharge 是交易，对账才清楚
//  2. 只记流水，余额由流水推导 —— 任何一笔都能追溯，绝不会出现「余额对不上账」
//  3. 生成走「预扣 → 提交 / 回滚」三步 —— 避免失败还扣钱（用户投诉第一来源）
//  4. 所有写入串行化 —— 防并发超扣
import fs from "node:fs";
import crypto from "node:crypto";
import { dataFile, HOME as DIR } from "./paths.js";

const LEDGER_FILE = dataFile("credits-ledger.json");
const ORDERS_FILE = dataFile("recharge-orders.json");
// 套餐可运营配置：默认用内置 PLANS，运营后台改价后落这里（不覆盖代码，回滚只需删文件）
const PLANS_FILE = dataFile("recharge-plans.json");

// ---------- 计费表 ----------
// 单位：算力点。真实项目里这张表应该也能由服务端下发，方便调价不发版。
export const COST_TABLE = {
  "image.generate": { cost: 10, label: "生成图片" },
  "image.edit": { cost: 6, label: "图片编辑" },
  "image.upscale": { cost: 4, label: "一键高清" },
  "video.generate": { cost: 120, label: "生成视频" },
  "detail-page": { cost: 60, label: "详情页制作" }
};

// 新用户赠送（对应主流的「注册送额度」）
export const SIGNUP_GRANT = 500;

// ---------- 充值套餐 ----------
export const PLANS = [
  { id: "plan-1000", credits: 1000, price: 19, bonus: 0, label: "体验包" },
  { id: "plan-5000", credits: 5000, price: 89, bonus: 500, label: "标准包", hot: true },
  { id: "plan-20000", credits: 20000, price: 299, bonus: 3000, label: "专业包" },
  { id: "plan-50000", credits: 50000, price: 699, bonus: 10000, label: "团队包" }
];

// ---------- 存储 ----------
function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function write(file, data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** ledger: { records: { [userId]: [entry, ...] } } */
function readLedger() {
  return read(LEDGER_FILE, { records: {} });
}

function writeLedger(l) {
  write(LEDGER_FILE, l);
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

// ---------- 串行队列 ----------
// 同一时刻只允许一次账本写入，避免并发超扣
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// ---------- 查询 ----------
export function balance(userId) {
  const l = readLedger();
  const rows = l.records[userId] || [];
  return rows.reduce((sum, r) => sum + r.amount, 0);
}

export function records(userId, { limit = 50, type } = {}) {
  const l = readLedger();
  let rows = [...(l.records[userId] || [])].reverse(); // 最新在前
  if (type) rows = rows.filter((r) => r.type === type);
  return rows.slice(0, limit);
}

export function costOf(action) {
  return COST_TABLE[action]?.cost ?? 0;
}

// ---------- 记账（内部） ----------
function append(l, userId, entry) {
  l.records[userId] ||= [];
  l.records[userId].push(entry);
  // 单用户流水超过 2000 条时裁旧，防止文件无限膨胀。
  //
  // ⚠️ 2026-10-14 修复：余额的唯一计算方式是「所有流水求和」（见 balance()）。
  // 早期实现直接 slice(-2000) 把旧记录丢掉 —— 那会把用户的余额一起丢掉：
  // 实测充值 2100 点后余额只剩 2000（100 点凭空蒸发），reconcile 也会报不一致。
  // 现在裁旧时先把被丢弃金额之和写成一条 carry 结转记录补在队首，
  // 保证「余额 == 流水求和」这个不变式恒成立（文件依然有界）。
  const MAX_ROWS = 2000;
  const rows = l.records[userId];
  if (rows.length <= MAX_ROWS) return;

  const dropCount = rows.length - MAX_ROWS;
  const dropped = rows.slice(0, dropCount);
  const carried = dropped.reduce((s, r) => s + (r.amount || 0), 0);
  const rest = rows.slice(dropCount);

  if (carried !== 0) {
    // 被丢弃的金额必须留下痕迹：在队首补一条结转记录，把这段历史压成一个数。
    // 注意这里**不能**再裁一次 —— 结转记录一旦被裁走，被丢掉的余额就真没了。
    // 因此数组上限放宽到 MAX_ROWS + 1，这是有意的取舍。
    rest.unshift({
      id: uid("tx"),
      userId,
      type: "carry",
      amount: carried,
      balanceAfter: dropped[dropped.length - 1]?.balanceAfter ?? null,
      reason: `历史流水结转（已归档 ${dropCount} 条）`,
      refId: "",
      archivedRows: dropCount,
      ts: dropped[dropped.length - 1]?.ts || Date.now()
    });
  }
  // 其余被丢弃的都是 0 金额记录（consume 标记等），没有余额需要结转
  l.records[userId] = rest;
}

function makeEntry(userId, { type, amount, reason, refId = "", balanceAfter, reserveTxId = "" }) {
  return {
    id: uid("tx"),
    userId,
    type, // grant | recharge | consume | reserve | refund | rollback
    amount, // 有符号：扣减为负
    balanceAfter,
    reason: reason || "",
    refId,
    // 退费/回收时记下退的是哪一笔预扣，审计可精确配对。
    // 字段是白名单式的：不传就不写，避免旧类型记录里多出空字段。
    ...(reserveTxId ? { reserveTxId } : {}),
    ts: Date.now()
  };
}

/** 直接加算力（充值 / 赠送） */
export function grant(userId, amount, reason, refId = "") {
  return serial(() => {
    const l = readLedger();
    const after = (l.records[userId] || []).reduce((s, r) => s + r.amount, 0) + amount;
    const entry = makeEntry(userId, { type: "recharge", amount, reason, refId, balanceAfter: after });
    append(l, userId, entry);
    writeLedger(l);
    return { ok: true, balance: after, entry };
  });
}

/**
 * 预扣：生成开始前调用。
 * 余额不足直接拒绝，不进入生成流程 —— 这是防止「超额生成」的第一道闸。
 *
 * ⚠️ 2026-10-14 修复（幂等）：同一 refId 只允许存在一笔「未了结」的预扣。
 * 以前 reserve 完全不做幂等判断，而 rollback 是按 refId 去重的，两者不对称：
 * 同一入参若失败两次，第二次 reserve 会再扣一笔，但第二次 rollback 会被
 * 「已回滚过」挡掉 → 用户永久少一笔钱（实测余额卡在 90，每再失败一次再丢一单）。
 * 现在重复 reserve 直接返回既有那笔预扣，不再重复扣费。
 */
export function reserve(userId, action, refId = "") {
  return reserveAmount(userId, action, refId, costOf(action));
}

/**
 * 按「指定金额」预扣 —— 模型网关专用（Sprint 1）。
 *
 * 为什么需要单独一个入口：计费表 COST_TABLE 是**按动作**定价（image.generate = 10），
 * 而模型注册表支持**按模型**定价（server/models/registry.js 的 cost 列，null 表示用基价）。
 * 两者不能互相覆盖，所以把「金额」变成入参；其余逻辑（refId 幂等、余额不足拒绝、
 * 流水与结转）与 reserve 共用同一份实现 —— 避免出现「两套扣费逻辑各自演进」这种最危险
 * 的重复：那种重复一旦出现，失败回滚与幂等修复只会落在其中一套上。
 */
export function reserveAmount(userId, action, refId = "", amount = 0) {
  const rounded = Math.round(Number(amount) || 0);
  const cost = Number.isFinite(rounded) && rounded > 0 ? rounded : 0;
  return serial(() => {
    if (cost <= 0) return { ok: true, cost: 0, reserved: false };

    const l = readLedger();
    const rows = l.records[userId] || [];

    // 同一 refId 已有**仍未收口**的预扣 → 复用它，绝不重复扣（挡住重复提交/双击）。
    //
    // ⚠️ 2026-10-16 修正：这里原来用「这个 refId 历史上出现过 consume/rollback」来判断"已了结"，
    // 于是只要曾经结算过一次，之后所有同 refId 的预扣都被认为"没有未了结的"→
    // 复用逻辑**永久失效**（重复提交一律再扣一次钱）。
    // 口径必须按「笔数」：已收口笔数 < 预扣笔数，才说明还有一笔悬着。
    if (refId) {
      const reserves = rows.filter((r) => r.type === "reserve" && r.refId === refId);
      const closed = rows.filter((r) => (r.type === "consume" || r.type === "rollback") && r.refId === refId).length;
      if (reserves.length > closed) {
        const existing = reserves[reserves.length - 1];
        return {
          ok: true,
          cost: Math.abs(existing.amount),
          reserved: false,
          duplicate: true,
          balance: rows.reduce((s, r) => s + r.amount, 0),
          txId: existing.id
        };
      }
    }

    const cur = rows.reduce((s, r) => s + r.amount, 0);
    if (cur < cost) {
      return { ok: false, code: "INSUFFICIENT_CREDITS", balance: cur, need: cost };
    }
    const after = cur - cost;
    const entry = makeEntry(userId, {
      type: "reserve",
      amount: -cost,
      reason: COST_TABLE[action]?.label || action,
      refId,
      balanceAfter: after
    });
    append(l, userId, entry);
    writeLedger(l);
    return { ok: true, cost, reserved: true, balance: after, txId: entry.id };
  });
}

/**
 * 回滚：生成失败时把预扣退回。
 * 一笔预扣只能回滚一次（靠 refId 去重），防止重复退款刷算力。
 *
 * 2026-10-14：配合 reserve 的幂等修复，优先用 reserveTxId 精确定位那一笔预扣，
 * 避免同 refId 历史上有多次预扣时退错金额。
 */
export function rollback(userId, refId, reserveTxId = "") {
  return serial(() => {
    const l = readLedger();
    const rows = l.records[userId] || [];

    const reserves = rows.filter((r) => r.type === "reserve" && r.refId === refId);
    const rollbacks = rows.filter((r) => r.type === "rollback" && r.refId === refId);

    // ---------- 幂等判定：必须按「每一次预扣」，不能按 refId 全局查重 ----------
    // ⚠️ 2026-10-16 真实事故：refId 是**请求内容签名**（同一个提示词+参数 → 同一个 refId）。
    // 下面这行旧代码只要历史上退过一次，就把**后来所有**同 refId 的退费都当成重复而跳过：
    //     const already = rows.some(r => r.type === "rollback" && r.refId === refId);
    // 于是用户第二天重试同一个请求、再次失败时，-10 的预扣永久卡在账上
    // （实测：3 次失败卡住 30 算力，余额 7950 → 7920，且再没有任何后续记录）。
    //
    // 正确口径：这个 refId 的「预扣笔数」必须**大于**「已退笔数」才允许退 ——
    // 既不会重复退同一笔，也不会因为陈年旧账把新的退费吞掉。
    if (reserveTxId && rows.some((r) => r.type === "rollback" && r.reserveTxId === reserveTxId)) {
      return { ok: true, skipped: true };
    }
    if (rollbacks.length >= reserves.length) return { ok: true, skipped: true };

    // 找到对应的预扣金额：优先按 txId 精确命中，退化为按 refId 找最近一笔
    const rs =
      (reserveTxId && reserves.find((r) => r.id === reserveTxId)) || reserves[reserves.length - 1];
    if (!rs) return { ok: true, skipped: true };

    const amount = Math.abs(rs.amount);
    const after = rows.reduce((s, r) => s + r.amount, 0) + amount;
    const entry = makeEntry(userId, {
      type: "rollback",
      amount,
      reason: "生成失败退回",
      refId,
      // 记下退的是哪一笔预扣：以后审计能精确配对，不再依赖猜测
      reserveTxId: rs.id,
      balanceAfter: after
    });
    append(l, userId, entry);
    writeLedger(l);
    return { ok: true, refunded: amount, balance: after, reserveTxId: rs.id };
  });
}

/**
 * 回收「悬空预扣」：预扣了但既没退费也没结算的算力。
 *
 * 什么时候会出现：生成中途进程被杀（关掉应用 / 崩溃 / 强杀），catch 里的 rollback 根本没机会跑。
 * 这时钱就永远卡在预扣里 —— 用户看到的是「失败了，但算力没回来」。
 *
 * 判定：按 refId 配对计数，预扣数 > (退费数 + 结算数) 的差额就是悬空笔数；
 * 只回收早于 olderThanMs 的（正在跑的任务它的预扣当然是"悬空"的，不能动）。
 *
 * @param {{ olderThanMs?: number, now?: number }} [opts]
 */
export function recoverStale({ olderThanMs = 30 * 60 * 1000, now = Date.now() } = {}) {
  return serial(() => {
    const l = readLedger();
    let refunded = 0;
    let count = 0;
    const refs = [];

    for (const userId of Object.keys(l.records || {})) {
      const rows = l.records[userId] || [];
      const byRef = new Map();
      for (const r of rows) {
        if (!r.refId) continue;
        if (!byRef.has(r.refId)) byRef.set(r.refId, { reserves: [], closed: 0 });
        const g = byRef.get(r.refId);
        if (r.type === "reserve") g.reserves.push(r);
        else if (r.type === "rollback" || r.type === "consume") g.closed += 1;
      }
      for (const [refId, g] of byRef) {
        let open = g.reserves.length - g.closed;
        if (open <= 0) continue;
        // 从最早的一笔开始收口（同为"悬空"时，先还老的）
        for (const rs of g.reserves) {
          if (open <= 0) break;
          if (now - Number(rs.ts || 0) < olderThanMs) continue;
          const amount = Math.abs(rs.amount);
          const after = (l.records[userId] || []).reduce((s, r) => s + r.amount, 0) + amount;
          append(
            l,
            userId,
            makeEntry(userId, {
              type: "rollback",
              amount,
              reason: "悬空预扣回收",
              refId,
              reserveTxId: rs.id,
              balanceAfter: after
            })
          );
          open -= 1;
          refunded += amount;
          count += 1;
          refs.push({ userId, refId, reserveTxId: rs.id, amount });
        }
      }
    }

    if (count) writeLedger(l);
    return { ok: true, count, refunded, refs };
  });
}

/** 提交：生成成功，把 reserve 标记为正式消费（账面上不再变动，只补一条语义记录） */
export function commit(userId, action, refId = "") {
  return serial(() => {
    const l = readLedger();
    const rows = l.records[userId] || [];
    const rs = [...rows].reverse().find((r) => r.type === "reserve" && r.refId === refId);
    if (!rs) return { ok: true, skipped: true };

    const entry = makeEntry(userId, {
      type: "consume",
      amount: 0, // 金额已在 reserve 时扣掉，这里只标记完成
      reason: COST_TABLE[action]?.label || action,
      refId,
      balanceAfter: rows.reduce((s, r) => s + r.amount, 0)
    });
    append(l, userId, entry);
    writeLedger(l);
    return { ok: true };
  });
}

/**
 * 查「同一 refId 是否已经正式消费过」。
 * 配合上游签名使用：refId = upstreamSignature(入参)。
 * 缓存被清理但账本里这条已消费过 → 重跑不再扣费（用户确实为这次结果付过一次）。
 */
export function findConsumed(userId, refId) {
  if (!refId) return null;
  const rows = readLedger().records[userId] || [];
  return [...rows].reverse().find((r) => r.type === "consume" && r.refId === refId) || null;
}

// ---------- 充值订单 ----------
function readOrders() {
  return read(ORDERS_FILE, { orders: [] });
}

function writeOrders(o) {
  write(ORDERS_FILE, o);
}

/**
 * 当前生效的套餐：运营后台保存过就用保存的，否则用内置 PLANS。
 * 只做「读」的合并，绝不因为文件损坏就把套餐清空 —— 解析失败一律回退内置。
 */
export function activePlans() {
  const saved = read(PLANS_FILE, null);
  if (Array.isArray(saved?.rows) && saved.rows.length) return saved.rows;
  return PLANS;
}

/** 某套餐（含运营改价后的版本） */
export function getPlan(planId) {
  return activePlans().find((p) => p.id === planId) || null;
}

/**
 * 保存套餐（运营后台）。校验放在这里，接口层只负责传参：
 *  - id 必须是 plan- 开头的小写标识（订单里要长期引用）
 *  - 价格必须 > 0，算力必须 > 0，赠送 >= 0
 *  - 套餐列表不允许为空，否则用户端无货可买
 */
export function savePlans(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("套餐列表不能为空");
  const seen = new Set();
  const clean = rows.map((p, i) => {
    const id = String(p?.id || "").trim();
    if (!/^plan-[a-z0-9-]{1,32}$/.test(id)) throw new Error(`第 ${i + 1} 个套餐 id 不合法（需 plan- 开头）`);
    if (seen.has(id)) throw new Error(`套餐 id 重复：${id}`);
    seen.add(id);
    const creditsN = Math.round(Number(p.credits));
    const bonusN = Math.round(Number(p.bonus) || 0);
    const priceN = Number(p.price);
    if (!Number.isFinite(creditsN) || creditsN <= 0) throw new Error(`套餐 ${id} 的算力必须大于 0`);
    if (!Number.isFinite(bonusN) || bonusN < 0) throw new Error(`套餐 ${id} 的赠送算力不能为负`);
    if (!Number.isFinite(priceN) || priceN <= 0) throw new Error(`套餐 ${id} 的价格必须大于 0`);
    return {
      id,
      credits: creditsN,
      bonus: bonusN,
      price: Number(priceN.toFixed(2)),
      label: String(p.label || "").slice(0, 20) || id,
      hot: Boolean(p.hot)
    };
  });
  write(PLANS_FILE, { rows: clean, updatedAt: Date.now() });
  return listPlans();
}

export function listPlans() {
  return activePlans().map((p) => ({
    ...p,
    total: p.credits + p.bonus,
    perUnit: Number((p.price / (p.credits + p.bonus)).toFixed(4))
  }));
}

/**
 * 创建订单。
 * 注意：这里只创建「待支付」订单，**不直接加算力**。
 * 加算力必须由支付回调触发（见 markPaid），否则用户可以伪造支付请求白嫖。
 */
export function createOrder(userId, planId) {
  const plan = getPlan(planId);
  if (!plan) throw new Error("套餐不存在");

  const order = {
    id: uid("ord"),
    userId,
    planId,
    credits: plan.credits,
    bonus: plan.bonus,
    price: plan.price,
    status: "pending", // pending | paid | cancelled | refunded
    createdAt: Date.now(),
    paidAt: null,
    payMethod: "",
    // 通道（wechat / alipay / aggregator / manual / sandbox）：财务统计按它分组
    channel: "",
    // 退款信息：退款是「钱退回 + 算力扣回」两件事，两者都要留痕
    refund: null
  };
  const o = readOrders();
  o.orders.push(order);
  writeOrders(o);
  return order;
}

/** 按订单号查（不限用户）—— 支付回调里用，回调没有用户上下文 */
export function findOrder(orderId) {
  return readOrders().orders.find((o) => o.id === orderId) || null;
}

export function listOrders(userId) {
  return readOrders()
    .orders.filter((o) => o.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 标记已支付并发算力。
 * ⚠️ 真实项目里这个方法**只能被支付网关的回调调用**（需验签），
 *    绝不能暴露成用户可调的接口。
 */
export async function markPaid(orderId, payMethod = "manual") {
  const o = readOrders();
  const order = o.orders.find((x) => x.id === orderId);
  if (!order) throw new Error("订单不存在");
  if (order.status === "paid") return { ok: true, already: true, order }; // 幂等
  if (order.status === "refunded") throw new Error("已退款订单不能再次入账");
  if (order.status === "cancelled") throw new Error("已取消订单不能入账");

  order.status = "paid";
  order.paidAt = Date.now();
  order.payMethod = payMethod;
  order.channel = payMethod;
  writeOrders(o);

  const total = order.credits + order.bonus;
  const r = await grant(
    order.userId,
    total,
    `充值 ${order.planId}${order.bonus ? `（含赠送 ${order.bonus}）` : ""}`,
    order.id
  );
  return { ok: true, order, balance: r.balance };
}

export function cancelOrder(userId, orderId) {
  const o = readOrders();
  const order = o.orders.find((x) => x.id === orderId && x.userId === userId);
  if (!order) throw new Error("订单不存在");
  if (order.status === "paid") throw new Error("已支付订单不可取消");
  if (order.status === "refunded") throw new Error("已退款订单不可取消");
  order.status = "cancelled";
  writeOrders(o);
  return order;
}

// ---------- 运营后台：订单查询 / 人工补单 / 退款 ----------

/**
 * 过期关单：仅 pending 可过期。
 * 自动任务每天扫一遍，别让「待支付」订单永远挂在列表里污染财务统计。
 */
export function expireOrder(orderId, now = Date.now()) {
  const o = readOrders();
  const order = o.orders.find((x) => x.id === orderId);
  if (!order) return { ok: false, reason: "订单不存在" };
  if (order.status !== "pending") return { ok: false, reason: "非待支付订单" };
  order.status = "expired";
  order.expiredAt = now;
  writeOrders(o);
  return { ok: true, order };
}

/** 全量订单（运营后台用，不分用户），最新在前 */
export function listAllOrders() {
  return readOrders()
    .orders.slice()
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 按订单号取（支付回调 / 补单 / 退款共用） */
export function getOrder(orderId) {
  return findOrder(orderId);
}

/** 给订单补一条运营备注（补单原因、沟通结论等），只改订单不动账 */
export function noteOrder(orderId, note, actor = "-") {
  const o = readOrders();
  const order = o.orders.find((x) => x.id === orderId);
  if (!order) throw new Error("订单不存在");
  order.notes = Array.isArray(order.notes) ? order.notes : [];
  order.notes.push({ note: String(note || "").slice(0, 200), actor, at: Date.now() });
  writeOrders(o);
  return order;
}

/**
 * 退款：钱退回（由支付通道线下/原路完成）+ 算力扣回（这里必须真的扣）。
 *
 * 为什么扣回要卡余额：充值送出的算力用户可能已经花掉了。
 * 余额不够还扣，账面直接变负数，等于把「用户已消费的服务」变成负债却没人知道。
 * 宁可拒绝并提示运营先走人工调账，也不制造看不见的负余额。
 *
 * @param {string} orderId
 * @param {{ reason?: string, actor?: string }} [opts]
 */
export function refundOrder(orderId, { reason = "", actor = "-" } = {}) {
  const o = readOrders();
  const order = o.orders.find((x) => x.id === orderId);
  if (!order) throw new Error("订单不存在");
  if (order.status !== "paid") throw new Error("只有已支付订单可以退款");
  if (order.refund) throw new Error("该订单已退款");

  const total = order.credits + order.bonus;
  return serial(() => {
    const ledger = readLedger();
    const current = (ledger.records[order.userId] || []).reduce((s, r) => s + r.amount, 0);
    if (current < total) {
      throw new Error(
        `用户余额不足，无法扣回已发放的 ${total} 算力（当前 ${current}）。请先人工调账或与客户确认后再退。`
      );
    }
    const after = current - total;
    append(
      ledger,
      order.userId,
      makeEntry(order.userId, {
        type: "refund",
        amount: -total,
        reason: `充值退款扣回（${reason || "运营操作"}）`,
        refId: order.id,
        balanceAfter: after
      })
    );
    writeLedger(ledger);

    order.status = "refunded";
    order.refund = {
      amount: order.price,
      credits: total,
      reason: String(reason || "").slice(0, 200),
      actor,
      at: Date.now()
    };
    writeOrders(o);
    return { ok: true, order, balance: after, deducted: total };
  });
}

/**
 * 人工调账：正数补额度，负数扣额度。
 * 负数必须保证扣完不为负 —— 否则「运营手滑多扣」会变成用户余额负数。
 */
export function adjust(userId, amount, reason, actor = "-") {
  const delta = Math.round(Number(amount) || 0);
  if (!Number.isFinite(delta) || delta === 0) throw new Error("调账金额必须是非零整数");
  const current = balance(userId);

  return serial(() => {
    const l = readLedger();
    const rows = l.records[userId] || [];
    const cur = rows.reduce((s, r) => s + r.amount, 0);
    if (delta < 0 && cur + delta < 0) {
      throw new Error(`调账后余额会变成负数（当前 ${cur}，扣 ${Math.abs(delta)}），请先核对`);
    }
    const after = cur + delta;
    const entry = makeEntry(userId, {
      type: "grant",
      amount: delta,
      reason: `人工调账：${String(reason || "运营操作").slice(0, 120)}（${actor}）`,
      refId: "",
      balanceAfter: after
    });
    append(l, userId, entry);
    writeLedger(l);
    return { ok: true, balance: after, delta, entry };
  });
}

// ---------- 新用户赠送 ----------
export function ensureSignupGrant(userId) {
  return serial(() => {
    const l = readLedger();
    const rows = l.records[userId] || [];
    if (rows.some((r) => r.type === "grant" && r.reason === "新用户赠送")) {
      return { ok: true, skipped: true };
    }
    const after = rows.reduce((s, r) => s + r.amount, 0) + SIGNUP_GRANT;
    const entry = makeEntry(userId, {
      type: "grant",
      amount: SIGNUP_GRANT,
      reason: "新用户赠送",
      balanceAfter: after
    });
    append(l, userId, entry);
    writeLedger(l);
    return { ok: true, granted: SIGNUP_GRANT, balance: after };
  });
}

/** 对账：余额必须等于流水求和，返回不一致的用户 */
export function reconcile() {
  const l = readLedger();
  const bad = [];
  for (const [userId, rows] of Object.entries(l.records)) {
    const sum = rows.reduce((s, r) => s + r.amount, 0);
    const last = rows[rows.length - 1];
    if (last && last.balanceAfter !== sum) {
      bad.push({ userId, sum, recorded: last.balanceAfter });
    }
  }
  return { ok: bad.length === 0, mismatched: bad };
}
