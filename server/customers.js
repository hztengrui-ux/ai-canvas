// 客户中心接口：客户列表 / 元数据 / 详情 / 档案维护 / 人工调账
//
// 设计要点：
//  1. 「账号」是事实来源（accounts.js），「档案」只是扩展属性（customer-profiles.json），
//     两者用 userId 关联；档案里绝不复制账号字段，避免改名后两处不一致。
//  2. 金额 / 算力一律走 credits.js 的导出（订单、流水、调账），本模块不直接读账本 JSON，
//     避免出现「运营后台算出来和用户端对不上」的对账事故。
//  3. 行级数据权限与 admin.js 完全同口径（all/dept/self/custom，r-super 直通）：
//     客户列表本质就是账号列表 + 消费聚合，权限模型不该在这里分叉。
//  4. 路由顺序：/meta 必须注册在 /:id 之前，否则 "meta" 会被当成客户 id。
import fs from "node:fs";
import * as accounts from "./accounts.js";
import * as credits from "./credits.js";
import * as rbac from "./rbac.js";
import * as audit from "./audit.js";
import { dataFile, HOME as DIR } from "./paths.js";

// 档案落盘：{ [userId]: { realName, company, wechat, level, tags, source, remark, region, updatedAt, updatedBy } }
const PROFILES_FILE = dataFile("customer-profiles.json");

// 等级白名单：值要稳定（前端筛选、接口入参都按它），标签可随时改文案
export const LEVELS = [
  { value: "normal", label: "普通客户" },
  { value: "vip", label: "VIP" },
  { value: "svip", label: "SVIP" },
  { value: "agent", label: "代理商" }
];
const LEVEL_VALUES = new Set(LEVELS.map((l) => l.value));
const LEVEL_LABEL = Object.fromEntries(LEVELS.map((l) => [l.value, l.label]));

// 来源默认选项。档案里若已存在自定义来源，meta 会追加进去（去重），
// 保证历史数据不会因为「选项被删掉」而在前端显示成空白。
const DEFAULT_SOURCES = ["官网", "小程序", "线下推广", "客户转介绍", "广告投放", "其他"];

// 档案文本字段与长度上限（单位：字符）
const TEXT_FIELDS = {
  realName: { max: 40, label: "真实姓名" },
  company: { max: 60, label: "公司" },
  wechat: { max: 40, label: "微信" },
  source: { max: 40, label: "来源" },
  remark: { max: 200, label: "备注" },
  region: { max: 40, label: "地区" }
};

const MAX_TAGS = 20;
const MAX_TAG_LEN = 20;

// ---------- 档案存储 ----------
function readProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
    return {};
  } catch {
    // 没有文件 / 文件损坏都按「无档案」处理：档案只是扩展属性，坏了不能影响客户列表
    return {};
  }
}

function writeProfiles(map) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(map, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
}

/** 取某个客户的档案（缺失字段补默认值，脏数据不抛错） */
function profileOf(profiles, userId) {
  const p = profiles[userId] || {};
  return {
    realName: String(p.realName || ""),
    company: String(p.company || ""),
    wechat: String(p.wechat || ""),
    level: LEVEL_VALUES.has(p.level) ? p.level : "normal",
    tags: Array.isArray(p.tags) ? p.tags.map(String).slice(0, MAX_TAGS) : [],
    source: String(p.source || ""),
    remark: String(p.remark || ""),
    region: String(p.region || ""),
    updatedAt: Number(p.updatedAt) || 0,
    updatedBy: String(p.updatedBy || "")
  };
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 校验并清洗 PUT 档案入参。
 * 只接受契约里的 8 个字段；账号字段（username/status/roleIds/密码）一律不认，
 * 从根上杜绝「借档案接口改账号权限」。
 */
function sanitizeProfilePatch(body) {
  if (!body || typeof body !== "object") throw new Error("请求体不合法");
  const patch = {};

  for (const [key, meta] of Object.entries(TEXT_FIELDS)) {
    if (!has(body, key)) continue;
    const val = String(body[key] ?? "").trim();
    if (val.length > meta.max) throw new Error(`${meta.label}最多 ${meta.max} 个字符`);
    patch[key] = val;
  }

  if (has(body, "level")) {
    const level = String(body.level ?? "").trim() || "normal";
    if (!LEVEL_VALUES.has(level)) {
      throw new Error("客户等级不合法（可选：normal / vip / svip / agent）");
    }
    patch.level = level;
  }

  if (has(body, "tags")) {
    if (!Array.isArray(body.tags)) throw new Error("标签必须是数组");
    const tags = [];
    for (const raw of body.tags) {
      const tag = String(raw ?? "").trim();
      if (!tag) continue;
      if (tag.length > MAX_TAG_LEN) {
        throw new Error(`标签「${tag.slice(0, 10)}…」超过 ${MAX_TAG_LEN} 个字符`);
      }
      // 去重：同一标签重复提交只保留一个（前端多选组件偶尔会重复）
      if (!tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > MAX_TAGS) throw new Error(`标签最多 ${MAX_TAGS} 个`);
    patch.tags = tags;
  }

  if (!Object.keys(patch).length) throw new Error("没有可更新的档案字段");
  return patch;
}

// ---------- 订单 / 流水聚合 ----------
function emptyOrderAgg() {
  return { orderCount: 0, paidOrderCount: 0, totalPaid: 0, refundAmount: 0, lastPaidAt: null };
}

/**
 * 单用户订单聚合。
 * - totalPaid：status==="paid" 的订单价格之和（契约口径）
 * - refundAmount：已退款订单的实际退款额
 * - lastPaidAt：最近一次「付过款」的时间；已退款订单也付过款，算
 * - orderCount：全部订单（含 pending / cancelled / expired / refunded）
 */
function aggregateOf(orders) {
  const agg = emptyOrderAgg();
  for (const order of orders || []) {
    agg.orderCount += 1;
    if (order.status === "paid") {
      agg.paidOrderCount += 1;
      agg.totalPaid += Number(order.price) || 0;
    }
    if (order.refund && Number(order.refund.amount)) {
      agg.refundAmount += Number(order.refund.amount);
    }
    if (order.paidAt) {
      const at = Number(order.paidAt) || 0;
      if (at > (agg.lastPaidAt || 0)) agg.lastPaidAt = at;
    }
  }
  return agg;
}

/** 全量订单按用户聚合（一次 listAllOrders，避免 N 次读文件） */
function aggregateAllOrders() {
  const byUser = new Map();
  for (const order of credits.listAllOrders()) {
    const id = order.userId;
    if (!id) continue;
    let agg = byUser.get(id);
    if (!agg) {
      agg = emptyOrderAgg();
      byUser.set(id, agg);
    }
    agg.orderCount += 1;
    if (order.status === "paid") {
      agg.paidOrderCount += 1;
      agg.totalPaid += Number(order.price) || 0;
    }
    if (order.refund && Number(order.refund.amount)) {
      agg.refundAmount += Number(order.refund.amount);
    }
    if (order.paidAt) {
      const at = Number(order.paidAt) || 0;
      if (at > (agg.lastPaidAt || 0)) agg.lastPaidAt = at;
    }
  }
  return byUser;
}

/**
 * 算力聚合：余额与累计消耗都从流水推导，不读账本文件、不自己算账。
 * 契约要求 totalSpent = reserve 流水绝对值求和（reserve 是负数，取绝对值）。
 * 注意 records 的 limit 传最大安全整数 = 取全量流水；余额等于全量流水求和（credits 的不变式）。
 */
function ledgerOf(userId) {
  const rows = credits.records(userId, { limit: Number.MAX_SAFE_INTEGER });
  let balance = 0;
  let totalSpent = 0;
  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    balance += amount;
    if (r.type === "reserve") totalSpent += Math.abs(amount);
  }
  return { rows, balance, totalSpent };
}

function round2(v) {
  return Number((Number(v) || 0).toFixed(2));
}

/** 组装列表行 / 详情基座（字段严格按契约第 1 节） */
function buildRow(user, profile, agg, ledger) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname || user.username,
    email: user.email || "",
    phone: user.phone || "",
    status: user.status || "active",
    deptId: user.deptId || "",
    deptName: user.deptName || "",
    roleNames: user.roleNames || [],
    realName: profile.realName,
    company: profile.company,
    wechat: profile.wechat,
    level: profile.level,
    levelLabel: LEVEL_LABEL[profile.level] || profile.level,
    tags: profile.tags,
    source: profile.source,
    remark: profile.remark,
    region: profile.region,
    balance: ledger.balance,
    totalPaid: round2(agg.totalPaid),
    refundAmount: round2(agg.refundAmount),
    totalSpent: ledger.totalSpent,
    orderCount: agg.orderCount,
    paidOrderCount: agg.paidOrderCount,
    lastPaidAt: agg.lastPaidAt || null,
    createdAt: user.createdAt || "",
    lastLoginAt: user.lastLoginAt || ""
  };
}

// ---------- 行级数据权限 ----------
// 与 admin.js 的 applyDataScope 等价（admin.js 不对外导出，这里复制一份语义，
// 不改 admin.js）。改规则时两处都要改，口径必须一致。
function applyDataScope(rows, user) {
  if (!user) return [];
  if ((user.roleIds || []).includes("r-super") || user.dataScope === "all") return rows;

  if (user.dataScope === "self") {
    return rows.filter((r) => r.id === user.id);
  }
  if (user.dataScope === "dept") {
    const scope = new Set(rbac.deptSubtree(user.deptId));
    return rows.filter((r) => r.id === user.id || scope.has(r.deptId));
  }
  if (user.dataScope === "custom") {
    const scope = new Set(user.customDeptIds || []);
    return rows.filter((r) => r.id === user.id || scope.has(r.deptId));
  }
  return rows;
}

// ---------- 工具 ----------
function ctx(req, user) {
  return {
    username: user?.username || "-",
    ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim(),
    ua: req.headers["user-agent"] || ""
  };
}

function httpError(message, status = 400, code = "") {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function parsePage(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize, 10) || 20));
  return { page, pageSize };
}

/** 按 lastPaidAt 倒序；无支付记录的排后面，同时间按创建时间倒序兜底（保证分页稳定） */
function compareRows(a, b) {
  const ap = a.lastPaidAt || 0;
  const bp = b.lastPaidAt || 0;
  if (bp !== ap) return bp - ap;
  return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
}

/** 档案字段变更摘要（审计用；长文本截断，避免审计日志被大段备注撑爆） */
function diffProfile(before, after, keys) {
  const changes = {};
  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    const same = Array.isArray(from)
      ? Array.isArray(to) && from.length === to.length && from.every((v, i) => v === to[i])
      : from === to;
    if (same) continue;
    const brief = (v) => {
      const s = Array.isArray(v) ? v.join("、") : String(v ?? "");
      return s.length > 60 ? `${s.slice(0, 60)}…` : s;
    };
    changes[key] = { from: brief(from), to: brief(to) };
  }
  return changes;
}

// ---------- 路由挂载 ----------
export function mountCustomers(app, { requirePerm, requireLogin } = {}) {
  // 统一的响应包装：兼容同步 / 异步，异常按契约回 400 {error} 或 403 {error, code}
  const wrap = (fn) => (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((out) => {
        if (out !== undefined && !res.headersSent) res.json(out);
      })
      .catch((err) => {
        if (res.headersSent) return;
        const status = Number(err?.status) || 400;
        const body = { error: err?.message || "操作失败" };
        if (err?.code) body.code = err.code;
        res.status(status).json(body);
      });
  };

  const log = (req, action, detail = {}) =>
    audit.record("admin.action", { action, ...detail }, ctx(req, req.user));

  // 取客户并校验行级数据范围：不存在 400，越权 403（防 IDOR）
  const requireCustomer = (id, actor) => {
    const user = accounts.getUser(String(id || ""));
    if (!user) throw httpError("客户不存在");
    if (!applyDataScope([user], actor).length) {
      throw httpError("无权访问该客户", 403, "FORBIDDEN");
    }
    return user;
  };

  // ---------- 客户列表 ----------
  // 注意：本路由必须注册在 "/:id" 之前（否则 "meta" 会被当成 id）
  app.get(
    "/api/admin/customers",
    requireLogin,
    requirePerm("admin:customer:view"),
    wrap((req) => {
      const { keyword = "", status = "", level = "" } = req.query;
      const { page, pageSize } = parsePage(req.query);
      const profiles = readProfiles();

      // 先做行级数据权限，再做业务筛选（与 admin.js 的顺序一致）
      let users = applyDataScope(accounts.listUsersFull(), req.user);

      const kw = String(keyword).trim().toLowerCase();
      if (kw) {
        users = users.filter((u) => {
          const p = profileOf(profiles, u.id);
          return [u.username, u.nickname, u.email, u.phone, p.realName, p.company, p.wechat]
            .map((v) => String(v || "").toLowerCase())
            .some((v) => v.includes(kw));
        });
      }
      if (status) users = users.filter((u) => u.status === status);

      const lv = String(level).trim();
      if (lv) users = users.filter((u) => profileOf(profiles, u.id).level === lv);

      // 全量订单只读一次；行的聚合先算出来，再排序分页
      const orderAgg = aggregateAllOrders();
      const merged = users.map((u) => {
        const profile = profileOf(profiles, u.id);
        const agg = orderAgg.get(u.id) || emptyOrderAgg();
        return { user: u, profile, agg, lastPaidAt: agg.lastPaidAt };
      });
      merged.sort(compareRows);

      const total = merged.length;
      const start = (page - 1) * pageSize;
      const pageItems = merged.slice(start, start + pageSize);

      // 算力聚合只对当前页计算（每行一次流水读取），避免列表整表扫账本
      const rows = pageItems.map(({ user, profile, agg }) =>
        buildRow(user, profile, agg, ledgerOf(user.id))
      );

      return { rows, total, page, pageSize };
    })
  );

  // ---------- 客户元数据（等级 / 来源） ----------
  app.get(
    "/api/admin/customers/meta",
    requireLogin,
    requirePerm("admin:customer:view"),
    wrap(() => {
      // 历史档案里的自定义来源追加到选项里，避免旧数据变成空白选项
      const profiles = readProfiles();
      const extra = new Set();
      for (const p of Object.values(profiles)) {
        const source = String(p?.source || "").trim();
        if (source) extra.add(source);
      }
      const sources = [...DEFAULT_SOURCES];
      for (const source of extra) if (!sources.includes(source)) sources.push(source);
      return { levels: LEVELS, sources };
    })
  );

  // ---------- 客户详情 ----------
  app.get(
    "/api/admin/customers/:id",
    requireLogin,
    requirePerm("admin:customer:view"),
    wrap((req) => {
      const user = requireCustomer(req.params.id, req.user);
      const profiles = readProfiles();
      const profile = profileOf(profiles, user.id);

      // 订单字段按契约第 2 节，补上账号名便于前端直接展示
      const orders = credits.listOrders(user.id).map((order) => ({
        ...order,
        username: user.username,
        nickname: user.nickname || user.username
      }));
      const agg = aggregateOf(orders);
      const ledger = ledgerOf(user.id);

      const row = buildRow(user, profile, agg, ledger);
      return {
        customer: {
          ...row,
          orders,
          // 最近 50 条算力流水（records 已是「最新在前」）
          records: ledger.rows.slice(0, 50),
          stats: {
            totalPaid: row.totalPaid,
            refundAmount: row.refundAmount,
            totalSpent: row.totalSpent,
            balance: row.balance,
            orderCount: row.orderCount
          }
        },
        profile
      };
    })
  );

  // ---------- 更新客户档案（只改档案，不动账号） ----------
  app.put(
    "/api/admin/customers/:id",
    requireLogin,
    requirePerm("admin:customer:edit"),
    wrap((req) => {
      const user = requireCustomer(req.params.id, req.user);
      const patch = sanitizeProfilePatch(req.body || {});

      const profiles = readProfiles();
      const before = profileOf(profiles, user.id);
      const next = {
        ...before,
        ...patch,
        updatedAt: Date.now(),
        updatedBy: req.user?.username || "-"
      };
      profiles[user.id] = next;
      writeProfiles(profiles);

      // 审计：记录改了哪些字段的 from→to（长文本已截断）
      log(req, "customer.profile.update", {
        target: user.username,
        userId: user.id,
        changes: diffProfile(before, next, Object.keys(patch))
      });

      const agg = aggregateOf(credits.listOrders(user.id));
      return { ok: true, customer: buildRow(user, next, agg, ledgerOf(user.id)) };
    })
  );

  // ---------- 人工调账（算力增减） ----------
  app.post(
    "/api/admin/customers/:id/adjust",
    requireLogin,
    requirePerm("admin:customer:edit"),
    wrap(async (req) => {
      const user = requireCustomer(req.params.id, req.user);
      const body = req.body || {};

      // amount 必须是整数（算力是整数点），可正可负但不能为 0
      const amount = Number(body.amount);
      if (!Number.isInteger(amount) || amount === 0) {
        throw new Error("调账金额必须是非零整数");
      }
      const reason = String(body.reason ?? "").trim();
      if (!reason) throw new Error("请填写调账原因");
      if (reason.length > 120) throw new Error("调账原因最多 120 个字符");

      const actor = req.user?.username || "-";
      // 真正的账务变更交给 credits.adjust：它负责负数不把余额扣成负数的校验
      const out = await credits.adjust(user.id, amount, reason, actor);

      log(req, "customer.credits.adjust", {
        target: user.username,
        userId: user.id,
        amount: out.delta,
        reason,
        balance: out.balance
      });

      return { ok: true, balance: out.balance, delta: out.delta };
    })
  );
}
