// 嵌入桥：把画布作为 iframe 嵌入宿主系统时的双向通信层
//
// 宿主 → 画布（postMessage）
//   { source: "ai-canvas-host", type, payload }
//   theme    { dark }              同步主题
//   route    { route }             切换页面 home | studio | projects
//   workflow { workflowId }        铺开一套工作流并进入创作台
//   prompt   { text }              写入画面描述节点
//   ping                           探活
//
// 画布 → 宿主
//   { source: "ai-canvas", type, payload }
//   ready        {}                画布已就绪
//   theme-change { dark }
//   route-change { route }
//   generated    { images, count } 生成完成
//   resize       { height }        建议高度（供宿主自适应）

import { store, bridge } from "./store.js";

// 判断是否处于 iframe 中（跨域时访问 window.top 会抛异常，同样说明被嵌入了）
export const IS_EMBEDDED = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

// 宿主来源：优先从 referrer 推断，比通配符安全
let hostOrigin = (() => {
  try {
    if (document.referrer) return new URL(document.referrer).origin;
  } catch {
    /* ignore */
  }
  return "*";
})();

export function postToHost(type, payload = {}) {
  if (!IS_EMBEDDED) return;
  try {
    window.parent.postMessage({ source: "ai-canvas", type, payload }, hostOrigin);
  } catch {
    /* ignore */
  }
}

// ---------- 宿主指令 ----------
const handlers = {
  theme({ dark }) {
    store.darkMode = !!dark;
  },
  route({ route }) {
    if (["home", "studio", "projects"].includes(route)) store.route = route;
  },
  workflow({ workflowId }) {
    if (!workflowId) return;
    store.route = "studio";
    // 复用「首页快捷任务 → 创作台自动铺开」的既有通道
    store.pendingWorkflow = workflowId;
    // 已经在创作台时 NodeCanvas 不会重新挂载，直接调一次
    bridge.applyWorkflow?.(workflowId);
  },
  prompt({ text }) {
    bridge.setPrompt?.(String(text ?? ""));
  },
  ping() {
    postToHost("pong");
  }
};

function onMessage(event) {
  const data = event?.data;
  if (!data || typeof data !== "object") return;
  if (data.source !== "ai-canvas-host") return;
  // 已知来源时校验来源，避免任意页面驱动画布
  if (hostOrigin !== "*" && event.origin !== hostOrigin) return;

  const fn = handlers[data.type];
  if (!fn) return;
  try {
    fn(data.payload || {});
  } catch (err) {
    console.warn("[embed] 指令执行失败:", data.type, err);
  }
}

// ---------- 状态回传 ----------
let lastHeight = 0;

function reportResize() {
  if (!IS_EMBEDDED) return;
  const h = Math.round(document.documentElement.scrollHeight);
  if (h && Math.abs(h - lastHeight) > 8) {
    lastHeight = h;
    postToHost("resize", { height: h });
  }
}

export function initEmbed() {
  if (!IS_EMBEDDED) return;

  window.addEventListener("message", onMessage);

  // 主题 / 路由变化回传宿主
  window.addEventListener("ai-canvas:theme", (e) => postToHost("theme-change", { dark: e.detail?.dark }));
  window.addEventListener("ai-canvas:route", (e) => postToHost("route-change", { route: e.detail?.route }));

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(reportResize).observe(document.documentElement);
  }

  // 握手：告诉宿主画布已就绪
  postToHost("ready", { embedded: true });
}

// 生成完成后由画布调用
export function notifyGenerated(payload) {
  postToHost("generated", payload);
}
