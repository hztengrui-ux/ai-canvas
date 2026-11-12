// 批量工作台（全自动文件夹出图）的接口封装。
//
// 与 api.js 保持同一套纪律：
//   · 统一走 apiFetch —— 自动带本地会话令牌与变更令牌，403/401 的重试与提示也在那边
//   · 非 2xx 一律抛 Error（中文、具体），调用方用 ElMessage 呈现，**不要静默失败**
//   · 只做「发请求 + 拿到结构化结果」，不在这里塞业务判断
//
// 接口契约（后端由 server/batch-workbench 一侧实现，字段名以契约为准，前端不改名）：
//   POST /api/batch/scan    {dir, recursive}
//   GET  /api/batch/fs      ?root=&rel=   → 图片字节（缩略图直接当 img src 用）
//   POST /api/batch/start   {dir, files[], params{}}
//   GET  /api/batch/state   → {ok, job|null}
//   POST /api/batch/pause | resume | cancel
import { apiFetch } from "./api.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * 解析响应：非 2xx 或 {ok:false} 都转成带原因的 Error。
 * 服务端在批量接口上的错误口径是 {error}（扫码失败、目录不存在、任务已在跑…），
 * 这里一并接住；`status` 留下来给调用方区分「接口还没上线（404）」。
 */
async function readJson(res, fallback) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null; // 404/500 的 HTML 错误页也会走到这里
  }
  if (!res.ok) {
    const err = new Error(body?.error || body?.message || `${fallback}（HTTP ${res.status}）`);
    err.status = res.status;
    err.code = body?.code || "";
    throw err;
  }
  if (body && body.ok === false) {
    const err = new Error(body.error || body.message || fallback);
    err.status = res.status;
    err.code = body.code || "";
    throw err;
  }
  return body || {};
}

/**
 * 缩略图地址。
 *
 * 为什么要一个专门的函数：img 标签的 src 走不了 apiFetch（没法加自定义 header），
 * 但服务端对 GET 也认 cookie 会话，所以这里直接把 URL 拼好给 img 用即可 ——
 * 与契约里「img src 直接用，会自动带 cookie」一致。
 * 两个参数都必须编码：Windows 路径里有空格、中文、`#`、`&`。
 */
export function batchThumbUrl(root, rel) {
  const r = String(root || "");
  const p = String(rel || "");
  if (!r || !p) return "";
  return `/api/batch/fs?root=${encodeURIComponent(r)}&rel=${encodeURIComponent(p)}`;
}

/** 扫描文件夹。返回 {ok, root, total, files[], groups[], skipped, truncated} */
export async function scanBatchDir(dir, recursive = true) {
  const res = await apiFetch("/api/batch/scan", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ dir, recursive: Boolean(recursive) })
  });
  return readJson(res, "扫描文件夹失败");
}

/** 启动整批任务。返回 {ok, job:{id,total,state}} */
export async function startBatch(payload) {
  const res = await apiFetch("/api/batch/start", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload || {})
  });
  return readJson(res, "启动批量任务失败");
}

/** 读取当前批次状态。job 为 null 表示没有批次（服务端每次只跑一个批次）。 */
export async function fetchBatchState() {
  const res = await apiFetch("/api/batch/state");
  return readJson(res, "读取批量进度失败");
}

/** 暂停。返回 {ok, job} */
export async function pauseBatch() {
  const res = await apiFetch("/api/batch/pause", { method: "POST" });
  return readJson(res, "暂停失败");
}

/** 续跑。返回 {ok, job} */
export async function resumeBatch() {
  const res = await apiFetch("/api/batch/resume", { method: "POST" });
  return readJson(res, "继续失败");
}

/** 取消。返回 {ok, job} */
export async function cancelBatch() {
  const res = await apiFetch("/api/batch/cancel", { method: "POST" });
  return readJson(res, "取消失败");
}

/** 给「接口还没上线」一个统一的判定，组件里据此给出更具体的提示 */
export function isNotReadyError(err) {
  return err?.status === 404;
}
