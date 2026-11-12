// 批量任务进度「落盘」
//
// 为什么是磁盘文件而不是服务端编排器：
//   参考 SynMew 的做法 —— 10 张变体 = 客户端把 10 拆成 3 批（4+4+2）顺序调用，
//   每批成功就把结果写进进度文件。服务端保持无状态，不用维护任务队列、
//   不用管 WebSocket 重连、崩溃后也不用恢复编排。
//   代价：进度由客户端驱动；换来的是服务端代码量为 0 与可断点续跑。
//
// 断点续跑：中途关掉应用 → 重开时按 batchId 读回进度文件，
//   已成功的批次直接复用结果，只对未完成的批次重新扣费生成。
import fs from "node:fs";
import path from "node:path";
import { dataFile, HOME as DIR } from "./paths.js";

const ROOT = dataFile("batches");

function ensure() {
  fs.mkdirSync(ROOT, { recursive: true });
  return ROOT;
}

function fileOf(id) {
  return path.join(ensure(), `${safeId(id)}.json`);
}

/** 只允许 [A-Za-z0-9_-]，挡住 ../ 之类的路径穿越 */
function safeId(id) {
  const s = String(id || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!s || s.length > 64) throw new Error("batchId 不合法");
  return s;
}

function read(id) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), "utf8"));
  } catch {
    return null;
  }
}

function write(id, data) {
  ensure();
  fs.writeFileSync(fileOf(id), JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  return data;
}

/**
 * 创建进度文件。
 * @param {object} o { id, total, perBatch, label, payload }
 * payload 是生成参数快照，续跑时直接用，避免用户中途改了提示词导致前后不一致。
 */
export function create({ id, total = 1, perBatch = 4, label = "", payload = null, idempotencyKey = "" }) {
  safeId(id);
  // 幂等：同一个幂等键重复 create（用户连点两次「开始批量」、客户端超时重试、
  // 断点续跑时重新发起）不再新建任务，直接返回既有进度文件。
  // 否则会出现两份进度、两条扣费链路，结果与账本对不上。
  const key = String(idempotencyKey || "").trim();
  if (key) {
    const existing = findByIdempotencyKey(key);
    if (existing) return existing;
  }
  const totalN = Math.max(1, Math.round(Number(total) || 1));
  const data = {
    id: safeId(id),
    label: String(label || ""),
    total: totalN,
    perBatch: Math.max(1, Math.round(Number(perBatch) || 4)),
    payload,
    idempotencyKey: key,
    items: Array.from({ length: totalN }, (_, i) => ({ index: i, status: "pending", images: [], error: "" })),
    done: 0,
    failed: 0,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  return write(data.id, data);
}

/** 更新某一批的结果 */
export function update(id, { index, status, images = [], error = "" }) {
  const data = read(id);
  if (!data) return null;
  const item = data.items[Number(index)];
  if (!item) return null;
  // 已成功是**终态**：任何迟到的重复提交（乱序响应、重试、客户端重启后续跑）
  // 都不能把它改回 failed/pending。否则一张已经生成好的图会被判失败并重新扣费。
  // 需要重做时走 retryFailed()，它只处理 failed 项。
  if (item.status === "ok") return data;
  item.status = status;
  if (status === "ok") item.images = images;
  if (status === "failed") item.error = String(error || "");
  if (status === "pending") item.images = [];
  data.done = data.items.filter((i) => i.status === "ok").length;
  data.failed = data.items.filter((i) => i.status === "failed").length;
  if (data.done + data.failed >= data.total) data.status = data.failed ? "partial" : "done";
  return write(id, data);
}

/** 标记整批结束（用户中止 / 主动收尾） */
export function finish(id, status = "done") {
  const data = read(id);
  if (!data) return null;
  data.status = status;
  return write(id, data);
}

export function get(id) {
  return read(safeId(id));
}

/** 已完成的所有图片（按 index 顺序） */
export function results(id) {
  const data = read(safeId(id));
  if (!data) return [];
  return data.items.filter((i) => i.status === "ok").flatMap((i) => i.images || []);
}

/** 读出全部进度文件（坏文件跳过，不让一份脏数据拖垮整个列表） */
function scanAll() {
  let names = [];
  try {
    names = fs.readdirSync(ensure()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findByIdempotencyKey(key) {
  return scanAll().find((row) => row && row.idempotencyKey && row.idempotencyKey === key) || null;
}

/** 列出可续跑的任务（未完成、按时间倒序） */
export function list({ limit = 20 } = {}) {
  const rows = scanAll().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  return rows.slice(0, limit).map((r) => ({
    id: r.id,
    label: r.label,
    total: r.total,
    done: r.done,
    failed: r.failed,
    status: r.status,
    updatedAt: r.updatedAt
  }));
}

export function remove(id) {
  try {
    fs.unlinkSync(fileOf(id));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** 清理超过 days 天的进度文件（服务启动时调用一次） */
export function sweep(days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const row of list({ limit: 500 })) {
    if ((row.updatedAt || 0) < cutoff) {
      remove(row.id);
      removed += 1;
    }
  }
  return removed;
}

/**
 * 服务启动时调用：把上次进程留下的 running 批次标成 interrupted。
 *
 * 为什么需要：服务端不持有跨进程任务状态（进度由客户端驱动），
 * 所以进程重启后磁盘上那些 running 就是「假运行中」——UI 会一直显示
 * 进度条在跑，用户以为还在生成。标成 interrupted 后，前端可以据此给出
 * 「续跑」入口，语义才诚实。
 */
export function recoverStale() {
  let marked = 0;
  for (const row of scanAll()) {
    if (row?.status === "running") {
      row.status = "interrupted";
      write(row.id, row);
      marked += 1;
    }
  }
  return marked;
}

/** 未完成的下标（不含已成功项）——「只重试未完成项」的下标来源 */
export function pendingIndexes(id) {
  const data = read(safeId(id));
  if (!data) return [];
  return data.items.filter((item) => item.status !== "ok").map((item) => item.index);
}

/**
 * 把失败项重置为 pending 并返回需要重跑的下标。
 * 已成功项**绝不**被重置：重复生成既浪费算力又会让结果集出现重复图。
 */
export function retryFailed(id) {
  const data = read(safeId(id));
  if (!data) return { ok: false, retried: [] };
  const retried = [];
  for (const item of data.items) {
    if (item.status === "failed") {
      item.status = "pending";
      item.error = "";
      retried.push(item.index);
    }
  }
  data.done = data.items.filter((i) => i.status === "ok").length;
  data.failed = data.items.filter((i) => i.status === "failed").length;
  if (retried.length) data.status = "running";
  data.retriedAt = Date.now();
  write(id, data);
  return { ok: true, retried };
}

/** 进度汇总（批量面板与续跑入口共用，避免前端各算各的） */
export function summary(id) {
  const data = read(safeId(id));
  if (!data) return null;
  const done = data.items.filter((i) => i.status === "ok").length;
  const failed = data.items.filter((i) => i.status === "failed").length;
  return {
    id: data.id,
    label: data.label,
    total: data.total,
    perBatch: data.perBatch,
    done,
    failed,
    pending: data.total - done - failed,
    status: data.status,
    idempotencyKey: data.idempotencyKey || "",
    createdAt: data.createdAt,
    updatedAt: data.updatedAt
  };
}

export function root() {
  return ensure();
}
