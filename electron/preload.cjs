// 预加载：把窗口控制与桌面能力安全地暴露给渲染进程
//
// 纪律：只暴露白名单方法，绝不 exposeInMainWorld 整个 ipcRenderer ——
// 后者等于把任意通道调用权交给页面，contextIsolation 就白开了。
const { contextBridge, ipcRenderer } = require("electron");

// 主进程通过 additionalArguments 告知当前窗口角色（login / main）
const argWindowMode = process.argv.find((a) => a.startsWith("--app-window="));
const windowMode = argWindowMode ? argWindowMode.split("=")[1] : "main";

/**
 * 统一的订阅工厂：注册监听 → 返回取消订阅函数。
 * 返回值必须是函数：Vue 组件在 onBeforeUnmount 里调用它，
 * 不返回的话监听器会随组件重建不断堆积（内存泄漏 + 重复处理同一事件）。
 * 写法与下面的 onWindowState 保持一致。
 */
function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,
  /** "login" 表示这是独立登录窗 */
  windowMode,

  // ---------- 窗口控制 ----------
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onWindowState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on("window:state", handler);
    return () => ipcRenderer.removeListener("window:state", handler);
  },

  // ---------- 登录流转 ----------
  /** 登录窗登录成功后调用：主进程会关掉登录窗并打开主窗口 */
  notifyLoginSuccess: () => ipcRenderer.invoke("auth:success"),
  /** 主窗口登出后调用：回到登录窗 */
  notifyLogout: () => ipcRenderer.invoke("auth:logout"),

  // ---------- 应用信息 ----------
  info: () => ipcRenderer.invoke("app:info"),
  openLogs: () => ipcRenderer.invoke("app:open-logs"),

  // ---------- 本地变更令牌 ----------
  // 主进程每次启动随机生成；所有写接口（POST/PUT/PATCH/DELETE）都必须带上它。
  // 只在 Electron 里存在：浏览器直连时拿不到也没有（那时服务端不启用该门）。
  getMutationToken: () => ipcRenderer.invoke("app:mutation-token"),

  // ---------- 系统通知（Sprint 2） ----------
  // 生成完成/失败时告知主进程；要不要真的弹（前台不打扰等）由主进程侧策略决定。
  // 渲染进程只提供事实：类型、数量、文案。
  notifyTask: (payload) => ipcRenderer.invoke("app:notify-task", payload),

  // ---------- 自动更新（真链路） ----------
  // 主进程侧：electron/updater.cjs 的 registerIpc() 注册了 update:check /
  // update:install / update:state，并通过 webContents.send 推送 6 类事件。
  // 这里把它们 1:1 桥接给渲染层 —— 没有这层，前端就够不到真链路，
  // 只能自己 setInterval + Math.random 造假进度条（第三轮要消灭的问题）。
  update: {
    /** 主动检查更新。返回 { ok, version?, reason? }；更新不可用时 ok=false, reason="dev"/"no-source" 等 */
    check: () => ipcRenderer.invoke("update:check"),
    /** 下载完成后确认安装：主进程走 autoUpdater.quitAndInstall() 真重启安装 */
    install: () => ipcRenderer.invoke("update:install"),
    /** 查询更新能力 { enabled, reason, version, differentialMinVersion } */
    state: () => ipcRenderer.invoke("update:state"),

    onChecking: (cb) => subscribe("update:checking", cb),
    onAvailable: (cb) => subscribe("update:available", cb),
    onNone: (cb) => subscribe("update:none", cb),
    onProgress: (cb) => subscribe("update:progress", cb),
    onDownloaded: (cb) => subscribe("update:downloaded", cb),
    onError: (cb) => subscribe("update:error", cb)
  }
});
