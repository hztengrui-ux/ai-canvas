/**
 * 全局错误边界（2026-09-25）
 * --------------------------------------------------------------------------
 * 之前这个项目**一个错误捕获都没有**：任何组件抛错 → 整棵组件树卸载 → 白屏，
 * 用户只能杀进程重开，而且不知道发生了什么。这个模块把「崩溃」变成「一次事故报告」。
 *
 * 三层捕获，各管一段：
 *   1. app.config.errorHandler  —— Vue 组件渲染 / 生命周期 / 事件处理里的错
 *   2. onErrorCaptured（App.vue）—— 子组件树的错，就地拦下不外溢
 *   3. window.onerror / unhandledrejection —— Vue 管不到的（第三方脚本、异步回调）
 *
 * 分级原则（很重要，别一刀切）：
 *   · **fatal（全屏兜底页）**：只有「组件树渲染不出来」才致命。此时界面已经是空的，
 *     与其留白屏，不如给一张能复制错误、能重载、能退回工作台的页。
 *   · **soft（角标提示）**：异步 rejected、接口超时、单个请求失败 —— 这些不该掀桌，
 *     记进 log，弹个轻提示即可，用户手上的活不能丢。
 *
 * 刻意不做的事：不自动 reload、不上报远端。
 *   自动 reload 会把用户未保存的画布内容直接清零；
 *   上报需要隐私合规评估，先留本地 log，等要接监控时再开。
 */
import { reactive } from "vue";

/** 全局错误状态。界面只认这一个真源。 */
export const errorState = reactive({
  /** 致命错误：非空时渲染兜底页 */
  fatal: null,
  /** 非致命错误累计次数（用于角标） */
  softCount: 0,
  /** 最近一条非致命错误的文案（用于轻提示） */
  softMessage: "",
  /** 环形日志，最多 30 条 */
  log: []
});

const LOG_MAX = 30;

/**
 * 有些错误是浏览器/第三方库的噪音，掀桌没意义。
 * ResizeObserver 那条尤其经典：它不是 bug，是布局时序的正常告警。
 */
const IGNORABLE = [
  /ResizeObserver loop/i,
  /Script error\.?/i, // 跨域脚本，拿不到堆栈，报了也没用
  /Loading chunk .* failed/i, // 发版时的旧 chunk，交给更新提示处理
  /Network Error/i
];

export function isIgnorable(err) {
  const msg = String(err?.message || err || "");
  return IGNORABLE.some((re) => re.test(msg));
}

/**
 * 把任意形态的错误（Error / 字符串 / 对象 / undefined）归一成可展示的结构。
 * 界面里最怕拿到 undefined 然后 .message 又炸一次。
 */
export function formatError(err, source = "") {
  const raw = err instanceof Error ? err : null;
  const message =
    (raw && raw.message) ||
    (typeof err === "string" && err) ||
    (err && (err.message || err.msg || err.error)) ||
    "发生了未知错误";

  return {
    title: source ? `${source} 出错` : "界面出错",
    message: String(message).slice(0, 500),
    stack: raw?.stack ? String(raw.stack).slice(0, 4000) : "",
    source: source || "",
    at: new Date().toISOString()
  };
}

function pushLog(entry) {
  errorState.log.unshift(entry);
  if (errorState.log.length > LOG_MAX) errorState.log.length = LOG_MAX;
}

/**
 * 报告一条**非致命**错误：记日志 + 轻提示，绝不掀桌。
 * @returns {boolean} 是否被记为 soft（被忽略的错误返回 false）
 */
export function reportError(err, source = "") {
  if (isIgnorable(err)) return false;
  const entry = { ...formatError(err, source), level: "soft" };
  pushLog(entry);
  errorState.softCount++;
  errorState.softMessage = entry.message;
  // 3 秒后清掉提示文案，避免一直挂着
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      if (errorState.softMessage === entry.message) errorState.softMessage = "";
    }, 3000);
  }
  return true;
}

/**
 * 报告一条**致命**错误：渲染兜底页。
 * 只在组件树真的渲染不出来时用 —— 判断标准很简单：
 * 界面此刻是不是空的？是空的那给兜底页不亏。
 */
export function reportFatal(err, source = "") {
  if (isIgnorable(err)) return false;
  const entry = { ...formatError(err, source), level: "fatal" };
  pushLog(entry);
  errorState.fatal = entry;
  return true;
}

/** 兜底页上的「重试」：清掉 fatal，回到界面 */
export function clearFatal() {
  errorState.fatal = null;
}

/** 把当前错误整理成可复制的文本（用户要贴给我排查时用） */
export function errorReportText() {
  const e = errorState.fatal;
  if (!e) return "";
  return [
    `时间：${e.at}`,
    `位置：${e.source || "未记录"}`,
    `错误：${e.message}`,
    e.stack ? `堆栈：\n${e.stack}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 挂 window 级兜底。返回清理函数（测试里要用）。
 * 注意 unhandledrejection 走 soft：一个请求失败不该把整屏干掉，
 * 用户正在画的画布还在呢。
 */
export function installGlobalHandlers() {
  if (typeof window === "undefined") return () => {};

  const onError = (event) => {
    // 资源加载失败（img/script）不是 JS 错误，也不该掀桌
    if (event?.target && event.target !== window && event.target.tagName) return;
    reportFatal(event?.error || event?.message, "window.onerror");
  };

  const onRejection = (event) => {
    reportError(event?.reason, "未处理的 Promise 拒绝");
  };

  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    window.removeEventListener("error", onError, true);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
