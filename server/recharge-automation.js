// 充值订单自动管理：过期关单 + 主动查单补单
//
// 为什么单独一个模块：
//  1. 这两件事是「无用户上下文」的后台动作，不该散落在 index.js 的启动代码里；
//  2. 查单补单必须走 payment-aggregator（可能尚未部署），所以用**动态 import**：
//     模块不存在时只是本轮跳过并记一条错误，绝不能让整个服务起不来；
//  3. 配置要能在运营后台改（落 recharge-automation.json），改完下一轮生效，
//     不用重启进程。
//
// 定时器每 60s 一轮，unref 掉 —— 不因为它让 Node 进程无法退出。
// 测试 / 多实例环境用 AI_CANVAS_DISABLE_AUTOMATION=1 关闭自动执行。
import fs from "node:fs";
import { dataFile, HOME } from "./paths.js";
import * as credits from "./credits.js";
import * as audit from "./audit.js";

const CONFIG_FILE = dataFile("recharge-automation.json");

// 默认值：120 分钟未支付的订单自动过期；上线 3 分钟内的订单参与查单；
// 每轮最多查 20 单（避免对聚合支付网关造成瞬时压力）。
const DEFAULTS = { enabled: true, expireMinutes: 120, syncAfterSec: 180, syncBatch: 20 };

// 配置合法区间（与接口契约第 2 节一致，接口层不再重复校验）
const RANGES = {
  expireMinutes: [5, 1440],
  syncAfterSec: [30, 3600],
  syncBatch: [1, 100]
};

const INTERVAL_MS = 60 * 1000;
// 单轮错误最多留 20 条，避免报告文件无限膨胀
const MAX_ERRORS = 20;

let timer = null;
let running = false;

// ---------- 配置文件读写 ----------
function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    // 文件不存在 / 损坏：一律回退默认值，绝不让自动任务因为一个坏 JSON 停摆
    return {};
  }
}

function writeFile(data) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}

function toIntIn(raw, fallback, [min, max]) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 读配置（永远返回一份完整、已夹紧到合法区间的对象） */
export function getConfig() {
  const raw = readFile();
  return {
    enabled: raw.enabled === undefined ? DEFAULTS.enabled : Boolean(raw.enabled),
    expireMinutes: toIntIn(raw.expireMinutes, DEFAULTS.expireMinutes, RANGES.expireMinutes),
    syncAfterSec: toIntIn(raw.syncAfterSec, DEFAULTS.syncAfterSec, RANGES.syncAfterSec),
    syncBatch: toIntIn(raw.syncBatch, DEFAULTS.syncBatch, RANGES.syncBatch),
    updatedAt: Number(raw.updatedAt) || 0
  };
}

/** 上一轮执行报告（GET /api/admin/recharge/automation 用） */
export function getLastReport() {
  const raw = readFile();
  return raw.lastReport && typeof raw.lastReport === "object" && !Array.isArray(raw.lastReport)
    ? raw.lastReport
    : null;
}

/**
 * 保存配置（部分更新，未传的字段保持不变）。
 *
 * 校验放在这里而不是接口层：定时器自己也会读这份配置，
 * 任何写入路径都必须经过同一套夹紧逻辑，否则后台能存进非法值把定时器带崩。
 * 写文件时保留 lastReport，避免改配置把执行报告冲掉。
 */
export function saveConfig(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("配置必须是对象");
  }
  const next = { ...getConfig() };

  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    const v = patch.enabled;
    if (typeof v !== "boolean" && v !== 0 && v !== 1) throw new Error("enabled 必须是布尔值");
    next.enabled = Boolean(v);
  }

  for (const [key, range] of Object.entries(RANGES)) {
    const v = patch[key];
    // 空字符串 / null 视为「不修改」（表单清空时常见），不要据此报错
    if (v === undefined || v === null || v === "") continue;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) throw new Error(`${key} 必须是数字`);
    if (n < range[0] || n > range[1]) throw new Error(`${key} 需在 ${range[0]}~${range[1]} 之间`);
    next[key] = n;
  }

  const out = { ...next, updatedAt: Date.now(), lastReport: readFile().lastReport ?? null };
  writeFile(out);
  return getConfig();
}

/** 持久化本轮报告（只改 lastReport，不动配置字段） */
function saveLastReport(report) {
  try {
    const cur = readFile();
    cur.lastReport = report;
    writeFile(cur);
  } catch (err) {
    // 报告写失败不影响本轮结果：内存里已经算过，接口层也能拿到返回值
    console.warn("[recharge-automation] 执行报告写入失败:", err?.message || err);
  }
}

/**
 * 执行一轮自动管理：过期关单 → 查单补单 → 写报告。
 *
 * 返回值固定为 { at, expired, synced, paid, errors }：
 *  - at       本轮开始时间戳
 *  - expired  被置为 expired 的订单数
 *  - synced   成功拿到查单结果的订单数（含「仍未支付」）
 *  - paid     查单确认已支付并完成入账（markPaid）的订单数
 *  - errors   本轮错误（字符串数组，已截断）
 *
 * 设计原则：**任何单笔订单失败都不中断整轮**，全部计入 errors。
 */
export async function runOnce({ source = "manual", actor = "system" } = {}) {
  const cfg = getConfig();
  const startedAt = Date.now();
  const report = { at: startedAt, expired: 0, synced: 0, paid: 0, errors: [] };
  const pushError = (msg) => {
    if (report.errors.length < MAX_ERRORS) report.errors.push(String(msg).slice(0, 200));
  };

  // ---------- 第一段：过期关单 ----------
  // 只处理 pending 且创建时间早于 expireMinutes 的订单。
  // 先拿一份快照再逐单 expireOrder；expireOrder 内部只动 pending，重复调用无副作用。
  const expireBefore = startedAt - cfg.expireMinutes * 60 * 1000;
  let snapshot = [];
  try {
    snapshot = credits.listAllOrders();
  } catch (err) {
    pushError(`读取订单失败：${err?.message || err}`);
  }
  for (const order of snapshot) {
    if (order.status !== "pending") continue;
    if (!(Number(order.createdAt) <= expireBefore)) continue;
    try {
      const r = credits.expireOrder(order.id, startedAt);
      if (r.ok) report.expired += 1;
    } catch (err) {
      pushError(`订单 ${order.id} 过期失败：${err?.message || err}`);
    }
  }

  // ---------- 第二段：主动查单补单 ----------
  // 候选：仍在 pending、且在最近 syncAfterSec 内创建。
  // 通道过滤口径：只查「空通道」和「aggregator」。
  //   为什么允许空通道：现有下单链路（index.js 的 /api/recharge/orders）不写 channel，
  //   channel 只在 markPaid 时才落；若这里强制要求通道信息，候选集会永远是空的，
  //   自动查单就成了摆设。空通道按「可能是聚合支付」尽力查一次，查不到不影响订单。
  //   为什么排除 wechat/alipay 等明确通道：这些单要走各自网关的查单，聚合支付查不了，
  //   查了只会白白产生错误噪音（单笔失败会计入 errors）。
  const syncSince = startedAt - cfg.syncAfterSec * 1000;
  let candidates = [];
  try {
    candidates = credits
      .listAllOrders()
      .filter((o) => {
        if (o.status !== "pending") return false;
        if (!(Number(o.createdAt) >= syncSince)) return false;
        const channel = String(o.channel || o.payMethod || "").toLowerCase();
        return channel === "" || channel === "aggregator";
      })
      .slice(0, cfg.syncBatch);
  } catch (err) {
    pushError(`筛选待查单订单失败：${err?.message || err}`);
  }

  if (candidates.length) {
    // 动态 import：payment-aggregator.js 由支付通道开发并行维护，可能还不存在。
    // 这里失败只代表「本轮无法查单」，绝不能让定时器抛异常 / 服务崩溃。
    let agg = null;
    try {
      agg = await import("./payment-aggregator.js");
    } catch {
      agg = null;
    }

    if (!agg || typeof agg.queryOrder !== "function") {
      pushError("聚合支付未配置，跳过自动查单");
    } else {
      // isConfigured 可选：模块没提供就默认已配置（queryOrder 会自己报错）
      let configured = true;
      try {
        configured = typeof agg.isConfigured === "function" ? Boolean(agg.isConfigured()) : true;
      } catch {
        configured = false;
      }

      if (!configured) {
        pushError("聚合支付未配置，跳过自动查单");
      } else {
        for (const order of candidates) {
          try {
            const res = await agg.queryOrder(order.id);
            if (!res || typeof res !== "object") {
              pushError(`订单 ${order.id} 查单无结果`);
              continue;
            }
            report.synced += 1;
            if (!res.paid) continue;

            // 金额校验：查单金额（分）必须与订单金额一致，防「低价订单冒充高价」
            const expectCents = Math.round(Number(order.price) * 100);
            const gotCents = Number(res.amount);
            if (Number.isFinite(gotCents) && gotCents > 0 && gotCents !== expectCents) {
              pushError(`订单 ${order.id} 金额不匹配（期望 ${expectCents} 分，实际 ${gotCents} 分）`);
              continue;
            }

            // 查单期间回调可能已经到了：以最新订单状态复核，避免重复入账
            const fresh = credits.getOrder(order.id);
            if (!fresh || fresh.status !== "pending") continue;

            await credits.markPaid(order.id, "aggregator");
            report.paid += 1;
            audit.record(
              "admin.action",
              {
                action: "recharge.order.sync_paid",
                order: order.id,
                userId: order.userId,
                price: order.price,
                tradeNo: res.tradeNo || "",
                source
              },
              { username: actor }
            );
          } catch (err) {
            pushError(`订单 ${order.id} 查单失败：${err?.message || err}`);
          }
        }
      }
    }
  }

  // 定时任务没有用户上下文，用 system 身份留痕；手动触发的审计由接口层写，避免重复
  if (source === "timer" && (report.expired > 0 || report.paid > 0)) {
    audit.record(
      "admin.action",
      {
        action: "recharge.automation.run",
        source,
        expired: report.expired,
        synced: report.synced,
        paid: report.paid,
        errors: report.errors.length
      },
      { username: "system" }
    );
  }

  saveLastReport(report);
  return report;
}

// ---------- 定时器 ----------

/** 一轮定时任务（带重入保护：上一轮没跑完就跳过本轮） */
async function tick() {
  if (running) return;
  running = true;
  try {
    const cfg = getConfig();
    if (!cfg.enabled) return; // 后台关闭自动执行时只保留定时器，不做任何写操作
    await runOnce({ source: "timer", actor: "system" });
  } catch (err) {
    // 定时器里的异常必须自己吞掉，否则会变成 unhandledRejection
    console.warn("[recharge-automation] 自动任务异常:", err?.message || err);
  } finally {
    running = false;
  }
}

/**
 * 启动自动管理（index.js 在 listen 之后调用）。
 * @returns {{started:boolean, intervalMs?:number, reason?:string}}
 */
export function startAutomation({ intervalMs = INTERVAL_MS } = {}) {
  // 测试环境 / 多实例部署：环境变量直接关掉，连定时器都不建
  if (process.env.AI_CANVAS_DISABLE_AUTOMATION === "1") {
    return { started: false, reason: "disabled_by_env" };
  }
  if (timer) return { started: false, reason: "already_started" };

  const ms = Math.max(5000, Math.round(Number(intervalMs)) || INTERVAL_MS);
  timer = setInterval(() => {
    void tick();
  }, ms);
  // 不让定时器阻止 Node 退出（Electron 退出 / 测试结束很关键）
  if (typeof timer.unref === "function") timer.unref();
  return { started: true, intervalMs: ms };
}

/** 停止自动管理（退出前 / 测试收尾用） */
export function stopAutomation() {
  const wasRunning = Boolean(timer);
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  return { stopped: wasRunning };
}

/** 定时器是否在跑（健康检查用） */
export function isAutomationStarted() {
  return Boolean(timer);
}
