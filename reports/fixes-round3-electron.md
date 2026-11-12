# 第三轮 · Electron/打包专项修复报告

任务：`task-5`「第三轮-Electron：打通自动更新真链路 + 白标打包 + bat/代理修正」
项目：`E:\DSH项目\ai-canvas`（Vue 3 + Element Plus + Express + Electron 33）
日期：2026-10-14
执行人：electron-engineer

---

## 0. 结论摘要

| # | 项目 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 自动更新真链路打通（消灭假进度条） | ✅ 已完成（代码级 + 契约级验证；Electron 窗口未实测） | `scripts/__brand.config.test.mjs` 防回归 21 项全绿；UpdateToast 用 `@vue/compiler-sfc` 编译 0 错误 |
| 2 | 白标打包（OEM 包真的不一样 + 品牌固化） | ✅ 已完成（打包器配置对象级验证；未真跑 electron-builder） | 三个品牌下 `appId/productName/artifactName/shortcutName/extraMetadata` 逐项断言；`server/brand.js` 真返回 OEM 品牌 |
| 3 | `build-installer.bat` 目录错 | ✅ 已完成 | 改指 `release\`，加存在性判断与可读提示 |
| 4 | `vite.config.js` 缺 `/materials` 代理 | ✅ 已完成（代理表运行期验证；dev server 实测被沙箱拦住） | 真实 `vite.config.js` 模块 import 后 proxy 表含 `/materials`；后端直连 `/materials/probe-round3.png` = HTTP 200 |

新增测试套件：`scripts/__brand.config.test.mjs`（**104 项通过 / 0 失败，exit 0**），已接入 `scripts/run-tests.mjs` 作为第 15 套。

全量测试：**15 套里 14 套通过**，唯一失败是 `server/__p18.test.mjs` 的 `TTL 过期场景可验证` ——
**与本次改动无关，是沙箱禁止「管道 stdio 的子进程」导致的既有失败**，证据与建议见 §6。

⚠️ 本报告 §7 列了 **9 项未验证**，请务必先看那一节再判断完成度。

---

## 1. 改动文件清单

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `electron/preload.cjs` | 改 | 新增 `update` 命名空间（3 个 invoke + 6 个事件订阅，订阅返回取消函数） |
| `electron/updater.cjs` | 改 | `init()` 幂等化、三个 IPC 通道无条件注册、新增 `setWindow()`、自动检查改挂窗口 |
| `electron/main.cjs` | 改 | `updater.init()` 提到 `whenReady` 只跑一次；主窗只 `setWindow`；品牌固化写回 env；关于/报错标题跟品牌 |
| `src/components/UpdateToast.vue` | 改 | 重写为「真链路优先 + web 兜底」，删除 `setInterval + Math.random` 假进度 |
| `electron-builder.config.cjs` | **新增** | 打包配置从 `package.json` 抽出，按 `BRAND` 现算四项身份 + 品牌固化 |
| `config/brand-resolver.cjs` | **新增** | 品牌解析唯一入口（打包期/运行期/测试共用一套规则） |
| `config/brand.json` | 改 | 每个品牌补 `appId`；OEM 的 `logo` 留空 + `logoPending/logoNote` 如实标注待补；OEM 补 `exeName` |
| `config/brand-assets/README.md` | **新增** | OEM 图标投放位置与「待补」状态表（不放占位图） |
| `package.json` | 改 | 删掉静态 `build` 段；`dist` 指向 `--config electron-builder.config.cjs`；新增 `test:brand` |
| `vite.config.js` | 改 | 补 `/materials` 代理 |
| `build-installer.bat` | 改 | `dist\*.exe` → `release\*.exe`，加存在性判断，支持按品牌打包 |
| `scripts/__brand.config.test.mjs` | **新增** | 白标打包配置 + 假进度条防回归测试（可独立跑） |
| `scripts/run-tests.mjs` | 改 | 接入第 15 套；服务端 spawn 的 stdio 由管道改文件句柄（沙箱兼容，见 §5.3） |
| `scripts/upload-release.mjs` | 改 | 更新源地址改从 `electron-builder.config.cjs` 读（`build` 段已搬走） |
| `reports/fixes-round3-electron.md` | **新增** | 本报告 |

**没有碰**：`server/**`（含 `server/brand.js`）、`src/components/NodeCanvas.vue`、`src/store.js`、`src/newui.css`、`src/__*.test.mjs`。

---

## 2. 项目 1：自动更新真链路（核心）

### 2.1 改了什么

**(a) `electron/preload.cjs`：补上真链路桥接（原来一个 `update:*` 都没暴露）**

- 新增 `subscribe(channel, cb)` 工厂：`ipcRenderer.on` 之后 **`return () => ipcRenderer.removeListener(channel, handler)`**，与既有 `onWindowState`（`preload.cjs:19-23`）写法完全一致。
- 暴露 `window.desktop.update`：`check()` / `install()` / `state()` 三个 invoke，外加 `onChecking / onAvailable / onNone / onProgress / onDownloaded / onError` 六个订阅。
- 仍是白名单式 `contextBridge.exposeInMainWorld("desktop", {...})`，**没有**整抛 `ipcRenderer`（测试里有一条专门断言 `!exposeInMainWorld("ipcRenderer")`）。

**(b) `src/components/UpdateToast.vue`：真链路优先，web 兜底只提示不撒谎**

| 改造前 | 改造后 |
| --- | --- |
| `setInterval` + `Math.random` 造 5.5 秒假进度（旧 `:34-61`） | 进度 **只**来自 `update:progress` 的 `percent`（`UpdateToast.vue:140-144`） |
| `state='done'` 由假定时器触发 | `state='done'` 只由 `update:downloaded` 触发（`:145-152`） |
| 「立即重启」= `location.reload()`（旧 `:67-69`） | 「立即重启」调 `window.desktop.update.install()`（`:232-249`）→ 主进程 `quitAndInstall` |
| 纯浏览器也假装下载 | 无 `update.check` 时走 **[web 兜底]**：只显示「发现新版本」，**不画进度条、不置 done**（`:199-222`） |
| 无 | 真链路不可用时如实说明原因：`dev` / `no-source` / `missing-dep`（`reasonText`，`:88-101`） |

判据用 `window.desktop?.update?.check` 是否存在（`:29`），而不是光看 `update` 对象在不在，避免 preload 只暴露一半时误判。
真链路在每次检查前先 `state()` 问能力（`:171-184`），因此 dev / 未配置更新源时不会去 invoke 一个会被 reject 的通道。
订阅在 `onMounted` 里**先订阅再检查**（`:264-266`），`onBeforeUnmount` 逐个调用取消函数（`:293-297`）。

**(c) `electron/updater.cjs`：修重复注册 + 让渲染层问得到「为什么不可用」**

- `init()` 幂等：新增 `initialized` 守卫（`:140-145`），重复调用只更新窗口引用与日志函数，**不再重复 `ipcMain.handle`**。
- 三个通道改为**无条件注册**（`registerIpc()`，`:122-148`）：原来 `isDev` / 无 `app-update.yml` 时 `init` 直接 `return`，通道根本没注册，渲染层 `invoke` 会被 reject（`No handler registered`），前端只能猜。现在统一返回 `{ ok:false, reason:"dev"|"no-source"|"missing-dep" }`。
- 新增 `setWindow(win)`（`:79-85`）：主窗随「登出→登录」重建，事件推送目标必须能换。
- 自动检查（原 8 秒定时器）改由 `scheduleAutoCheck()`（`:91-99`）安排，且**要求窗口已挂上**才排、只排一次 —— 因为 `init()` 已被提到 `whenReady`（窗口还不存在），定时器若留在 `init` 里，8 秒后事件会发到空引用上丢掉。

**(d) `electron/main.cjs`：修「每次建主窗都重复注册」这个真实 bug**

- `updater.init({...})` 从 `createMainWindow()`（旧 `:323`）移到 `app.whenReady` 内、首次建窗之前（新 `:532`），**全文件只出现一次**。
- `createMainWindow()` 内改为 `updater.setWindow(mainWin)`（`:355`）；主窗 `closed` 时 `updater.setWindow(null)`（`:404`），不再往已销毁窗口推事件。

### 2.2 为什么

- 旧版 preload 没有任何 `update:*` 桥接 → 渲染层**完全够不到**真链路，这是「假进度条」能存在的前提。只改 UpdateToast 不改 preload，真链路依然是死的。
- `init()` 放在建主窗流程里，会让打包版「登出 → 登录」第二次建主窗时抛
  `Attempted to register a second handler for 'update:check'`，打断 `createMainWindow`，主窗停在未加载状态。
- 假进度条比「没有更新提示」更糟：用户以为装了新版，实际什么都没发生。

### 2.3 怎么验证 + 实测输出

```powershell
# ① 独立品牌/防回归测试（含 21 项更新链路断言）
node scripts/__brand.config.test.mjs        # → 104 通过 / 0 失败，exit 0

# ② UpdateToast.vue 真编译（沙箱跑不了 vite build，用 compiler-sfc 直编）
#    parse → 0 errors；compileScript → 通过；compileTemplate → 0 errors
```

实测（节选）：

```
  ✓ UpdateToast 不再用 Math.random 冒充进度（只看代码，不算注释）
  ✓ UpdateToast 里 setInterval 假进度已删干净
  ✓ UpdateToast 以 update.check 是否存在作为真链路判据
  ✓ UpdateToast「立即重启」调 update.install() 而不是 location.reload()
  ✓ UpdateToast 保留并明确标注 web 兜底路径
  ✓ UpdateToast 的 location.reload() 只在 web 兜底分支（真链路分支先 return）
  ✓ UpdateToast.vue 能被 @vue/compiler-sfc 解析（0 错误）
  ✓ UpdateToast.vue 的 <script setup> 编译通过
  ✓ UpdateToast.vue 模板编译通过（0 错误）
  ✓ preload 暴露 update.check / install / state
  ✓ preload 六个事件订阅齐全
  ✓ preload 订阅函数返回取消订阅函数
  ✓ preload 未整体暴露 ipcRenderer
  ✓ updater 导出 setWindow（主窗重建后可换推送目标）
  ✓ updater init 幂等（initialized 守卫，不再重复注册同名通道）
  ✓ updater 三个通道无条件注册（渲染层能问出不可用原因）
  ✓ updater 保留 quitAndInstall 真安装
  ✓ updater 的启动自动检查挂在 setWindow 上（不会在窗口还不存在时就把事件发丢）
  ✓ updater 自动检查有「窗口未挂上则不排」的守卫
  ✓ main.cjs 里 updater.init 只调用一次（修掉登出→登录重复注册）
  ✓ main.cjs 建主窗时只 setWindow
  ✓ main.cjs 的 init 在 app.whenReady 之后、createMainWindow 定义之外
```

> 说明：`Math.random` / `setInterval` 的断言会先剥掉注释再匹配 —— UpdateToast 头部注释必须写明「改造前用 setInterval + Math.random」，否则后人不知道这段历史；但断言要针对真正会执行的代码。

---

## 3. 项目 2：白标打包

### 3.1 改了什么

**(a) 抽出 `electron-builder.config.cjs`（新增）**

`package.json` 是静态 JSON，读不到环境变量 → `BRAND=oem-a npm run dist` 打出来的包与默认包完全一样。现在：

```jsonc
// package.json（已删除整个静态 build 段）
"dist": "npm run build && electron-builder --config electron-builder.config.cjs"
```

`electron-builder.config.cjs` 在打包开始时被 require，按 `BRAND` 现算四项身份：

| 字段 | 来源 | BRAND=oem-a 实测值 |
| --- | --- | --- |
| `appId` | `brand.json` 的 `appId`（新增字段，缺失则 `com.<slug>.ai-canvas`） | `com.xmulo.ai-canvas` |
| `productName` | `brand.json` 的 `appName` | `X.MULO 智能助手` |
| `win.artifactName` | `<artifactSlug>-ai-canvas-${version}-setup.${ext}` | `oem-a-ai-canvas-${version}-setup.${ext}` |
| `nsis.shortcutName` | `brand.json` 的 `appName` | `X.MULO 智能助手` |

另附：`win.icon` / `nsis.installerIcon` 支持 `config/brand-assets/<key>/icon.ico`（有就用，没有回退 `build/icon.ico` 并在日志标注）；`win.executableName` 支持可选 `exeName`（只给 OEM 设 ASCII 名，**默认品牌保持不设**，不动老用户已安装的 exe 路径）。
`files` 补了 `config/**/*` 的注释说明（原本就有，但漏了它固化字段就进不了包）。
`publish.url` 改从 `AI_CANVAS_UPDATE_URL` 读，缺省仍是那个占位符（并在打包日志里告警）。

**(b) 品牌固化进包 —— 选了 `extraMetadata`，不生成额外文件**

`electron-builder.config.cjs:53` → `extraMetadata: { main: "electron/main.cjs", aiCanvasBrand: "<brandKey>" }`

**为什么选它**（而不是 `config/brand.build.json`）：

1. `extraMetadata` 是 electron-builder 每次打包**必然执行**的机制，不存在「忘了跑某个前置脚本导致固化丢失」的可能；
2. 不产生 `config/brand.build.json` 这类产物文件 —— 那种文件容易和源码不一致、容易被误提交、也容易被 .gitignore 漏掉；
3. 机制已从依赖源码确认，不是猜的：
   - `node_modules/app-builder-lib/out/fileTransformer.js:27-34` —— 拷贝到主 `package.json` 时走 `modifyMainPackageJson(file, extraMetadata, ...)`；
   - 同文件 `:87-104` —— `deepAssign(mainPackageData, extraMetadata)` 后再 `cleanupPackageJson`，而清理只删 `_` 开头与 `dist/gitHead/build/scripts/keywords/devDependencies` 等固定名单，`aiCanvasBrand` 会保留。

运行时读取（`electron/main.cjs:20-34`）：

```js
const BRAND_RESOLVED = brandResolver.resolveRuntimeBrandKey({
  rootDir: ROOT_DIR, env: process.env, frozenKey: appPkg.aiCanvasBrand
});
process.env.BRAND = BRAND_RESOLVED.key;   // ← 关键一步
const APP_TITLE = BRAND.appName;
```

**为什么这样写**：`server/brand.js:24-27` 只认 `process.env.BRAND`，而 `server/**` 不在本轮写盘范围。把算好的 key 写回环境变量，`fork` 出去的内置服务继承 env（`main.cjs:106-109` 的 `env: {...process.env, ...}`），于是**未改动的 `server/brand.js` 也能拿到固化品牌**，接口返回、主色、文案全跟着变。
优先级：`BRAND` 环境变量 > 打包固化值 > `kuaduoduo` 默认；未知取值一律回退默认、不抛错（与 `server/brand.js` 口径一致）。

**(c) logo 与图标：不伪造，如实回退并标注待补**

- `config/brand.json`：`oem-a` / `oem-b` 的 `logo` **故意留空**，并加 `logoPending: true` + `logoNote`（逐品牌写明「未提供方形 mark，当前回退默认 `/brand/logo-mark.png`」）；`kuaduoduo` 保持真实 `logo` 不变。
- 回退是**服务端真实行为**：`server/brand.js:44` 的 `b.logo || "/brand/logo-mark.png"`（未改动）—— 测试里通过真实 import 验证。
- 图标投放位置与状态写进 `config/brand-assets/README.md`（含「当前状态」表，明确三个品牌各自的 ✅/❌），**没有放任何占位图**。

### 3.2 怎么验证 + 实测输出

`scripts/__brand.config.test.mjs` 可独立运行、失败非 0 退出，分四段共 104 项；其中与品牌相关的 71 项实测输出节选：

```
[1] 品牌解析器（临时 fixture，不依赖真实 brand.json）
  ✓ BRAND=oem-a → productName = 品牌 appName
  ✓ BRAND=oem-a → appId 用品牌自己的（否则会覆盖跨多多的安装）
  ✓ BRAND=oem-a → shortcutName 跟随品牌
  ✓ BRAND=oem-a → artifactName 带品牌前缀（不再固定 kuaduoduo-）
  ✓ BRAND=oem-b → appId 各自独立
  ✓ BRAND 缺失 → 回退默认品牌 kuaduoduo
  ✓ BRAND 为空白串 → 视为未设置，回退默认
  ✓ 未知 BRAND → 不崩，回退默认品牌
  ✓ logo 留空的品牌 → logoPending=true（如实标注待补）
  ✓ logo 留空的品牌 → logoNote 里写明待补
  ✓ brand.json 损坏 → 不崩，回退默认品牌
  ✓ 运行期：环境变量优先于固化值 / 无环境变量时用打包固化值 / 都没有 → 默认
  ✓ 未提供品牌图标 → pending=true 且回退 build/icon.ico
  ✓ 放了品牌图标 → branded=true 且路径指向品牌目录

[2] 真实 electron-builder.config.cjs（打包器实际读到的对象）
  ✓ [真实配置] BRAND=oem-a → appId 独立
  ✓ [真实配置] BRAND=oem-a → win.artifactName 带品牌前缀
  ✓ [真实配置] BRAND=oem-a → nsis.shortcutName 独立
  ✓ [真实配置] 品牌固化：extraMetadata.aiCanvasBrand = oem-a
  ✓ [真实配置] files 包含 config/**（否则固化字段与 brand.json 进不了包）
  ✓ [真实配置] 输出目录是 release（不是 dist）
  ✓ [真实配置] 品牌图标待补时如实回退 build/icon.ico（不伪造 OEM 图）
  ✓ [真实配置] 默认品牌 → appId 仍是 com.kuaduoduo.ai-canvas（老用户升级路径不变）
  ✓ [真实配置] 默认品牌 → 不设 executableName（不改变老用户已装 exe 路径）
  ✓ [真实配置] BRAND=oem-b → 三项身份与 A 包互不覆盖
  ✓ [真实配置] 未知 BRAND 不抛错，回退默认身份

[3] 运行期链路：main.cjs 取值规则 + 真实 server/brand.js 返回
  ✓ 固化 key=oem-a（真实 brand.json）→ 运行期解析出 oem-a
  ✓ 真实 brand.json：三个品牌 appId 互不相同（否则 OEM 包会覆盖安装）
  ✓ server/brand.js（未改）：固化品牌写回 env 后 → key=oem-a
  ✓ server/brand.js：name = X.MULO
  ✓ server/brand.js：appName = X.MULO 智能助手
  ✓ server/brand.js：主色跟随品牌（#E8590C）
  ✓ server/brand.js：logo 留空时如实回退默认 mark
  ✓ server/brand.js：无 BRAND 时回到 kuaduoduo（默认行为不变）
  ✓ server/brand.js：未知 BRAND 不崩，回退默认
```

「默认品牌身份不变」这条很关键：`appId` / `artifactName` / `executableName` / `shortcutName` 都保持原值，老用户升级路径不受影响。
打包日志里也会打出身份行，CI 翻日志即可确认这次打的是哪个牌子：

```
[brand] key=oem-a (来源 env) productName="X.MULO 智能助手" appId=com.xmulo.ai-canvas
[brand] 安装包名 oem-a-ai-canvas-0.2.0-setup.exe / exe XMULO-AI-Canvas.exe
[brand] ⚠️ OEM logo 待补：X.MULO 未提供方形 mark，当前回退默认 /brand/logo-mark.png。
[brand] ⚠️ 品牌 oem-a 未提供专属图标（config/brand-assets/oem-a/icon.ico），回退 build/icon.ico
[brand] ⚠️ 更新源还是占位符（https://REPLACE-WITH-YOUR-OSS...）
```

---

## 4. 项目 3：`build-installer.bat`

### 4.1 改了什么 / 为什么

- `dist\*.exe` → `release\`：electron-builder 输出目录是 `release`（`electron-builder.config.cjs:42` 的 `directories.output`），`dist\` 是 vite 的前端产物。原来 `dir /b "dist\*.exe"` 永远列不出安装包，`explorer "dist"` 打开的也是错的目录。
- 打开目录前先判断：`release` 不存在 → 提示并 `exit /b 1`；存在但没有 `.exe`（只剩 `latest.yml` / `blockmap`）→ 提示并 `exit /b 1`。
- 顺带支持按品牌打包：`build-installer.bat oem-a` → `set "BRAND=%~1"`，不传则默认品牌。

### 4.2 怎么验证

静态断言（4 项）+ 手工核对全文。断言内容：取包路径为 `release\*.exe`、不再出现 `dist\*.exe`、有存在性判断、无安装包时给可读提示并非 0 退出、支持 `%~1` 品牌参数。

```
  ✓ bat 从 release 目录取安装包（不再是 dist\*.exe）
  ✓ bat 打开目录前先判断存在性
  ✓ bat 没安装包时给可读提示并非 0 退出
  ✓ bat 支持按品牌打包（build-installer.bat oem-a）
```

> 未实际执行该 bat（它会调用 `npm run dist`，沙箱禁止且耗时极大）—— 见 §7.6。

---

## 5. 项目 4：`vite.config.js` 补 `/materials` 代理

### 5.1 改了什么 / 为什么

```js
"/api": "http://127.0.0.1:5181",
"/outputs": "http://127.0.0.1:5181",
"/materials": "http://127.0.0.1:5181"   // ← 新增
```

服务端 `server/index.js:1062` 有 `app.use("/materials", express.static(materialDir(), ...))`；
少了这条代理，`npm run dev` 下素材图全部 404（画布上的参考图直接裂开）。
（核对过服务端只有 `/outputs`、`/materials` 两个运行期静态挂载需要代理；`/brand/*`、`/templates/*` 由 vite 自己从 `public/` 提供。）

### 5.2 怎么验证 + 实测输出

**(a) 真实配置对象（不是正则）**：`vite.config.js` 是纯 ESM，直接 import 拿真实配置：

```js
const cfg = (await import("../vite.config.js")).default;
// proxy = {"/api":"http://127.0.0.1:5181","/outputs":"http://127.0.0.1:5181","/materials":"http://127.0.0.1:5181"}
// port = 5180
// plugins = vite:vue,strip-generated-sources
```

```
  ✓ vite 真配置：/materials 代理指向 127.0.0.1:5181（dev 下素材图不再 404）
  ✓ vite 真配置：原有 /api 与 /outputs 代理未丢
  ✓ vite 真配置：剔除生成源文件的插件仍在（防止误删导致包体回涨）
```

**(b) 目标路由真实存在**：起真后端（`AI_CANVAS_HOME` 指到工作区内临时目录、`materialDir` 指向其中、预置一枚探针文件），直连请求：

```
backend-direct /materials/probe-round3.png : HTTP 200 len=42
  body 解码 = DSH-ROUND3-MATERIALS-PROXY-PROBE-7f3a91   ← 与预置内容逐字节一致
```

即「代理的目标路径确实由后端提供内容」。

**(c) 代理跳本身未能实测** —— 见 §7.3：
`vite` dev server 在本沙箱起不来，`node_modules/esbuild/lib/main.js:1978 ensureServiceIsRunning` 抛 `spawn EPERM`（已单独确认 `esbuild.transformSync` 同样 `spawn EPERM`）。这是沙箱对管道 stdio 子进程的限制，与本改动无关，但也意味着「浏览器 → vite:5180 → 后端:5181」这一跳我没能跑通。

---

## 6. 环境拦路发现：`npm test` 现在为何是红的（非本次改动）

全量命令（任务指定）：

```powershell
$env:AI_CANVAS_HOME="E:\DSH项目\ai-canvas\.testdata-b"; $env:AI_CANVAS_VAULT="file"
& "<node.exe>" scripts/run-tests.mjs
```

结果：**15 套 14 通过，exit 1**。唯一失败：

```
──────── P1-8 上游签名自测（签名规则 / 缓存隔离 / 账本协同） ────────
=== 4. 缓存清理（sweep）===
  ✅ sweep 清掉旧版本签名条目
  ✅ sweep 保留当前版本有效条目
  ❌ TTL 过期场景可验证  stdout=undefined stderr=undefined
```

### 6.1 根因（已定位并证明）

`server/__p18.test.mjs:190-194` 用 `spawnSync(..., { encoding: "utf8" })` 起子进程验证 TTL —— `encoding` 隐含**管道 stdio**，在本沙箱直接被拒：`error.code = EPERM`、`stdout = undefined`，于是 `:196` 的 `JSON.parse` 落进 catch，报出 `:199` 那条 `TTL 过期场景可验证`。

证明（临时探针，已删除）：

```
=== 1) 现状：spawnSync + encoding（内部走管道 stdio）===
  error.code = EPERM
  status     = null
  stdout     = undefined
=== 2) 对照组：同一个子进程脚本，输出走文件句柄（不碰管道）===
  error      = (无错误)   status = 0
  child 输出 = [["刚写入时命中",true],["TTL 过后不命中",true],["sweep 报告已清理",true]]
  ✅ 刚写入时命中   ✅ TTL 过后不命中   ✅ sweep 报告已清理
```

对照组还**忠实复刻了父进程的播种步骤**（`__p18.test.mjs:159-171`：`cachePut` 存活条目 → 手工塞 `usig_v1_*` 残留 → `sweep()` 报 `{"removed":1,"kept":1}`），然后才跑子进程脚本。三个 TTL 断言全过 → **该用例本身逻辑是对的，唯一障碍就是管道 stdio**。

### 6.2 建议（超出我的写盘范围，未改）

`server/__p18.test.mjs:190-194` 把子进程输出改走文件句柄（或 `stdio: "inherit"` + 让子进程自己写文件），与我在 `scripts/run-tests.mjs` 里做的改造同款，改完这 15 套在本沙箱应当全绿。**我按纪律没有碰 `server/**`。**

### 6.3 我对 `scripts/run-tests.mjs` 的改造（在我的写盘范围内）

原 `run-tests.mjs:61-76` 用 `stdio: ["ignore","pipe","pipe"]` 起服务端并收集 `bootLog` —— 同样的管道限制让它**根本跑不起来**（`spawn EPERM`，`run-tests.mjs:61`）。
改为把 stdout/stderr 重定向到 `DATA_DIR/server.log` 的文件句柄，`readBootLog()` 保留「启动失败时打印服务端输出」的语义，并在收尾 `closeSync` 后再删临时目录（Windows 上不关句柄删不掉）。
**影响面**：只在受限沙箱里从「不可运行」变「可运行」；正常环境行为等价。副产物是这套 15 套测试终于能在本环境真跑，而不是只能静态断言。

---

## 7. 未验证清单（请重点看）

| # | 未验证项 | 为什么没验证 | 我已做到什么程度 |
| --- | --- | --- | --- |
| 1 | **真正跑 `electron-builder` 打 OEM 包** | 沙箱禁止（任务也明确不跑） | 断言了打包器**实际读到的配置对象**：三品牌下 `appId/productName/win.artifactName/nsis.shortcutName/extraMetadata/files/directories.output/win.icon` 全部逐项核对 |
| 2 | **固化字段在产物 `package.json` 里的最终形态** | 同上，没真打包 | 读 `app-builder-lib` 源码确认机制：`fileTransformer.js:27-34`（主 `package.json` 走 `modifyMainPackageJson`）、`:87-104`（`deepAssign` 后 `cleanupPackageJson` 不删自定义键） |
| 3 | **vite dev server 代理跳（浏览器 → 5180 → 5181）** | `esbuild` 无法 spawn（`spawn EPERM`），dev server 起不来 | ① 真实 `vite.config.js` 模块 import 后 proxy 表含 `/materials`；② 后端直连 `/materials/...` = 200 且字节一致 |
| 4 | **`vite build` 产物** | 同上（`vite build` 也要 esbuild）；沙箱跑不了 | 只做了语法与配置层验证，没有验证 `emptyOutDir` / strip 插件在真实构建中的行为 |
| 5 | **Electron 真机链路端到端**：preload → UpdateToast → `update:*` 事件 → `quitAndInstall` | 本环境 GUI 起不来（Lead 已确认） | 契约级验证 + SFC 真编译 + 21 项防回归断言；`quitAndInstall(false, true)` 调用点保留 |
| 6 | **`build-installer.bat` 实跑** | 会调用 `npm run dist` | 4 项静态断言 + 全文人工核对；`%~1` 品牌分支未执行 |
| 7 | **`scripts/upload-release.mjs` 实跑** | 需要 `release/` 产物与 OSS 凭证 | 语法检查（`--check`）+ 全文审查；改为从 `electron-builder.config.cjs` 读更新源，避免 `build` 段搬走后占位符检查静默失效 |
| 8 | **OEM 视觉白标的完成度** | OEM 方未提供 logo / 图标资产 | 如实标注待补（`logoPending`/`logoNote` + README 状态表），配置留空即回退默认，**未伪造任何图** |
| 9 | **前端展示「OEM logo 待补」提示** | 需要改 `server/brand.js` 或 `/api/brand` 消费方，超出我的写盘范围 | 只在配置/代码注释与本报告里标注；若要在界面上提示，请 Lead 决定是否在 `server/brand.js` 的 `current()` 里透出 `logoPending` |

另外两条需要 Lead 知情的边界：

- **`server/brand.js` 我没改**（纪律要求）。品牌固化靠 `main.cjs` 写回 `process.env.BRAND` 达成；如果将来有人绕过 `main.cjs` 直接 `node server/index.js` 起 OEM 服务，则仍需显式传 `BRAND`（这是预期行为，已在 `brand.json` 的 `_comment` 里写明）。
- **`config/brand.json` 新增了字段**（`appId`、OEM 的 `logoPending/logoNote/exeName`）。对 `server/brand.js` 无副作用（它只挑已知字段），但如果有别处直接遍历 brand.json，请留意。

---

## 8. 复现命令

```powershell
$node = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd E:\DSH项目\ai-canvas

# 新增套件（可独立跑，失败非 0 退出）
& $node scripts/__brand.config.test.mjs                 # → 104 通过 / 0 失败

# 全量 15 套
$env:AI_CANVAS_HOME="E:\DSH项目\ai-canvas\.testdata-b"; $env:AI_CANVAS_VAULT="file"
& $node scripts/run-tests.mjs                           # → 14 通过 / 1 失败（见 §6）

# 语法
foreach($f in @("electron/main.cjs","electron/preload.cjs","electron/updater.cjs",
  "electron-builder.config.cjs","config/brand-resolver.cjs","scripts/run-tests.mjs",
  "scripts/__brand.config.test.mjs","scripts/upload-release.mjs","vite.config.js")){ & $node --check $f }
# → 九个文件 syntax-exit=0
```

`report` 涉及的关键行号均以当前工作区文件为准（行号可能随后续改动漂移，函数名不变）。
