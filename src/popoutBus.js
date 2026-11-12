/**
 * 主窗口 ↔ 独立弹出窗口（双屏）的数据总线。
 *
 * 弹出窗口是另一个渲染上下文（Electron 里是独立 BrowserWindow，浏览器里是新标签页），
 * 两边不共享 Vue 状态，用同源 BroadcastChannel 同步：
 *   - 主窗口：selection / 结果变化时 post { type:"state", payload }
 *   - 弹出窗口：挂载完成 post { type:"ready" }，主窗口收到后立刻补发一次当前状态
 * 没有BroadcastChannel 的环境（几乎没有）总线退化为空操作，不影响主流程。
 */
const CH = "ai-canvas:popout";

let ch = null;

function bus() {
  if (ch === null) {
    try {
      ch = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CH) : false;
    } catch {
      ch = false;
    }
  }
  return ch || null;
}

export function sendPopout(msg) {
  try {
    // payload 里会混入 Vue 的 reactive Proxy（节点 data / lineage），
    // postMessage 结构化克隆遇到 Proxy 直接抛 DataCloneError，
    // 所以先转成纯 JSON 数据再发，失败对主流程无影响。
    const plain = JSON.parse(JSON.stringify(msg ?? null));
    bus()?.postMessage(plain);
  } catch {
    /* 通道关闭等场景静默 */
  }
}

/** 返回取消函数 */
export function onPopout(fn) {
  const b = bus();
  if (!b) return () => {};
  b.onmessage = (e) => {
    try {
      fn(e.data);
    } catch {
      /* 消息处理失败不影响通道 */
    }
  };
  return () => {
    if (b.onmessage !== fn) return;
    b.onmessage = null;
  };
}
