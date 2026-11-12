// Electron 主进程
// 职责：单实例守卫 → 选空闲端口 → 起内置服务 → 登录窗/主窗切换 → 窗口状态持久化
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, nativeImage, Notification } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
// 注意：Electron 也导出一个 net，但那是它的网络请求 API（类似 fetch），
// 不是 Node 的 net 模块——这里要的是 createServer，必须从 node:net 引。
const net = require("node:net");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
// 2026-11-03 架构改造：内置服务从「child_process.fork + ELECTRON_RUN_AS_NODE」
// 换成「worker_threads」。原因是安全加固要关掉 RunAsNode fuse，
// 而 fork 依赖它 —— 关掉之后服务起不来、整个应用白屏。
// worker 有独立的 V8 isolate 与事件循环：同步的图片合成、SSE 推送不会卡住界面线程，
// 崩溃也能通过 error/exit 事件兜住，行为和原来的子进程基本等价。
const { Worker } = require("node:worker_threads");
const updater = require("./updater.cjs");
const { createTrayController } = require("./tray.cjs");
const brandResolver = require("../config/brand-resolver.cjs");
const appPkg = require("../package.json");

const ROOT_DIR = path.join(__dirname, "..");

// ---------- 品牌（白标） ----------
// 三层取值：环境变量 BRAND > 打包固化值 > 默认 kuaduoduo。
// 固化值来自 electron-builder 的 extraMetadata：打包时把选中的品牌 key 写进
// 产物 package.json 的 aiCanvasBrand 字段（见 electron-builder.config.cjs）。
// 为什么在 main.cjs 里落这一步：server/brand.js 只认 process.env.BRAND，
// 而 server/** 不在本轮改动范围。这里把算好的 key 写回环境变量，
// fork 出去的内置服务继承 env → 品牌配置、主色、接口返回值全部跟着变，
// 装上 OEM 包从快捷方式启动也不会再回落成「跨多多」。
const BRAND_RESOLVED = brandResolver.resolveRuntimeBrandKey({
  rootDir: ROOT_DIR,
  env: process.env,
  frozenKey: appPkg.aiCanvasBrand
});
const BRAND = brandResolver.resolveBrand({
  rootDir: ROOT_DIR,
  env: { BRAND: BRAND_RESOLVED.key }
}).brand;
process.env.BRAND = BRAND_RESOLVED.key;
const APP_TITLE = BRAND.appName;

// ---------- 免安装（绿色）模式 ----------
// 为什么需要：默认情况下 Electron 把 userData 放在 %APPDATA%，内置服务的账号/账本
// 放在 %USERPROFILE%\.ai-canvas —— 于是"免安装版"照样会往系统目录写东西：
// 换台机器带着走时，登录态、项目、算力账本全留在原来那台机器上，不叫绿色版。
//
// 触发条件（满足任一即进入绿色模式）：
//   1) exe 同级放了一个名为 portable.flag 的标记文件（打包免安装版时我会放）
//   2) 环境变量 AI_CANVAS_PORTABLE=1
// 进入绿色模式后：
//   - Electron 的 userData（窗口状态、boot.log）→ <exe目录>\data\appdata
//   - 内置服务的数据根（AI_CANVAS_HOME）→ <exe目录>\data
//   整个文件夹拷到 U 盘/别处就能接着用。
const PORTABLE_FLAG = "portable.flag";
function isPortable() {
  if (process.env.AI_CANVAS_PORTABLE === "1") return true;
  try {
    return fs.existsSync(path.join(path.dirname(process.execPath), PORTABLE_FLAG));
  } catch {
    return false;
  }
}

const PORTABLE = isPortable();
if (PORTABLE) {
  const baseDir = path.dirname(process.execPath);
  const dataDir = path.join(baseDir, "data");
  try {
    fs.mkdirSync(path.join(dataDir, "appdata"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "outputs"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "materials"), { recursive: true });
  } catch {
    /* 目录建不出来就退回默认行为，不要让应用起不来 */
  }
  // userData 必须在 app ready 之前设置
  app.setPath("userData", path.join(dataDir, "appdata"));
  // 内置服务（fork）继承这些环境变量；显式覆盖，避免用户环境里已有值造成半绿半不绿
  process.env.AI_CANVAS_HOME = dataDir;
  process.env.AI_CANVAS_OUTPUTS = path.join(dataDir, "outputs");
  process.env.AI_CANVAS_MATERIALS = path.join(dataDir, "materials");
}

// ---------- 全局状态 ----------
let serverProc = null;
let trayCtl = null;
let mainWin = null;
let loginWin = null;
let serverUrl = "";
let quitting = false;

// ---------- 每会话双令牌（不落盘，随进程生命周期） ----------
//   RUNTIME_TOKEN  主进程用来确认「就绪的那个服务确实是我 fork 出来的」：
//                  端口被别人占用时，对方不会回显这个随机值，于是不会误判就绪。
//   MUTATION_TOKEN 主进程经 IPC 下发给页面，服务端所有写接口强制校验它。
// 两个令牌都只存在于内存与环境变量（父子进程单向传递），不写文件、不进日志。
const RUNTIME_TOKEN = crypto.randomBytes(32).toString("hex");
const MUTATION_TOKEN = crypto.randomBytes(32).toString("hex");

const DEV_URL = process.env.AI_CANVAS_DEV_URL || "";
const IS_DEV = Boolean(DEV_URL);

// ---------- 生产环境调试封锁（2026-11-03 安全加固） ----------
// 目的：把「连上 CDP 就能读 DOM/改状态/调接口」这条最常见的逆向入口堵掉。
// REA、Chrome DevTools、Puppeteer、Playwright 全部靠 --remote-debugging-port 或
// --inspect 附着进程；打包版一律拒绝启动，并把键盘上的 DevTools 快捷键也封掉。
// 开发态（AI_CANVAS_DEV_URL / 非打包运行）保持原样，否则没法调试。
const DEBUG_SWITCH_RE =
  /^(--inspect(-brk|-port|-publish-uid)?($|=)|--remote-debugging-(port|pipe|address)($|=)|--enable-logging($|=)|--js-flags($|=))/i;

function enforceProductionLockdown() {
  if (!app.isPackaged) return;

  const badArg = process.argv.slice(1).find((a) => DEBUG_SWITCH_RE.test(String(a)));
  const nodeOpts = process.env.NODE_OPTIONS || "";
  const envBad = /--inspect|--remote-debugging/i.test(nodeOpts);

  if (!badArg && !envBad) return;

  const detail = badArg ? `命令行参数 ${badArg}` : "环境变量 NODE_OPTIONS 含调试开关";
  try {
    dialog.showErrorBox(
      `${APP_TITLE} 无法以调试模式启动`,
      `检测到 ${detail}。\n\n` +
        "为保护知识产权，正式版不允许附加调试器或远程调试端口。\n" +
        "请直接双击程序启动；如需排障请联系技术支持获取诊断包。"
    );
  } catch {
    /* 对话框失败也要退出 */
  }
  process.exit(1);
}

enforceProductionLockdown();

// ---------- 单实例守卫 ----------
// 不加锁的话双开会起两个服务抢同一个端口，第二个直接崩
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  const target = mainWin || loginWin;
  if (!target) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
});

// ---------- 窗口状态持久化 ----------
const STATE_FILE = () => path.join(app.getPath("userData"), "window-state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    const next = { ...readState(), ...patch };
    fs.writeFileSync(STATE_FILE(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* 状态写失败不影响使用 */
  }
}

/** 还原上次的窗口位置，但要确认那个位置现在还在屏幕内（拔掉外接屏后不至于跑到屏幕外） */
function restoredBounds(fallback) {
  const s = readState();
  if (!s.width || !s.height) return fallback;
  const displays = require("electron").screen.getAllDisplays();
  const visible = displays.some((d) => {
    const b = d.workArea;
    return (
      s.x >= b.x - 40 &&
      s.y >= b.y - 40 &&
      s.x < b.x + b.width - 80 &&
      s.y < b.y + b.height - 80
    );
  });
  if (!visible) return { width: s.width, height: s.height };
  return { x: s.x, y: s.y, width: s.width, height: s.height };
}

function trackBounds(win, key) {
  const save = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    const b = win.getBounds();
    writeState({ [`${key}`]: { x: b.x, y: b.y, width: b.width, height: b.height } });
  };
  win.on("resize", save);
  win.on("move", save);
  win.on("close", save);
}

// ---------- 选一个空闲端口 ----------
function pickPort() {
  // 手机联调时端口必须是可预期的：用户要在微信小程序里手填地址，
  // 每次启动都换一个端口等于每次都要改配置。所以显式给了 PORT 就用它（被占用才回退随机）。
  const wanted = Number(process.env.PORT || 0);
  if (Number.isInteger(wanted) && wanted > 0) {
    return new Promise((resolve) => {
      const probe = net.createServer();
      probe.unref();
      probe.on("error", () => resolve(5181));
      probe.listen(wanted, "0.0.0.0", () => {
        probe.close(() => resolve(wanted));
      });
    });
  }
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => resolve(5181));
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------- 启动内置服务 ----------
async function startServer() {
  if (IS_DEV) return DEV_URL;

  const port = await pickPort();
  const entry = path.join(__dirname, "..", "server", "index.js");

  // worker_threads：entry 是 ESM（package.json type=module），所以传 file:// URL，
  // Node 会按最近的 package.json 判定为 ES module。
  // stdout/stderr 打开后可用 worker.stdout 读，把服务端日志继续转发到主进程 stdout。
  serverProc = new Worker(pathToFileURL(entry).href, {
    name: "ai-canvas-server",
    stdout: true,
    stderr: true,
    env: {
      ...process.env,
      PORT: String(port),
      // 默认仍只监听本机。手机联调时由外部设 AI_CANVAS_BIND=0.0.0.0 打开
      // （security.js 会同步进入 MOBILE_MODE，只放行私有网段，并且不把本机令牌发给别人）。
      // 以前这里写死 "127.0.0.1"，等于把"手机连不上"焊死在桌面版里 —— 用户以为功能坏了。
      AI_CANVAS_BIND: process.env.AI_CANVAS_BIND || "127.0.0.1",
      // 双令牌注入：服务端据此启用「变更令牌门」并在每个响应回显运行标识
      AI_CANVAS_RUNTIME_TOKEN: RUNTIME_TOKEN,
      AI_CANVAS_MUTATION_TOKEN: MUTATION_TOKEN,
      // worker 里不该出现 Electron 专属变量，显式抹掉，避免服务端误判
      ELECTRON_RUN_AS_NODE: undefined
    }
  });

  serverProc.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  serverProc.on("error", (err) => {
    if (quitting) return;
    dialog.showErrorBox(
      `${APP_TITLE} 内置服务异常`,
      `服务线程抛错：\n\n${String(err?.stack || err)}`
    );
    quitting = true;
    app.quit();
  });
  serverProc.on("exit", (code) => {
    if (!quitting && code !== 0) {
      dialog.showErrorBox(`${APP_TITLE} 内置服务已停止`, `服务线程意外退出（code ${code}）。应用将关闭。`);
      app.quit();
    }
  });

  const url = `http://127.0.0.1:${port}/`;
  const ok = await waitForServer(url, 25000, RUNTIME_TOKEN);
  if (!ok) {
    dialog.showErrorBox(
      "启动失败",
      `内置服务在 25 秒内没有就绪。\n\n端口：${port}\n\n` +
        "常见原因：依赖未安装完整，或端口被占用。\n" +
        "可尝试删除 node_modules 后重新安装依赖。"
    );
    quitting = true;
    app.exit(1);
    return url;
  }
  return url;
}

async function waitForServer(url, timeoutMs, expectedRuntimeToken = "") {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${url}api/session`);
      if (res.ok) {
        // 端口归属校验：服务端每个响应都回显本次运行标识。
        // 端口被别的程序占用时，对方不会带这个头 → 不判就绪，继续等/最终超时，
        // 而不是把一个「别人的服务」当成内置服务用起来。
        if (!expectedRuntimeToken) return true;
        if (res.headers.get("x-ai-canvas-runtime-token") === expectedRuntimeToken) return true;
      }
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------- 是否已登录 ----------
// 注意：/api/auth/status 需要带本地会话令牌，先取令牌再查状态，
// 否则永远返回 loggedIn=false，登录窗会每次都弹出来。
async function isLoggedIn() {
  try {
    const sres = await fetch(`${serverUrl}api/session`);
    const { token } = await sres.json();
    if (!token) return false;

    const res = await fetch(`${serverUrl}api/auth/status`, {
      headers: { "X-AI-Canvas-Token": token }
    });
    const data = await res.json();
    return Boolean(data?.loggedIn);
  } catch {
    return false;
  }
}

// ---------- 应用图标 ----------
// 白标：优先用品牌自己的图标（config/brand-assets/<key>/icon.*），没有就回退。
// build/ 与 public/ 只在开发目录里有，打包后走 dist/ 内被 vite 拷过去的品牌图。
//
// ⚠️ 2026-10-18：打包后这些路径都在 app.asar 里。nativeImage / Tray 走的是原生文件系统，
//   asar 内部路径拿不到真实文件 —— 日志里就是 "Unable to create status tray icon"。
//   所以 config/ 与 dist/ 都做了 asarUnpack，这里把路径改写回真实磁盘路径。
function asarRealPath(p) {
  const m = /^(.*app\.asar)[\\/](.+)$/.exec(p);
  if (!m) return p;
  const unpacked = path.join(`${m[1]}.unpacked`, m[2]);
  return fs.existsSync(unpacked) ? unpacked : p;
}

function appIcon() {
  const candidates = [
    path.join(ROOT_DIR, "config", "brand-assets", BRAND.key, "icon.ico"),
    path.join(ROOT_DIR, "config", "brand-assets", BRAND.key, "icon.png"),
    path.join(ROOT_DIR, "build", "icon.ico"),
    path.join(ROOT_DIR, "build", "icon.png"),
    path.join(ROOT_DIR, "dist", "brand", "logo-mark.png"),
    path.join(ROOT_DIR, "public", "brand", "logo-mark.png")
  ].map(asarRealPath);
  return candidates.find((p) => fs.existsSync(p));
}

// ---------- 内容安全策略 ----------
// 服务端只设了 X-Frame-Options 等，没设 CSP，Electron 会对渲染层告警。
// 桌面端统一注入，把信任范围限制在「本机服务」。
function applyCsp() {
  const { session } = require("electron");
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // Element Plus 会写行内样式，样式源必须放开 inline
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp]
      }
    });
  });
}

// ---------- 诊断日志 ----------
// Windows 上 Electron 主进程的 console.log 不一定进 stdout，
// 调试期统一写到 userData/boot.log，便于定位启动问题
function logLine(msg) {
  // Windows 上 Electron 主进程的 stdout 会被吞掉，只有 stderr 能出来，
  // 所以这里统一走 stderr；同时落一份文件便于事后排查。
  try {
    process.stderr.write(`[main] ${msg}
`);
  } catch {
    /* ignore */
  }
  try {
    fs.appendFileSync(
      path.join(app.getPath("userData"), "boot.log"),
      `[${new Date().toISOString()}] ${msg}
`
    );
  } catch (e) {
    try {
      process.stderr.write(`[main] 日志写入失败: ${e.message}
`);
    } catch {
      /* ignore */
    }
  }
}

// ---------- 加载诊断 ----------
function watchLoad(win, tag) {
  win.webContents.on("did-finish-load", () => logLine(`[${tag}] 页面加载完成`));
  win.webContents.on("did-fail-load", (_e, code, desc, url) =>
    logLine(`[${tag}] 加载失败 code=${code} desc=${desc} url=${url}`)
  );
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) logLine(`[${tag}] 渲染层: ${message}`);
  });
}

// ---------- 登录窗 ----------
function createLoginWindow() {
  const b = restoredBounds({ width: 440, height: 620 });

  loginWin = new BrowserWindow({
    width: 440,
    height: 620,
    minWidth: 400,
    minHeight: 560,
    ...(b.x != null ? { x: b.x, y: b.y } : {}),
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#ffffff",
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ["--app-window=login"]
    }
  });

  loginWin.once("ready-to-show", () => {
    loginWin.show();
    loginWin.focus();
  });
  loginWin.loadURL(`${serverUrl}?window=login`);
  watchLoad(loginWin, "login");
  trackBounds(loginWin, "loginBounds");
  applyDevToolsLock(loginWin);

  loginWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  loginWin.on("closed", () => {
    loginWin = null;
    // 登录窗被直接关掉（没登录成功）→ 退出应用
    if (!mainWin && !quitting) app.quit();
  });
}

// ---------- 主窗口 ----------
// 生产包里的 DevTools 封锁：即使有人绕过 fuses 拿到一个能开的窗口，
// 也不让「打开开发者工具」这条捷径成立。三条都做：
//   1) 真被人 openDevTools 了，立即关掉；
//   2) 快捷键（F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+U）拦掉，不留菜单之外的口子；
//   3) 右键菜单里的「检查」由 Chromium 自己弹，打包版通过 toolbar 关闭（见 watchLoad 之外）。
// 开发态原样放行：本地调试、自动化截图都用得上。
function applyDevToolsLock(win) {
  if (!app.isPackaged || IS_DEV) return;
  const wc = win?.webContents;
  if (!wc) return;

  wc.on("devtools-opened", () => {
    try {
      wc.closeDevTools();
    } catch {
      /* ignore */
    }
  });

  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = String(input.key || "").toLowerCase();
    const ctrl = input.control || input.meta;
    const isDevtoolsCombo = (ctrl && input.shift && (key === "i" || key === "j" || key === "c")) || key === "f12";
    const isViewSource = ctrl && key === "u";
    if (isDevtoolsCombo || isViewSource) {
      event.preventDefault();
    }
  });
}

function createMainWindow() {
  // 方案 §3 基准 1440×900、最小 1180×720（原来是 1360×860 / 1080×680，两项都低于要求）
  const b = restoredBounds({ width: 1440, height: 900 });

  mainWin = new BrowserWindow({
    width: b.width,
    height: b.height,
    ...(b.x != null ? { x: b.x, y: b.y } : {}),
    minWidth: 1180,
    minHeight: 720,
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#ffffff",
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (readState().mainMaximized) mainWin.maximize();

  mainWin.once("ready-to-show", () => mainWin.show());
  applyDevToolsLock(mainWin);

  // 「关闭」= 收进托盘，而不是退出进程。
  // ⚠️ 只有托盘**确实建起来了**才这么做：托盘创建失败时若仍拦截关闭，
  // 窗口会消失、进程还在跑，用户除了任务管理器再也点不开 —— 那是最糟的形态。
  mainWin.on("close", (e) => {
    if (quitting) return;
    if (!trayCtl || !trayCtl.isCreated()) return;
    e.preventDefault();
    mainWin.hide();
  });

  // 自动更新：这里只把事件推送目标指向新主窗。
  // 初始化（含 ipcMain.handle 注册）已提到 app.whenReady 里只做一次 ——
  // 以前 init() 放在这里，每次建主窗都会重复注册 update:check 等同名通道，
  // Electron 会抛「Attempted to register a second handler」并打断建窗流程，
  // 打包版「登出 → 登录」就会卡在未加载的白窗上。
  updater.setWindow(mainWin);
  mainWin.loadURL(serverUrl);
  watchLoad(mainWin, "main");
  trackBounds(mainWin, "mainBounds");

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    // 双屏独立窗口：同源 + window=popout 才允许创建真实子窗口（可拖到第二块屏幕）
    if (url.startsWith(serverUrl) && url.includes("window=popout")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 460,
          height: 780,
          minWidth: 320,
          minHeight: 400,
          // 带原生标题栏：用户能在第二块屏幕自由拖动 / 最小化 / 关闭
          frame: true,
          backgroundColor: "#ffffff",
          icon: appIcon(),
          webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false
          }
        }
      };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  const push = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.webContents.send("window:state", { maximized: mainWin.isMaximized() });
  };
  for (const ev of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    mainWin.on(ev, push);
  }
  mainWin.on("maximize", () => writeState({ mainMaximized: true }));
  mainWin.on("unmaximize", () => writeState({ mainMaximized: false }));

  // 渲染进程崩溃时给出可读提示，而不是静默白屏
  mainWin.webContents.on("render-process-gone", (_e, details) => {
    dialog.showErrorBox("界面异常", `渲染进程已退出：${details.reason}`);
  });

  mainWin.on("closed", () => {
    mainWin = null;
    // 窗口没了就别再往它推更新事件（否则事件静默丢失，也可能指向已销毁对象）
    updater.setWindow(null);
    if (!quitting) app.quit();
  });
}

// ---------- 登录成功后切主窗 ----------
async function switchToMain() {
  createMainWindow();
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.destroy();
    loginWin = null;
  }
}

// ---------- 应用菜单 ----------
// frameless 窗口下没有原生菜单栏，但必须注册 Menu 才能让
// Ctrl+C / Ctrl+V / Ctrl+A / Ctrl+Z 等编辑快捷键生效
function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "forceReload", label: "强制重新加载" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
        ...(IS_DEV ? [{ role: "toggleDevTools", label: "开发者工具" }] : [])
      ]
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "close", label: "关闭" }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "打开日志目录",
          click: () => shell.openPath(app.getPath("userData"))
        },
        {
          label: "关于",
          click: () =>
            dialog.showMessageBox({
              type: "info",
              title: "关于",
              // 白标：品牌名跟着 BRAND 走，不再写死「跨多多」
              message: `${APP_TITLE}（品牌 ${BRAND.key}）`,
              detail:
                `版本 ${app.getVersion()}\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}` +
                `${BRAND.logoPending ? "\n\n⚠️ OEM logo 待补：当前界面使用默认 mark。" : ""}`
            })
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
ipcMain.handle("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());

ipcMain.handle("window:toggle-maximize", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  if (w.isMaximized()) w.unmaximize();
  else w.maximize();
  return w.isMaximized();
});

ipcMain.handle("window:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle("window:is-maximized", (e) => Boolean(BrowserWindow.fromWebContents(e.sender)?.isMaximized()));

// 登录成功：登录窗 → 主窗
ipcMain.handle("auth:success", async () => {
  await switchToMain();
  return true;
});

// 主窗口登出：回到登录窗
ipcMain.handle("auth:logout", async () => {
  const keep = mainWin;
  mainWin = null;
  createLoginWindow();
  keep?.destroy();
  return true;
});

ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  dev: IS_DEV
}));

ipcMain.handle("app:open-logs", () => shell.openPath(app.getPath("userData")));

// 生成完成的系统通知。
// 判定「要不要打扰用户」的策略（前台不打扰、静默、成功/失败文案）在 electron/tray.cjs 里，
// 主进程只负责把「窗口当前是否在前台」这个事实传进去 —— 模块本身不持有窗口，
// 这样它才能被纯 node 单测覆盖。
ipcMain.handle("app:notify-task", (event, payload) => {
  if (!trayCtl) return { ok: false, error: "托盘未就绪" };
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return { ok: false, error: "拒绝：调用方不是本应用窗口" };
  return trayCtl.notify({ ...(payload || {}), focused: win.isFocused() });
});

// 下发布变更令牌：渲染进程所有写操作都要带上它。
// 校验的是「调用方是不是本应用的窗口、且停在我们的服务来源上」——
// 与 AI Change 的 isTrustedMainRendererUrl 同思路，但这里在 Electron 侧做，
// 因为令牌根本不应该出现在任何页面可直接读取的全局对象里（只经由白名单 IPC 按需取）。
ipcMain.handle("app:mutation-token", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const url = win && !win.isDestroyed() ? win.webContents.getURL() : "";
  if (!win || !serverUrl || !url.startsWith(serverUrl)) {
    throw new Error("拒绝：调用方不是本应用窗口");
  }
  return MUTATION_TOKEN;
});

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  buildMenu();
  applyCsp();

  // 自动更新：只初始化一次（在首次建窗之前）。
  // 此处注册 update:check / update:install / update:state，之后 createMainWindow()
  // 只用 setWindow() 换推送目标，重复建窗不会再触发重复注册。
  const updateState = updater.init({ log: logLine, isDev: IS_DEV });
  logLine(
    `品牌：${BRAND.key}（来源 ${BRAND_RESOLVED.source}）· 自动更新：${
      updateState.enabled ? "已启用" : `未启用（${updateState.reason}）`
    }`
  );

  serverUrl = await startServer();
  logLine(`服务地址 ${serverUrl}`);
  logLine("启动完成");

  // 已登录（会话还有效）就直接进主窗，否则先弹登录窗
  if (await isLoggedIn()) {
    createMainWindow();
  } else {
    createLoginWindow();
  }

  // ---------- 托盘（Sprint 2） ----------
  // 常驻入口：窗口收起来后还能拉回来；生成完成的系统通知也走它（策略在其内部）。
  // 依赖注入 Electron 对象，模块本身不 require("electron") —— 这样它能被纯 node 单测。
  trayCtl = createTrayController({
    Tray,
    Menu,
    nativeImage,
    Notification,
    shell,
    iconPath: appIcon(),
    appName: APP_TITLE,
    tooltip: `${APP_TITLE} · 本地创作台`,
    isDev: IS_DEV,
    onShow: () => {
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.show();
        mainWin.focus();
      } else {
        createMainWindow();
      }
    },
    onHide: () => mainWin?.hide(),
    onQuit: () => {
      quitting = true;
      app.quit();
    },
    // 打包版不提供开发者工具入口（托盘菜单也一并封掉，避免「右键托盘」绕过）
    onToggleDevTools: () => {
      if (app.isPackaged) return;
      mainWin?.webContents.toggleDevTools();
    },
    onCheckUpdate: () => mainWin?.webContents.send("update:check"),
    log: logLine
  });
  const trayRes = trayCtl.create();
  logLine(`托盘：${trayRes.ok ? "已就绪" : `创建失败（${trayRes.error}）`}`);
  if (trayRes.ok) trayCtl.setStatus({ text: "就绪" });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  // 托盘先撤：否则 Windows 上图标会残留到鼠标划过才消失
  try {
    trayCtl?.destroy();
  } catch {
    /* ignore */
  }
  if (serverProc && !serverProc.killed) {
    try {
      // worker_threads 没有 kill()，用 terminate() 强制结束（返回 Promise，退出阶段不等）
      serverProc.terminate();
    } catch {
      /* ignore */
    }
  }
});

process.on("uncaughtException", (err) => {
  try {
    const logDir = app.getPath("userData");
    fs.appendFileSync(
      path.join(logDir, "crash.log"),
      `\n[${new Date().toISOString()}] ${err?.stack || err}\n`
    );
  } catch {
    /* ignore */
  }
  dialog.showErrorBox(APP_TITLE, String(err?.stack || err));
});
