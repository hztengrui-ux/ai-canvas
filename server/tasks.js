/**
 * 服务端任务注册表（2026-09-25）
 * --------------------------------------------------------------------------
 * 修的是一个「用户看得见、我们看不见」的坑：
 * 前端点「取消」之前只断开本地 fetch，服务端那条请求继续跑完 ——
 *   · ComfyUI 的 GPU 还在算，队列还占着
 *   · 预扣的算力照扣不误（provider 没抛错，commit 正常执行）
 * 用户感知就是一句：「我明明取消了，怎么还扣我钱」。
 *
 * 取消要真取消，得同时做两件事，缺一不可：
 *   1. 断开我们自己发出的上游请求（AbortController）
 *   2. 让上游**停止计算** —— 光断开连接，ComfyUI 那边照样跑完
 * 所以任务除了 signal，还要能挂 provider 自己的清理钩子（ComfyUI 的 /interrupt）。
 *
 * 顺序有讲究：先跑钩子停上游，再断连接。
 * 反过来做的话，连接先断了，钩子里的请求可能跟着一起被取消掉。
 */

/** @type {Map<string, {id,controller,userId,kind,refId,hooks:Function[],canceled,cancelReason,startedAt}>} */
const tasks = new Map();

/** 超过这个时长还没结束的任务，视为泄漏，扫描时清掉 */
const STALE_MS = 30 * 60 * 1000;

/**
 * 可被中断的等待。各家 provider 轮询都要用。
 * 普通 setTimeout 在取消后还会睡满整个间隔才醒 —— 用户点了取消要干等好几秒。
 */
export function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("已取消"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("已取消"));
      },
      { once: true }
    );
  });
}

/**
 * 注册一个任务。返回任务对象；调用方拿 signal 传给 provider 的 fetch。
 * @param {string} id 前端生成的 taskId（与前端 AbortController 一一对应）
 */
export function register(id, { userId = "", kind = "image", refId = "", provider = "" } = {}) {
  if (!id) return null;
  const t = {
    id: String(id),
    controller: new AbortController(),
    userId: String(userId || ""),
    kind: String(kind || "image"),
    refId: String(refId || ""),
    provider: String(provider || ""),
    hooks: [],
    canceled: false,
    cancelReason: "",
    startedAt: Date.now()
  };
  tasks.set(t.id, t);
  return t;
}

export function get(id) {
  return id ? tasks.get(String(id)) || null : null;
}

/** 给 provider 的 fetch 用：拿不到就返回 undefined，fetch 会忽略它 */
export function signalOf(id) {
  return tasks.get(String(id))?.controller.signal || undefined;
}

/**
 * provider 注册自己的清理钩子。
 * ComfyUI 就靠这个调 /interrupt —— 否则 GPU 会一直算到结束。
 */
export function onCancel(id, fn) {
  const t = tasks.get(String(id));
  if (t && typeof fn === "function") t.hooks.push(fn);
}

export function isCanceled(id) {
  return Boolean(tasks.get(String(id))?.canceled);
}

/**
 * 取消一个任务。
 * @returns {{ok:boolean, already?:boolean, error?:string}}
 */
export async function cancel(id, reason = "user") {
  const t = tasks.get(String(id));
  if (!t) return { ok: false, error: "任务不存在或已结束" };
  if (t.canceled) return { ok: true, already: true };
  t.canceled = true;
  t.cancelReason = String(reason || "user");

  // 先停上游（ComfyUI /interrupt），再断本地连接
  const results = [];
  for (const fn of t.hooks) {
    try {
      results.push(await fn());
    } catch (e) {
      results.push({ ok: false, error: e?.message || String(e) });
    }
  }
  try {
    t.controller.abort();
  } catch {
    /* 已 abort 过，忽略 */
  }
  return { ok: true, id: t.id, hooks: results };
}

export function unregister(id) {
  if (id) tasks.delete(String(id));
}

/** 当前挂着的（未取消的）任务数 —— 排障时看一眼就知道有没有泄漏 */
export function activeCount() {
  let n = 0;
  for (const t of tasks.values()) if (!t.canceled) n++;
  return n;
}

export function snapshot() {
  return [...tasks.values()].map((t) => ({
    id: t.id,
    // 2026-10-18：补上 userId / startedAt / state。
    // 手机端要按账号过滤"我的进度"，只给 id/provider 是没法过滤的。
    userId: t.userId || "",
    provider: t.provider,
    kind: t.kind,
    canceled: t.canceled,
    state: t.canceled ? "canceled" : "running",
    startedAt: t.startedAt || 0,
    hooks: t.hooks.length,
    ageMs: Date.now() - t.startedAt
  }));
}

/**
 * 清掉超时任务。
 * 任务正常结束时会 unregister；这个扫描是兜底 ——
 * 万一请求进程崩了、连接断了没走 finally，槽位和内存不能一直占着。
 */
export function sweepStale(now = Date.now()) {
  let n = 0;
  for (const [id, t] of tasks) {
    if (now - t.startedAt > STALE_MS) {
      try {
        t.controller.abort();
      } catch {
        /* 忽略 */
      }
      tasks.delete(id);
      n++;
    }
  }
  return n;
}
