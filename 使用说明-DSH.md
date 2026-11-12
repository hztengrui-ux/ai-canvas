# 在 DSH 里跑通「跨多多 AI 创作台」——环境适配说明

> 适用：本副本位于 `E:\DSH项目\ai-canvas`（工作区内），由 `D:\跨多多AI创作台源码包\…zip` 复制而来。
> 原始源码包在 D 盘保持原样未改动。

---

## 一、为什么不能照 README 直接 `npm install`

DSH 的文件沙箱只允许写**工作区**（`E:\DSH项目`）。而这个项目的默认行为会往沙箱外写 4 个位置，
全部会被拒绝，表现为看起来莫名其妙的报错：

| # | 默认写入位置 | 沙箱表现 | 真实报错 |
|---|---|---|---|
| 1 | `%LOCALAPPDATA%\npm-cache` | 拒绝 | `npm error code EPERM … _cacache\tmp\…` |
| 2 | `%TEMP%\esbuild-xxxx` | 拒绝 | `[vite:esbuild-transpile] remove …: Access is denied.` |
| 3 | `%USERPROFILE%\.ai-canvas`（运行数据） | 拒绝 | 服务端起不来 / 写账本失败 |
| 4 | `%LOCALAPPDATA%\electron`（二进制缓存） | 拒绝 | Electron 下载失败 |

**解法：把这 4 个位置全部改写到工作区内。** 已经封装成 `dsh-env.ps1`：

```powershell
cd E:\DSH项目\ai-canvas
. .\dsh-env.ps1        # 注意是「点 + 空格 + 路径」，dot-source 才会留在当前会话
```

它设置的关键变量：

```
npm_config_cache      = <项目>\.npm-cache
TEMP / TMP            = <项目>\.tmp          ← vite/esbuild 必须
ELECTRON_CACHE        = <项目>\.electron-cache
AI_CANVAS_HOME        = <项目>\.rundata       ← 运行数据（账号/账本/审计）
AI_CANVAS_OUTPUTS     = <项目>\.rundata\outputs
AI_CANVAS_VAULT       = file                  ← 用本地加密文件存密钥，不碰系统凭据管理器
PORT                  = 5199
```

> `AI_CANVAS_VAULT=file` 很重要：默认后端是系统凭据管理器（`@napi-rs/keyring`），
> 在受限环境里不可用；`file` 后端把密钥加密成一个个 `.enc` 文件，放在 `AI_CANVAS_HOME\secrets\`。
> 项目自己的测试也是这么跑的（见 `scripts/run-tests.mjs`）。

---

## 二、还有两处沙箱限制，改环境变量解决不了

这两条是 DSH 沙箱**禁止命名管道**造成的，属于文档化的边界，不要反复重试同一条命令：

### 1. `npm install` 的生命周期脚本

`npm install` 会因为某个包的 postinstall 脚本 `spawn EPERM` 而失败，**并且整个 node_modules 会被回滚**。

```powershell
# ✅ 正确做法：跳过生命周期脚本
npm install --ignore-scripts --registry=https://registry.npmmirror.com
```

代价：Electron 的 `dist\electron.exe` 不会被下载（它靠 postinstall 下载）。
所以 **`npm run desktop` / `npm run dist` 在当前环境跑不了**；
但 `npm run build` + `npm run server` + `npm test` 全都正常——这也是本次验证的范围。

### 2. `vite build` 与 `npm test` 需要一次性放开沙箱

- **vite build**：esbuild 必须通过命名管道拉起常驻服务进程 → `spawn EPERM`
  （已确认 `node_modules\@esbuild\win32-x64\esbuild.exe --version` 本身能跑，纯粹是管道被禁）
- **npm test**：`scripts/run-tests.mjs` 用 `stdio: ["ignore","pipe","pipe"]` 拉起被测服务 → `spawn EPERM`

这两条各需要**一次**放宽沙箱执行：

```
sandbox_permissions: danger-full-access
```

> 实测：vite build 在放宽后 3.35s 构建成功（1672 模块）。

**备选方案（不想放宽沙箱时）**：测试可以绕开 `run-tests.mjs`，逐个直接跑。
除了 3 个需要外部服务端的用例（`__payments` / `__sync-http` / `__p18-http`，
它们读 `BASE` 环境变量）之外，其余 11 个测试文件都能用 `stdio:"inherit"` 直接运行。
需要外部服务端的 3 个，自己起一个服务端（用 `stdio:"inherit"`）再指定 `BASE` 即可。

---

## 三、标准验证流程（本项目实测通过）

```powershell
cd E:\DSH项目\ai-canvas
. .\dsh-env.ps1

# 1) 装依赖（跳过生命周期脚本 + 国内镜像）
npm install --ignore-scripts --registry=https://registry.npmmirror.com
# → added 572 packages in 23s

# 2) 全量测试（13 套 / 需沙箱放宽一次）
npm test
# → 12 套通过，1 套失败（主题套件，见下）

# 3) 生产构建（需沙箱放宽一次）
npm run build
# → ✓ built in 3.35s；dist/ 共 4.45 MB

# 4) 起服务并验证
npm run server
# → http://127.0.0.1:5199
```

### 验证服务真的在跑

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:5199/          # 200
curl.exe -s http://127.0.0.1:5199/api/session                          # 拿 token
```

拿到 token 后带上 `X-AI-Canvas-Token: <token>` 请求受保护接口：

```powershell
$tok = (curl.exe -s http://127.0.0.1:5199/api/session | ConvertFrom-Json).token
curl.exe -s -H "X-AI-Canvas-Token: $tok" http://127.0.0.1:5199/api/templates
```

> ⚠️ PowerShell 里用 `curl.exe -d '{"a":"b"}'` 传 JSON 会被引号规则吃掉（body-parser 报
> `SyntaxError: Expected property name`）。**把 JSON 写进文件再 `--data-binary "@file"`**，
> 或用 `Invoke-RestMethod`。

### 首次登录

服务起来后访问 `http://127.0.0.1:5199/`，走首次初始化：
- 账号 `admin` / 密码 `admin888`（`使用说明.md:29` 的说法）
- 注意：**代码里没有硬编码这个账号**。第一个管理员是由 `POST /api/auth/setup` 现场创建的，
  并自动获得 `r-super`（超级管理员）。`admin/admin888` 只是文档约定 + 测试里用的值。

---

## 四、当前实测结果（2026-10-14）

| 项目 | 结果 |
|---|---|
| `npm install --ignore-scripts` | ✅ 572 包 / 23s |
| `vite build` | ✅ 1672 模块 / 3.33s / dist 4.45 MB |
| 服务启动 + 静态页 | ✅ HTTP 200，`<title>跨多多科技 · AI 创作台</title>` |
| JS/CSS 资源 | ✅ 200（JS 1.61 MB、CSS 549 KB） |
| 公开接口 | ✅ `/api/session` `/api/brand` `/api/recharge/pay-status` 全 200 |
| 受保护接口 | ✅ 401（未带令牌，符合预期）→ 带令牌后全 200 |
| 首次初始化 + 登录 | ✅ 建号成功，返回 15 个权限码、`dataScope=all` |
| 模板下发 | ✅ 11 条 / 5 个分组 / 11 张示意图全部 200 |
| **全量测试** | ✅ **16 套全绿，exit 0** |

> 注：`npm test` 里 `__fixes.test.mjs`（第二轮：4 条严重缺陷防回归）会自己再起一个隔离实例
> （端口随机、数据目录独立），与 runner 起的那个互不干扰；
> `__round3.test.mjs`（第三轮：语义缩放/画布 id/作品组/技能入口/模型选择器）与
> `__brand.config.test.mjs`（白标打包）是纯静态+纯函数，不依赖服务端。

### 关于第 9 套（主题）那个曾经的失败 —— 已修

第一轮跑出来的是：

```
✗ 默认主题是 aurora
主题与批量模式：82 项通过，1 项失败
```

原因：`src/__theme.test.mjs:52` 断言写死 `DEFAULT_THEME === "aurora"`，
而 `src/theme.js:54` 实际已是 `"atelier"`（某轮把默认主题换成米白底，测试没跟着改）。
这是**测试断言过期**，不是功能坏了；`run-tests.mjs` 要求全绿才 exit 0，所以当时 `npm test` 必然返回 1。

**第二轮已修**：断言改为锁定 `"atelier"`，并补两条结构性断言（默认主题必须存在于注册表、
定义必须完整），以后改名会给出可读失败信息而不是静默失效。现在该套 **85/85 通过**。

---

## 五、本次新增/改动的文件（原源码包未动）

| 文件 | 说明 |
|---|---|
| `dsh-env.ps1` | 新增。DSH 环境修正脚本（上文第一节内容） |
| `.gitignore` | 追加 `.npm-cache/ .electron-cache/ .tmp/ .rundata/ .verifydata/` |
| `使用说明-DSH.md` | 新增。本文件 |
| `reports/*.md` | 新增。深度拆解报告 + 复验 + 交叉核查（共 7 份） |
| `server/__fixes.test.mjs` | 新增。第二轮 4 条严重缺陷的防回归验收（43 项断言） |
| `src/__round3.test.mjs` | 新增。第三轮验收：语义缩放选择器 / 画布 id / 作品组 / 技能入口 / 模型选择器（43 项） |
| `scripts/__brand.config.test.mjs` | 新增。白标打包与假进度条防回归（104 项） |
| `scripts/run-tests.mjs` | 改动。接入上述三套；服务端日志改文件句柄（绕开沙箱管道限制） |
| `server/__p18.test.mjs` | 改动。TTL 用例改走文件句柄取子进程输出（原来是管道 stdio，受限环境静默失败） |
| `electron/preload.cjs` `electron/updater.cjs` `electron/main.cjs` | 改动。自动更新真链路桥接 + init 幂等 |
| `src/components/UpdateToast.vue` | 改动。删除 `Math.random` 假进度，改走真链路 |
| `electron-builder.config.cjs` | 新增。按 BRAND 现算 appId/productName/产物名/快捷方式 |
| `server/index.js` `server/credits.js` `server/accounts.js` `server/admin.js` | 改动。R1–R4 四条严重缺陷修复 |
| `src/api.js` `src/components/AccountModals.vue` | 改动。R3 充值链路 |
| `src/__theme.test.mjs` | 改动。R5 断言修正 |
| `src/newui.css` | 改动。语义缩放改用真实类名 + 待接入徽标 |
| `src/store.js` `src/components/NodeCanvas.vue` `src/components/AppShell.vue` `src/components/StudioView.vue` `src/style.css` | 改动。画布 id / 作品组 / 技能入口 / 模型选择器 |
| `build-installer.bat` `vite.config.js` | 改动。目录修正 + `/materials` 代理 |
| `dist/` | 构建产物（可删，重新 build 会生成） |

### 桌面端（Electron）

#### ⚠️ 一个必须知道的环境限制：这台机器拒绝「修改 exe」

实测结论（三个独立工具、同一个错）：

| 工具 | 操作 | 结果 |
|---|---|---|
| NSIS 安装器 | 写 `Uninstall ….exe` | ❌「不能打开要写入的文件」 |
| electron-builder | 下载 winCodeSign 解压 | ❌ 符号链接「客户端没有所需的特权」 |
| `rcedit-x64.exe` | 给 exe 写图标 | ❌ `Fatal error: Unable to commit changes` |

**统一解释**：这台机器对「创建/修改可执行文件」有限制（企业组策略 / 受控文件夹访问 /
AppLocker 一类）。这解释了为什么安装包两次都失败——**不是我们打包的问题**。

**直接后果**：

1. **安装包在本机装不上**（写卸载器被拒）→ 用免安装版
2. **exe 换不了自定义图标**（默认显示 Electron 图标）→ 功能不受影响，只是图标不好看
3. 已试过把 winCodeSign 的 rcedit **预置进 electron-builder 缓存**绕开符号链接那步
   （`scripts/prepare-wincodesign.mjs`，解压排除 darwin 后 rcedit 确实拿到了），
   但即便绕过解压，`rcedit` 写 exe 仍被系统拒绝 → **这条路在本机走不通，已停止**

> 换台不受策略管控的机器（或开「开发者模式」/ 加白名单）后，
> `AI_CANVAS_SIGN_EXE=1 npm run portable` 即可让 exe 带上自定义图标。

#### ✅ 推荐：免安装版（绿色版）——解压即用，不写系统目录

```
ai-canvas\release\ai-canvas-portable\
├── 跨多多 AI 创作台.exe        ← 双击这个就能开
├── 创建桌面快捷方式.bat         ← 跑一次，桌面+开始菜单就有图标（体验等同安装版）
├── portable.flag               ← 绿色模式标记（有它才会把数据写在 data\）
├── 使用说明-免安装版.txt
├── 安装失败诊断.ps1             ← 万一还想试安装包，先跑它定位卡在哪
├── SHA256SUMS.txt              ← 80 个文件的校验和（拷完可核对）
└── data\                       ← 账号/项目/算力账本/窗口状态/日志全在这里
    ├── appdata\
    ├── outputs\
    └── materials\
```

**为什么这是"真绿色"**：exe 同级的 `portable.flag` 会让主进程进入 portable 模式
（`electron/main.cjs`），把 Electron 的 `userData`、内置服务的 `AI_CANVAS_HOME`、
`outputs`、`materials` **全部重定向到程序自己目录下的 `data\`** ——
不碰 `%APPDATA%` 和 `%USERPROFILE%\.ai-canvas`。整个文件夹拷到 U 盘/别的机器接着用，数据跟着走。

> 这是后加的能力。之前"免安装版"其实照样往 `%APPDATA%` 写，只能算免安装、不算绿色。

**想要"装好的"体验**：双击 `创建桌面快捷方式.bat`，桌面与开始菜单就会出现
「跨多多 AI 创作台」图标（不需要管理员权限、不碰注册表）。功能与安装版**完全一样**。

#### ⚠️ NSIS 安装包：两次都失败了 → 建议用免安装版

| 报错 | 含义 |
|---|---|
| `NSIS Error: Error writing temporary file. Make sure your temp folder is valid.` | 安装器写**自己的临时文件**失败 |
| `不能打开要写入的文件：…\AppData\Local\Programs\ai-canvas\Uninstall ….exe` | 安装器写**卸载器文件**被拒 |

**已用你机器上的实际状态核查过**：

- 目标目录 `%LOCALAPPDATA%\Programs\ai-canvas` **根本不存在** → 不是"旧版占用/文件被锁"
- 同目录下 `kuaduo-nesting-web`、`AI Change` 都装成功了 → **用户级安装在你机器上是通的**
- 该目录权限正常（Administrator 有完全控制权）、无相关进程在跑

结论：**不是权限或占用问题**，而是那个特定文件的写入被拦（最常见是安全软件的实时防护
在拦截"新建可执行文件 + 写卸载器"这个组合动作）。

**处理顺序**：

1. **直接用免安装版**（首选）——绕过整个安装器，功能一模一样
2. 仍想用安装包：跑 `安装失败诊断.ps1`，它会打印卡在哪一步，结果同时存到桌面
3. 临时关闭杀软的「文件实时防护」→ 重试 → 装完再打开
4. 右键安装包 →「以管理员身份运行」
5. 仍失败：把诊断脚本的输出发我

> 我**没有**改成 `perMachine` 安装或强制换安装目录 —— 那是拿没根据的猜测去改打包配置；
> 你机器上其它应用的用户级安装都正常，改它反而可能引入新问题。
> 安装包本身仍然保留：`release\kuaduoduo-ai-canvas-0.2.0-setup.exe`（89.94 MB）+
> `.blockmap` + `latest.yml`（自动更新三件套）。

#### 打包时的一个权限坑（已解决）

electron-builder 只要执行「改写 exe」，就会下载解压 `winCodeSign-2.6.0.7z`，
里面含 **macOS 符号链接**；Windows 非管理员且未开「开发者模式」时解压直接失败：

```
ERROR: Cannot create symbolic link : 客户端没有所需的特权
```

→ 打包中止（与项目代码无关）。**对策**：默认跳过改写 exe，产出未签名安装包。

- 代价：exe 用 Electron 默认图标、无版本信息；首次运行 SmartScreen 会拦一次。
- 要正式签名 / 自制图标（需管理员或开发者模式）：`AI_CANVAS_SIGN_EXE=1 npm run dist`
- 安装器图标走 NSIS 自身资源，**不受影响，始终正常**。

重新生成免安装版：`node scripts/make-portable.mjs`（会重算 SHA256SUMS.txt）

> ⚠️ **本会话内打不开 GUI 窗口**（Electron 的 GUI 初始化在沙箱派生的进程里完不成，
> 连最小空窗口都跑不通，已确认与项目代码无关）。所以"双击看到界面"这一步需要你在桌面上验证。
> 想先不开窗口看界面，用浏览器访问 `npm run server` 起的 `http://127.0.0.1:5199` 即可。

---

## 六、关于安卓版：做不了"移植"，需要先定方向

**结论：这不是一个"打包一下就有"的事，需要你选一条路线。** 依据如下（实测统计）：

| 障碍 | 实测 |
|---|---|
| 后端是 Express + Node 桌面服务 | `server/` **25 个文件 / 6523 行**，`node:fs` 17 处、`node:crypto` 8 处、`express` 9 处 |
| 密钥存系统凭据管理器 | `@napi-rs/keyring`（原生二进制，**安卓没有对应实现**） |
| 前端几乎全是鼠标交互 | `touchstart` **0 处**、`touch-action` **0 处**、`gesture` **0 处**（只有 4 处 `pointerdown`）→ 无限画布的滚轮缩放/悬停/右键菜单在触屏上都没有 |
| 前端依赖 Electron 桥 | `window.desktop` **12 处**（窗口控制、自动更新等） |
| 数据全在本机 | 账号/账本/项目都在本地文件，安卓沙箱下要换存储方案 |

**三条可选路线**（工作量差一个数量级）：

| 路线 | 做法 | 代价 | 预估 |
|---|---|---|---|
| **A. WebView 套壳 + 云端后端** | 把现有前端原样打进 Android WebView，后端部署到服务器，手机连你的服务 | 需要真部署（域名/HTTPS/支付回调备案）+ 触屏适配 | **3–5 天**（不含云部署与备案） |
| **B. 真原生（Capacitor + 重写后端）** | 前端搬 Capacitor，把 6523 行 Node 后端改成设备端 API（SQLite/文件/支付） | 等于**再做一遍产品**；画布要重写触控手势 | **3–6 周** |
| **C. 移动端 Web 精简版** | 单独做一个只用手机访问的页面，只保留查看/生成 | 功能砍掉大半 | **1–2 周** |

**我的建议**：如果目标是"手机上也能用"，先走 **A**——投入最小、能最快验证价值；
如果目标是"卖安卓 App"，那得按 **B** 立项，因为它跟桌面版本质上是两个产品。

**需要你定**：手机上你主要想干什么？（看图/出图/管账号/只是看进度）
定了我就按那条路线开工。

---

## 七、2026-10-17 视觉升级：新增默认主题「棱镜 Prism」

你给了那张运营分析参考稿并说"ui 与风格做得不好看，参考这个配色"。
配色不是眼估的——用 Pillow 对那张 906×1122 的图做了量化取色，再落成一套主题 token。

### 取到的五个主色

| 角色 | 色值 | 用在 |
|---|---|---|
| 底色（雾霭蓝紫） | `#ECEFF9` | 页面底、画布底 `#E7ECF7` |
| 招牌（柠檬绿） | `#D8FA34` | **当前导航项**、**主 CTA 按钮**（配墨黑字）、排序/筛选选中态 |
| 墨黑反色 | `#15171E` | 强调卡、深色侧栏、次级按钮 |
| 钴蓝（信息色） | `#4361EE` | 链接、焦点环、Element Plus 主色 |
| 薄荷（正向色） | `#7FD4D4` | 正向数据（保留 token，暂未大面积铺） |

用色逻辑跟前三套不同：**行为色（柠檬绿，可点）× 信息色（钴蓝，可读）分开**。
前三套是"单主色 + 中性灰"，所以整屏都是同一支蓝；这套把"能点的"和"能读的"拆开，
界面就不会到处都蓝。

### 改了哪些文件

| 文件 | 改动 |
|---|---|
| `src/themes.css` | 新增 `html[data-theme="prism"]` 基础块（40 个 token 全给齐）+ `html.dark[data-theme="prism"]` 暗色块 |
| `src/prism.css` | **新文件**，Prism 专属表面规则（底色渐变、导航药丸、主 CTA 字色、选中态统一），必须在 `redesign.css` 之后加载 |
| `src/main.js` | `import "./prism.css"`（排在 redesign 之后、responsive 之前） |
| `src/theme.js` | `THEMES` 增加 prism（排第一）、`DEFAULT_THEME = "prism"`、`DOT_COLORS.prism`；顺手修了 `canvasDotColor` 兜底不分明暗的旧问题 |
| `src/store.js` | 初始 `theme: "prism"` |
| `src/components/ThemeSwitcher.vue` | 兜底值跟随新默认 |
| `src/__theme.test.mjs` | 断言 4 套主题 / 默认 prism；新增 12 项：DOT_COLORS 覆盖检查、prism.css 加载顺序检查 |

**为什么 token 和表面规则要分两个文件**：`themes.css` 在 `main.js` 里排在
`redesign.css` **之前**，而 redesign 里已经有一批 `html[data-theme] .topbar` 这种
同特异性的规则 —— 主题块里写的表面样式会被它盖掉（同特异性、后写的赢）。
所以 token 留在 themes.css（测试逐项断言的就是它），专属表面规则放 prism.css。

### 怎么换回去

顶栏右上角"棱镜"→ 弹出四套：**棱镜 / 极光玻璃 / 画布工作室 / 流光灵动**，
每套都有亮/暗两版（共 8 组配色）。老用户 localStorage 里存的旧主题 id 仍然有效，
不会白屏；存了已删除的 `classic` 会静默落到默认主题。

### 白标注意

主题里 `--primary` 一律写成 `var(--brand)`，所以白标客户改 `config/brand.json`
的 `primary` 后，按钮/链接会自动跟品牌色走 —— 这条契约没动。
**但** Prism 的主 CTA 渐变（`--accent-grad`）与柠檬绿（`--lime`）是写死的：
白标如果换的是红/紫品牌色，请一并覆盖这两个 token，否则会出现"红品牌 + 绿按钮"。

---

## 八、手机端（微信小程序）：看图 / 出图 / 看进度 / 管账号

第一版走的是「局域网直连 + 开发者工具测试号」，不需要 AppID、不需要域名、不需要备案。

### 8.1 它长什么样

```
手机（微信小程序，6 个页面）
   │  http://192.168.x.x:5199      ← 同一个 WiFi
   ▼
电脑（跨多多客户端自带的服务端）
   │  AI_CANVAS_BIND=0.0.0.0       ← 只有手机联调时才打开
   ▼
data/ outputs/ materials/         ← 还是原来那套存储，一份数据两处看
```

四个能力都做了：

| 能力 | 手机上怎么用 |
|---|---|
| **看图** | 「看图」页两列网格、下拉刷新、触底加载、点开全屏左右滑、长按保存；**顶部吸顶筛选条**：时间（全部/今天/近 7 天/近 30 天）+ 项目 chips（含「未归属」），切换即重拉 |
| **出图** | 「出图」页选技能/模型 → 写提示词 → 1~4 张 → 可传 3 张参考图 → 提交后进「进度」页 |
| **看进度** | 「首页」显示正在生成的任务数；「进度」页每 1.5 秒轮询，进度文案逐条滚动 |
| **管账号** | 「我的」页看用户名/角色/余额、改密码（改完其它设备自动下线）、退出登录 |
| **充值** | 余额行/首页余额卡点进「充值」页：套餐网格、下单、订单列表与取消；**沙箱模式可「模拟支付」即刻到账**（走真实回调链路），配了真实商户号后明确提示"请到电脑端支付" |

### 8.2.1 两个新功能的边界（诚实说明）

**看图筛选**
- 时间筛选基于图片落盘时间（本地自然日），「近 7 天」= 本地 0 点往前 6 天，不是滚动 7×24 小时。
- 项目筛选靠**桌面端生成时上报的 `projectId` + `projectName`**。这个改动是 2026-10-18 才加的，
  **更早生成的图没有项目归属，会统一落到「未归属项目」** —— 历史数据补不回来。
- 项目本身存在桌面端的 localStorage 里（服务端没有项目表），所以项目名只能靠生成时"捎带"过来。

**充值**
- 小程序内做**真实支付**必须有商户号 + 小程序 AppID，服务端走 JSAPI 下单再调 `wx.requestPayment`。
  当前没有这些凭证，所以：沙箱模式能完整闭环（下单 → 模拟支付 → 到账），
  一旦电脑端配了真实凭证，手机端会明确提示"请到电脑端完成支付"并保留订单号，**不会假装能付**。
- 模拟支付不是直接改余额：它由服务端用沙箱私钥签一张回调票据，走**和真实网关完全相同的**
  验签 → 金额核对 → 幂等三道闸。

### 8.2 电脑端：三步

1. **启动联调模式**：双击项目根目录的 **`启动-手机联调.bat`**。
   窗口里会打印 `http://192.168.x.x:5199` —— 这就是手机要填的地址。
   （它做三件事：监听 `0.0.0.0`、开手机模式、固定端口 5199。窗口别关。）
2. **装微信开发者工具**（`developers.weixin.qq.com/miniprogram/dev/devtools/download.html`）。
3. **导入 `miniprogram/` 目录**：
   - 新建项目 → 目录选到 `ai-canvas/miniprogram`
   - AppID 那一栏点 **「测试号」**（不需要注册）
   - 详情 → 本地设置 → 勾选 **「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**
     （局域网是 http，不勾这项连不上）

### 8.3 手机端：两步

1. 小程序「我的」页 → 「服务端地址」→ 填电脑上那个 `http://192.168.x.x:5199` → 保存（重启生效）。
2. 用电脑端的账号密码登录（**账号必须是电脑端已经创建好的**；没创建过会提示去电脑端初始化）。

### 8.4 三个必须知道的限制

| 限制 | 说明 / 怎么办 |
|---|---|
| **出图需要先配模型** | 手机端只是代理，真正出图还是电脑端那个引擎。电脑端「设置 → 模型密钥」里至少要配一个云厂商 Key，或本机跑着 ComfyUI。没配的话出图会失败并提示原因（这是预期行为，不是 bug） |
| **只能在同一个 WiFi** | 第一版没走公网。手机用 4G/5G 或换个网络就连不上 |
| **正式版必须上 HTTPS** | 开发者工具里勾了「不校验域名」才能用 http；等你要发「体验版/正式版」给别人才需要域名 + 备案 + HTTPS，那是另一件事 |

**Windows 防火墙**：第一次如果手机连不上但电脑自己能访问，去「Windows 安全中心 → 防火墙 → 允许应用通过防火墙」放行 Node/客户端，或者临时关掉专用网络的防火墙试一下。

### 8.5 服务端做了哪些安全边界（不是裸奔）

这几个点是专门为"服务开到局域网上"补的，任何一条漏了都等于给同网段的人开后门：

| 边界 | 做法 | 测试 |
|---|---|---|
| **本机令牌不外发** | `/api/session` 只回环地址能拿；局域网请求一律 403 `LOCAL_ONLY`。不漏这条的话，网段里任何人 `curl` 一下就能拿到绕过登录的机器令牌 | 实测：局域网拿 → 403，本机拿 → 200 |
| **手机用独立令牌** | 登录发 `m_` + 64 位 hex 的会话令牌，7 天有效期、滑动续期；与机器令牌完全隔离，登出/改密立即失效 | 71 项断言里有令牌形状与登出失效 |
| **私有网段白名单** | 只有显式开 `AI_CANVAS_MOBILE=1` / `BIND=0.0.0.0` 才接受 `10./192.168./172.16-31.` 的 Host；公网 IP、域名一律拒 | 单测：默认状态下私有网段 Host 被拒 |
| **变更令牌门豁免有边界** | `/api/m/*` 豁免（小程序拿不到主进程内存里的令牌，且只走 header 无 cookie ⇒ 无 CSRF 面）；普通写接口**仍然**要变更令牌 | 加了反向断言：豁免没开成一片 |

另外：出图不是让手机直连生成接口，而是服务端用**该用户自己的令牌**代跑 SSE
（`server/mobile-jobs.js`）。好处是计费/幂等/退款/取消全部沿用原有逻辑，一行没改；
手机上断网、切后台也不影响任务继续跑，回来还能查进度。

### 8.6 接口清单

完整契约在 **`docs/mobile-api.md`**（前后端唯一依据，改字段先改它）。
共 18 个接口：
登录 / 登出 / 改密码 / bootstrap / home / outputs（含 from·to·project 筛选）/ tasks /
upload / jobs（提交·查·取消）/ info / recharge（页数据）/ recharge 下单 / 发起支付 / 模拟支付 / 取消订单。

### 8.7 测试

新增第 34 套 `server/__mobile.test.mjs`，**89 项断言**，分两段：

- 纯逻辑（45 项）：令牌形状、无效令牌解析不出人、回环判定、**额外令牌校验器接上 ≠ 放开鉴权**（含"别的 m_ 令牌仍被拦""不可信 Host 仍 403"）、作业越权隔离
- 真服务端（44 项）：登录错误码、令牌有效期、无令牌 401、机器令牌与 m_ 令牌同源、bootstrap/outputs/tasks 字段、
  **看图筛选**（from 生效、project=__none、不存在项目返回 0 条而不是 500）、**充值闭环**
  （下单 → 沙箱模拟支付 → 余额 +1000 → 重复支付拒绝 → 取消后不能再付 → 客户端传的价格被忽略）、
  作业 404、**登出后令牌立即失效**

`__guard-token.test.mjs` 补了 5 项「变更令牌门对 /api/m/ 的豁免边界」，
其中 2 项专门锁住**服务端自调必须补变更令牌** ——
否则桌面版里手机端会「能登录、能看图，一点出图就 403」，而且日志里只有一条 `MUTATION_TOKEN_REQUIRED`。

全量 `npm test` → **34 套全绿，exit 0**。

---

## 九、首次打开：SmartScreen 那道坎怎么过

双击免安装版 exe 时，Windows 会弹：

> Windows 已保护你的电脑 / Microsoft Defender SmartScreen 阻止了无法识别的应用启动 / 发布者：发布者未知

**根因不是病毒，是两件事叠加**：
1. 文件被打了 **Mark-of-the-Web**（从微信 / 网盘 / 浏览器拿到的文件都会带一个
   `Zone.Identifier` 备用数据流），SmartScreen 靠这个标记决定要不要拦；
2. exe **没有代码签名证书**，所以发布者显示"未知"。

### 9.1 正确解法（推荐，一次搞定）

**双击「直接打开-免安装版.bat」**（在客户端目录里）。它做三件事：

1. 删掉整个目录里所有文件的「来自网络」标记（`Unblock-File`）—— SmartScreen 的根因；
2. 清掉可能让 Electron 变成"跑 Node"的 `ELECTRON_RUN_AS_NODE` 环境变量；
3. 启动客户端。

> 这是系统正规做法，**不关任何安全防护**。之后直接双击 exe 也不会再弹。

### 9.2 如果还弹

| 情况 | 做法 |
|---|---|
| 弹窗里有「更多信息」 | 点它 → 「仍要运行」。只需一次 |
| 连「更多信息」都没有（单位电脑被策略锁死） | 跑「跳过安全检查-慎用.bat」→ 选 1。它会关掉**当前 Windows 用户**的「检查应用和文件」（HKCU，免管理员）；想恢复再跑它选 2 |
| 想确认到底被什么拦 | 跑「安装失败诊断.ps1」 |

### 9.3 已经做的"正规化"改造

| 项 | 之前 | 现在 |
|---|---|---|
| 程序图标 | Electron 默认的原子图标 | **跨多多品牌图标**（`build/icon.ico`，6 个尺寸） |
| 属性页信息 | 空白 | 产品名 / 公司「跨多多科技」/ 版本 `0.2.0.0` / 版权 |
| 启动方式 | 直接双击 exe（必弹一次） | **「直接打开-免安装版.bat」**：解除锁定后启动，不再弹 |

> 换图标与版本信息由 `scripts/apply-brand-icon.mjs` 调 rcedit 完成，**已接进 `npm run portable`**，
> 以后每次打包自动带上。万一 rcedit 被杀软锁文件导致失败：
> `AI_CANVAS_SKIP_ICON=1 node scripts/make-portable.mjs` 可跳过。

### 9.4 为什么"发布者未知"消不掉（说清楚，免得白折腾）

要让它显示公司名、彻底不弹警告，只能买**代码签名证书**（OV 约 ¥1000+/年，EV 约 ¥3000+/年）
并在打包时签名（`AI_CANVAS_SIGN_EXE=1` + 证书）。没有证书时：
- 解除文件锁定 → 日常不再弹（已实现）；
- 但 exe 属性页的"数字签名"仍是空，这是证书问题，不是程序问题。

### 9.5 启动器为什么是 bat + ps1 两个文件

批处理（`.bat`）按**系统代码页**（中文 Windows 是 936）读字节，把 UTF-8 中文写进去
会被从多字节中间切断，报出 `'PP' is not recognized` 这类完全不指向根因的错误；
`for` 括号块里的管道和 `^` 续行也会互相打架。

所以现在一律拆两层：
- **外壳 `.bat`**：纯 ASCII，只有三行（切目录 + 叫 PowerShell + 退出）；
- **主体 `.ps1`**：UTF-8 **带 BOM**，中文提示与全部逻辑都在这里。

这样以后改中文提示再也不会把启动器改坏。

### 9.6 本轮验证记录（含一条重要结论）

- 启动器实测：输出 18 行中文提示、`cmd` 解析错误 **0 个**、解除锁定/启动指令都正确执行。
- 图标与版本信息：`Get-Item` 读回 `ProductName / CompanyName / FileVersion 0.2.0.0` 全部正确；
  PE 可正常解析（`Get-AuthenticodeSignature` 返回 `NotSigned`，符合无证书预期）；
  `SHA256SUMS.txt` 与实际哈希一致（换图标在算校验和**之前**做，所以对得上）。
- **GUI 在本会话里起不来，但与本项目无关**：用**原装 Electron 33.2.0**（未做任何改动）
  做对照，同样以 `0x80000003`（STATUS_BREAKPOINT）退出 —— 是这个 agent 会话的
  Chromium 初始化限制，不是 exe 被改坏。你本机双击是正常的。

---

## 十、界面里那些「即将上线」的按钮

技能下拉（顶栏「技能」）里有 **3 个确实还没接入**的入口，现在会**如实标注、点了有反馈**：

| 技能 | 为什么没接 | 点了会告诉你现在能怎么做 |
|---|---|---|
| 一键高清 | 超分模型尚未接入 | 在结果图工具条里点「本地 2× 放大」（不消耗算力） |
| 局部编辑 | inpaint 后端尚未接入 | 从「AI 文生图」重出一张，或在画布用「自定义场景」加参考图重画 |
| 买家秀 | 买家秀模板尚未接入 | 在「使用模板」挑场景模板，或用「爆款复刻」上传参考图仿拍 |

### 10.1 本轮修掉的问题：点了没反应

原来的写法是给下拉项加 `:disabled="skill.available === false"`。
禁用状态下**浏览器根本不派发 click**，`onSkillClick` 永远不执行 ——
用户只看到一个灰标签"待接入"，既不知道原因，也不知道下一步。

现在：
1. **不再禁用**，可点击；
2. 点击弹出说明：**原因 + 现在能走的替代做法**（`ElMessageBox`，正文保留换行）；
3. 悬停有 `title` 提示（还没点就能看到原因）；
4. 文案统一为「即将上线」，并用柠檬绿小胶囊标出来（看得出未接入，但不像"坏掉的灰按钮"）；
5. 顺手修了一个逻辑问题：以前 `launchSkill` 是**先切到创作台再返回失败**，
   所以你点一个没接入的技能会先"跳走"再弹提示，看到的是空画布。
   现在失败就不导航。

### 10.2 回归测试怎么锁住的

`src/__round3.test.mjs` 里新增 6 条断言（共 72 条，全绿）：

- 下拉项**不能**再出现 `:disabled="skill.available === false"`（这条直接锁死原 bug）
- 不可用技能点击必须走 `ElMessageBox.alert`，且必须展示 `alternative`
- 每个不可用技能都必须有非空的 `alternative`（光说不行等于没说）
- `launchSkill` 失败**不得**改变 `store.route`（先摆到 home 再断言，避免空话）
- 返回值带 `unavailable` 标记，调用方能区分"未接入"与"未知技能"
- 文案必须是「即将上线」，不能再出现「待接入」

---

## 十一、打包事故复盘：客户端「打开了但页面是 Error」

这是本轮最重要的一处修复，值得单独记下来 —— 因为它的现象和根因差得很远。

### 11.1 现象

打包后的客户端双击启动：

- 进程在、服务起来了、`boot.log` 写着「启动完成」；
- 但**窗口标题是 `Error`**，页面全白；
- 服务端日志只有一行：

```
[server] Error: ENOENT, dist\index.html not found in E:\...\resources\app.asar
```

所有静态资源（`/assets/*.js`、`/brand/*.png`、`/`）全部 404。

### 11.2 根因（不是路径写错）

**Electron 33 在 `ELECTRON_RUN_AS_NODE` 模式下，`fs.createReadStream` 读 asar 内部路径会抛 ENOENT。**

内置服务是 `main.cjs` 用 `child_process.fork` 拉起来的子进程，正好跑在这个模式。实测对比：

| API | 读 `app.asar\dist\index.html` |
|---|---|
| `fs.existsSync` / `statSync` / `readFileSync` | ✅ 正常 |
| `fs.createReadStream` | ❌ `ENOENT, ... not found in app.asar` |

而 `express.static` 和 SPA 回退**全是流式读** → 一个文件都读不出来。

> 这就是为什么它特别难查：`existsSync` 说文件在、`readFileSync` 也能读，
> 只有"打开页面"这一步失败 —— 很容易误判成路由写错或构建产物没进包。

### 11.3 修法（两处，必须配套）

1. **`electron-builder.config.cjs`**：`asarUnpack: ["dist/**", "config/**"]`
   把前端产物与品牌资源解包成 `resources/app.asar.unpacked/` 里的**真实磁盘文件**。
2. **`server/index.js`**：新增 `realPath()`，把 `xxx\app.asar\dist` 改写成
   `xxx\app.asar.unpacked\dist`（找不到就保持原样，开发态无副作用）。
3. **`electron/main.cjs`**：`appIcon()` 也走同样的路径改写 ——
   否则托盘图标读的是 asar 内路径，日志里会出现
   `Unable to create status tray icon`（原生 `nativeImage` 不认 asar）。

（`server/**` 不用解包：ESM `import` 走的是 Node 的模块解析，asar 支持正常，
只有 `createReadStream` 这一族坏了。）

### 11.4 回归检查（这次不靠"看配置对不对"）

新增 `scripts/__verify-packaged-app.mjs`，**用打包好的 exe 自己**（run-as-node 模式）
去 `createReadStream` 那个首页文件 —— 直接复现当初崩掉的那一步：

```powershell
node scripts/__verify-packaged-app.mjs
```

9 项检查，其中最关键的两项：

- `dist/index.html 已解包（asarUnpack）`
- `打包 exe 用流式方式能读到首页（这是当初崩掉的地方）`

对**修复前**的包跑，它会报 6 项不达标（已验证检查确实有效，不是空转）；
对修复后的包跑，9 项全过。

> 这个脚本必须在上线前跑。CLI 层面的 `npm test` 覆盖不到 asar 行为 ——
> 它只在打包产物里才出现，属于"必须对着真产物验"的一类问题。

### 11.5 修好后的实测

| 检查 | 结果 |
|---|---|
| 窗口标题 | `跨多多 AI 创作台`（不再是 `Error`） |
| `GET /` | **200**，958 字节，`<title>跨多多科技 · AI 创作台</title>` |
| 8 个 JS/CSS 资源 | 全部 **200**（最大 963 KB 的 element-plus 也正常） |
| `/brand/logo-mark.png` | **200**，154 KB |
| 托盘 | `托盘：已创建 / 已就绪` |

### 11.6 另一个环境问题：这台机器上要 `--no-sandbox`

直接启动会以 `0x80000003`（STATUS_BREAKPOINT）退出；加 `--no-sandbox` 就正常。
用**原装 Electron 33.2.0**（未改动）对照，行为完全一致 —— 属于运行环境限制
（受管控/虚拟化桌面常见），不是产物问题。

所以启动器里加了**自动兜底**：`直接打开-免安装版.bat` 先正常启动，
4 秒后若进程已消失，会自动用 `--no-sandbox` 再拉一次，并说明代价
（只关渲染进程沙箱隔离，本机自用工具可接受）。

---

## 十二、界面配色定稿：墨黑 + 荧光绿（2026-10-18）

用户要求"所有页面的蓝色改成荧光绿"。第一版我直接把蓝色 token 换成绿色，**被否了 —— 也确实难看**，
原因值得记下来：

### 12.1 第一版为什么难看

| 问题 | 具体表现 |
|---|---|
| **满屏黄绿雾** | 页面底色也跟着改成 `#eef3e7`，配绿色图标/文字 → 整屏一个色相，像旧报纸 |
| **两种绿打架** | logo 是鲜黄绿 `#9FF939`，界面绿是橄榄绿 `#4E9E00`，色相/明度都不一致 → 脏 |
| **层级塌了** | 原设计是「荧光绿=行为色 + 钴蓝=信息色」双色分工；全改绿后重点卡片（黑色算力卡）成了孤岛 |
| **对比不足** | 绿色图标落在浅绿底上，`AI 换衣` 选中态几乎看不见 |

结论：**荧光绿天生不能当信息色**（在白底上对比太低），它只能当"点睛的行为色"。

### 12.2 定稿方案（用户选定）

| 角色 | 颜色 | 用途 |
|---|---|---|
| 中性底 | `#ECEFF2` 冷灰 | 页面底色（去掉原来的蓝紫偏色，也去掉第一版的黄绿） |
| 墨黑 | `#15171E` | 主色：logo、图标、链接、白字按钮底（原钴蓝的全部位置） |
| 荧光绿 | `#D8FA34` | **只给**主 CTA、当前选中项、热门角标（配墨黑字） |
| 石板灰 | `#5A6274` | info 语义色（原来也是钴蓝） |

这样界面是"中性 + 一点荧光"的高级感，层级清楚，也不会再有满屏绿。

### 12.3 蓝色原来藏在 4 个地方（只改一处不够）

| 来源 | 位置 | 处理 |
|---|---|---|
| 主题 token | `src/themes.css` 的 `html[data-theme="prism"]` | 整套重写（底/边/brand/primary/info/页面底光） |
| **品牌主色注入** | `config/brand.json` 的 `kuaduoduo.primary`，运行期由 `App.vue` **内联**写进 `--brand` | 改成 `#15171E` ← 最容易漏，内联样式优先级高于主题表 |
| 硬编码 hex | `style.css`/`account.css`/`admin.css` 共 33 处 | 全换成 `var(--primary)` 系列，以后跟着主题走 |
| 位图 logo | `logo-mark.png`、`logo.png`、`build/icon.png`+`.ico` | 用 alpha 蒙版重填墨黑（`scripts/recolor-brand-refresh.py` 可换任意色） |

> 换色脚本支持 `--hex`，且永远从 `reports/theme-backup/*.blue.png` 的**原始蓝版**重算 ——
> 连续换几版配色不会层层叠加色相、越改越脏。

### 12.4 怎么验的（不靠肉眼）

1. `node src/__theme.test.mjs` → 99 项；全量 `npm test` → 34 套全绿；
2. 起本地服务 + headless Chrome 逐页截图（工作台/创作台/模板库/我的项目）；
3. Python 统计偏蓝像素（`b > r+25 且 b > g+15`）：创作台 0.07%、工作台 0.50%
   （后者是石板灰 `#5A6274` 被脚本误判为"偏蓝"，不是真蓝；模板库剩下的蓝在封面照片里）；
4. 截图归档在 `reports/theme-2026-10-18-green/`：
   `方案A-墨黑配荧光绿.png`（定稿）、`方案B-深森林绿配中性底.png`（备选，未采用）。

### 12.5 回退办法

- 位图：`reports/theme-backup/*.blue.png` 是原始蓝版，拷回 `public/brand/` 与 `build/` 即可；
  `build/icon.ico` 需再生成一次（见 `scripts/recolor-brand-refresh.py` 末尾）。
- 颜色：`src/themes.css` 的 prism 段 + `config/brand.json` 的 `primary`/`primaryDeep`。

### 12.6 白标注意

`oem-a`（橙）`oem-b`（紫）的 `primary` 未动，它们仍跟随各自品牌色。
新增品牌时记得：**`primary` 与 `--accent-grad` / `--lime` 要一起选**，否则会出现"红品牌 + 绿按钮"。
---

## 十三、模型接入：谷歌（Nano Banana）与豆包（2.1 / Seedream）（2026-10-23）

### 13.1 先回答那个关键问题：豆包 2.1 能不能出图？

**不能。** 豆包 2.1（Doubao-Seed-2.1 Pro / Turbo）是**语言模型**，强项是 Coding / Agent / 语义理解，
它只输出文本。字节的出图模型是**另一条产品线**：豆包 · **Seedream**（4.x / 5.0 Pro），走火山方舟的
「图片生成 API」。所以：

| 需求 | 该接的模型 | 我们代码里对应 |
|---|---|---|
| 优化提示词 / 提炼卖点 / 翻译提示词（语义） | 豆包 2.1 Pro / Turbo | `server/textai.js` + `server/providers/llm.js` |
| 出图（文生图 / 图生图 / 多图融合） | 豆包 Seedream 4.0 / 5.0 Pro | `server/providers/jiemeng.js` |
| 出图（谷歌） | Nano Banana 2（`gemini-2.5-flash-image`）/ Pro（`gemini-3-pro-image-preview`） | `server/providers/gemini.js` |

另外：**谷歌没有 2.1 这个版本**。它的图像模型叫 Nano Banana 系列（2.5 Flash Image / 3 Pro Image），
语言模型是 Gemini 2.5 / 3。界面上沿用了「Nano Banana Pro」「Nano Banana 2」的叫法。

### 13.2 顺手修掉的一个真 bug：模型名分两层

以前 `server/providers/gemini.js` 直接把配置里的字符串当上游模型名发出去，默认值是 `nano-banana-pro` ——
而 Google 官方接口只认 `gemini-2.5-flash-image` / `gemini-3-pro-image-preview`，**真调用会 404**；
但反过来，中转站可能偏偏就叫 `nano-banana-pro`。同一个名字两边都对不上。

现在拆成两层：

- **界面 id**（`nano-banana-pro`）—— 用户看到的，也是注册表主键；
- **上游 apiId** —— 真正发出去的字符串。解析顺序见 `registry.apiIdOf()`：
  1. 用户在设置里填的覆盖值（`config.models[id]`）
  2. 注册表里的官方默认值
  3. 兜底：原样用 id（未注册模型走这条，保持老的宽松行为）

这样官方 Key 与中转站 Key 用同一份代码，切换只改设置里的一行。

### 13.3 新增的模型

| 界面模型 | provider | 官方默认上游名 | 能力 |
|---|---|---|---|
| 豆包 Seedream 5.0 Pro（新） | `jiemeng` | `doubao-seedream-5-0-pro` | 中文多图融合，最多 14 张参考图 |

谷歌两个模型沿用原有条目（Nano Banana Pro / 2），只是补了 `apiId`，从"发错名"变成"发对名"。

### 13.4 语义处理（LLM）怎么接

- 传输：**OpenAI 兼容** `POST {baseUrl}/chat/completions`（Bearer 鉴权）。
  方舟官方地址 `https://ark.cn-beijing.volces.com/api/v3`，中转站填它们给的 `/v1` 即可。
- 三个任务（`server/textai.js`，模板写死在服务端）：
  - `optimize-prompt` 把口语需求扩写成结构化提示词（首页输入框「AI 优化」按钮）
  - `selling-points` 提炼 3-5 条卖点（每行一条，`·` 开头）
  - `translate-prompt` 翻成英文关键词
- 接口：`POST /api/ai/semantic`，入参 `{task, text, context}`，出参 `{ok, task, result, model, usage}`。
  错误契约：任务不支持 → 400 `UNSUPPORTED_TASK`；内容空/超长 → 400；**没配 Key → 503 `LLM_NOT_CONFIGURED`**；
  上游报错 → 502 `LLM_FAILED`（错误消息原样透出，便于用户发现"模型名填错"）。
- **刻意不让前端传 system 消息**：否则前端等于拿到一个任意 LLM 代理，账单会失控。

> ⚠️ 计费：语义调用目前**不扣算力**（`text.semantic` 只记审计日志，含 token 数）。
> 如果要按次收费，在 `server/credits.js` 的 `COST_TABLE` 里加动作并在 `/api/ai/semantic` 里走预扣即可。

### 13.5 设置页新增两栏

1. **语义处理（豆包 2.1 / LLM）**：API 地址、模型名、Key。
2. **模型 ID 覆盖（接中转站必填）**：Nano Banana Pro / Nano Banana 2 / 豆包 Seedream 5.0 Pro 三个输入框，
   留空 = 用官方默认。

### 13.6 验证

- `server/__semantic.test.mjs`：**34 项**（apiId 三级优先 / 请求形状 / content 数组兼容 / 上游报错透出 / 未配 Key 报错）
- 全量 `npm test`：**35 套全绿**
- 接口冒烟（真实服务）：
  - `GET /api/models` → 含 `seedream-5-pro`（cost 10、maxRefImages 14）
  - `POST /api/ai/semantic`（未配 Key）→ **503 `LLM_NOT_CONFIGURED`**，提示"设置 → 语义处理"
  - 未知任务 → **400 `UNSUPPORTED_TASK`**

---

## 十四、界面收敛：分栏改名 / 下线两个模型 / 只留一套主题 / 换技能图标（2026-10-23）

用户一次提了四件事，都属"界面做减法"。记在这里，因为其中两处涉及**兼容性取舍**。

### 14.1 供应商分栏 `aichange` → 跨多多

只改展示名（`store.js` 的 `MODEL_PROVIDER_TABS`），**id 保持 `aichange` 不动** ——
`PROVIDER_OF_MODEL` / `providerOf()` / 分组逻辑全靠这个 id，改 id 会牵一大片。
以后再加品牌，改 `label` 即可。

### 14.2 下线「通义万相」与「本地 ComfyUI」

用户要求这两个模型从选择器里去掉。**没有直接删注册表条目**，而是加了 `hidden: true`：

| 位置 | 处理 |
|---|---|
| `server/models/registry.js` | 两条加 `hidden: true`，并新增 `visibleModels()` 统一口径 |
| `server/gateway.js` | `catalog()` 改用 `visibleModels()`，`/api/models` 不再下发 |
| `src/store.js` | 从 `IMAGE_MODELS` / `PROVIDER_OF_MODEL` 移除 |
| `src/components/SettingsDialog.vue` | 撤掉「DashScope Key / 通义万相模型」与「ComfyUI 地址/模型」两段设置 |
| `src/components/HomeView.vue` | 首页底部"能力来源"去掉这两家（否则宣传了选不到的模型） |
| `src/store.js` | 演示任务里的示例标签换成在售模型 |
| `server/skills.js` | 7 个技能的默认模型清单里剔除它们，改成 `nano-banana-pro / jiemeng / seedream-5-pro / gpt-image-2` |

**为什么不删除**：老项目/历史任务里存着 `model: "wanxiang"` 或 `"comfyui"`。
真删掉会掉进网关的"未注册模型宽松路径"——不报错，但计费与能力校验退化成基价，
排障时很难看出异常。`hidden` 的语义是"内部仍在、界面不展示"，是最小风险解。

> 踩坑记录：`visibleModels()` 最初直接 `MODELS.filter(...)`，结果 `/api/models` 下发的
> `cost` 全是 `undefined`——因为 `listModels()` 才会补 `action`/`effectiveCost`。
> 现在 `visibleModels` 走 `listModels(...).filter(...)`，测试里也锁了"每条都带单价"。

### 14.3 只留一套主题（删 Aurora / Atelier / Momentum）

- `src/themes.css`：按「顶层规则」解析后删除 14 个规则片段（含 `@keyframes momentum-sheen`），
  986 行 → 602 行。**注意**：这轮删除曾误删 `html.theme-transition *`（切换过渡）规则，
  被 `__theme.test.mjs` 抓到（"切换过渡只在 .theme-transition 期间生效"变红），已补回。
- `src/theme.js`：`THEMES` 只留 prism，`DOT_COLORS` 只留 prism 一组，兜底色改用 prism。
- `src/components/ThemeSwitcher.vue`：主题卡片条件渲染（`THEMES.length > 1` 才显示），
  只剩一套时按钮显示「外观」，弹层里只有亮色/暗色。
- 旧存档兜底：`normalizeThemeId("atelier")` → `prism`，不清 localStorage 也不会白屏。
- 测试同步更新（`__theme.test.mjs` 84 项）。

### 14.4 技能按钮图标：Grid → Tools

`Grid`（九宫格）在顶栏一排线性图标里像个"仪表盘"，语义和画布/批量打架；
换成 `Tools`（工具箱），一眼是"一堆现成做法"。位置：`StudioView.vue` 技能库入口。

### 14.5 验证

| 项 | 结果 |
|---|---|
| 全量 `npm test` | **35 套全绿**（含主题 84 项、技能库 441 项、模型网关） |
| `scripts/verify-dist-strings.mjs` | 7 项：含「跨多多」、不含「通义万相」/`Flux-2-Klein`/旧主题 id、含 `seedream-5-pro`、含「AI 优化」、CSS 只有 prism |
| 截图 | 技能按钮已是工具箱图标；顶栏外观按钮显示「外观」 |

> `verify-dist-strings.mjs` 的存在理由：`dist/assets` 里可能残留旧的 `index-*.js`，
> 直接 grep 目录会误判；这个脚本只校验 **index.html 真正引用的那一个** bundle。

---

## 十五、无限画布（Studio）视觉重做 + 版本号不再显示（2026-10-23）

用户两点反馈：
1. 「跨多多无限画布界面设计不好看」；
2. 「图 2 没有更新版本号，不要出现这个」→ 设置里的 `当前版本 v0.2.0` 隐藏。

### 15.1 版本号：直接不显示

`SettingsDialog.vue` 的「版本与更新」只留**检查更新**按钮。
理由：版本号只有真正发版时才可信；平时挂着一个不随构建变化的 `v0.2.0`，
既误导（看不出是哪一版），也让"检查更新"这个动作显得没意义。
有更新时仍照常展示新版本号 / 体积 / 更新说明。

### 15.2 画布重做：先定问题，再动手

对着截图逐条列的（不是"感觉不好看"）：

| 问题 | 具体表现 |
|---|---|
| 顶栏 | 项目名 / 技能 / 模型三种形状控件挤一条线；右侧一串 12px 图标不分组，点击目标小 |
| 空状态 | 两块**不等高白卡**硬拼（上传 177px + 输入 545px），左边文案换行成两行，右边输入框像搜索条，"生成"还是灰的 |
| 画布 | 一片均匀灰白 + 稀疏点阵，与顶栏之间没有分隔，缺空间层次 |
| 工具条 | 贴边白长条，图标间距不均，激活态不明显 |
| 层级 | 全屏只有一个荧光绿，视线被吸走但没有第二层可看 |

改法（保持"中性灰 + 墨黑 + 荧光绿"不动，只做加法）：

- **新增 `src/studio-polish.css`**（排在 prism 之后、responsive 之前），只覆盖 studio 选择器，
  不碰 style.css / redesign.css 那 150KB+ 的历史层；
- 尺寸收敛到 32 / 40 两档，图标统一 15px；顶栏改毛玻璃 + 底部 1px 分隔；
- 画布加极淡径向光，点阵压淡 → "桌面感"；
- 左侧工具条 / 右下角控件改成独立圆角浮层，激活态荧光绿底 + 墨黑图标；
- **空状态合并成一张卡**（`EmptyCanvas.vue` 重写模板 + scoped 样式）：
  标题 → 一行输入区（上传 / 描述 / 开始生成）→ 流程起点 → 快捷键说明；
- 节点：上传占位块加清晰虚线边 + 荧光绿 hover；结果卡加表头分隔与阴影；
  选中节点荧光绿环；连线加深。

### 15.3 这轮踩的两个坑（都靠 CDP 量出来才定位）

1. **`position: relative` 顶掉绝对定位**
   `.node-canvas-wrap` 靠 `position: absolute; inset: 0` 撑满父级。我在精修层里顺手写了
   `position: relative`，结果它高度塌成 **0**，空状态卡片被裁掉上半身。
   同一次还发现 `.canvas-empty.rich` 也一样：任何"顺手统一一下定位"的改动都会让整块错位。
   → 结论：**改画布布局前先用 CDP 量 `getBoundingClientRect`**，不要对着截图猜。
   （脚本：`E:\DSH项目\.tmp\probe-layout.mjs`，思路可复用。）
2. **`.float-corner` 是左下角按钮组，锚点是 `left`**
   我按"右下角"写了 `right: 14px`，与它原有的 `left: 14px` 同时存在 → 元素被拉伸成
   **整条白色横带**压在画布底部。改成 `left: 14px; right: auto;` 即恢复。

### 15.4 顺带修掉的空下拉框

重做后截图发现：「请输入画面描述」节点的模型下拉是**空白**的。根因是
`store.imageModel` 的默认值还是已下线的 `wanxiang`，且老工作流模板里存着旧模型 id
→ `<select>` 的 value 不在选项里，浏览器就显示空白。

修法两层：
- `store.js` 默认值改成在售模型（`seedream-5-pro`）；
- `PromptNode.vue` 加 `watchEffect` 归一化：模型 id 不在 `IMAGE_MODELS` 里就改回第一个，
  老项目打开也不会再出现空下拉。

### 15.5 验证

| 项 | 结果 |
|---|---|
| 全量 `npm test` | **35 套全绿** |
| CDP 布局量测 | `.node-canvas-wrap` 849px、`.ce-panel` 垂直居中（y=321, h=319）、`.float-corner` 宽 124px（未被拉伸） |
| 空状态截图 | 单卡居中、荧光绿主按钮、流程 chip 一行 |
| 铺节点截图 | 6 节点 / 5 连线正常；模型下拉显示「豆包 Seedream 5.0 Pro」 |

---

## 十六、全自动批量工作台（文件夹 → 批量出图）（2026-10-23）

用户的原话：「这个批量化的模式不是一种批量方式，我更多的是想把文件夹丢进去，实现自动批量，
包括预览窗口，把背景模糊成磨砂玻璃风格，显示对比图或者成品图（原图 + 结果）」。
设计稿先过了一遍（`prototypes/batch-workbench.html` + `reports/batch-workbench-design-2026-10-23/`），
用户回「开工」后才动代码。

### 16.1 与旧「批量」的区别（这是整件事的关键）

| | 旧的画布批量（`server/batch.js`） | 新的文件批量（`server/filebatch.js`） |
|---|---|---|
| 批次单位 | **一段提示词** → 出 N 张图 | **一个文件** → 跑一次完整流水线 |
| 进度口径 | 已出图张数 | 已处理文件数 |
| 目录结构 | 全部平铺在 outputs | 可保留子文件夹结构 |
| 入口 | 画布里的「批量节点」 | 顶栏「全自动批量」 |

两者并存，没有替换。老的批量节点模式一行没动。

### 16.2 后端：`server/filebatch.js`

- `scan({dir, recursive})`：递归扫描，只收 5 种图片扩展名，跳过隐藏目录 / `node_modules` / 回收站，
  文件数与递归深度都有上限（2000 / 8 层），返回 `files[]`、`groups[]`、`skippedFiles`、`truncated`。
- `resolveInside(root, rel)`：**所有**文件访问都过它，`../`、绝对路径一律 `PATH_ESCAPE`。
- `renderName / renderPrompt`：命名与提示词模板的变量替换（`{原名}{序号}{子文件夹}{文件名}{模特}`）；
  命名里的 `\ / : * ? " < > |` 全部替换成 `_` —— 否则用户写个 `{原名}:{序号}`
  在 Windows 上会直接抛错，或者更糟：把文件写到别的目录。
- `start()`：逐文件跑；每张图内部**调本机 `/api/generate`**（与手机端作业同一套路），
  于是算力预扣/退回、上游缓存、任务取消、血缘记录全都自动复用，不用重写一遍。
- 进度写进 `<输出目录>/batch.json`，`skipDone: true` 时按 `rel` 跳过已完成 —— 断点续跑靠它。
- 暂停/继续/取消：`pause()` 只置标志（当前这张图会跑完，避免白扣一次钱），
  `cancel()` 才 abort 连接并把未完成的标成"已取消"。

### 16.3 前端：`BatchWorkbench.vue` + `GlassCompare.vue`

三栏（左素材 / 中流水线 / 右预览）+ 底部运行条 + 磨砂玻璃对比浮层，
三种对比模式：滑动对比（clip-path + 可拖拽分割线）、并排、只看结果。

**目录选择为什么是"填路径 + 扫描"而不是系统文件夹对话框**：
Electron 33 里 `File.path` 已被移除，渲染进程又没桥接 `webUtils.getPathForFile`，
`<input webkitdirectory>` 只能拿到相对路径。所以先支持"粘贴绝对路径 → 扫描"（100% 可用），
以后主进程桥接了就自动接上（组件里已 feature-detect）。

### 16.4 这轮踩的坑（都很典型）

1. **`resolveSize(resolution, ratio)` 参数传反** → 3:4 批次全变正方形（2048×2048）。
   更隐蔽的是：它不报错，只是比例不对——不盯着出图结果根本发现不了。
2. **前端传 `size: "2K"`**，而 `/api/generate` 只认 `WxH` → 整批 8 张全部
   「尺寸不合法：2K」。修法做了两层：前端用 `pickSize()`（档位/像素都吃），
   后端 `normalizeSize()` 再兜一次 —— 接口层不能假设调用方单位正确。
3. **`el-select` 被自己的 CSS 画成空胶囊**：给 `.bw-select` 加了 `border/height/display:flex`，
   而它的内部结构是 `.el-select > .el-select__wrapper`。改成只用 `:deep()` 调内部尺寸。
4. **缩略图状态选择器前缀写错**：组件挂的是 `is-done/is-running/is-error`，
   我按 `done/error` 写，结果失败的角标变成一个没有底色的 ✕。
5. **预设键升级**：`batch-preset-v1` 里存过像素值，读回来后 `size` 语义与 v2 冲突，
   直接换成 `-v2` 让旧预设作废（这类"本地缓存 schema 变更"必须升键，不能兼容读）。
6. **PowerShell 里 `[String.Text.Encoding]` 类型名写错**，`$t` 未赋值就把文件写成 0 字节，
   整个 `filebatch.js` 被清空过一次。教训：写文件的命令里，**变量必须先赋值再用**，
   改完立刻 `node --check`。

### 16.5 验证

| 项 | 结果 |
|---|---|
| 全量 `npm test` | **37 套全绿**（新增「文件批量」36 项断言） |
| 接口冒烟 | 扫描 8 张 / 2 分组 ✓、缩略图 200 image/png ✓、越界 `../` → 404 `PATH_ESCAPE` ✓ |
| 整批跑通 | 8 个文件依次跑完，失败原因逐条显示（本机无 API Key → 「未配置火山方舟 API Key」） |
| 产物 | `batch.json` 落在输出目录，条目含 `rel/status/outputs/error/ms` |
| 界面 | 三栏、缩略图状态角标、对比列表、进度环、底部运行条均按设计稿呈现 |

---

## 十七、登录 / 初始化页重做：墨黑舞台 + 荧光绿点睛（2026-10-23）

用户原话：「图 3 是现在登录页面，不好看，不适合统一我们的色彩，不大气；
可以参考图 1 图 2 的布局与色彩风格，主要是色彩与按钮风格」。

### 17.1 旧版的问题

旧登录页是「白蓝玻璃」风格：淡蓝渐变背景 + 蓝色圆环 SVG + 蓝色系按钮。
这跟后来定稿的「中性灰 + 墨黑 + 荧光绿」是两套语言——首页、画布、批量全是墨黑/荧光绿，
一进登录页却能明显看出"这是另一个产品的皮"。另外旧版把 LOGO + 标题 + 表单塞在**一张居中卡片**里，
上下留白平均，没有主次，所以"不大气"。

### 17.2 新结构：左右分屏

```
┌────────────────────────────┬──────────────────────────┐
│ 墨黑舞台（58%）              │ 浅灰表单面板（42%）        │
│  品牌行（白底 LOGO 方块）     │  跨多多 AI 创作台（微标识） │
│  AI VISUAL STUDIO           │  SETUP                   │
│  让每一张商品图               │  初始化管理员             │
│  都值得上架 ← 荧光绿           │  首次使用…                │
│  一句话说明 + 3 条卖点         │  [账号] [密码] [确认]     │
│  结果预览卡（左下）           │  [创建并进入 →] 荧光绿     │
│  本地部署 / 密钥不出本机        │  提示 + 页脚              │
└────────────────────────────┴──────────────────────────┘
```

- 深色块用 `linear-gradient(105deg,#1b1e26,#15171e,#101216)` + 两层径向光（左上荧光绿 32%、右下冷灰），
  再加 44px 的极淡网格（`mask-image` 只让中间显形）——有"画布"的质感，但文字始终是主角。
- 标题 800 字重、-1.2px 字距，「值得上架」用荧光绿 + 半透明绿垫底。
- 左下角"结果预览卡"：原图/结果两个缩略块 + 荧光绿角标 + 文件名 + 进度条，
  一眼能看出这产品在干什么（比三张纯装饰的小贴纸更有信息量）。
- 表单：48px 高、13px 圆角、聚焦时荧光绿 4px 光晕；主按钮 50px 荧光绿、墨黑字、右侧箭头，
  悬停变深绿并上浮 1px；禁用态转灰，不装作可点。
- 右侧顶部一行 10.5px 的微标识（"跨多多 AI 创作台"），把大片留白"钉"住，不然空得慌。

### 17.3 独立登录窗（440×620）

Electron 的独立登录窗只有 440×620，分屏放不下，所以 `max-width: 980px` 时塌成单列：
深色舞台压成 **82px 高的品牌条**（只有 LOGO + 名称），表单紧接其下，整窗不需要滚动。

> 踩坑：窄窗里品牌条高度会塌成"只有 padding"的 42px（grid 的 auto 行没把 flex 子项算进去），
> `overflow:hidden` 于是把 "KUADUO TECH" 裁掉下半截。给 `.lg-stage` 一个 `min-height: 82px` 才稳。
> 这类问题看截图只觉得"字有点怪"，必须用 CDP 量 `getBoundingClientRect` 才能定位。

### 17.4 验证

| 项 | 结果 |
|---|---|
| 全量 `npm test` | 通过（登录页只改视觉，未动认证逻辑） |
| 宽屏 1600×1000 | 分屏、标题、卖点、预览卡、荧光绿主按钮均按设计呈现 |
| 独立小窗 440×620 | 单列不滚动，品牌条完整、按钮可见 |
| 填充态 | 输入后主按钮由灰转荧光绿（截图 `reports/login-2026-10-23/01`） |

---

## 十八、批量入口统一：画布「批量节点」→ 独立「全自动批量」页（2026-10-23）

用户截图指出两处批量入口重复：画布顶栏的「批量节点」+ 它下面那条「批量模式·已选 / 批量面板 / 全选 / 反选 / 网格整理 / 运行选中」。
要求「批量节点用全自动批量」——即：批量只留一个入口，通向新的全自动批量页。

### 18.1 改了什么

| 位置 | 改前 | 改后 |
|---|---|---|
| 画布顶栏 | 「无限画布 / 批量节点」二选一切换模式 | 「无限画布」（常态）+「全自动批量 ↗」**跳转按钮** |
| 画布批量条 | 切到批量模式就出现 | 不再出现（模式恒为 free） |
| `Ctrl/Cmd + B` | 切批量模式 | 直接去「全自动批量」页（保留用户的手感） |
| 画布模式持久化 | 记住上次停在 batch | 旧的 `batch` 存档一律改写成 `free`，避免老用户莫名停在加选状态 |
| 帮助文案 | "切换批量模式 Ctrl+B / 加选 / 串行生成" | "无限画布自由摆放 / 全自动批量按文件夹出图" |

「全自动批量」按钮后面加了一个小箭头（↗）：它**不是模式**，是去另一个页面。
不加这个箭头的话，它和左边高亮的「无限画布」看起来像同一组单选钮，还是会被误读成"切换"。

### 18.2 没删的东西（有意保留）

`NodeCanvas.vue` 里的批量条、`BatchDock.vue`、`store.canvasMode`、`batch.js` 全都留着：
- 画布批量跑的是"选中若干执行节点串行生成"，与文件批量（按文件夹、逐文件）是两种能力；
- 代码保留意味着以后想恢复入口只需改一个按钮，不用重写；
- 但**界面上不再有入口**，所以不会同时出现两套批量给用户造成选择困难。

### 18.3 验证

| 项 | 结果 |
|---|---|
| 画布页 DOM | `.bb-bar` 数量 = **0**（批量条不再渲染） |
| 顶栏文案 | `无限画布 全自动批量` |
| 点击跳转 | `bw-workspace` 出现、`.clean-topbar` 消失 → 确认真跳到了批量页 |
| 全量 `npm test` | 通过 |

---

## 十九、新增「Nano Banana 2.1」（谷歌图像模型，2026-10-23）

用户要求：「加一个谷歌新型模型 2.1，API 接口接上」。

### 19.1 先说清楚一个事实

Google 官方公布的图像模型名目前是：

| 官方 id | 对应界面名 |
|---|---|
| `gemini-3-pro-image-preview` | Nano Banana Pro |
| `gemini-2.5-flash-image` | Nano Banana 2 |

**没有字面上的 "2.1"**。用户看到的 "Nano Banana 2.1" 很可能来自中转站/聚合 API 的自定义型号名。
所以这一项的做法是「**能接、能改**」而不是硬编码一个不存在的名字：

- 注册表新增 `nano-banana-2.1`（provider=gemini、tab=google）；
- 默认 `apiId` 先按 `gemini-2.5-flash-image` 走 —— 大多数聚合 API 接受这个名；
- 真名在「设置 → 模型 ID 覆盖 → Nano Banana 2.1」里填，改完立即生效（`apiIdOf` 优先读用户覆盖）；
- 如果上游回 404 / 型号不存在，错误原文会透出，提示用户去改这一项。

### 19.2 改了哪些文件

| 文件 | 改动 |
|---|---|
| `server/models/registry.js` | 新增条目（含 apiId / provider / tab / maxRefImages: 3） |
| `src/store.js` | IMAGE_MODELS、PROVIDER_OF_MODEL、MODEL_TAGLINE 三处同步 |
| `src/components/SettingsDialog.vue` | 新增 `modelGoogle21` 字段 + 输入框 + 回填/保存 |

三处必须同步的原因：`__gateway.test.mjs` 会双向比对「前端清单」与「服务端可见模型」，
并且校验供应商分栏、group、单价是否一致 —— 只加一边会直接测试飘红（这是好事，防漏）。

### 19.3 验证

| 项 | 结果 |
|---|---|
| 注册表自测 | `getModel('nano-banana-2.1')` 存在，apiId=`gemini-2.5-flash-image`，visible=true |
| 可见模型数 | 7 → **8** |
| 模型选择器（Google 分栏） | 3 条：Nano Banana Pro / 2 / **2.1**，单价 10 算力/次 |
| 全量 `npm test` | 通过（0 失败） |

---

## 二十、供应商分栏「跨多多」改名「优质国产」（2026-10-23）

用户指了模型选择器的第三个分栏（原来写「跨多多」）说"优质国产"。
判断：那一栏装的是国内模型（Seedream 5.0 Pro / 即梦），用公司品牌名当分栏名，
会让人误以为"跨多多自研模型"，改成类目名才对。

### 20.1 改动

| 位置 | 改前 | 改后 |
|---|---|---|
| `src/store.js` `MODEL_PROVIDER_TABS` | `{ id: "aichange", label: "跨多多" }` | `{ id: "aichange", label: "优质国产" }` |
| `scripts/verify-dist-strings.mjs` | 断言 bundle 含「跨多多」 | 断言含「优质国产」 |

`id` 仍然是 `aichange` —— 它连着 `PROVIDER_OF_MODEL`、`modelsOfProvider()`、属性面板的 optgroup，
改 id 会牵一整片，没有收益。

### 20.2 验证

| 项 | 结果 |
|---|---|
| 页面实际渲染（CDP 读 DOM） | 分栏按钮 = `OpenAI / Google / 优质国产` |
| bundle 字符串 | 含「优质国产」，`label:"跨多多"` 已不存在（剩下的 13 处都是"跨多多科技"品牌名） |
| 全量 `npm test` | 通过 |
| 产物校验脚本 | 7/7 通过（含新断言） |

> 顺手记一个工具坑：`node xxx.mjs | Select-Object -First 6` 会在第 6 行**掐断管道并杀掉 node**，
> 脚本里后面的 `writeFileSync` 根本没执行 —— 于是我拿着上一轮的旧截图做了半天判断，
> 还以为改名没生效。截图类脚本一律用 `Out-String` 收完整输出。

---

## 二十一、右侧两列合并成「一列三页」（属性页并入技能面板，2026-11-02）

用户截图圈住工作台右侧说：「这右边太宽，两个可以合并吗，实用精细化」。

### 21.1 这其实是个 bug，不只是"宽"

右侧原本是**两列并排**：`StudioDock`（374px，Agent / 技能）+ `InspectorPanel`（268px，属性）。
加起来 642px，在 1600 宽的窗口里画布只剩 ~882px。

更要紧的是副作用：`InspectorPanel` 是 `flex: 0 0 268px` 的**独立一列**，
它把画布挤窄之后，落在右侧的节点会**跑到属性栏底下**。CDP 量过：
参考节点 rect `[1636, 524, 300, 290]`，而它内部「图 0/10」「+ 上传图片」「生成视频」
的 `elementFromPoint` 全部返回 `.inspector` —— 节点在屏幕上看得见、点不动。
用户上一轮说的「无法操作，还有右边」，根因就在这里。

### 21.2 改法：属性变成同一个面板的第三页

| 位置 | 改前 | 改后 |
|---|---|---|
| 右侧布局 | dock 374px + 属性栏 268px（两列） | dock 374px（一列） |
| `StudioDock.vue` | `Agent` / `技能` 两个 Tab | `Agent` / `技能` / **`属性`**（选中节点时才出现） |
| `InspectorPanel.vue` | 自己一列、自己拖宽、自己最小化 | 新增 `embedded` 属性：塞进 dock 时**不带**拖宽条/最小化/弹出按钮，宽度和边框交给 dock |
| `StudioView.vue` | 模板里挂 `<InspectorPanel class="studio-inspector" />` | 删掉那一行（属性已并入 dock） |

取舍：**不是**把属性栏删掉，也不是塞进抽屉，而是它本来就不该占一列。
`embedded` 用 prop 而不是复制一份组件，是为了以后"双屏独立窗口"（`popoutBus`）还能单独用。

### 21.3 交互上的两处细节

1. **自动切页**：`watch(() => store.selection.length)` —— 从「没选中」变成「有选中」时自动切到属性页；
   取消选中（变成 0）时自动退回技能页。这样用户点节点就**直接看到参数**，不用再找 Tab。
2. **Tab 只在有选中时出现**：没选中时只有 `Agent | 技能` 两个 Tab。
   一个永远点开是空白/占位的第三个 Tab，比没有更糟。
3. 属性页把 dock 底部那条「消耗积分 / 立即生成」隐藏（`v-if="tab !== 'inspector'"`）——
   属性页改的是已有节点的参数，不产生新的生成动作。

### 21.4 验证（CDP 实测，非目测）

| 项 | 结果 |
|---|---|
| 选中前的 Tab | `["Agent", "技能*"]`，`.studio-inspector` 不存在 |
| 画布宽度 | **1134px**（改前同尺寸窗口约 866px，多出 268px 全给了画布） |
| 选中节点后 | Tab 变 `["Agent", "技能", "属性*"]`，属性页自动激活 |
| 属性页位置 | rect `[1225, 122, 345, 769]` —— 在 dock 内部，没有第二列 |
| 拖宽条 / 最小化按钮 | 嵌入态下均不存在（`.studio-dock .ins-resize` = 0） |
| 内容正确性 | 标题「画面描述」/ 副标题 `p1` / 字段 `提示词 模型 画幅 张数` |
| 全量 `npm test` | **34 套全绿，0 失败** |

截图：`reports/studio-merge-panel-2026-11-02/`（00 改造前两列 / 01 右侧只剩一列 / 02 属性页 / 03 属性页细节）。

> 踩坑记录：写 CSS 时给 `.studio-dock .inspector.is-embedded` 加了 `flex: 1 1 auto; width: 100%`，
> 但没清 `border-left` 和 `animation` —— 结果面板左缘多一条线、切页时还会播一次"从右侧滑入"，
> 看起来像页面闪了一下。嵌入态要显式写成 `border-left: none; animation: none`。


---

## 二十二、2026-11-03 开发态恢复（DSH 重装 / 工程列表丢失后的复原）

用户原话：「这个软件重装了，需要恢复开发状态」。当天现场三处症状、三个互不相干的根因：

| 症状 | 真实原因 |
|---|---|
| 左侧 14 个工程全消失 | `C:\Users\Administrator\.dsh\storages\workspace.json` 被**还在运行的 DSH** 用内存副本覆盖回 2 条 |
| `npm run dev` 起的桌面端打不开 / 登录失败 | dev 模式主进程故意不启后端；Electron 的 `--user-data-dir` 落在工作区外时 SingletonLock 建不出来 |
| 项目页看不到以前的画布项目 | 项目只存渲染层 localStorage，且按 origin 隔离：旧应用 `127.0.0.1:5181`、dev `127.0.0.1:5180` |

### 22.1 DSH 工程列表：外部改文件必须等 DSH 完全退出

- `@deepseek-ai/dsh-storage-json` 每个 unit 一个 JSON 文件，写入是**整文件原子替换**，且只在内存发生 mutation 时落盘；退出时不 flush。
- 结论：只要 DSH 进程还活着，外部改写 `workspace.json` 一定会在下一次「新建/打开工作区」时被内存副本覆盖。本次工程列表就是这么丢的第二次。
- 工具：`E:\DSH项目\tools\dsh-restore-workspaces.mjs`（本次新建）——`--build` 出 16 条目标清单、`--install` 先备份再原子写、`--watch` 轮询 `DeepSeek Harness.exe` 等它退出后合并写、`--verify` 校验。14 个工程沿用固定 UUID（ai-canvas = `aa1ba28e-3d34-4f08-8788-b43fedfb5ef6`）。
- 结果：DSH 重启后 workspace.json 16 条，ai-canvas 等 14 项全在；`default-workspace` 与 `E:\DSH项目` 的既有 id 未被改动。

### 22.2 dev 模式：一条命令起「前端 + 后端 + Electron」

`electron/main.cjs:229` 是 `if (IS_DEV) return DEV_URL;` —— 开发模式**故意不启后端**，窗口直接加载 vite 地址。所以只起 Electron 时登录会失败（「无法建立本地会话，请刷新页面重试」）。

新建 `tools/dev-start.mjs` + `dev-start.cmd` / `dev-stop.cmd`：

| 能力 | 说明 |
|---|---|
| 一键启动 | Vite(5180) + 后端(5181，即 vite proxy 目标) + Electron(dev) |
| profile | 默认 `ai-canvas/.devprofile`（**必须在工作区内**，见 22.3） |
| 环境 | `AI_CANVAS_DEV_URL`、`AI_CANVAS_HOME=E:\ai-canvas-data`，并删掉 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` |
| 参数 | `--status` / `--stop` / `--restart` / `--foreground` / `--cdp=<port>` / `--home=` / `--profile=` / `--vite-port` / `--api-port` |
| 日志 | `.tmp/vite-dev.log`、`.tmp/server-dev.log`、`.tmp/electron-dev.log`；pid 存 `.tmp/ai-canvas-dev.json` |

`package.json` 增加 `dev:desktop` / `dev:status` / `dev:stop`；桌面快捷方式 `E:\DSH项目\启动开发版.lnk` → `dev-start.cmd`。

### 22.3 本机 Electron 的两个硬约束（实测二分出来的）

1. **`--user-data-dir` 必须在 `E:\DSH项目` 之内**。落在 `E:\ai-canvas-data`、`E:\t-prof-1`、`C:\...\prof-cn` 等任何工作区外路径，Chromium 都秒退：
   `ERROR:process_singleton_win.cc(465) Lock file can not be created! Error code: 5`。旧 `tools\launch-desktop.mjs` 正是这么写的，所以打不开。
2. **必须 `--no-sandbox`**（DSH 子进程上下文里）：不加就 `0x80000003 STATUS_BREAKPOINT`，没有任何 stderr。dev-start 已内置。

### 22.4 旧画布项目：localStorage 跨 origin 迁移

- `src/project.js` 只用 4 个 localStorage 键：`ai-canvas.project.graph.v1`（当前画布，**单槽**）、`ai-canvas.projects.v1`（项目列表）、`...assets.v1`、`...meta.v1`。服务端不存项目（`server/mobile-routes.js:126` 只是内存计数）。
- 旧数据在 `E:\ai-canvas-data\chrome-profile\Default\Local Storage\leveldb`（origin `http://127.0.0.1:5181`，最后写 10/18）。
- 迁移：拷贝 leveldb 到临时目录 → headless Chrome 打开 `http://127.0.0.1:5181/` 导出 6 个键（产物存档 `reports/dev-restore-2026-11-03/old-localstorage.json`）→ 通过 CDP 注入 dev origin（5180）并刷新。
- 结果：项目页出现「未命名项目 10/18 09:46」；注入 `graph.v1` 后进画布就是**旧的那张图**（参考图 + 画面描述 + 执行 + 结果，4 节点 3 连线，视口 123%）。
- 坑：画布是单槽模型（`openProject()` 只切项目名/id，不换内容），所以"打开某个项目看到它的图"取决于 `graph.v1` 里存的是哪份；注入时必须**先回首页**再刷新，否则画布卸载时的 `flushSave` 会用当前空画布覆盖注入值。

### 22.5 验证

| 项 | 结果 |
|---|---|
| `node scripts/run-tests.mjs` | **34 套全绿**；手机端（小程序）89 项通过 |
| `npm run build` | ✓ 3.59s，产物 `dist/assets/index-C089CWcF.js`（与恢复前同 hash） |
| dev 启动 | Vite 5180 + 后端 5181 + Electron，标题「跨多多科技 · AI 创作台」，console error 0 |
| 登录 | admin / admin888 → 工作台 |
| 无限画布 | 默认 3 节点 → 注入旧图后 4 节点 3 连线，`已保存` 正常刷新 |
| 截图 | `reports/dev-restore-2026-11-03/01~05*.png` |

### 22.6 尚未解决 / 注意事项

- **打包版仍打不开**：`release\win-unpacked\跨多多 AI 创作台.exe` 用旧的 `--user-data-dir=E:\ai-canvas-data\appdata` 会 SingletonLock 失败；换成工作区内 profile 能起来，但后端崩在 `EPERM: operation not permitted, open 'E:\ai-canvas-data\refresh-tokens.json'`（`server/rbac.js:106` ← `pruneTokens` ← `server/index.js:1434`）。该文件已改名为 `refresh-tokens.json.bak-1007` 让应用重建；是否与 DSH 沙箱给 `E:\DSH项目` 的额外 ACE / 工作区外目录限制有关，未定论。发版前要单独验一遍。
- 上次会话的 Electron fuses（`scripts/apply-fuses.mjs`）**没有写进 release 产物**：两枚 exe 仍是原版（RunAsNode=on、AsarIntegrity=off）。
- `.devprofile` 里就是恢复后的项目数据，别删；`.tmp` 下的临时 profile 目录可清。
- dev 态一条既有 Vue 警告：`Invalid prop: type check failed for prop "selectionKeyCode"`（`NodeCanvas` 的 `<VueFlow>` 收到数组），不影响功能。

---

## 二十三、模型 API 自检 + 云端化方案（2026-11-05）

### 23.1 自检做了什么

设置页新增「一键自检全部接口」和每个 provider 的「测试连接」：

- 免费探测：列表型探 `GET {baseUrl}/models`，对话型发 `max_tokens: 1` 的 `POST /chat/completions`，ComfyUI 探 `/system_stats`
- **不生成图片、不扣算力、不落盘**（覆盖值只用于这次探测）
- 把失败分类成 `NO_KEY / AUTH / FORBIDDEN / PATH / MODEL / RATE / TIMEOUT / NETWORK / UPSTREAM`，每个 code 配一句中文 + 该改哪个输入框

后端：`server/providers/probe.js` + `POST /api/providers/probe`（`server/index.js`，单独限流 120 次/分钟）
前端：`src/components/SettingsDialog.vue` + `src/api.js#probeProvider`
测试：`server/__probe.test.mjs`（24 项，假上游，已接入 `scripts/run-tests.mjs`）

### 23.2 一键自检怎么用

1. 打开设置抽屉（右上齿轮）
2. 在对应 provider 里填 Key / 地址 / 模型（可以先不保存）
3. 点该组「测试连接」，或点顶部「一键自检全部接口」
4. 按提示修：`PATH` 多看地址是否以 `/v1` 结尾；`MODEL` 去填「模型 ID 覆盖」；`TIMEOUT` 检查代理/中转

> 掩码 Key（`sk-****`）不参与探测，服务端会用保险箱里的真 Key；
> 把输入框清空再测，会明确报 `NO_KEY`（不会偷偷用旧 Key 假装成功）。

### 23.3 本机实测（18:20）

```
0/4 项通过，待修：OpenAI、Gemini、即梦、LLM
OpenAI / Gemini → 请求超时（本机直连 api.openai.com、generativelanguage.googleapis.com 不通）
即梦            → 401 Key format incorrect（设置里还是占位 Key）
LLM             → 还没填写 API Key
```

链路本身正常，失败都是凭据/网络问题。填真 Key（或配代理/中转）后应转 `OK`。

### 23.4 云端化方案（文档，未动代码）

`reports/cloud-migration-2026-11-05/云端化方案.md`：

- 现状：账号/会话/账本/订单/审计都是 JSON；**项目数据只在浏览器 localStorage**（服务端没有项目库）；厂商 Key 在用户机器保险箱
- 目标：`server/storage`（file / pg 两套实现）+ PostgreSQL 16 + Redis 7 + S3 + Caddy
- 分期：P0 地基 3 天 → P1 账号 4 天 → P2 项目/文件 8 天 → P3 上线 5 天（约 3 周）
- 已落盘部署骨架：`deploy/Dockerfile`、`docker-compose.yml`、`Caddyfile`、`.env.example`、`README.md`

**部署三坑（务必看 `deploy/README.md`）**：
1. 容器 `hostname` 必须固定 —— vault 密钥由 `os.hostname()` 派生（`server/vault.js:102`），hostname 变了旧 Key 全解不开；
2. `AI_CANVAS_BIND=0.0.0.0`，否则容器外访问不到；
3. `/api/session` 只对回环发令牌，所以阶段 0 容器只能做服务端探活，给浏览器用必须等 P1 账号体系。

### 23.5 验证

| 项 | 结果 |
|---|---|
| `node scripts/run-tests.mjs` | **35 套全绿**（新增「模型 API 自检」，含手机端 89 项） |
| `npm run build` | ✓ 6.04s |
| UI 一键自检 | 4 个 provider 就地渲染结果 + 提示 |
| 回包脱敏 | 无 apiKey 字段 |

截图：`reports/api-probe-2026-11-05/01-设置页自检.png`、`02-自检结果.png`
