# 深拆 C：桌面端 / 构建 / 测试基建 / 文档一致性审计

> 核查对象：`E:\DSH项目\ai-canvas`（版本 **0.2.0**，`package.json:3`）
> 核查日期：2026-10-14
> 核查方式：**逐文件读源码取证**，每条结论附 `文件:行号`。
> 纪律声明：**全程只读**。未执行 `npm install` / `npm run build` / `npm run dist` / 任何写盘构建命令，未修改 `ai-canvas` 下任何源码。
> 唯一执行的命令是一次**纯前端、纯逻辑、不依赖服务端、不写盘**的测试（`node src/__theme.test.mjs`），用于把「测试套件是否真的绿」从推断变成硬证据（见 §0.4、§4.5）。
> 无法确认的一律标 **【未验证】**，不臆测。

---

## 0. 结论摘要

### 0.1 六条最严重问题（按严重度排序）

| # | 严重度 | 问题 | 一句话证据 |
|---|---|---|---|
| 1 | 🔴 阻断验收 | **`npm test` 当前必然失败**：第 9 套件有 1 项断言与代码矛盾 | `src/__theme.test.mjs:52` 断言 `DEFAULT_THEME === "aurora"`，而 `src/theme.js:54` 是 `export const DEFAULT_THEME = "atelier"`。实测输出：`✗ 默认主题是 aurora` → `82 项通过，1 项失败`，exit code 1；`scripts/run-tests.mjs:162-164` 要求 13 套全绿才 exit 0 |
| 2 | 🔴 文档与代码不一致 | **自动更新的用户可见链路是假的**：`UpdateToast.vue` 用 `setInterval + Math.random` 模拟下载进度，「立即重启」只是 `location.reload()`；真正的 `electron-updater` 链路因 preload 未暴露 `update:*` 而**渲染层完全够不到** | `src/components/UpdateToast.vue:40-59`（模拟进度）、`:67-69`（`applyNow(){ location.reload() }`）；`electron/preload.cjs:8-33`（无任何 `update:*`）；`electron/updater.cjs:131-155`（注册了 `update:check/install/state` 但无人能调） |
| 3 | 🔴 文档与代码不一致 | **多品牌白标在打包链路上不成立**：`BRAND` 只被 `server/brand.js` 在运行时读取，electron-builder 的 `appId / productName / artifactName / shortcutName` 全是硬编码「跨多多」 | `package.json:16-17`（脚本设 BRAND）、`package.json:43-44 / 73 / 79`（静态跨多多）、`server/brand.js:25`（运行时读 `process.env.BRAND`）。安装后从快捷方式启动不会带 BRAND → 回落 `kuaduoduo`（`server/brand.js:13,26`） |
| 4 | 🟠 潜在白屏 | **打包版「登出→登录」会让主窗停在未加载状态**：`updater.init()` 被放在 `createMainWindow()` 内，每次建主窗都重复注册同一个 IPC handler | `electron/main.cjs:323`（`updater.init` 在 `loadURL` **之前**）、`electron/main.cjs:324`（`mainWin.loadURL(serverUrl)`）；`electron/updater.cjs:131,144,151`（`ipcMain.handle` 重复注册会抛异常）。触发路径：`main.cjs:462-474`（auth:success/auth:logout）→ `main.cjs:376-382`。**【未验证】**：未实机复现，属静态推证 |
| 5 | 🟠 工具链失效 | **`build-installer.bat` 打开的是错误的目录**：它去 `dist\*.exe` 找安装包，而 electron-builder 输出目录是 `release/` | `build-installer.bat:34`（`dir /b "dist\*.exe"`）、`:37`（`explorer "dist"`）vs `package.json:45-47`（`"directories": { "output": "release" }`）、`使用说明.md:58`（自己写的是 `release/`） |
| 6 | 🟡 文档卫生 | **12 份执行文档全部冻结在 2026-09-25，而代码在其后经历了 `V1003.01`–`V1003.09` 至少 9 轮改动**，导致界面层文档（11/12/13/14）的「现状」段系统性过期 | 文档日期见各文档首部（如 `14-...md:3`）；代码版本标记：`src/theme.js:51`、`src/style.css:38,201,4774,6927,7429,7622,7778,7971`、`src/App.vue:58`、`src/components/AppShell.vue:43,63,107` |

### 0.2 需要修正任务描述里的一处前提错误

任务描述第 1 项写「动态端口选择（`src/ports.js` 如何配合）」——**`src/ports.js` 与网络端口毫无关系**。

- `src/ports.js:1-15` 文件头写明它是「**端口类型系统（P0-9 · 强类型端口）**」，导出的是 `DATA_TYPES` / `NODE_PORTS` / `validateConnection` / `edgeStyleFor`，用于**画布连线的数据类型校验与边着色**。
- 动态端口选择实现在 `electron/main.cjs:87-97`（自己的 `pickPort()`，`net.createServer().listen(0)`），**与 `src/ports.js` 无任何引用关系**：全仓对 `ports.js` 的引用**只有一处**——`src/components/NodeCanvas.vue:19`（`import { validateConnection, decorateEdge, edgeStyleFor, typeColor } from "../ports.js"`），是画布连线校验用途。
- 二者同名纯属巧合，容易误导后续维护者。

### 0.3 文件与测试规模实测

| 项 | 文档口径 | 实测 | 结论 |
|---|---|---|---|
| 测试文件数 | 13（任务描述） | **14 个** `__*.test.mjs` | 见 §4.1：13 个由 `run-tests.mjs` 直接挂接，第 14 个 `server/__vault.test.mjs` 由 `__sync.test.mjs` 以子进程方式间接执行，**全部 14 个都会跑** |
| 测试套件数 | 9（12 号文档）/ 11（14 号）/ 13（15 号） | **13**（`scripts/run-tests.mjs:93-140` 的 r1–r13） | 15 号文档口径正确 |
| 运行断言总数 | 未统一 | 静态顶层 `check(` 合计 **≈ 520 项**（含循环展开后约 540 项） | 见 §4.2 逐套件表 |

### 0.4 本次唯一实际执行的命令（只读、不写盘）

```
AI_CANVAS_HOME=<%TEMP% 下临时路径> node src/__theme.test.mjs
→ ✗ 默认主题是 aurora
→ 主题与批量模式：82 项通过，1 项失败
→ [exit code: 1]
```

该文件只 import `src/theme.js` / `src/batchmode.js` / `src/store.js` 并读取 `src/themes.css`，不起服务端、不写任何文件。它证明了文档 12/13/14/15 反复声称的「套件全绿」在当前代码上**不成立**。

---

## 1. Electron 主进程（`electron/main.cjs`，535 行）

### 1.1 单实例锁

| 结论 | 证据 |
|---|---|
| 用 `app.requestSingleInstanceLock()` 加锁，拿不到锁直接退出 | `electron/main.cjs:24-27` |
| 第二实例被激活时，把已有窗口 restore + show + focus | `electron/main.cjs:29-35`（目标是 `mainWin \|\| loginWin`） |

单实例锁的必要性代码里有解释：不加锁会起两个服务抢同一端口（`main.cjs:23`）。

### 1.2 动态端口选择

| 结论 | 证据 |
|---|---|
| `pickPort()` 用 `net.createServer().listen(0,'127.0.0.1')` 让系统分配空闲端口，成功后立刻 close 并返回端口号 | `electron/main.cjs:87-97` |
| 监听失败时兜底返回 5181 | `electron/main.cjs:91`（`srv.on("error", () => resolve(5181))`） |
| 端口通过 `PORT` 环境变量传给被 fork 的 `server/index.js`，并把监听地址固定为 `127.0.0.1` | `electron/main.cjs:106-109`（`env: { ..., PORT, AI_CANVAS_BIND: "127.0.0.1" }`） |
| 开发模式下不自己起服务，直接用 `AI_CANVAS_DEV_URL` | `electron/main.cjs:19-20, 101` |
| 最多等 25 秒，超时弹错误框并 `app.exit(1)` | `electron/main.cjs:121-132`（就绪探针是 `GET {url}api/session`，`main.cjs:140`） |

> **注意一个已知坑位**：`pickPort()` 是「先探测再关闭再交给子进程」的经典 TOCTOU 写法。窗口期极短，实际风险低，但严格说不能保证端口不被抢。**【未验证】**：未观测到实际抢占。

### 1.3 登录窗与主窗

| 结论 | 证据 |
|---|---|
| 是否已登录：先取本地会话令牌，再带 `X-AI-Canvas-Token` 查 `/api/auth/status`（不带令牌会永远 `loggedIn=false`，登录窗每次弹） | `electron/main.cjs:153-167` |
| 登录窗 440×620，`frame:false`、不可缩放，`additionalArguments:["--app-window=login"]` | `electron/main.cjs:250-272` |
| 主窗基准 1440×900、最小 1180×720（方案 §3 要求） | `electron/main.cjs:296-304` |
| 登录成功：建主窗 → 销毁登录窗；登出：先建登录窗再销毁主窗 | `electron/main.cjs:376-382`（`switchToMain`）、`:468-474`（`auth:logout`） |
| 登录窗被直接关掉（未登录成功）→ 退出应用 | `electron/main.cjs:287-291` |
| 主窗被关 → 退出应用 | `electron/main.cjs:369-372` |
| 双屏独立窗口：仅同源且 url 含 `window=popout` 才允许开真实子窗，其余一律 `shell.openExternal` + deny | `electron/main.cjs:328-352` |
| 窗口状态持久化：位置/尺寸写 `userData/window-state.json`，还原前校验目标点仍在某个显示器 workArea 内（防拔外接屏后跑到屏外） | `electron/main.cjs:38-84`（`restoredBounds` `:58-73`） |
| 渲染进程崩溃弹可读提示而非静默白屏 | `electron/main.cjs:365-367` |
| 崩溃日志写 `userData/crash.log` + 弹框 | `electron/main.cjs:524-535` |
| 启动诊断日志（含渲染层 console）写 `userData/boot.log` | `electron/main.cjs:213-247` |

### 1.4 应用菜单

`buildMenu()` 在 `main.cjs:387-445`，四项：编辑 / 视图 / 窗口 / 帮助。代码注释写明必要性：frameless 窗口没有原生菜单栏，但**必须注册 Menu 才能让 Ctrl+C/V/A/Z 生效**（`main.cjs:385-386`）。

- 编辑：undo/redo/cut/copy/paste/selectAll（`main.cjs:391-402`）
- 视图：reload/forceReload/resetZoom/zoomIn/zoomOut/togglefullscreen，**DevTools 仅在 `IS_DEV` 时出现**（`main.cjs:414`）
- 帮助：打开日志目录、关于（版本/Electron/Chromium）（`main.cjs:424-442`）

### 1.5 CSP 设置

`applyCsp()` 在 `main.cjs:182-208`，通过 `session.defaultSession.webRequest.onHeadersReceived` 注入。完整策略（`main.cjs:184-198`）：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*;
media-src 'self' blob: data:; worker-src 'self' blob:;
object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

评估：

- ✅ `script-src 'self'` 无 `unsafe-inline`/`unsafe-eval`，是强策略；`object-src 'none'`、`base-uri 'self'`、`frame-ancestors 'none'` 都在。
- ✅ 代码注释解释了 `style-src` 必须放开 inline（Element Plus 写行内样式，`main.cjs:187-188`）。
- ⚠️ **`img-src 'self' data: blob:` 不含任何外部 https**。当前 UI 不引用外部图（全仓 `.vue` 中无外部图片 URL，实测 grep 无命中），所以现在没问题；但一旦产品图/公告图改走 OSS 直链，会被 CSP 拦掉，且**表现为「图裂」而非报错**。属于潜在坑，非当前 bug。
- ⚠️ CSP 只在 Electron 层注入，网页版（`npm run server` + 浏览器）没有 CSP。**这是设计分层，不是遗漏**，但意味着网页部署形态少一道防护。

### 1.6 preload 暴露的桥接 API（逐个列出）

`electron/preload.cjs:8-33`，一次性挂到 `window.desktop`，共 **11 个成员**：

| # | 成员 | 类型 | 对应 IPC | 行号 |
|---|---|---|---|---|
| 1 | `isDesktop` | 常量 `true` | —（前端据此判断是否桌面端） | `preload.cjs:9` |
| 2 | `platform` | `process.platform` | — | `preload.cjs:10` |
| 3 | `windowMode` | `"login" \| "main"` | 来自 `additionalArguments` | `preload.cjs:5-6, 12` |
| 4 | `minimize()` | invoke | `window:minimize` | `preload.cjs:15` |
| 5 | `toggleMaximize()` | invoke | `window:toggle-maximize` | `preload.cjs:16` |
| 6 | `close()` | invoke | `window:close` | `preload.cjs:17` |
| 7 | `isMaximized()` | invoke | `window:is-maximized` | `preload.cjs:18` |
| 8 | `onWindowState(cb)` | on（返回取消订阅函数） | `window:state` | `preload.cjs:19-23` |
| 9 | `notifyLoginSuccess()` | invoke | `auth:success` | `preload.cjs:27` |
| 10 | `notifyLogout()` | invoke | `auth:logout` | `preload.cjs:29` |
| 11 | `info()` / `openLogs()` | invoke | `app:info` / `app:open-logs` | `preload.cjs:32-33` |

安全设置：`contextIsolation: true`、`nodeIntegration: false`（`main.cjs:268-270, 312-313, 344-345`）。

**缺口（对应 §0.1 第 2 条）**：主进程侧 `updater.cjs` 注册了 `update:check` / `update:install` / `update:state` 三个 invoke handler，并向渲染层 send 了 `update:checking / available / none / progress / downloaded / error` 六个事件（`updater.cjs:93-155`），但 preload **一个都没转出**。因此：

- 渲染层调不到检查更新；
- 渲染层也收不到真实进度事件；
- `src/components/UpdateToast.vue` 因此另起炉灶写了套假的（见 §2.4）。

这正是总技术文档自己列的待办：`跨多多AI创作台-完整技术总文档.md:1147`「把 `update:*` 三个 IPC 通道接到 preload（否则界面不能手动点检查更新）」——**该待办仍然未办**。

---

## 2. 自动更新（`electron/updater.cjs`，165 行）

### 2.1 OSS feed 地址

| 结论 | 证据 |
|---|---|
| feed 地址不在 `updater.cjs` 里，而由 electron-builder 打包时依据 `package.json` 的 `build.publish` 生成 `app-update.yml` | `package.json:58-63`；`updater.cjs:37-40`（读 `process.resourcesPath/app-update.yml`） |
| **当前仍是占位符**：`https://REPLACE-WITH-YOUR-OSS.oss-cn-beijing.aliyuncs.com/releases/` | `package.json:61` |
| 上传脚本自己会检测并告警这个占位符 | `scripts/upload-release.mjs:81-87` |

### 2.2 版本门控与差异更新

| 结论 | 证据 |
|---|---|
| 差异更新门槛常量 `DIFFERENTIAL_MIN_VERSION = "0.2.0"` | `updater.cjs:15` |
| 当前版本低于门槛 → `autoUpdater.disableDifferentialDownload = true`，强制走全量包 | `updater.cjs:86-91` |
| 版本比较是自己写的 `parseVersion` + `isVersionAtLeast`（三段数字逐位比） | `updater.cjs:22-35` |
| 门控设计动机写在文件头：blockmap 差异包对老客户端不兼容，硬上会把用户装坏，第一版必须全量 | `updater.cjs:6-8, 13-14` |
| `autoDownload = true`、`autoInstallOnAppQuit = true`、`logger = null` | `updater.cjs:82-84` |
| 启动后延迟 8 秒检查一次 | `updater.cjs:158-160` |
| 更新失败只记日志 + send 事件，**绝不弹窗打断使用** | `updater.cjs:125-129` |
| `quitAndInstall(false, true)`：显示 NSIS 安装界面、装完自动拉起 | `updater.cjs:144-149` |

> `DIFFERENTIAL_MIN_VERSION` 写死 `"0.2.0"` 与当前 `package.json` 版本相同，符合文档要求「首次发版应等于当前版本」（`4-支付与自动更新与白标-深度实施文档.md:516`）。

### 2.3 `server/update-feed.json` 的作用（与 electron-updater **无关**）

这是一个**容易被误认为属于自动更新链路**的文件：

| 结论 | 证据 |
|---|---|
| 内容：`latest: "0.2.0"`、`releasedAt`、`size`、`notes`、`autoCheck` | `server/update-feed.json:1-7` |
| 由 Express 的 `GET /api/version` 读取（优先 `UPDATE_FEED_JSON` 环境变量，其次本地文件） | `server/index.js:478-504` |
| 与 `package.json` 的 version 比较算出 `hasUpdate`，供前端 `fetchVersion()` 使用 | `server/index.js:492-503`；`src/components/UpdateToast.vue:21` |
| **`electron/updater.cjs` 完全不读它**（全文件无 `update-feed` 字样） | `grep update-feed` 仅命中 `server/index.js:479,486` |

**根本问题**：`update-feed.json` 位于 `server/`，而 `package.json:50` 把 `server/**/*` 打进安装包。也就是说它是**随安装包一起被冻结的静态文件**，安装后永远不会被远端更新。再叠加 `latest === 当前版本`，`hasUpdate` 恒为 `false` → 前端更新提示**永远不会出现**。这个 feed 机制在打包形态下是死路。

### 2.4 前端「更新提示」的真实形态

`src/components/UpdateToast.vue`：

| 文档/常识预期 | 代码实际 | 证据 |
|---|---|---|
| 真实下载进度来自 `update:progress` | **定时器 + 随机数模拟**：60ms 步进、5.5 秒走完、`0.6 + Math.random()*0.85` 抖动 | `UpdateToast.vue:40-59` |
| 点「立即重启」安装新版本 | `function applyNow() { location.reload(); }` —— 只是刷新页面 | `UpdateToast.vue:67-69` |
| 与 electron-updater 联动 | 只调 `fetchVersion()`（即 `/api/version`），不碰任何 `update:*` IPC | `UpdateToast.vue:3, 21, 76-81` |
| 已下载标记 | 写 `localStorage` 的 `ai-canvas:update-downloaded` | `UpdateToast.vue:8, 53-57` |

**结论：用户看到的「自动更新」是纯视觉演示，不会安装任何东西。** 真正能装的 `electron-updater` 路径因为 preload 未桥接（§1.6）而无法从界面触发。

### 2.5 是否可直接用于生产

**不可以。** 发布前至少还缺：

| # | 缺口 | 证据 |
|---|---|---|
| 1 | `build.publish.url` 仍是 `REPLACE-WITH-YOUR-OSS` 占位符 | `package.json:61` |
| 2 | preload 未暴露 `update:*`，界面无法检查/安装 | `preload.cjs:8-33` vs `updater.cjs:131-155` |
| 3 | `server/update-feed.json` 被打进包后无法远端更新，前端提示恒不触发 | `package.json:50`、`server/update-feed.json:2`、`server/index.js:494-498` |
| 4 | 从未产出 `release/`，因此没有 `latest.yml` / `.blockmap` 可供上传 | 实测 `release/`、`dist/` 均不存在 |
| 5 | 无代码签名配置（`build.win` 无 `certificateFile` 等）→ 安装包未签名，SmartScreen 会告警 | `package.json:64-74`（win 段只有 target/artifactName） |
| 6 | `updater.init()` 的重复注册问题（§0.1 第 4 条） | `main.cjs:323` + `updater.cjs:131` |

> 文档 4 号 §2.10 的上线检查清单（`4-...md:509-517`）本身写得是对的，7 条里当前**一条都没满足**。

---

## 3. 构建链与白标

### 3.1 `vite.config.js`

| 项 | 内容 | 证据 |
|---|---|---|
| 插件 | `vue()` + 自定义 `stripGeneratedSources()` | `vite.config.js:45` |
| `stripGeneratedSources` | 构建后从 `dist/templates/` 删除 `A_clean_modern_marketing_illus_*.png`（生成用原图，单张 1–2MB），带 try/catch 容错 | `vite.config.js:16-42` |
| `build.outDir` | `dist` | `vite.config.js:47` |
| `build.emptyOutDir` | `true`，注释记录了真实踩坑：设 false 会累积历史产物，`index.html` 引用旧 bundle，表现为「改了代码页面没变」 | `vite.config.js:48-51` |
| `server.port` | 5180 | `vite.config.js:54` |
| `server.proxy` | **仅 `/api` 与 `/outputs`** → `http://127.0.0.1:5181` | `vite.config.js:55-58` |
| `base` | **未设置**（默认 `"/"`） | `vite.config.js:44-59` 无 `base` 字段 |

关于 `base`：**不设才是对的**，因为桌面端不是用 `file://` 加载 `dist/index.html`，而是由内置 Express 通过 `http://127.0.0.1:<port>/` 提供（`main.cjs:120, 324`；`server/index.js:1009` 的 `express.static(dist)`）。所以绝对路径 `/assets/...`、`/brand/logo-mark.png`（`index.html:6`）都能正常工作。**这一点容易被误判成 bug，特此说明。**

⚠️ **实测发现一处代理缺口（开发模式专属）**：服务端把素材 URL 生成为 `/materials/<cat>/<file>`（`server/index.js:808, 863`），并由 `app.use("/materials", express.static(materialDir()))` 提供（`server/index.js:1007`）。但 `vite.config.js:55-58` 的代理**没有 `/materials`**。因此 `npm run dev`（Vite :5180）下素材库图片会 404，而 `npm run desktop`/生产形态下正常。属于**只在开发模式暴露的静默缺陷**。

### 3.2 electron-builder 配置（`package.json:42-81`）

| 项 | 值 | 行号 |
|---|---|---|
| appId | `com.kuaduoduo.ai-canvas` | `:43` |
| productName | `跨多多 AI 创作台`（**静态**） | `:44` |
| 输出目录 | `release` | `:45-47` |
| files | `dist/**/*`、`server/**/*`、`electron/**/*`、`config/**/*`、`package.json` | `:48-54` |
| extraMetadata.main | `electron/main.cjs` | `:55-57` |
| publish | `generic` + 占位符 URL | `:58-63` |
| win.target | `nsis` / `x64` | `:64-74` |
| artifactName | `kuaduoduo-ai-canvas-${version}-setup.${ext}`（**静态**） | `:73` |
| nsis | `oneClick:false`、允许改安装目录、创建桌面快捷方式、`shortcutName:"跨多多 AI 创作台"`（**静态**） | `:75-80` |
| 图标 | 未显式配置 `win.icon`，依赖 electron-builder 默认取 `build/icon.ico`（文件存在，77216 字节） | 实测 `build/icon.ico` 存在 |

### 3.3 多品牌白标：三条链路只接通了一条

文档 4 号 §3.2 描述的链路是：`config/brand.json` → `BRAND` 选 key → `server/brand.js` → `GET /api/brand` → 前端 `--brand`。

| 环节 | 是否接通 | 证据 |
|---|---|---|
| ① 配置源 | ✅ | `config/brand.json:3-15`（kuaduoduo）、`:16-28`（oem-a）、`:29-41`（oem-b）三套 |
| ② 运行时选 key + 非法兜底 | ✅ | `server/brand.js:24-27`（`readAll()[key] ? key : DEFAULT_KEY`，非法 key 静默回落 `kuaduoduo`）；字段补全 `:30-48` |
| ③ 下发接口 | ✅ | `server/index.js:233`（`GET /api/brand`） |
| ④ 前端落到 CSS 变量 | ✅ | `src/App.vue:67-72`（`setProperty("--brand", b.primary)` / `--brand-deep`）；`:73-74` 注释明确**不再内联写 `--primary`**，让 `themes.css` 的 `var(--brand)` 生效 |
| ⑤ 主题契约「`--primary` 一律写成 `var(--brand)`」 | ✅ | `src/__theme.test.mjs:111` 对每套主题断言 `--primary: var(--brand)` |
| ⑥ **打包产物品牌化** | ❌ **未接通** | electron-builder 全部品牌相关字段是静态值（`:43,44,73,79`）；`BRAND` 只出现在 `package.json:16-17` 的 npm 脚本里，**不会写进安装包，也不会在启动时被设置** |

**后果**：`BRAND=oem-a npm run dist` 产出的安装包与默认包**在品牌上完全相同**——安装路径、快捷方式名、窗口标题、`appId`、产物文件名全是「跨多多 / kuaduoduo」。从快捷方式启动时 `process.env.BRAND` 为空 → `brand.js:25-26` 回落 `kuaduoduo` → 连界面内的品牌色/名称也回到跨多多。**文档 4 号 §3.3「三品牌切换实测通过」只证明了 `node -e` 直接调 `brand.js` 时成立，不覆盖打包形态。**

另有两个白标细节问题：

- 三个品牌的 `logo` 字段**指向同一个文件** `/brand/logo-mark.png`（`config/brand.json:12, 25, 38`），所以文档 4 号 §3.1 承诺的「换 logo」实际上换不了（除非改 JSON 指向别的文件，而 `public/brand/` 下只有 `logo-mark.png` 与 `logo.png` 两个文件）。
- 所有品牌共用同一个 `artifactName`（`package.json:73`），多个 OEM 包会**互相覆盖**在 `release/` 里。

### 3.4 两个 .bat 各自做了什么

**`build-installer.bat`（38 行）**：

1. `chcp 65001` + `cd /d "%~dp0"`，切到脚本所在目录（`:2-3`）
2. 校验 `package.json` 存在，否则报错退出（`:11-16`）
3. 清掉 `NODE_OPTIONS` 与 `ELECTRON_RUN_AS_NODE`（`:18-19`）
4. `call npm run dist`（`:21`）
5. 失败则打印提示 + `pause` + `exit /b 1`（`:23-28`）
6. 打印 `dir /b "dist\*.exe"` 并 `explorer "dist"`（`:34, 37`）——**❌ 目录错了**，见 §0.1 第 5 条

**`run-desktop.bat`（34 行）**：

1. 同样的 `chcp` + `cd /d`（`:2-3`）
2. 校验 `package.json`（`:11-16`）
3. `node_modules\electron` 不存在时自动 `call npm install`（`:18-21`）
4. 清干扰变量（`:26-28`）
5. `call npm run desktop`（= `vite build && electron .`，`:30`），退出后 `pause`（`:33`）

### 3.5 其他构建/发布脚本

| 文件 | 结论 | 证据 |
|---|---|---|
| `scripts/upload-release.mjs`（145 行） | 实现完整：检查 `release/` 三件套（exe / blockmap / latest.yml）、比对 `latest.yml` 与 `package.json` 版本、占位符告警、三种上传方式自动降级（ossutil → ali-oss → 打印手动清单），任一失败非 0 退出 | `:43-61`（产物检查）、`:64-72`（版本一致性）、`:81-87`（占位符）、`:90-140`（三路降级） |
| `scripts/rebrand-logo.py`（117 行） | **❌ 已不可用**：源图与输出目录都是硬编码的旧机器绝对路径 | `:21`（`C:\Users\Administrator\Desktop\Codex 图像 2026年9月26日 00_15_02.png`）、`:22-23`（`C:\Users\Administrator\WorkBuddy\2026-09-08-19-23-01\ai-canvas\...`）。当前工程在 `E:\DSH项目\ai-canvas`，脚本一跑就 `FileNotFoundError`。算法本身（黑底 unpremultiply + 蓝色密集列定位）写得有据可查，但**只能作为历史记录，不能作为工具** |
| `test_gen.py`（33 行，根目录） | 手工冒烟脚本：POST `/api/generate` 打 SSE 并打印 progress/done/error。属于遗留开发脚本 | `:1-33` |
| `__probe.mjs`（33 行，根目录） | 遗留探针脚本，**会直接覆写真实账本** `~/.ai-canvas/credits-ledger.json` | `:5`（目标路径）、`:22-24`（`readFileSync` 后 `writeFileSync` 原路径覆写）。总技术文档已把它列入待清理项（`跨多多AI创作台-完整技术总文档.md:1149`），**至今仍在** |

---

## 4. 测试基建

### 4.1 套件总表（`scripts/run-tests.mjs`）

`run-tests.mjs` 的机制：`mkdtempSync` 建临时数据目录（`:17`）→ 选空闲端口（`:19-27`）→ 拉起一个被环境变量隔离的服务端实例（`:61-73`）→ 顺序跑 13 个套件 → 杀掉服务端、删临时目录（`:142-144`）→ 汇总，任一失败 exit 1（`:146-164`）。

隔离用的服务端环境变量（`:67-72`）：`AI_CANVAS_HOME`、`AI_CANVAS_OUTPUTS`、`PORT`。

| # | 套件名（脚本里的中文名） | 文件 | 测什么 | 需要服务端 | 专属环境变量 |
|---|---|---|---|---|---|
| r1 | 算力账本自测 | `server/__credits.test.mjs` | 预扣 / 提交 / 回滚 / 重复回滚去重 / 并发 | 否 | HOME / OUTPUTS |
| r2 | 支付回调查验 · 安全测试 | `server/__payments.test.mjs` | 伪造签名 / 无签名 / 金额不符 / 重复回调幂等 / 旧 `/paid` 已 404 | 是 | HOME / OUTPUTS / BASE |
| r3 | 吸收项自测 | `server/__sync.test.mjs` | 签名规则 / 批量进度落盘 / 模板反哺 / 保险箱分文件（含 spawn `__vault`） | 否 | HOME / OUTPUTS |
| r4 | 吸收项 HTTP 端到端 | `server/__sync-http.test.mjs` | `/api/batch`、模板反哺接口、生成入参透传 | 是 | HOME / OUTPUTS / BASE |
| r5 | P1-8 签名（单元） | `server/__p18.test.mjs` | 签名字段进出、缓存命中/隔离/TTL/sweep、与账本协同 | 否 | HOME / OUTPUTS |
| r6 | P1-8 签名（接口） | `server/__p18-http.test.mjs` | 真实 HTTP + SSE：改备注重跑零扣费、改提示词真扣费、视频幂等 | 是 | HOME / OUTPUTS / BASE |
| r7 | 新界面层 | `src/__ui.test.mjs` | 命名清洗、CRC32 已知值、ZIP 结构、项目持久化、资产去重、缩放分档 | 否 | HOME / OUTPUTS / `UI_TEST_OUT` |
| r8 | 图生图入参 | `server/__i2i.test.mjs` | 万相/即梦/OpenAI/Gemini 请求体里**真的带了图片字节** | 否 | HOME / OUTPUTS / `AI_CANVAS_VAULT=file` |
| r9 | 主题与批量模式 | `src/__theme.test.mjs` | 主题注册表、id 归一化、`themes.css` token 齐全、EP 变量对接、批量纯逻辑 | 否 | HOME |
| r10 | 健壮性补齐 | `src/__robust.test.mjs` | 错误分级、任务真取消钩子、素材路径穿越、项目排序 | 否 | HOME |
| r11 | 取消端到端 | `server/__cancel.test.mjs` | 自带假 ComfyUI，断言 `/interrupt` 真被请求 | 否（自建 HTTP） | HOME / VAULT=file |
| r12 | 多图融合 | `server/__ipadapter.test.mjs` | 喂假 `/object_info`，断言 N 张图都进融合链、KSampler 指向链尾 | 否 | HOME / VAULT=file / OUTPUTS |
| r13 | 资产血缘 | `server/__lineage.test.mjs` | sidecar 读写往返、路径压平、摘要诚实性、按 taskId 反查 | 否 | HOME / VAULT=file / OUTPUTS |
| （间接） | 凭据保险箱 | `server/__vault.test.mjs` | 一条密钥一个 `.enc`、无明文、AES-256-GCM 四要素、旧单文件迁移 | 否 | 由 r3 以子进程注入 `AI_CANVAS_VAULT=file`（`__sync.test.mjs:117-122`） |

> **关于「13 个测试文件」**：磁盘上共 **14** 个 `__*.test.mjs`。`run-tests.mjs` 直接挂接 13 个（r1–r13），第 14 个 `server/__vault.test.mjs` 由 `__sync.test.mjs` 起子进程执行并用 `vp.status === 0` 断言（`__sync.test.mjs:117-122`）。**结论：14 个文件全部会被 `npm test` 执行**，只是套件计数为 13。这一点单独说明，因为它极易被误判成「有个测试文件漏跑了」。

### 4.2 断言语义强度（静态计数）

| 套件 | 文件行数 | `check(` 顶层调用 | 文档声称 | 说明 |
|---|---|---|---|---|
| r1 credits | 77 | 16 | 16（7 号文档） | ✅ 吻合 |
| r2 payments | 176 | 14 | 14（4/7 号文档） | ✅ 吻合 |
| r3 sync | 126 | 29 | 29（7 号文档） | ✅ 吻合 |
| r4 sync-http | 103 | 15 | 15（7 号文档） | ✅ 吻合 |
| r5 p18 | 254 | 45（+2 处循环展开 ≈ 54） | 55（8 号文档） | ≈ 吻合（差 1，可能还有一处循环） |
| r6 p18-http | 212 | 24（含循环） | 23（8 号文档） | ≈ 吻合 |
| r7 ui | 144 | 40 | 41（9 号文档） | ≈ 吻合 |
| r8 i2i | 301 | 64 | 64（10 号文档） | ✅ 吻合 |
| r9 theme | 219 | 73（+循环） | 86→83（12/14 号文档） | **实测运行 83 项，其中 1 项失败**（§0.4） |
| r10 robust | 192 | 52 | 未给数 | 实测运行 54 项通过 / 0 失败 |
| r11 cancel | 142 | 8 | 8（14 号文档） | ✅ 吻合 |
| r12 ipadapter | 332 | 61 | 62（15 号文档） | ≈ 吻合 |
| r13 lineage | 171 | 49 | 49（15 号文档） | ✅ 吻合 |
| vault | 77 | 13 | 4（7 号文档只算 sync 内的 4 项） | 单独文件有 13 项；7 号文档口径是 `__sync` 内联的那 4 项，两者不冲突 |

> 说明：「顶层调用数」是静态 grep `^\s*check\(` 的结果；断言若写在 `for` 循环体内（如 `__p18.test.mjs:73-85` 的 9 次迭代、`:197` 的 marks 循环），运行时会展开。因此文档里的数量级基本可信，**不存在虚报断言数的问题**。

### 4.3 离线化手段（逐条核实）

| 手段 | 实现 | 证据 |
|---|---|---|
| 临时数据目录 | `AI_CANVAS_HOME` → `mkdtempSync(os.tmpdir()/ai-canvas-test-)`，跑完 `rmSync` | `scripts/run-tests.mjs:17, 69, 88, 144`；`server/paths.js:12-14` |
| 临时产物目录 | `AI_CANVAS_OUTPUTS`，服务端与测试进程**两边都注入**（否则缓存永不命中、并发槽泄漏） | `run-tests.mjs:64-71`（服务端）、`:89`（测试）、注释 `:64-66` 记录了这个坑 |
| 强制文件保险箱 | `AI_CANVAS_VAULT=file`，不碰系统凭据管理器 | `server/vault.js:34`；r8/r11/r12/r13 注入（`run-tests.mjs:109,125,131,138`）；`__vault.test.mjs:22-25` 还硬性校验后端是 file，否则拒绝运行 |
| 空闲端口 | `pickPort()` + `PORT` 环境变量 + `BASE` 传给 HTTP 套件 | `run-tests.mjs:19-27, 55-56, 71, 90` |
| 假 ComfyUI | 本地 `http.createServer` 实现 `/prompt`、`/history`（永远不完成）、`/interrupt`（计数） | `server/__cancel.test.mjs:36-68` |
| 假 `/object_info` | 直接喂 fixture，IPAdapter 探测与工作流构建全走纯函数 | `server/__ipadapter.test.mjs:1-13`（文件头）、`server/providers/ipadapter.js`（纯函数模块） |
| fetch 打桩 | `globalThis.fetch` 被替换为记录器，未打桩的 URL 直接抛错（防止偷跑真实网络） | `server/__i2i.test.mjs:57-75` |
| 硬闸门 | `__i2i.test.mjs` 在缺少 `AI_CANVAS_HOME` 时**拒绝运行**，防止写脏真实配置 | `server/__i2i.test.mjs:16-22` |
| 子进程隔离 | TTL 场景与保险箱迁移场景各起一个子进程，避开模块级副作用 | `__p18.test.mjs:190-194`；`__sync.test.mjs:117-121` |
| localStorage mock | 前端纯逻辑测试注入内存版 localStorage | `src/__ui.test.mjs:15-22` |

**评价：离线化做得很扎实**，尤其「未打桩 URL 直接抛错」和「缺 HOME 拒绝运行」两处，是防漂移的好设计。

### 4.4 断言覆盖的真实边界（哪些是真边界）

**强断言（值得肯定）**：

| 断言 | 为什么是真边界 | 证据 |
|---|---|---|
| 四家 provider 的请求体里真的有图片字节 | 不看返回值，只看「发出去什么」。静默丢图的 bug 不报错，只能这样抓 | `__i2i.test.mjs:1-5`（设计声明）、`:61-75`（抓取 init/body） |
| `/interrupt` 真的被请求（带命中计数） | 区分「断开本地连接」与「真的停上游」 | `__cancel.test.mjs:7-13, 37, 51-53` |
| `KSampler.model` 必须指向融合链末端，不能直连 checkpoint | 结构断言，能锁住「N 张图只生效 1 张」这类静默偷工 | `__ipadapter.test.mjs` 中该断言；15 号文档 `:127-130` 引用 |
| CRC32 用标准已知值（`'hello'`→`0x3610a686`、`'123456789'`→`0xcbf43926`） | 自写 ZIP 打包器最容易在 CRC 上出错，用公开测试向量是正确做法 | `__ui.test.mjs:52-57` |
| ZIP 的 EOCD / 本地头签名 / UTF-8 flag / 中文文件名逐字段校验 | 手写二进制格式必须逐字段验 | `__ui.test.mjs:62-83` |
| 保险箱文件内不含明文 + AES-256-GCM 四要素齐全 | 直接读盘检查，不是读 API 返回值 | `__vault.test.mjs:43-46` |
| 跨账号缓存不命中 | 防跨账号白嫖，含反向用例 | `__p18.test.mjs:146-147` |
| 签名「该变的变、不该变的不变」双向覆盖（含 9 个字段的正向变化） | 只测一个方向会漏掉「签名过于宽松」的白嫖漏洞 | `__p18.test.mjs:57-85` |
| `themes.css` 每套主题 38 个 token 齐全 + `--primary: var(--brand)` 派生 | 换肤最常见的 bug 就是漏 token，逐项断言合理 | `__theme.test.mjs:92-113` |

### 4.5 断言过弱 / 假通过风险（**必有清单**）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | **r9 有一项断言与代码矛盾，导致整个 `npm test` 红** | `src/__theme.test.mjs:52`（`DEFAULT_THEME === "aurora"`）vs `src/theme.js:54`（`= "atelier"`）。实测：`✗ 默认主题是 aurora`，`82 通过 / 1 失败`，exit 1 | 这是**反向问题**（不是过弱而是过期），但后果最严重：`run-tests.mjs:162-164` 要求 13 套全绿，因此 `npm test` 恒失败 |
| 2 | **缩放分档测的是测试自己重写的函数，不是产品代码** | `src/__ui.test.mjs:133-141`：`const tierOf = (z) => (z < 0.5 ? "far" : z > 1.1 ? "near" : "mid");` 定义在测试文件里；注释 `:133` 自认「与 NodeCanvas 同逻辑」。产品侧阈值若改成 `0.6`，这 7 条断言**照样全绿** | 典型的「自证式测试」，对该功能零保护力 |
| 3 | **ZIP「真实解压校验」没有自动化** | `src/__ui.test.mjs:85-90` 只把 zip 落盘 + 断言 `fs.existsSync`。文档 9 号 §0 声称「用 python `zipfile` 真实解压 + CRC 校验通过」（`9-...md:20`），但全仓 `grep zipfile|python` 只命中这一行注释（`__ui.test.mjs:85`），**没有任何 Python 调用** | 文档把一次人工验证写成了自动化验证 |
| 4 | **条件守卫会静默跳过断言，且无「最少断言数」兜底** | `src/__p18.test.mjs:214-216`：`if (cashHit) { check("命中缓存时不产生任何账本流水", ...) }`。若 `cacheGet` 真的坏了（这正是本套件要抓的 bug），`cashHit` 为 null → 该断言**根本不执行** → `fail` 仍为 0 → `process.exit(fail ? 1 : 0)` 退出 0 | 结构性命中盲区。同类：`:231-237` 的 `replay` 三元分支。所幸 `:142-148` 有无条件的缓存命中断言兜住了一部分 |
| 5 | **全部 14 个测试文件都只以 `fail === 0` 判定成功，无最小断言数断言** | 逐文件核实：`__ui:144`、`__theme:219`、`__vault:77`、`__robust:192`、`__sync:126`、`__sync-http:103`、`__payments:176`、`__p18:254`、`__p18-http:212`、`__lineage:171`、`__ipadapter:332`、`__i2i:301`、`__credits:77`、`__cancel:142` 全是 `process.exit(fail ? 1 : 0)` 形态 | 一旦某套件的断言因环境/守卫整体不执行，套件仍报「通过」。建议每个套件末尾加一句 `check("断言数达到下限", pass >= N)` |
| 6 | **r9 的 `themes.css` 检查靠字符串匹配，容易漏** | `src/__theme.test.mjs:83-89` 的 `blockOf()` 用 `indexOf("\n}")` 找块结束；`:108` 用正则 `\n\s*--token\s*:` 找声明 | 对当前文件格式有效，但对压缩/重排过的 CSS 会失效。属**可接受的取舍**（源文件由人工维护），记录备查 |
| 7 | **r2 的攻击面覆盖依赖「旧 `/paid` 404」这一条作为主要防线证据** | `server/__payments.test.mjs:154-155` | 这条断言本身是对的（服务端确实已删，见 `server/index.js` 路由表无 `/paid`），但见 §5 doc-4 行：**前端 `src/api.js:407-411` 仍在调用它**，即「后端删了、前端没删」，测试只覆盖了后端 |

**另记一处只有测试能发现、但当前测不到的问题**：`src/api.js:407-411` 的 `payOrder()` 调用已被删除的 `/paid` 接口，且它**仍被生产代码调用**——`src/components/AccountModals.vue:10` 导入、`:102` 调用 `payOrder(pendingOrder.value.id, payChannel.value)`。也就是说**充值弹窗里点「支付」会打到 404**。这是「后端已按文档改造、前端漏改」的实锤（详见 §5 文档 4 的行）。`npm test` 覆盖不到它（没有前端到后端的契约测试）。

---

## 5. 文档一致性审计（**本任务核心产出**）

### 5.0 审计基线与总判断

- 12 份执行文档的日期均为 **2026-09-25**（各文档首部，如 `14-界面完整性补齐-完整执行开发文档.md:3`）。
- 代码中存在 **`V1003.01`–`V1003.09`** 九轮后续改动标记（`src/style.css:38,201,4774,6927,7429,7622,7778,7971`、`src/theme.js:51`、`src/App.vue:58`、`src/components/AppShell.vue:43,63,107`、`src/components/HomeView.vue:16,95`、`src/components/LoginView.vue:20`、`src/components/BootSplash.vue:4`）。工程内**没有 git**（实测 `ai-canvas/.git` 与父目录 `.git` 均不存在），无法用提交记录精确对时，但版本标记足以证明「文档之后还有修改」。
- **总体判断**：**服务端相关的声明（4 号的支付、7 号的吸收项、8 号的签名、10 号的图生图、15 号的 IPAdapter/血缘）与代码高度吻合**；**界面层声明（11/12/13/14）出现系统性过期**，其中 4 处属「文档与代码不一致」（不是没做，而是描述已与现状相反）。

### 5.1 逐文档审计

#### 文档 4 · `4-支付与自动更新与白标-深度实施文档.md`（925 行）

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| §0.1 ①「真实支付代码完成，已能跑通完整链路」 | `server/index.js:206`（建单，不加算力）、`:243`（`/pay`）、`:319-320`（微信/支付宝回调）、`:270`（`payments.verifyCallback`）、`:303`（`credits.markPaid`，全仓唯一加算力入口：`server/credits.js:279`） | ✅ **已落地（后端）** |
| §1.2 规则 3「沙箱回调只在沙箱模式开放，配真实凭证后 403」 | `server/index.js:323-327`（`if (!payments.payStatus().sandbox) return res.status(403)`）；`server/payments.js:55-62`（`mode = ready.wechat ? "wechat" : ready.alipay ? "alipay" : "sandbox"`） | ✅ 已落地 |
| §1.2 规则 2「验签 + 验金额 + 幂等」 | `server/index.js:270`（验签）、`server/payments.js:110,190,254,295`（三路 `verifyCallback`）、`server/credits.js:279`（幂等 `markPaid`） | ✅ 已落地 |
| §1.1 / §1.10「旧的 `/paid` 接口已移除（404）」 | **服务端确实已移除**：`server/index.js` 57 条路由中无 `/paid`。**但前端仍在调用**：`src/api.js:407-411` 的 `payOrder()` 指向 `/api/recharge/orders/${id}/paid`，且被 `src/components/AccountModals.vue:10, 102` 真实引用 | ⚠️ **部分落地 / 文档与代码不一致**（充值弹窗点支付 = 404） |
| §0.1 ②「自动更新代码完成，差一个 OSS 地址」 | 见 §2.4/§2.5：真实链路 `updater.cjs` 存在但**渲染层够不到**；用户看到的更新提示是 `UpdateToast.vue:40-69` 的模拟进度 + `location.reload()` | ❌ **未落地（用户可见功能不成立）** |
| §2.10「`npm run dist` 后 `release/` 有 `latest.yml`」 | `release/` 目录当前不存在（实测）；`package.json` 无 `--publish` 参数，需手动跑 `scripts/upload-release.mjs` | ⚪ 未验证（本工作区从未构建） |
| §0.1 ③「多品牌白标完全可用，零外部依赖」 | 运行时可切 ✅（`server/brand.js:24-48`、`server/index.js:233`、`src/App.vue:67-72`）；**打包链路未接** ❌（`package.json:43,44,73,79` 全静态） | ⚠️ **部分落地**（§3.3） |
| §3.1「换名字、换主色、换 logo、换文案」 | 三个品牌 `logo` 字段指向同一文件 `/brand/logo-mark.png`（`config/brand.json:12,25,38`） | ⚠️ **部分落地**（logo 实际换不了） |
| §3.3「非法 key 有兜底，不会白屏」 | `server/brand.js:24-27`、`:34-47`（字段级默认值补全） | ✅ 已落地 |
| §0.1 ④ / §4「11 张模板示意图已全部补齐」 | `server/data/templates.json` 11 条模板**每条都有 `preview`**（`:10,20,30,39,49,58,67,76,85,94,103`）；`public/templates/` 下 11 个对应 `.webp` 实测存在 | ✅ **已落地（11/11）** |
| §0.1「安全测试 14 通过 / 0 失败」 | `server/__payments.test.mjs` 顶层 `check(` = 14 ✅ | ✅ 吻合 |
| §0.2「权威源码在 `ai-canvas/`，根目录是旧快照，不要改」 | 本次核查目录 `E:\DSH项目\ai-canvas` 结构完整；根目录旧快照未参与本次审计 | ✅ 描述成立 |

**落地比例（严格按 4 条主声明）**：**1 项完全落地 / 2 项部分落地 / 1 项未落地 ≈ 50%**。文档 4 号是 12 份里**问题最重的一份**：它把②③标成了「✅ 代码完成」，而这两项恰恰是用户可见层最不成立的两项。

---

#### 文档 5 · `5-统一主方案V1-差距分析与实施路线.md`（553 行）

这是一份**核查型**文档（22 项能力体检 + 路线图），自身声明「文档只证明设计过，不证明实现了」(`:5`)，并带大段后续更新批注（`:8-22`）。

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| §0.2 红灯 1「生成接口不接收图片」(`:50`) | 已修复：`server/index.js:529` 起的 `/api/generate` 走 `refimage`，`server/providers/{wanxiang,jiemeng,openai,gemini}.js` 均 `import { loadReferences }`（如 `wanxiang.js:146`、`openai.js:16`、`jiemeng.js:19`、`gemini.js:39`） | ✅ 已落地（后续文档 10 号） |
| §0.2 红灯 2「不能从系统拖文件进画布」(`:51`) | 已修复：文档 9 号自陈落点 `NodeCanvas.vue:975/1030`；`src/__theme.test.mjs` 的接线检查也验证了画布批量类 | ✅ 已落地（后续文档 9 号） |
| §0.2 红灯 3「项目零持久化」(`:52`) | 已修复：`src/project.js`（315 行）提供 localStorage 持久化 + 保存三态；测试 `src/__ui.test.mjs:92-117` 覆盖 | ✅ 已落地 |
| §0.2 红灯 4「单批最多 4 张」(`:53`) | 仍然存在：`server/index.js:525` 注释「单批张数上限：模型侧一次最多出 4 张」；批量靠客户端分批（`src/batch.js`）绕过 | ⚠️ 部分落地（按方案 §4.4 的「客户端批量」决策，符合预期） |
| §1 表格 A3/A4/B2–B5/C3/C4/C6/D2–D4/E4/E7–E9/F4–F6 全部 ❌→ 已由 9 号文档改造 | 逐一核实：`nodes/GroupNode.vue` ✅、`EmptyCanvas.vue` ✅、`InspectorPanel.vue` ✅、`TaskBar.vue` ✅、`ReviewView.vue` ✅、`exportkit.js` ✅、`project.js` ✅、`responsive.css` ✅ | ✅ 已落地 |
| §4.5 P1 清单 P1-1…P1-8 | P1-1 项目落盘 → `src/project.js` ✅；P1-2 作品组 → `GroupNode.vue` ✅；P1-5 批量 → `src/batch.js`+`server/batch.js` ✅；P1-8 上游签名 → `server/upstream.js` ✅ | ✅ 已落地 |
| **`:16` 批注「仍未完成：E1（素材管理）、E6（资产血缘）、ComfyUI 多图融合」** | 三项均已在代码中实现：E1 → `server/materials.js`（`TAG_GROUPS` `:22-40`、`setTags` `:107`）+ `server/index.js:795,822,832`；E6 → `server/lineage.js` + `server/index.js:632,984,996`；多图融合 → `server/providers/ipadapter.js` + `comfyui.js:15,177,356` | ❌ **文档与代码不一致**（该批注本身已过期，被 14/15 号文档推翻） |
| §10 验收清单 P0/P1/P2/P3（`:497-523`） | 全部仍是未勾选 `- [ ]`，无任何勾选痕迹 | ⚪ 无法作为落地证据（文档自身未维护） |

**落地比例**：作为核查文档，**22 项中的 ❌/⚠️ 项已 100% 被后续文档关闭**；但**文档自身保留的「仍未完成」批注与代码相反**，属❌不一致。给出 **≈ 85%（含 1 处跨文档矛盾）**。

---

#### 文档 6 · `6-SynMew无限画布-穿透拆解与方案同步.md`（263 行）

这是**外部竞品拆解**文档，不含本项目功能完成度声明。它给出的行动项是「吸收 4 项 + 重排 1 项 + 坚持 1 项」。

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| §0「吸收 4 项（上游签名、文件夹批量语义、强类型端口、模板反哺），重排 1 项（P1 批量简化）」 | 4 项全部落地，见文档 7 号逐条核实 | ✅ 已落地（转由 7 号文档承载） |
| §0 / §8「坚持不迁 Tauri」 | 仍是 Electron：`package.json:38`（`electron ^33.2.0`）、`:7`（`main: electron/main.cjs`）；无任何 Tauri 依赖 | ✅ 决策被执行 |
| §2 数据模型（session.json 还原） | 属**外部工具**的事实描述，与本仓库代码无关 | ⚪ 不在审计范围 |

**落地比例**：**100%**（自身无功能声明；行动项由 7 号文档承载并已核实）。

---

#### 文档 7 · `7-SynMew吸收项-完整执行开发文档.md`（569 行）

文档自称「5 项全部落地并通过自测」（`:3`）。

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| P0-9 强类型端口：「新增 `src/ports.js`（126 行）」 | 文件存在，**实测正好 126 行**；导出 `DATA_TYPES`/`NODE_PORTS`/`validateConnection`/`edgeStyleFor`（`src/ports.js:18,36,89,110`） | ✅ **已落地（行数精确吻合）** |
| P1-5 批量简化：「新增 `src/batch.js` + `server/batch.js`，10 张拆 4+4+2」 | 两文件均存在（`src/batch.js` 124 行、`server/batch.js` 165 行）；`server/batch.js:151` 有 `sweep(days)` | ✅ 已落地 |
| P1-8 上游签名：「新增 `server/upstream.js`」 | 文件存在（274 行），`SIG_VERSION="v2"`（`:29`），签名形如 `usig_v2_<32hex>`（`:146`） | ✅ 已落地 |
| P2 模板反哺：「新增 `POST /api/templates/from-project` + 顶栏『存为模板』」 | 接口 `server/index.js:152`；前端入口 `src/components/StudioView.vue:103, 316`（按钮）、`:124`（成功提示） | ✅ 已落地 |
| P2 凭据结构：「重写 `server/vault.js` + 旧单文件自动迁移」 | `server/vault.js:67-71`（一条密钥一个 `.enc`）、`:114-133`（AES-256-GCM）、`:153-181`（`migrateLegacy` 启动迁移 + 旧文件改名保留） | ✅ 已落地 |
| P2 `server/templates.js` 的 `sanitizeGraph`/`saveFromProject`/`graph` | 接口与调用存在（`server/index.js:152`）；测试 `server/__sync.test.mjs:100-104` 断言 `source === "project"`、无节点图/无名称时拒绝 | ✅ 已落地 |
| P2 `server/credits.js` 新增 `findConsumed()` | `server/credits.js` 中被 `__p18.test.mjs:222,224,229` 直接调用并断言 | ✅ 已落地 |
| §0.3「`npm test` 四套件全绿（16 / 14 / 29 / 15 项）」 | 四个数**全部吻合**（见 §4.2）；但这四个套件只是现在 13 套件中的前 4 个 | ✅ 断言数吻合 / ⚠️ 口径过期 |
| §0.3「`npx vite build` ✓ 1648 modules」 | 属于历史构建记录 | ⚪ 未验证（未复现构建） |
| §0.3「57 项断言 + 构建通过」 | 29（sync）+ 15（sync-http）+ 13（vault）= **57** ✅ 完全吻合 | ✅ 吻合 |
| §0.4 `server/__vault.test.mjs` 新增 | 文件存在（77 行），由 `__sync.test.mjs:117-122` 子进程执行 | ✅ 已落地 |

**落地比例：100%（5/5）**。这是 12 份文档中**与代码吻合度最高**的一份，断言数甚至能精确对上。

---

#### 文档 8 · `8-P1-8上游签名-完整执行文档.md`（234 行）

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| 签名版本 `usig_v2_`，旧版本条目自动作废 | `server/upstream.js:29`（`SIG_VERSION="v2"`）、`:146`（`usig_${SIG_VERSION}_${hex}`）、`:156`（`startsWith` 校验） | ✅ 已落地 |
| 覆盖通路：`/api/generate` + `/api/generate-video` | `server/index.js:549`（generate 取签名）、`:883`（generate-video 取签名） | ✅ 已落地 |
| 缓存按 `userId` 隔离 | `server/upstream.js:191-199`（`cacheGet(sig, userId)`，`entry.userId !== userId` 返回 null）；调用侧 `server/index.js:557,888` 传 `chargeUser` | ✅ 已落地 |
| 启动全量 `sweep()` + TTL + 文件存活 + 版本校验 | `server/upstream.js:241-267`；启动调用 `server/index.js:1018`（`upstream.sweep()`） | ✅ 已落地 |
| 参考图「只取内容哈希」（同图重传不算新任务） | `server/upstream.js:85-97`（`assetSig`：本地文件取 sha256 前 32 位、**不带文件名**）、`:100-113`（`refSig` 且**顺序不敏感**） | ✅ 已落地（实现比文档更严谨：还做了顺序归一化） |
| 用户可见 `savedCost` | `server/upstream.js:203`（`savedCost: Number(entry.cost)`） | ✅ 已落地 |
| 「55 项单元 + 23 项 HTTP 端到端」 | 静态 45（+2 处循环展开 ≈ 54）/ 24 | ✅ 数量级吻合 |
| §1「`npm test` 六项全过」 | 当前是 **13 套件，且第 9 套失败** | ❌ **文档与代码不一致**（口径过期 + 现状为红） |
| §2.1 进/不进签名字段表 | `server/upstream.js:32-43`（`SIGNED_FIELDS`）、`:122-137`（payload 构造）、`:139-142`（全空则返回 `""`，避免空任务共用 refId） | ✅ 已落地 |

**落地比例：功能 100%（7/7 维度），度量 1/2 过期**。

---

#### 文档 9 · `9-新界面层-完整执行开发文档.md`（440 行）

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| §2 新增 9 个文件 | 全部存在：`src/project.js`、`src/exportkit.js`、`src/newui.css`、`src/components/InspectorPanel.vue`、`TaskBar.vue`、`ReviewView.vue`、`EmptyCanvas.vue`、`nodes/GroupNode.vue`、`src/__ui.test.mjs` | ✅ 已落地（9/9） |
| A3 作品组（框选编组/整体拖动/折叠/重命名） | `src/components/nodes/GroupNode.vue`（**53 行，与文档一致**，`:51` 折叠态提示「双击标题可重命名」）；`src/components/NodeCanvas.vue:380`（`重命名作品组`） | ✅ 已落地 |
| A4 语义缩放三档 | `src/__ui.test.mjs:133-141`（分档阈值）；文档称落在 `NodeCanvas.vue:51` + `newui.css` | ⚠️ 已落地但**测试测的是副本**（§4.5 第 2 条） |
| B2/B3/B4 空态上传卡片 + 就地提示词 + 4 个示例入口 | `src/components/EmptyCanvas.vue`（**87 行，与文档一致**） | ✅ 已落地 |
| B5 系统文件拖入（`dataTransfer.files`） | 文档称 `NodeCanvas.vue:975/1030` | ✅ 已落地 |
| C3 右侧属性栏「无选中不渲染」 | `src/components/InspectorPanel.vue`（实测 **429 行**，文档称 242 行） | ✅ 已落地（行数过期） |
| C4 底部任务条四态 + 取消 + 重做 | `src/components/TaskBar.vue`（**81 行，与文档一致**） | ✅ 已落地 |
| C6 保存三态 + 上次保存时间 | `src/project.js:34`（`safeSet`）；测试 `src/__ui.test.mjs:104-105` 断言 `store.saveState === "saved"` 且文案含「已保存」 | ✅ 已落地 |
| D2/D3 审阅+策展双模式 | `src/components/ReviewView.vue`（**246 行，与文档一致**） | ✅ 已落地 |
| D4 独立 review 路由 | 文档称 `App.vue:206` + `AppShell.vue:59` | ✅ 已落地 |
| E4 每任务一个 AbortController | 文档称 `NodeCanvas.vue:764` + `api.js:202` | ✅ 已落地 |
| E7 localStorage 自动存 + 恢复 | `src/project.js:15`（`KEY_LIST`）、`:107,142,160` | ✅ 已落地 |
| E8 命名规则 + ZIP + 项目 JSON | `src/exportkit.js`（**201 行，与文档一致**）：`safeName`、`assetName`、`crc32`、`makeZip` | ✅ 已落地 |
| E9 成本预估弹窗 | 文档称 `NodeCanvas.vue:461/466` | ✅ 已落地 |
| F5 窗口 1440×900 / min 1180×720 | `electron/main.cjs:296-304` | ✅ 已落地 |
| F6 商品一致性参数（参考强度/印花区域）送服务端 | 文档称 `InspectorPanel.vue:88-105` | ✅ 已落地 |
| §1「仍然没做」清单：E1 素材、E6 血缘、云端 provider 图生图、ComfyUI 多图融合、服务端任务取消 | **六项全部已实现**：`server/materials.js`、`server/lineage.js`、`server/providers/refimage.js`+四家、`server/providers/ipadapter.js`、`server/tasks.js`（`:77,99`）+ `comfyui.js:317`（`/interrupt`） | ❌ **文档与代码不一致**（该段是当时诚实的自陈，但**文档未回填**，读者会误判为仍缺失） |
| §0「python `zipfile` 真实解压 + CRC 校验通过」 | 测试只做 `fs.existsSync`（`src/__ui.test.mjs:85-90`），全仓无 python 调用 | ⚠️ **证据不实**（人工验证被写成自动化验证） |
| §2 逐文件行数（project 226 / exportkit 201 / newui.css 1060 / InspectorPanel 242 / TaskBar 81 / ReviewView 246 / EmptyCanvas 87 / GroupNode 53 / __ui 144） | 实测：**329** / 201 ✅ / **1660** / **429** / 81 ✅ / 246 ✅ / 87 ✅ / 53 ✅ / 144 ✅ | ⚠️ **6/9 精确吻合**；3 处不符（`project.js` 226→329、`newui.css` 1060→1660、`InspectorPanel.vue` 242→429），均为后续 V1003 轮次改动所致 |
| §0「自测 41 项断言」 | `src/__ui.test.mjs` 顶层 `check(` = 40 | ⚠️ 近似（差 1） |

**落地比例：功能 ≈ 100%（17 项改造全部在代码中），存在 3 类声明问题（「六项仍未做」未回填、python 校验未自动化、3 处行数过期）→ 综合 ≈ 85%。**

---

#### 文档 10 · `10-云端图生图入参-完整执行开发文档.md`（280 行）

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| 万相改走 `multimodal-generation`，`messages[0].content` 带 `{image}` | `server/providers/wanxiang.js:101`（端点 `/api/v1/services/aigc/multimodal-generation/generation`）、`:146`（`loadReferences`）、`:157-163`（`i2iModel` 默认 `wan2.6-image`） | ✅ 已落地 |
| 新增配置 `wanxiang.i2iModel` | `server/config.js:22`（`i2iModel: "wan2.6-image"`） | ✅ 已落地 |
| 修 bug ①：万相负向词位置（旧协议必须在 `input.negative_prompt`） | `server/providers/wanxiang.js:29-36`（旧协议放 `input`）、`:54`（新协议才放 `parameters`）；`:14,34` 有明确注释 | ✅ 已落地（修得干净：按协议分支，不是一刀切） |
| 修 bug ②：路径校验收敛到 `refimage.js` 一处 | `server/providers/comfyui.js:12`（`import { resolveLocalFile, loadReferences } from "./refimage.js"`）；其余三家均 `import ... refimage.js`（`wanxiang.js:146`、`jiemeng.js:19`、`openai.js:16`、`gemini.js:39`） | ✅ 已落地 |
| `refimage.js` 同时产出 `{buf,b64,dataUri,mime,name}` | `server/providers/refimage.js`（167 行） | ✅ 已落地 |
| 即梦用 `image` 字段（单图字符串/多图数组） | `server/providers/jiemeng.js:19` 引入 refimage | ✅ 已落地 |
| OpenAI 换端点 `/v1/images/edits` + multipart + `input_fidelity` | `server/providers/openai.js:6`（注释）、`:50`（`${base}/images/edits`） | ✅ 已落地 |
| Gemini 用 `inline_data`（裸 base64，不带 `data:` 前缀） | `server/providers/gemini.js:49-55`（`inline_data: { mime_type, data: r.b64 }`，注释明确「裸 base64，不是 data URI」） | ✅ 已落地 |
| §0「64 项断言」 | `server/__i2i.test.mjs` 顶层 `check(` = 64 ✅ | ✅ 吻合 |
| §6 人工验收 7 条（需真实 Key） | 文档自己声明「单测打桩了 fetch，证明不了各家 API 收不收」（`:229`） | ⚪ **未验证**（需用户提供四家 Key，属诚实披露） |
| §8「下一步：IPAdapter 多图融合、服务端取消」 | 两项均已在 15 号文档 / 代码中完成（`ipadapter.js`、`tasks.js`） | ⚠️ 口径过期（非错误） |

**落地比例：100%（功能与断言数全部核实；真机验收按文档声明的口径不在此列）。**

---

#### 文档 11 · `11-视觉升级三方案.md`（136 行）

文档头部已被回填更新批注（`:7-11`），声明「三套方案已全部实现为可自由切换的主题，本文保留作为方案对比与决策依据，不再作为待办清单」。

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| 头部批注「已交付 `src/theme.js` + `src/themes.css`，四套主题 × 明暗」 | 两文件存在；但**实际是 3 套主题**（`src/theme.js:23-48`，`classic` 已删） | ⚠️ **部分落地**（批注里「四套」已过期） |
| §2 方案 A（Aurora）token：`--bg: #0B0D14` | 实际 `src/themes.css:120` 是 `--bg: #070a12` | ⚠️ **文档与代码不一致**（提案值与最终值不同） |
| §2 方案 B（Atelier）token：`--bg: #FAF8F5`、`--primary: #E8590C` | 实际 `src/themes.css:231` 是 `--bg: #faf8f5` ✅（底色一致）；`atlier` 默认色板以 `:230-303` 为准 | ⚠️ 部分一致 |
| §2 方案 C（Momentum）token：`--bg: #FFFFFF` | 实际 `src/themes.css:335` 是 `--bg: #f6f7fb` | ⚠️ **不一致** |
| §3「8 处微交互」+ §3.8「`prefers-reduced-motion` 时全部动画关闭」 | 有实现：`src/style.css:6831, 7414`、`src/newui.css:1325`、`src/responsive.css:104` 四处 `@media (prefers-reduced-motion: reduce)` | ✅ 已落地 |
| §3/§4 排版纪律（负字距、tabular-nums、圆角升级、留白加倍） | 属视觉主观项，**未逐条验证** | ⚪ **未验证** |

**落地比例：≈ 60%**（方案已实现为可切换主题，但文档中的「四套主题」「具体 token 值」与最终代码不符；文档自己已声明降级为「决策依据」，故按**部分不一致**计）。

---

#### 文档 12 · `12-主题切换与画布模式-完整执行开发文档.md`（260 行）

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| §1 新增 6 个文件 | 全部存在：`src/theme.js`（195 行，文档称 197）、`src/themes.css`（827 行，文档称 ~600）、`src/batchmode.js`（107 行，文档称 108）、`src/components/ThemeSwitcher.vue`（66 行，文档称 62）、`CanvasModeSwitch.vue`（36 行，文档称 38）、`BatchDock.vue`（157 行，文档称 152） | ✅ 已落地（6/6 存在；行数普遍有 ±2–40% 偏移） |
| §2.1「四套主题 × 明暗」，其中 `aurora` 为**默认**、`classic` 是回滚通道 | 实际 **3 套**（`src/theme.js:23-48`，`THEME_IDS` `:50`）；`classic` 已从 `THEMES`/`DOT_COLORS`/`themes.css` 三处移除；**默认已改为 `atelier`**（`src/theme.js:51-54`） | ❌ **文档与代码不一致**（主题数、默认值双错） |
| §2.1「两者都写 localStorage（`ai-canvas.theme.v1` / `ai-canvas.dark.v1`）」 | 实际 key 已升级为 **v2**：`src/theme.js:56-57`（`ai-canvas.theme.v2` / `ai-canvas.dark.v2`） | ❌ **文档与代码不一致** |
| §2.2 硬契约 1「主题只换 token，不换 DOM」 | `src/__theme.test.mjs:105-113` 逐主题断言 token 齐全；`main.js:18-20` 样式层顺序被测试守卫（`__theme.test.mjs` [10] 段） | ✅ 已落地 |
| §2.2 硬契约 2「`--primary` 一律 `var(--brand)`」 | `src/App.vue:67-74`（只写 `--brand`/`--brand-deep`，注释明确不再内联 `--primary`）；测试断言每套主题 `--primary: var(--brand)` | ✅ 已落地 |
| §2.2 硬契约 3「`.dark` 同时挂 `<html>` 与 `<body>`」 | `src/theme.js:109-116`（两个 `classList.toggle("dark", on)`） | ✅ 已落地 |
| §1 `src/main.js` 引入 `themes.css` 且排在 `style.css` 之后 | `src/main.js:11`（style.css）、`:18`（themes.css）；测试断言顺序 | ✅ 已落地 |
| §1 `src/main.js` mount 前 `initTheme()` | `src/main.js:26`（在 `createApp` `:31` 之前） | ✅ 已落地 |
| §1 `src/store.js` 新增 `theme/canvasMode/batchDockOpen/batchRows` + bridge 6 个批量接口 | `src/store.js:88,93,95,97`；测试 `__theme.test.mjs` [10] 段逐条断言 `bridge` 暴露 `batchFromPrompts/runBatchNodes/cancelBatch/tidyGrid/getSelectedIds/setSelectedIds` | ✅ 已落地 |
| §1 两处顶栏都有主题切换器 | 测试实测断言「主页顶栏也有主题切换器」「创作台顶栏有主题切换器」 | ✅ 已落地 |
| §1「`server/config.js` 的 `outputsDir` 支持 `AI_CANVAS_OUTPUTS` 覆盖」 | `server/config.js:40-42` | ✅ 已落地 |
| §0「`npm test` 九套件全绿（新增第 9 套 86 项断言）」「`vite build` 通过（1664 modules）」 | 现在是 13 套件；第 9 套实测 **83 项中 1 项失败**（§0.4） | ❌ **文档与代码不一致**（第 9 套已红） |

**落地比例：功能 9/9 落地，声明项 3/3 不一致 → 综合 ≈ 75%。**

---

#### 文档 13 · `13-界面完整性设计与确认清单.md`（212 行）

这是一份「先摊开界面盘子等用户拍板」的**确认清单**，其 §6 的 G1–G8 缺口清单是本轮后续工作的源头。

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| §0「22 个界面单元，19 已落地、3 只有骨架」 | 单元与组件基本对得上（`LoginView`/`BootSplash`/`HomeView`/`ProjectsView`/`StudioView`+`NodeCanvas`/`TemplatesView`/`ReviewView`/`AuditView` 等均存在） | ✅ 基本成立 |
| §1 代码量分布（NodeCanvas 1886 / AccountModals 559 / StudioView 432 / TemplatesView 247 / ReviewView 246 / InspectorPanel 242 / HomeView 230 / SettingsDialog 268 / ProjectsView 77 / AuditView 116） | 实测：1894 / **559** ✅ / 435 / 263 / **246** ✅ / 429 / 273 / **268** ✅ / **222** / 123 | ⚠️ **3/10 精确吻合**（AccountModals、ReviewView、SettingsDialog）；`ProjectsView` 从 77→**222** 是因为文档 14 号把它重写了，其余为 V1003 轮次偏移 |
| §6 G1 项目页无空态 | 已修复：`src/components/ProjectsView.vue:156`（「还没有项目」）、`:170`（「没有匹配的项目」，两种空态分开写） | ✅ 已落地（14 号文档） |
| §6 G2 素材库无删除/标签/SKU | 已修复：`server/materials.js:22-40`（颜色/品类/季节/SKU 四组标签）、`:107`（`setTags`）、`:134`（删除）；接口 `server/index.js:822,832` | ✅ 已落地（14 号文档） |
| §6 G3 全项目零骨架屏 | 已补 **3 处**：`TemplatesView.vue:205-211`、`ProjectsView.vue:144-149`、`AuditView.vue:104-109`；样式 `src/newui.css:1294-1344` | ⚠️ **部分落地**（文档 14 号称「4 处」，实测 3 处；`HomeView`/`ReviewView` 无骨架） |
| §6 G4 零错误边界 | 已修复：`src/errorboundary.js`（132 行）、`src/components/ErrorFallback.vue`（223 行）、`src/main.js:23,29,35-37`、`src/App.vue:2,21,42,218` | ✅ 已落地（14 号文档） |
| §6 G5 结果资产血缘 E6 | 已实现：`server/lineage.js`、`server/index.js:632,984,996`、`src/components/InspectorPanel.vue:372-405` | ✅ 已落地（15 号文档） |
| §6 G6 ComfyUI 多图融合 | 已实现：`server/providers/ipadapter.js`（266 行）、`comfyui.js:15,177,356` | ✅ 已落地（15 号文档） |
| §6 G7 服务端真取消 `/interrupt` | 已实现：`server/tasks.js:77,99`、`comfyui.js:311-318,407`、`server/index.js:699` | ✅ 已落地（14 号文档） |
| §6 G8 1180×720 以下无适配 | 已实现：`src/responsive.css`（100 行，三档断点）、`main.js:20` 引入 | ✅ 已落地（15 号文档） |
| §5 状态矩阵「主题 4 套（含经典蓝）」 | 实际 3 套（`src/theme.js:23-48`） | ❌ **文档与代码不一致** |
| §7 第 1 条「当前默认 `极光玻璃`（深空）」 | 实际默认 `atelier`（暖白纸面）：`src/theme.js:51-54` | ❌ **文档与代码不一致** |
| §8「每阶段结束跑 `npm test`（九套件）」 | 现在 13 套件且第 9 套红（§0.4） | ❌ 口径过期 |
| §9 交付物位置（`design-proposals/screens.html`、`themes.css`） | 实测存在：`design-proposals/{index.html,screens.html}`、`src/themes.css` | ✅ 已落地 |

**落地比例：作为缺口清单，G1–G8 **8/8 已被关闭（100%）**；但文档中的「现状」描述（主题数、默认主题、套件数、代码行数）**系统性过期**。

---

#### 文档 14 · `14-界面完整性补齐-完整执行开发文档.md`（372 行）

文档称「全部落地 · 十一套件测试全绿」（`:7`），并逐条对应用户拍板的 6 项决策。

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| 决策①「默认主题 = 极光玻璃·暗色 ✅，`DEFAULT_THEME = "aurora"`，默认明暗为暗色」 | **代码是 `atelier`**：`src/theme.js:54`；`:51-53` 注释写明「V1003.06：默认主题改成『画布工作室』（暖白纸感 #FAF8F5）。原来默认是『极光玻璃』……用户明确要求『默认是米白底，不是深蓝黑』」 | ❌ **文档与代码不一致（已被后续需求推翻）** |
| 决策②「经典蓝删除 ✅：`THEMES` 移除、`DOT_COLORS` 删、`themes.css` 删两块 token」 | 三处均已删：`src/theme.js:23-48`（无 classic）、`:186-190`（`DOT_COLORS` 只有 3 套）、`src/themes.css` 实测无 `data-theme="classic"`（仅 `aurora/atelier/momentum`） | ✅ 已落地 |
| 决策② 兼容「`normalizeThemeId("classic") === "aurora"`」 | 代码 `src/theme.js:64-66` 返回 `DEFAULT_THEME`；测试 `src/__theme.test.mjs:62` 用的是 `=== DEFAULT_THEME`（能通过） | ⚠️ **文档写法已过期**（`classic` 现在落到 `atelier`，不是 `aurora`）；测试因未写死常量而仍然有效 |
| 决策③ 项目页补强（两种空态/排序/就地重命名/复制副本/删除二次确认） | `ProjectsView.vue:54`（新建即重命名）、`:156`/`:170`（两种空态）、`:129-136`（排序）、`:190-211`（重命名/复制）；排序实现 `src/project.js:273-275`（`localeCompare(name, "zh-CN")` 拼音序） | ✅ 已落地 |
| 决策③ 顺带修 bug「`removeProject` 只改内存不落盘」 | 已修：`src/project.js:170-172`（`filter` 后 `safeSet(KEY_LIST, list)`） | ✅ 已落地 |
| 决策④ G4 错误边界 | `src/errorboundary.js:1-15`（文件头说明两级：`app.config.errorHandler` + `onErrorCaptured`）；`src/main.js:35-37`；`src/App.vue:42,218` | ✅ 已落地 |
| 决策④ G7 真取消（断上游 + `/interrupt` + 回滚账本） | `server/tasks.js:15-16`（顺序：**先跑钩子停上游，再断连接**）、`:99`；`comfyui.js:317`；`server/index.js:699` | ✅ 已落地 |
| 决策④ G3 骨架屏「4 处接入 shimmer」 | 实测 **3 处**（`TemplatesView.vue:205`、`ProjectsView.vue:146`、`AuditView.vue:104`）+ 样式 `newui.css:1318-1344` | ⚠️ **部分落地**（4 → 3） |
| 决策⑤ 素材标签 = 颜色/品类/季节/SKU | `server/materials.js:22-40`（`TAG_GROUPS` 四组，SKU 为自由文本，其余为下拉）；接口 `server/index.js:795`（GET）、`:822`（PATCH tags）、`:832`（DELETE） | ✅ 已落地 |
| §5 路径穿越校验 | `server/materials.js:60`（拒绝含分隔符/`..`/隐藏文件）、`:68`（`startsWith(dir + sep)` 二次兜底）；测试 `src/__robust.test.mjs:137-147`（含编码穿越、非白名单分类、路径段数） | ✅ 已落地 |
| §7「十一套件全绿」「`npx vite build` 通过」 | 现 13 套件，第 9 套 1 项失败 | ❌ **文档与代码不一致** |
| §8 变更文件清单（errorboundary 156 / ErrorFallback 228 / tasks 157 / materials 147 / robust 192 / cancel 142 / ProjectsView 77→222 / MaterialLibrary 116→260） | 实测：**156 ✅ / 228 ✅ / 157 ✅ / 147 ✅ / 192 ✅ / 142 ✅ / 222 ✅ / 260 ✅** | ✅ **8/8 精确吻合**（本份文档的行数是 12 份里最准的） |
| §9「未完成项：IPAdapter 多图融合、E6 血缘、窄窗适配」 | 三项均已在 15 号文档完成 | ⚠️ 口径过期（非错误） |

**落地比例：6 项决策中 5 项落地（83%）；3 处声明与代码不一致（默认主题、骨架屏数量、套件数）→ 综合 ≈ 82%。**

---

#### 文档 15 · `15-多图融合与资产血缘-完整执行开发文档.md`（280 行）

| 文档声明 | 代码证据（文件:行号） | 结论 |
|---|---|---|
| G6「ComfyUI IPAdapter 多图融合：多张参考图真的都参与生成」 | `server/providers/ipadapter.js`（286 行，文档称「约 250 行」；纯函数模块：`detectIPAdapter`/`outIndex`/`pickIPAdapterModel`/`appendIPAdapter`/`fallbackMessage`）；接线 `comfyui.js:15,177,356`（`fused = refNames.length > 1 && ipadapter.available`） | ✅ 已落地 |
| G6 设计取舍①「绝不硬编码节点签名，从 `/object_info` 读真实签名、按 output 名查下标」 | `ipadapter.js:43`（`outIndex` 按类型名查端口）、`:11`（注释）；`comfyui.js:340,345`（`/object_info` 一次拉够，合并原先的双拉） | ✅ 已落地 |
| G6 取舍②「只挑有 `model` 输入的 apply 节点做链式串联」 | `ipadapter.js:116` 附近按 `requiredKeys().includes("model")` 判定 | ✅ 已落地 |
| G6 取舍③「DiT 架构只认专用节点」 | `ipadapter.js` 中按 arch 分流（`comfyui.js:353` 传 `arch`） | ✅ 已落地 |
| G6 权重策略 `0.85→0.68→0.54→0.44`（衰减 0.8、保底 0.3） | `ipadapter.js` 的 `weightsFor(count, base, decay, min)` | ✅ 已落地 |
| G6 诚实降级文案 | `ipadapter.js` 的 `fallbackMessage(refCount, capability)`；调用 `comfyui.js:363` | ✅ 已落地 |
| 「第 12 套件 62 项」 | `server/__ipadapter.test.mjs` 顶层 `check(` = 61 | ⚠️ 近似（差 1） |
| E6「新增 `server/lineage.js`，每张图旁边 `sidecar`」 | 文件存在（172 行）；`META_SUFFIX = ".meta.json"`（`:23`）；落盘 `server/index.js:632` | ✅ 已落地 |
| E6「`GET /api/outputs/meta` + `/api/outputs/lineage`」 | `server/index.js:984`（meta）、`:996`（lineage），两者都 `requireLogin` | ✅ 已落地 |
| E6「在 `express.static` 之前拦掉 `.meta.json` 请求（403）」 | `server/index.js:977-981`（拦截中间件）在 `:1006`（`express.static(outputsDir())`）**之前**注册 | ✅ 已落地（顺序正确） |
| E6「别人的血缘不给看：`entry.userId !== req.user.id` 且非超管 → 403」 | `server/index.js:990`；`isSuper` 定义 `:105`（`roleIds.includes("r-super")`） | ✅ 已落地 |
| E6「写失败绝不影响生成，一律吞错只打 warn」 | `server/lineage.js` 内 try/catch（`server/index.js:632` 处的调用不参与失败判定） | ✅ 已落地 |
| E6「文件名来自 URL，必须防穿越」 | `server/lineage.js` 用 `path.basename` + `startsWith(dir + sep)` 双防线 | ✅ 已落地 |
| E6 前端「来源」区块 + 复制提示词 | `src/components/InspectorPanel.vue:372`（「来源」）、`:400`（「复制提示词」按钮）、`:405`（「没有来源记录（外部导入或早期产出）」）、`:139`（注释说明查不到是正常情况） | ✅ 已落地 |
| E6「`sidecar.summarize()` 的 `reproducible` 判定：prompt 和 provider 缺任一都不标可复现」 | `server/upstream.js` 中无此函数，实际在 `server/lineage.js` 的 `summarize`；被 `server/index.js:988,993` 调用 | ✅ 已落地（函数归属文件与文档用词不同，功能一致） |
| 「第 13 套件 49 项」 | `server/__lineage.test.mjs` 顶层 `check(` = 49 | ✅ 吻合 |
| G8「新建 `src/responsive.css`，在 `main.js` 里排在所有样式之后引入」 | `src/responsive.css`（108 行）；`src/main.js:20`（在 `themes.css` `:18` 之后） | ✅ 已落地 |
| G8 三档断点（≤1180 / ≤1000 / ≤720 高）+ reduced-motion | `src/responsive.css:104`（`prefers-reduced-motion`）；断点值需逐行核对，**未逐条验证具体像素** | ⚠️ 部分验证 |
| §4「`scripts/run-tests.mjs` 改：挂接第 12、13 套件」 | `run-tests.mjs:128-140`（r12、r13） | ✅ 已落地 |
| §0「新增测试 111 项（第 12 套件 62 + 第 13 套件 49）」 | 静态 61 + 49 = 110 | ⚠️ 近似（差 1，与 62 的口径一致） |
| §5「十三套件全绿」「`vite build` 通过」「Electron 桌面端重启，界面正常加载」 | **第 9 套 1 项失败**（§0.4）→ 十三套件不全绿 | ❌ **文档与代码不一致** |
| §6 末句「剩余未做的是再往前的业务规划（**鉴权商用化、OSS 自动更新、多品牌白标**等）」 | 与文档 4 号 §0.1（②自动更新 ✅代码完成、③白标 ✅完全可用）**直接矛盾** | ❌ **跨文档不一致**（谁的现状都不对：4 号高估，15 号低估） |

**落地比例：3/3 功能项落地，2 处度量/口径不一致 → 综合 ≈ 88%。**

---

### 5.2 12 份文档落地比例汇总

| 文档 | 已落地 | 部分落地 | 未落地 | 文档与代码不一致 | 综合落地率（我的判断口径） | 备注 |
|---|---|---|---|---|---|---|
| 4 支付/更新/白标 | 1 | 2 | 1 | 1（前端仍调已删 `/paid`） | **≈ 50%** | 问题最重：②③两项声明与用户可见现实相反 |
| 5 统一主方案 | 10+ | 1 | 0 | 1（「仍未完成」批注已过期） | **≈ 85%** | 核查型文档；验收清单从未勾选 |
| 6 SynMew 拆解 | 自身无功能声明 | — | — | 0 | **100%** | 行动项由 7 号承载 |
| 7 SynMew 吸收项 | 5 | 0 | 0 | 0（仅套件口径过期） | **100%** | 断言数 57 精确吻合 |
| 8 P1-8 上游签名 | 7 维度 | 0 | 0 | 1（「六项全过」已过期） | **≈ 95%** | 实现比文档更严谨（参考图顺序归一化） |
| 9 新界面层 | 17 | 1 | 0 | 2（「六项仍未做」已全部做完；python 校验未自动化） | **≈ 85%** | 行数 6/9 精确吻合（非普遍过期） |
| 10 云端图生图入参 | 8 | 0 | 0 | 0（真机验收属诚实披露） | **100%** | 断言 64 精确吻合 |
| 11 视觉升级三方案 | 1（reduced-motion） | 3 | 0 | 3（主题数 / 三套 token 值） | **≈ 60%** | 文档已自降级为「决策依据」 |
| 12 主题与画布模式 | 9 | 0 | 0 | 3（主题数 / 默认主题 / localStorage key） | **≈ 75%** | 功能全在，声明全错 |
| 13 界面完整性清单 | 8（G1–G8） | 1（骨架 4→3） | 0 | 3（主题数 / 默认主题 / 套件数） | **≈ 80%** | 缺口已清零，现状描述过期 |
| 14 界面完整性补齐 | 5 决策 | 0 | 0 | 3（默认主题 / 骨架数 / 套件数） | **≈ 82%** | 决策①已被后续需求推翻；行数 8/8 精确吻合 |
| 15 多图融合与血缘 | 3 | 0 | 0 | 2（十三套件全绿 / 与 4 号互相矛盾） | **≈ 88%** | 功能实现质量高（诚实降级、双防线） |

**12 份综合落地率 ≈ 83%**（按文档条目加权；功能层远高于此数，文档**度量层**远低于此数）。

### 5.3 跨文档互相矛盾清单

| # | 矛盾点 | A 方 | B 方 |
|---|---|---|---|
| 1 | 自动更新/白标到底做完没有 | `4-...md:16-17`（②③ ✅ 代码完成） | `15-...md:279-280`（「剩余未做的是…OSS 自动更新、多品牌白标」） |
| 2 | E1/E6/多图融合到底做完没有 | `5-...md:16`（「仍未完成：E1、E6、ComfyUI 多图融合」） | `14-...md:21`（G2 ✅）、`15-...md:18-20`（G6/E6 ✅） |
| 3 | 默认主题是哪个 | `12-...md:45`（aurora 默认）、`13-...md:182`（当前默认极光玻璃）、`14-...md:30-32`（✅ 默认 aurora·暗） | `src/theme.js:51-54`（atelier，V1003.06 起） |
| 4 | 有几套主题 | `12-...md:43-48`（4 套）、`13-...md:150`（4 套） | `src/theme.js:23-48`（3 套，classic 已删） |
| 5 | 有几套测试 | `12-...md:6`（九套）、`14-...md:7`（十一套）、`15-...md:5`（十三套） | `run-tests.mjs:93-140`（13 套，其中 1 套红） |

### 5.4 附带发现：两份非编号文档也已经过期

任务要求「另需读根目录文档」，实测这两份也需要回填：

**`README.md`（62 行）—— 停留在 v0.1.0 时代**

| 声明 | 代码现状 | 证据 |
|---|---|---|
| §架构「`components/InfiniteCanvas.vue` 自研无限画布引擎（无第三方画布库）」「`PromptPanel.vue` 生成面板」 | 这两个文件**已移入 `src/components/_deprecated/`**；现役是 Vue Flow：`package.json:28-29`（`@vue-flow/core`、`@vue-flow/background`）、`src/components/NodeCanvas.vue`（1894 行） | `src/components/_deprecated/InfiniteCanvas.vue`、`src/components/_deprecated/PromptPanel.vue`；全仓无对 `_deprecated` 的引用（实测 grep 只命中文件自身） |
| §运行「只有 npm install / build / server」 | 缺 `test`、`desktop`、`dist`、`release:upload` 等全部脚本 | `package.json:8-22` |
| §提供方「万相 / 即梦 / ComfyUI」三路 | 实际五路：另有 OpenAI、Gemini | `server/providers/openai.js`、`server/providers/gemini.js`；`server/config.js:48`（`PROVIDER_KEYS` 五项） |
| §路线图「画布项目持久化（保存/恢复布局）」（列为**候选**） | 早已实现（文档 9 号 E7） | `src/project.js`（315 行）、`src/__ui.test.mjs:92-117` |
| §设置「保存于 `~/.ai-canvas/config.json`（仅本机）」 | 密钥**不入 config.json**，只进 vault | `server/config.js:18`（注释「这里永远不存 apiKey」）、`:100-101`（双保险删除）、`server/vault.js` |

**`使用说明.md`（159 行）—— 局部过期，含 1 处指向不存在的文件**

| 声明 | 代码现状 | 证据 |
|---|---|---|
| §4 目录结构「`server/store.js` 密钥存储（系统凭据管理器）」 | **`server/store.js` 不存在**；实际是 `server/vault.js`（204→225 行），且现在有**两种后端**（系统凭据管理器 / 本地加密文件） | 实测 `server/store.js` 不存在；`server/vault.js:4-5, 49-62` |
| §3「`npm test` 一键跑『算力账本 + 支付回调安全』测试」 | 实际跑 13 套件 | `scripts/run-tests.mjs:93-140` |
| §2 纪律 3「不要删 `.workbuddy/` 目录」 | 该目录**在本工作区不存在**（数据实际在 `%APPDATA%\ai-canvas\` 与 `~/.ai-canvas/`，同段自己也这么说） | 实测 `.workbuddy` 不存在 |
| §3「`npm run dist` 输出到 `release/`」 | ✅ 正确（反衬 `build-installer.bat:34,37` 写错） | `package.json:45-47` |
| §4「`public/templates/ 11 张模板示意图（WebP）`」 | ✅ 11 个 webp 存在，但同目录另有 **7 个 1–2MB 的生成源 PNG**（靠 `vite.config.js:16-42` 构建时剔除） | 实测 `public/templates/` 含 `A_clean_modern_marketing_illus_*.png` × 7 |
| §5「生成结果 `outputs/`」 | 默认是 `path.join(process.cwd(), "outputs")`（`server/config.js:42`）；打包后 `cwd` 是安装目录 | `server/config.js:37-42`。**【未验证】**：未实测打包形态下该目录是否可写（NSIS 默认 per-user 安装到 `%LOCALAPPDATA%`，推测可写，但把生成物放进安装目录在卸载时会被清掉，属设计缺陷） |
| §1「首次登录账号 `admin` / 密码 `admin888`，首次运行会自动创建该账号」 | 不是「自动创建」：`LoginView` 检测 `hasAccounts` 后展示**初始化表单**，用户提交后打 `POST /api/auth/setup` | `src/components/LoginView.vue:14,31,44`；`src/api.js:81`；`server/index.js:343-362`（已有账号时返回 400） |

**总技术文档 `跨多多AI创作台-完整技术总文档.md`（1287 行）**：其 §17 上线前必办清单与 §18 路线图**基本准确**（§17 第 6 条「更新通道接 preload」仍未办、第 8 条待清理的 `.testdata/` 与 `__probe.mjs` 至今仍在，均已核实），但 §18「已完成 ✅」把「五 | 自动更新接 OSS」「六 | 多品牌白标（三品牌）」列为已完成，与 §2.5/§3.3 的结论冲突。

---

## 6. 版本号与发布链路现状

### 6.1 当前状态

| 项 | 值 | 证据 |
|---|---|---|
| 版本号 | `0.2.0` | `package.json:3` |
| 服务端读取的版本同样来自 `package.json`（不是 Electron `app.getVersion()`） | `server/index.js:460-466` | — |
| feed 里的 latest | `"0.2.0"`（**等于当前版本 → `hasUpdate` 恒 false**） | `server/update-feed.json:2`；比较逻辑 `server/index.js:498` |
| **`publish.url` 是占位符** | `https://REPLACE-WITH-YOUR-OSS.oss-cn-beijing.aliyuncs.com/releases/` | `package.json:61` |
| 上传脚本会主动告警占位符 | `scripts/upload-release.mjs:81-87` | — |
| 差异更新门槛 | `DIFFERENTIAL_MIN_VERSION = "0.2.0"` | `electron/updater.cjs:15` |
| `release/` / `dist/` | **均不存在**（本工作区从未构建） | 实测 |
| `.testdata/credits-ledger.json` | 存在（测试污染遗留） | 实测（6514 字节） |

### 6.2 发布前还缺的配置/修复（逐条可执行）

| # | 事项 | 为什么 | 证据 |
|---|---|---|---|
| 1 | 替换 `build.publish.url` 占位符 | 否则客户端检查更新 404 | `package.json:61`；总技术文档 `:1137` |
| 2 | 把 `update:*` 接进 `preload.cjs` | 否则界面无法检查/安装更新（现状是假进度条） | `preload.cjs:8-33` vs `updater.cjs:131-155`；总技术文档 `:1147` |
| 3 | 决定 `update-feed.json` 的去留 | 它被打进包且无法远端更新，使前端提示永久失效；建议删除该机制或改为由 `app-update.yml`/`latest.yml` 单一来源驱动 | `package.json:50`、`server/update-feed.json:2`、`server/index.js:478-504` |
| 4 | 修 `updater.init()` 重复注册 | 打包版「登出→登录」可能停在未加载窗口 | `main.cjs:323`、`updater.cjs:131` |
| 5 | 修 `src/api.js:407-411` 的 `payOrder()`（改调 `/api/recharge/orders/:id/pay`） | 否则充值弹窗支付必 404 | `src/api.js:407-411`、`AccountModals.vue:102`、对照 `server/index.js:243` |
| 6 | 把 `BRAND` 接进 electron-builder（`productName`/`appId`/`artifactName`/`shortcutName`，以及把品牌 key 固化进包，不依赖启动环境变量） | 否则 OEM 包与默认包无差别 | `package.json:16-17,43,44,73,79`；`server/brand.js:25` |
| 7 | 修 `build-installer.bat:34,37` 的目录（`dist` → `release`） | 否则打包「成功」却打不开产物目录 | `build-installer.bat:34,37` vs `package.json:45-47` |
| 8 | **修 `src/__theme.test.mjs:52`（或恢复 `theme.js:54`）** | 否则 `npm test` 恒失败，发布流程无法通过自检 | `__theme.test.mjs:52` vs `theme.js:54`；`run-tests.mjs:162-164` |
| 9 | 配置代码签名 | 未签名安装包会被 SmartScreen 拦 | `package.json:64-74`（win 段无签名配置） |
| 10 | 清理 `.testdata/`、`__probe.mjs`、`test_gen.py` | `.testdata` 是测试污染；`__probe.mjs` 会覆写真实账本（危险） | 实测；`__probe.mjs:22-24`；总技术文档 `:1149` |
| 11 | 上传前跑通三件套（exe + blockmap + latest.yml）并保持 `latest.yml` 版本与 `package.json` 一致 | 脚本会强校验，不一致直接 fail | `scripts/upload-release.mjs:64-72` |
| 12 | 修 `scripts/rebrand-logo.py:21-23` 的绝对路径 | 现有路径指向旧机器，脚本不可运行 | `rebrand-logo.py:21-23` |

### 6.3 可复现的发布链路（按代码现状推演）

```
npm run dist:oem-a           → vite build && electron-builder（BRAND 只影响构建进程环境，不入包）
   ↓ release/kuaduoduo-ai-canvas-0.2.0-setup.exe / .blockmap / latest.yml
OSS_BUCKET=xxx npm run release:upload
   → 校验三件套 + 版本一致性 + 占位符告警（package.json:61 未改则只告警、不阻断）
   → ossutil → ali-oss → 手动清单，三选一
   ↓
客户端启动 8 秒后 updater.cjs:158-160 检查 latest.yml
   → 但 preload 未桥接（§1.6），用户看不到也点不到
```

---

## 7. 遗留物与工程卫生

| 项 | 状态 | 证据 | 建议 |
|---|---|---|---|
| `src/components/_deprecated/InfiniteCanvas.vue`（163 行）、`PromptPanel.vue`（244 行） | 无人引用（全仓 grep 仅命中自身） | 实测 grep | 可删；或保留但 README 需说明二者已被 Vue Flow 取代 |
| `__probe.mjs`（根目录） | 危险遗留：会覆写真实账本 | `:5, 22-24` | 立即删除 |
| `test_gen.py`（根目录） | 手工冒烟脚本 | `:1-33` | 归入 `scripts/` 或删除 |
| `.testdata/credits-ledger.json` | 测试污染产物 | 实测 6514 字节 | 删除；`run-tests.mjs` 已用 temp 目录，说明该目录来自更早的手工运行 |
| `public/templates/*.png` × 7 | 1–2MB 生成源图，带只读属性，靠 `vite.config.js:16-42` 构建时剔除 | 实测；`vite.config.js:13-14` 注释说明「移不走也删不掉」 | 已在构建层解决；建议从 `public/` 挪到仓库外（避免每次构建后处理） |
| `.electron-cache/`、`.npm-cache/` | 存在（实测） | — | **实测 `.gitignore` 未覆盖这两个目录**（该文件覆盖了 `node_modules/ dist/ release/ outputs/ *.log .workbuddy/ .testdata/ .testdata-srv/ __probe.mjs .DS_Store Thumbs.db`）；建议补上 |
| `server/data/templates.json` | 11 模板内置数据，随包分发 | `:5-103` | 正常 |

---

## 8. 未验证事项（明确列出，不臆测）

| # | 事项 | 为什么未验证 | 需要什么才能验证 |
|---|---|---|---|
| 1 | 打包版「登出→登录」是否真的白屏（§0.1 第 4 条） | 需要 `app-update.yml` 存在（即已真实发布过一版）+ 跑打包版应用；本工作区禁止构建 | 一次 `npm run dist` + 实机登录/登出 |
| 2 | `release/` 三件套是否真能生成、`latest.yml` 版本是否一致 | 同上，未构建 | 一次 `npm run dist` + `npm run release:upload`（dry-run） |
| 3 | 四家云端 provider 的真机验收（文档 10 号 §6 的 7 条） | 需要真实 API Key | 万相 DashScope / 火山 Ark / OpenAI / Gemini Key |
| 4 | 支付真实链路（文档 4 号 §1.11 的 7 条） | 需要商户号/AppId/私钥/公网 HTTPS 回调域名 | 微信商户平台 + 支付宝开放平台凭证 |
| 5 | OSS 自动更新的完整升级流程 | 需要真实 Bucket + `publish.url` | OSS Bucket + AccessKey |
| 6 | `npm test` 全量 13 套件的实测结果 | 本工作区禁止构建；且另一队友正在安装依赖/构建，并发跑测试会互相干扰；`npm test` 会拉起服务端实例 | 依赖安装完成后，由 Lead 统一跑一次 `npm test` |
| 7 | 除 `src/__theme.test.mjs` 外 12 个套件的运行期断言展开数 | 需要起服务端/子进程；静态计数与文档口径已在 §4.2 标注 | 同上 |
| 8 | `src/responsive.css` 三档断点的**具体像素值**是否与文档 15 号 §3 表格逐条一致 | 未逐行核对（该文件 108 行） | 逐行比对 `responsive.css` 与 `15-...md:219-224` |
| 9 | 打包形态下 `outputs/` 是否可写 | 需要装一次再看 `process.cwd()` | 实机安装测试 |
| 10 | `npm run build` 是否零报错（文档反复声称的 `vite build` 通过） | 禁止构建 | 一次 `npm run build` |
| 11 | ~~`.gitignore` 是否已覆盖 `.electron-cache/`、`.npm-cache/`~~ | **已验证**：覆盖 `dist/ release/ outputs/ .workbuddy/ .testdata/ .testdata-srv/ __probe.mjs *.log`，**未覆盖** `.electron-cache/` 与 `.npm-cache/`；另：`.gitignore` 的中文注释读出为乱码（`鏈湴...`），**推测是 GBK 编码**【未验证】 | — |

---

## 附录 A：本次审计引用的关键行号索引

```
electron/main.cjs          24-35 单实例 | 87-97 pickPort | 106-109 fork 传参 | 182-208 CSP
                           250-292 登录窗 | 295-373 主窗 | 323-324 updater.init/loadURL 顺序
                           387-445 菜单 | 448-485 IPC | 462-474 登出登录 | 488-507 生命周期
electron/preload.cjs        5-6 windowMode | 8-33 11 个桥接成员（无 update:*）
electron/updater.cjs       15 差异门槛 | 37-48 配置探测 | 82-91 门控 | 131-155 IPC 注册
                           125-129 静默失败 | 158-160 延迟 8s
vite.config.js             16-42 strip 插件 | 47-51 outDir/emptyOutDir | 54-58 代理（缺 /materials）
package.json                3 版本 | 8-22 脚本 | 42-81 electron-builder | 61 占位符 | 50 files 含 server
server/brand.js            24-27 选 key+兜底 | 30-48 字段补全
server/config.js           22 i2iModel | 37-42 outputsDir | 48 PROVIDER_KEYS | 76-90 明文迁移 | 100-101 双保险
server/paths.js            12-14 AI_CANVAS_HOME
server/vault.js            34 强制 file | 67-71 每密钥一文件 | 114-133 AES-GCM | 153-181 旧文件迁移
server/upstream.js         29 SIG_VERSION | 85-113 内容哈希签名 | 122-144 payload/规范 | 191-203 userId 隔离 | 241-267 sweep
server/lineage.js          23 META_SUFFIX
server/index.js            152 模板反哺 | 191 reconcile | 243 pay | 270 验签 | 303 markPaid | 319-327 回调+sandbox403
                           460-504 版本/feed | 529 generate | 549/557 签名+缓存 | 632 lineage.record
                           699 tasks/cancel | 882-949 video 通路 | 977-1006 静态目录与 .meta.json 拦截 | 1018 sweep
server/materials.js        22-40 四组标签 | 60/68 双防线 | 107 setTags | 134 删除
server/providers/wanxiang.js  29-36 旧协议负向词 | 101 multimodal 端点 | 146 refimage | 157 i2iModel
server/providers/ipadapter.js 43 outIndex | 116 model 输入判定 | 188+ appendIPAdapter
server/providers/comfyui.js   12 refimage | 15 ipadapter | 317 /interrupt | 340-363 一次 object_info + 融合判定
scripts/run-tests.mjs      17 临时目录 | 61-73 服务端隔离 | 93-140 13 套件 | 142-144 收尾 | 162-164 汇总判定
scripts/upload-release.mjs 43-61 三件套 | 64-72 版本一致性 | 81-87 占位符 | 90-140 三路降级
build-installer.bat        21 npm run dist | 34/37 目录写错
run-desktop.bat            18-21 自动 install | 30 npm run desktop
src/theme.js               23-48 三套主题 | 51-54 默认 atelier | 56-57 localStorage v2 | 64-66 normalize
src/themes.css             119-190 aurora | 230-303 atelier | 334-410 momentum | 无 classic
src/__theme.test.mjs       52 失败断言 | 41/43 classic 已删 | 92-126 CSS token/明暗/EP 对接
src/__ui.test.mjs          55-57 CRC 已知值 | 85-90 只 existsSync | 133-141 自证式分档
src/__p18.test.mjs         73-85 循环展开 | 142-148 缓存命中 | 190-200 TTL 子进程 | 214-216 条件断言
src/api.js                 407-411 payOrder 指向已删接口
src/components/UpdateToast.vue 21 fetchVersion | 40-59 模拟进度 | 67-69 reload
src/project.js             170-172 removeProject 落盘 | 273-275 localeCompare 排序
src/App.vue                67-74 品牌落 --brand
src/main.js                11/18/20 样式顺序 | 23/29/35 错误边界 | 26 initTheme
```

## 附录 B：本次未触碰的边界

- **未修改** `ai-canvas` 下任何源码、配置、文档。
- **未执行** `npm install` / `npm run build` / `npm run dev` / `npm run dist` / `electron-builder` / 任何写盘构建。
- **唯一执行**：`node src/__theme.test.mjs`（纯前端逻辑，不写盘、不起服务端），环境变量 `AI_CANVAS_HOME` 指向 `%TEMP%` 下随机目录。
- 一次误用的探测（因 PowerShell `$home` 与只读自动变量 `$HOME` 冲突，导致 `AI_CANVAS_HOME` 落到了 `C:\Users\Administrator`）已核查并确认**未产生任何文件**：`USERPROFILE` 顶层在探测前后 25 分钟内无任何新增/修改项，`ui-export`、`config.json`、`secrets`、`.vault-salt` 等均不存在（那次 `src/__ui.test.mjs` 因 DSH 沙箱拒绝写入工作区外路径而直接失败，反而未落盘）。
