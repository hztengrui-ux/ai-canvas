# AI Change 参考工具深度分析

> 基于真实安装文件（`C:\Users\Administrator\AppData\Local\Programs\AI Change`，v2.8.5）与隔离后端跑出的真实界面截图。

---

## 一、工具定位

| 项目 | 内容 |
|---|---|
| 品牌 | AI Change（同一份代码还用于 晶灵服装AI、X.MULO） |
| 版本 | 2.8.5 |
| 形态 | Electron 桌面应用 |
| 渲染层 | React + wouter + Tailwind，Vite 打包到 `resources/app/dist/public` |
| 后端 | 内嵌 Node 服务，打包在 `resources/app/dist/index.cjs`，由 Electron 主进程以 `ELECTRON_RUN_AS_NODE` 子进程拉起 |
| 授权 | license-tool（Go 二进制）采集机器指纹 + 在线验证 + 吊销检查 |
| 更新 | electron-updater + 阿里云 OSS 通用更新通道 |

---

## 二、整体安全架构（真实代码反推）

### 2.1 三端结构

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 主进程（resources/app/electron/main.cjs）          │
│  - 负责窗口、生命周期、授权、存储迁移、自动更新              │
│  - 生成一次性令牌并注入后端环境变量                          │
├─────────────────────────────────────────────────────────────┤
│  预加载脚本（preload.cjs）+ 渲染进程                         │
│  - contextIsolation=true / nodeIntegration=false             │
│  - 仅暴露白名单 API（electronAPI）：媒体源、变更令牌、文件、   │
│    授权、存储、剪贴板、主题、更新等                          │
├─────────────────────────────────────────────────────────────┤
│  本地后端服务（resources/app/dist/index.cjs）                │
│  - 监听 127.0.0.1:3100（品牌相关偏移）                       │
│  - 静态托管 SPA + REST/SSE API                               │
│  - 读取加密的本地会话，调用云端账号/计费/模型服务              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Electron 渲染进程安全

| 措施 | 实现 |
|---|---|
| `contextIsolation` | 强制 `true` |
| `nodeIntegration` | 强制 `false` |
| `sandbox` | 未显式禁用，即默认开启 |
| `webSecurity` | 主窗口未禁用；仅日志/状态小窗设为 `false` 用于向 localhost 检查 |
| `preload` | 仅 `preload.cjs`，不暴露 `require` / `process` |
| 导航锁定 | `secureMainRendererWindow(win, allowedOrigin)`：仅允许渲染进程停留在 `http://127.0.0.1:<backendPort>`，任何外链通过 `shell.openExternal` 打开系统浏览器 |
| 弹窗/重定向 | `setWindowOpenHandler` 统一 `action: "deny"` |
| 启动确认 | 每个窗口加载附带 `__startup_attempt=<uuid>`，渲染进程必须通过 IPC 回传确认才能显示 |

### 2.3 后端访问控制：双令牌机制

Electron 主进程每次启动生成两个 256-bit 随机十六进制令牌：

| 令牌 | 用途 | 传递方式 | 后端校验 |
|---|---|---|---|
| `BACKEND_RUNTIME_TOKEN` | 只读/媒体访问 | `AICHANGE_RUNTIME_TOKEN` 环境变量 | 渲染页加载时同源，由 `fetch` 自动携带 Cookie；内部控制 API 用 `x-internal-control-token` 头 |
| `BACKEND_MUTATION_TOKEN` | 写入/变更 | `AICHANGE_MUTATION_TOKEN` 环境变量；通过 `getBackend-mutation-token` IPC 暴露给受信渲染帧 | 需要请求头 `x-mutation-token` |

关键代码行为：
- `ipcMain.handle("get-backend-mutation-token", event => { if (!isTrustedMainRendererUrl(event.senderFrame?.url)) throw ...; return BACKEND_MUTATION_TOKEN; })`
- 后端对 `/api/internal/*` 等控制接口要求 `x-internal-control-token`。

### 2.4 密钥与会话存储

**位置**：`%APPDATA%\ai-change\config\`

| 文件 | 内容 |
|---|---|
| `.encryption_salt` | 32 字节盐，hex 表示，用于派生 AES 密钥 |
| `app_api_session.json` | 云端账号 session 以 `ENC:` 前缀 + AES-256-GCM 加密后落盘 |
| `api_keys.json` | 仅保存「模型偏好」（如 `image_editing_primary_model`），不存原始 API key |
| `license.json` | 授权码、状态、客户名、激活时间 |

加密方式：后端 `dist/index.cjs` 内确认使用 `aes-256-gcm` + `pbkdf2Sync` + `.encryption_salt`。

**原始 API key 实际存储位置**：未在渲染层配置文件中直接出现，推断由后端管理并走 AES 加密写入配置目录，或通过 `company-secret-fields.cjs` 在导出/迁移时主动剥离。

### 2.5 数据目录与配置原子化

- 业务数据根可自定义（当前为 `E:\AI Change\aichange_data`），配置根固定 `%APPDATA%\ai-change\config`。
- 配置写入使用原子化：`tmp-${pid}-${uuid}` 文件 → `fsync` → `rename`。
- 目录迁移有 stage/backup/marker 机制：`config-root-v1.stage`、`config-root-version.json`、backup 目录，崩溃后可恢复。
- 配置目录禁止符号链接，启动时会递归校验。

### 2.6 授权与更新安全

| 项目 | 实现 |
|---|---|
| 授权校验 | `license-tool-windows-amd64.exe` 调用 `verify` 子命令，与后端通信校验机器指纹；主进程还会调用 `checkRevocationOnline` 在线检查吊销 |
| 自动更新 | `electron-updater` + `app-update.yml` 指向 `https://aichangehh.oss-cn-beijing.aliyuncs.com/releases/`；分阶段灰度在 `windows-update-rollout.cjs` 中控制 |
| 公司密钥清理 | `company-secret-fields.cjs` 白名单剥离 `comfly_api_key`、`ark_api_key`、`claude_api_key` 等，防止用户配置导出时泄露 |

---

## 三、应用界面（真实截图）

### 3.1 首页：对话式入口

![AI Change 首页](reference/ref-home.png)

- 左侧竖向导航：新建、首页、项目、个人、帮助。
- 顶部：logo + 版本、主题切换、算力余额/充值、用户头像。
- 中央是大号对话输入框，提示语与电商场景强相关（“将图中的衣服设计一个合适的欧美模特…”）。
- 输入框下方是快捷任务：AI换衣、图片编辑、详情页制作、AI视频。
- 底部展示「最近项目」。

设计关键词：**浅色、低饱和、大圆角、聊天优先、任务快捷入口**。

### 3.2 画布页

![AI Change 画布](reference/ref-canvas.png)

- 顶部：项目名下拉、模型设置、缩放控制（100% / +）、主题/算力/头像。
- 左侧工具栏：服装、商品、图片、文档/文案、素材库五个垂直图标。
- 右侧悬浮「对话」按钮，可随时唤出侧边聊天。
- 底部左：项目目录 / 帮助。
- 画布区为大面积浅灰网格背景，等待用户从左侧拖拽/点击添加节点。

与此前截图推断一致：它确实是一个**左侧工具栏 + 顶部参数 + 右侧对话 + 中心无限画布**的节点式工作流。

### 3.3 功能模块（从渲染产物提取）

- 账号：手机号登录/验证码、个人中心、团队管理、成员与余额共享。
- 计费：算力余额、充值、使用记录、模型价格、官方刊例价。
- 创作：AI换衣、图生图、图片编辑、详情页制作、AI视频、视频换衣/换模特、参考视频。
- 资产：服装/模特/场景/商品素材库，素材可拖入画布。
- 项目：项目列表、最近生成、导出详情。
- 连接：微信接入，可在微信直接发素材/消息同步到画布。

---

## 四、与 ai-canvas 的差距

| 维度 | AI Change（参考） | ai-canvas（当前） |
|---|---|---|
| 壳 | Electron 桌面应用 | 浏览器 + Express |
| 渲染隔离 | `contextIsolation=true`，`nodeIntegration=false` | 普通浏览器环境，依赖同源策略 |
| 令牌模型 | 每进程随机 Runtime + Mutation 双令牌 | 单一会话 token（刚加） |
| 会话加密 | AES-256-GCM + PBKDF2 盐加密落盘 | 无会话系统；配置掩码 |
| API key 存储 | 加密文件或剥离，不在前端暴露 | Windows 凭据管理器（已做） |
| 数据目录 | 可自定义、原子迁移、符号链接防护 | 固定 `~/.ai-canvas/` |
| 授权 | license-tool 机器指纹 + 在线校验 | 无 |
| 账号/计费 | 完整云端账号、算力、充值、团队 | 模拟 credits，无真实计费 |
| 自动更新 | electron-updater + OSS | 无 |
| 界面范式 | 首页对话 + 快捷任务 + 项目/画布 | 直接进画布，无首页对话入口 |
| 顶部栏 | 简洁：项目名 + 模型设置 + 缩放 | 已对齐 |
| 左侧栏 | 竖向图标工具（服装/商品/图片/文档/库） | 竖向图标 + 可展开工作流预设 |
| 右侧 | 对话浮钮 | 无 |

---

## 五、建议的下一步

1. **补齐整体安全架构图**：把 Electron/浏览器层、BFF 层、Provider 层、存储层分层画出，并标注令牌、加密、隔离边界。
2. **在 ai-canvas 侧对齐双令牌模型**：把当前单 session token 拆分为「读取令牌」（同源 Cookie）和「变更令牌」（仅通过可信 IPC/预加载暴露）。
3. **加密本地会话/配置**：当前只有 key 进凭据管理器；可参照 AI Change 用 AES-256-GCM + 机器派生盐加密 `app_api_session.json` 类文件。
4. **首页重做**：从「直接进画布」改为「对话式首页 + 快捷任务卡片 + 最近项目」，与参考工具一致。
5. **画布工具栏左侧化**：把当前可展开的工作流预设面板改成固定的左侧图标工具栏（服装/商品/图片/文案/素材库）。
6. **右侧对话浮层**：在画布页增加悬浮「对话」入口，让用户随时用文字驱动画布。
7. **数据目录可配置与迁移**：为后续 Electron 化做准备，先把配置写入做原子化、路径可配置。

---

## 六、关键文件清单（参考工具内部）

| 路径 | 作用 |
|---|---|
| `resources/app/electron/main.cjs` | Electron 主进程 |
| `resources/app/electron/preload.cjs` | contextBridge 白名单 |
| `resources/app/electron/backend-controller.cjs` | 后端子进程生命周期 + 内部控制请求 |
| `resources/app/electron/config-root.cjs` | 配置目录原子迁移 |
| `resources/app/electron/company-secret-fields.cjs` | 密钥字段白名单剥离 |
| `resources/app/dist/index.cjs` | 后端服务打包产物 |
| `resources/server/license-tool/*.exe` | 机器指纹授权校验 |
| `%APPDATA%/ai-change/config/.encryption_salt` | 本地加密盐 |
| `%APPDATA%/ai-change/config/app_api_session.json` | 加密云端会话 |
| `%APPDATA%/ai-change/config/api_keys.json` | 模型偏好（非原始密钥） |
