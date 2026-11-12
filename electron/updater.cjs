// 自动更新（electron-updater + 对象存储静态托管）
//
// 方案来自对 AI Change 的实机拆解：provider: generic 指向 OSS 的 releases 目录，
// 客户端拉 latest.yml 比对版本 → 差异下载 → NSIS 静默安装。不需要自建更新服务。
//
// ⚠️ 首次接入的坑（AI Change 的代码里明确做了版本门控）：
//    差异更新（blockmap）对老版本客户端不兼容，硬上会把用户装坏。
//    所以第一版必须走全量包，等用户都升上来再逐步放开。
//
// 2026-10-14 第三轮修复：
//   1. init() 变成幂等 —— 以前它被放在 createMainWindow() 里，每建一次主窗就
//      重复 ipcMain.handle("update:check") 注册同名通道，Electron 会抛
//      「Attempted to register a second handler」把建窗流程打断。
//   2. 三个 IPC 通道改成「永远注册」—— 以前 isDev / 无更新源时直接 return，
//      通道根本没注册，渲染层 invoke 会被 reject（No handler registered），
//      前端只能靠猜。现在统一返回 { ok:false, reason }，前端能明确区分
//      「更新不可用」和「检查失败」。
//   3. 新增 setWindow(win)：主窗会随「登出→登录」重建，事件推送目标必须能换，
//      而不是把窗口引用焊死在 init 的参数里。
const { app, ipcMain, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// 差异更新最低支持版本。低于它的客户端只走全量包。
// 我们首次发版时这应该等于「当前版本」，之后每次大改 blockmap 格式时上调。
const DIFFERENTIAL_MIN_VERSION = "0.2.0";

let autoUpdater = null;
let mainWinRef = null;
let logFn = () => {};
let checking = false;

// 是否已经初始化过（含 ipc 通道注册）。防止重复注册同名 handle。
let initialized = false;
// 「启动后延迟检查」是否已安排（只安排一次，且必须等窗口挂上）
let autoCheckScheduled = false;
// 当前更新能力状态：enabled=false 时三个 IPC 依旧可用，只是如实返回原因。
let status = { enabled: false, reason: "not-initialized" };

function parseVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

function isVersionAtLeast(version, minimum) {
  const c = parseVersion(version);
  const m = parseVersion(minimum);
  if (!c || !m) return false;
  for (let i = 0; i < c.length; i += 1) {
    if (c[i] !== m[i]) return c[i] > m[i];
  }
  return true;
}

/** 读取打包时生成的 app-update.yml，判断是否配置了更新源 */
function updateConfigPath() {
  return path.join(process.resourcesPath || path.join(__dirname, ".."), "app-update.yml");
}

function hasUpdateSource() {
  try {
    const file = updateConfigPath();
    if (!fs.existsSync(file)) return false;
    // 更新源还是占位符时**不要**去检查：electron-updater 每次启动都会失败一次，
    // 渲染层就弹「检查更新失败 ERR_CONNECTION_CLOSED」，用户看到的就是"这软件有毛病"。
    // 等真正配好 OSS/更新源（AI_CANVAS_UPDATE_URL）之后，这里自然恢复。
    const raw = fs.readFileSync(file, "utf8");
    if (raw.includes("REPLACE-WITH-YOUR-OSS")) return false;
    return true;
  } catch {
    return false;
  }
}

function send(channel, payload) {
  try {
    if (mainWinRef && !mainWinRef.isDestroyed()) {
      mainWinRef.webContents.send(channel, payload);
    }
  } catch {
    /* ignore */
  }
}

/** 事件推送目标窗口。主窗重建后必须重新指向，否则事件发到已销毁的窗口上。 */
function setWindow(win) {
  mainWinRef = win || null;
  // 首次挂上窗口时才安排「启动后延迟检查」：
  // init() 现在在 app.whenReady 里跑（窗口还不存在），如果定时器在 init 里起，
  // 8 秒后事件可能发到一个还没有 webContents 的空引用上，渲染层永远收不到。
  if (mainWinRef) scheduleAutoCheck();
}

/**
 * 启动后延迟检查（只安排一次）。等窗口挂上再排，避免事件发给不存在的窗口；
 * 也避免 logout → login 重建主窗时反复自动检查。
 */
function scheduleAutoCheck() {
  if (autoCheckScheduled || !status.enabled || !autoUpdater) return;
  // 窗口还没挂上就先不排（init 时通常如此），等 setWindow() 再来
  if (!mainWinRef) return;
  autoCheckScheduled = true;
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => logFn(`自动更新：首次检查失败 ${e.message}`));
  }, 8000);
}

function currentState() {
  return {
    enabled: status.enabled === true,
    reason: status.reason || "",
    version: safeAppVersion(),
    differentialMinVersion: DIFFERENTIAL_MIN_VERSION
  };
}

function safeAppVersion() {
  try {
    return app.getVersion();
  } catch {
    return "0.0.0";
  }
}

/**
 * 注册 IPC 通道。只注册一次（由 initialized 守卫）。
 * 无论更新是否可用，这三个通道都要在 —— 渲染层需要能问出「为什么不可用」。
 */
function registerIpc() {
  ipcMain.handle("update:state", () => currentState());

  ipcMain.handle("update:check", async () => {
    if (!status.enabled || !autoUpdater) {
      return { ok: false, reason: status.reason || "disabled" };
    }
    if (checking) return { ok: false, reason: "busy" };
    checking = true;
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, version: r?.updateInfo?.version || null };
    } catch (e) {
      return { ok: false, reason: e.message };
    } finally {
      checking = false;
    }
  });

  ipcMain.handle("update:install", () => {
    if (!status.enabled || !autoUpdater) {
      return { ok: false, reason: status.reason || "disabled" };
    }
    logFn("自动更新：用户确认安装，即将重启");
    // isSilent=false 让 NSIS 显示安装界面，isForceRunAfter=true 装完自动启动
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });
}

/**
 * 初始化。幂等：重复调用只更新窗口引用与日志函数，不会重复注册 IPC。
 * 开发模式或无更新源时更新能力置为不可用，但 IPC 仍然就绪。
 */
function init({ win, log, isDev } = {}) {
  if (win) setWindow(win);
  if (log) logFn = log;

  if (initialized) {
    logFn("自动更新：已初始化过，本次只更新窗口引用（避免重复注册 IPC）");
    return currentState();
  }
  initialized = true;
  registerIpc();

  if (isDev) {
    status = { enabled: false, reason: "dev" };
    logFn("自动更新：开发模式，跳过");
    return currentState();
  }
  if (!hasUpdateSource()) {
    status = { enabled: false, reason: "no-source" };
    logFn("自动更新：未找到 app-update.yml（未配置更新源），跳过");
    return currentState();
  }

  try {
    // 延迟 require：electron-updater 在非 Electron 环境会抛错
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    status = { enabled: false, reason: "missing-dep" };
    logFn(`自动更新：electron-updater 加载失败 ${e.message}`);
    return currentState();
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  // 版本门控：低于阈值的客户端关闭差异更新，强制全量
  const cur = app.getVersion();
  if (!isVersionAtLeast(cur, DIFFERENTIAL_MIN_VERSION)) {
    autoUpdater.disableDifferentialDownload = true;
    logFn(`自动更新：当前 ${cur} 低于差异更新门槛 ${DIFFERENTIAL_MIN_VERSION}，本次走全量包`);
  }

  autoUpdater.on("checking-for-update", () => {
    logFn("自动更新：检查中");
    send("update:checking");
  });

  autoUpdater.on("update-available", (info) => {
    logFn(`自动更新：发现新版本 ${info.version}`);
    send("update:available", {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : ""
    });
  });

  autoUpdater.on("update-not-available", () => {
    logFn("自动更新：已是最新");
    send("update:none", { version: app.getVersion() });
  });

  autoUpdater.on("download-progress", (p) => {
    send("update:progress", {
      percent: Math.round(p.percent || 0),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    logFn(`自动更新：${info.version} 已下载完成，等待用户确认安装`);
    send("update:downloaded", { version: info.version });
  });

  autoUpdater.on("error", (err) => {
    // 更新失败绝不弹窗打断使用，只记日志
    logFn(`自动更新失败：${err?.message || err}`);
    send("update:error", { message: String(err?.message || err) });
  });

  status = { enabled: true, reason: "" };

  // 若此刻已经有窗口（例如运行期重新 init），立刻安排；否则等 setWindow() 来触发
  scheduleAutoCheck();

  return currentState();
}

module.exports = { init, setWindow, isVersionAtLeast, DIFFERENTIAL_MIN_VERSION };
