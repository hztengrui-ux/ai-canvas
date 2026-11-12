# 跨多多 AI 创作台 · 完整技术总文档

> **归集版 v1.0** · 2026-09-23 · 项目版本 `0.2.0`
>
> 本文把此前分散在 **15 份文档**（共 4300 余行）里的内容，连同**当前源码的实测状态**，归集为一份可独立阅读的完整技术文档。
> 全文数据取自真实文件内容与实跑输出，不写未落地的功能。

---

## 目录

| 章 | 内容 | 对应历史文档 |
|---|---|---|
| 0 | [源码位置警示与 30 秒速览](#0-先读这一页) | — |
| 1 | [产品定位与能力矩阵](#1-产品定位与能力矩阵) | README.md |
| 2 | [快速开始：命令速查](#2-快速开始命令速查) | 使用说明.md |
| 3 | [系统架构：分层与数据流](#3-系统架构分层与数据流) | NodeAI_Tool_深度拆解.md |
| 4 | [后端：模块详解](#4-后端模块详解) | 2-商业化技术方案-可跑通.md |
| 5 | [后端：完整接口参考（51 个）](#5-后端完整接口参考) | — |
| 6 | [前端：组件清单与设计体系](#6-前端组件清单与设计体系) | 1-界面对标与优化方案.md |
| 7 | [桌面端：Electron 与 IPC](#7-桌面端electron-与-ipc) | — |
| 8 | [安全体系：四层防护](#8-安全体系四层防护) | 2-商业化技术方案 §5 |
| 9 | [商业化闭环：算力账本](#9-商业化闭环算力账本) | 跨多多AI创作台-商业化改造完整实施文档.md |
| 10 | [商业化闭环：充值与支付网关](#10-充值与真实支付网关) | 4-支付与自动更新与白标 §1 |
| 11 | [自动更新接 OSS](#11-自动更新接-oss) | 4-支付与自动更新与白标 §2 |
| 12 | [多品牌白标](#12-多品牌白标) | 4-支付与自动更新与白标 §3 |
| 13 | [模板体系与 11 张示意图](#13-模板体系与-11-张示意图) | 4-支付与自动更新与白标 §4 |
| 14 | [竞品研究结论归集](#14-竞品研究结论归集) | AI_Change / LOOM42 / NodeAI 三份拆解 |
| 15 | [测试体系](#15-测试体系) | — |
| 16 | [踩坑全集](#16-踩坑全集) | 多份文档散落记录 |
| 17 | [上线前必办清单](#17-上线前必办清单) | — |
| 18 | [路线图](#18-路线图) | — |
| 19 | [历史文档索引](#19-历史文档索引) | — |

---

## 0. 先读这一页

### 0.1 ⚠️ 源码有两份，别改错

```
2026-09-08-19-23-01/
├── README.md                 ← v0.1.0 旧快照（仅当时打 ZIP 用）
├── 使用说明.md               ← v0.1.0 旧快照
├── server/  src/  dist/      ← v0.1.0 旧快照，已落后
└── ai-canvas/                ← ✅ 权威源码 v0.2.0，后续一律在这里工作
```

根目录那份是 9 月 23 日 15:43 之前的快照。**所有开发、构建、打包都必须在 `ai-canvas/` 下进行。**

### 0.2 30 秒速览

**它是什么**：一个桌面版 AI 电商视觉创作工具。核心交互是**无限节点画布** —— 拖入商品图、参考图、提示词，连线组成工作流，一键生成电商主图 / 模特图 / 详情页 / 短视频。

**技术栈**：

| 层 | 选型 | 版本 |
|---|---|---|
| 前端 | Vue 3 `<script setup>` | ^3.5.0 |
| UI 组件 | Element Plus | ^2.9.0 |
| 画布 | Vue Flow（core/background/controls/minimap） | core ^1.48.2 |
| 构建 | Vite | ^6.0.0 |
| 后端 | Express | ^4.21.0 |
| 桌面壳 | Electron | ^33.2.0 |
| 增量更新 | electron-updater | ^6.8.9 |
| 打包 | electron-builder（NSIS） | ^25.1.8 |
| 凭据存储 | @napi-rs/keyring（系统钥匙串） | ^2.0.0 |

**规模**（实测）：

| 区域 | 文件数 | 行数 |
|---|---|---|
| `server/`（含 data、providers） | 16 | 3,659 |
| `src/`（.vue + .js） | 35 | 6,866 |
| `electron/` | 3 | 712 |
| `scripts/` | 2 | 236 |
| **合计** | **56** | **11,473** |

**当前落成状态**：

| 能力 | 状态 | 验证方式 |
|---|---|---|
| 节点画布 + 工作流 | ✅ 完成 | 端到端可用 |
| 账号体系 + RBAC（15 权限 / 4 角色） | ✅ 完成 | 接口实测 |
| 算力账本（预扣→提交/回滚） | ✅ 完成 | **16/16 测试通过** |
| 充值套餐与订单 | ✅ 完成 | 500 → 6000 实测 |
| 微信/支付宝支付 + 回调验签 | ✅ 完成 | **14/14 安全测试通过** |
| 生成扣费 + 失败退款 | ✅ 完成 | 6000 → 6000 退款实测 |
| 自动更新（差异更新带版本门控） | ✅ 代码完成 | ⚠️ 待填 OSS 地址 |
| 多品牌白标 | ✅ 完成 | 三品牌切换实测 |
| 11 张模板示意图 | ✅ 完成 | 11/11 覆盖，1.4 MB |
| 授权 License 校验 | ❌ 未做 | 见 §18 路线图 |

---

## 1. 产品定位与能力矩阵

### 1.1 定位

一句话：**把电商视觉生产的生产线搬到一个桌面画布上，并且按用量付费。**

不是聊天机器人，不是在线 SaaS。它解决的是「每天要出几十张图、风格要统一、流程要可复用」的批量场景 —— 这也是为什么核心交互是**节点工作流**而不是对话框：工作流可以被保存、复刻、批量跑。

### 1.2 能力矩阵

| 能力域 | 具体条目 | 实现位置 |
|---|---|---|
| **画布编排** | 无限画布、缩放平移、框选、节点连线、蚂蚁线动效、小地图 | `src/components/NodeCanvas.vue`（797 行） |
| **节点类型** | 商品图 / 参考图 / 提示词 / 风格 / 执行器 / 结果 —— 6 类 | `src/components/nodes/*.vue` |
| **模板广场** | 11 套预置工作流，四类分组，服务端下发 | `TemplatesView.vue` + `server/templates.js` |
| **图像生成** | 文生图 / 图生图 / 换装 / 姿势裂变 / 固定脸换背景 / 白底图 | `server/providers/*` |
| **视频生成** | 图片转视频、爆款视频复刻 | `providers/wanxiang.js` |
| **详情页** | 详情页编排制作（按次计费 60） | workflow `detail-page` |
| **素材库** | 分类上传、本地托管 | `/api/materials*` |
| **AI 对话** | 侧边抽屉式助手 | `ChatDrawer.vue` |
| **运营后台** | 看板 / 账号 / 角色 / 部门 / 日志 / 密钥 | `components/admin/*.vue` |
| **商业化** | 算力余额、充值套餐、订单、消费流水 | `credits.js` / `payments.js` |
| **安全** | 会话令牌、Host/Origin 校验、限流、预算熔断、审计日志、密钥保险箱 | `security.js` / `vault.js` / `audit.js` |
| **多模型** | 通义万相 / 即梦 / Gemini / OpenAI 兼容 / 本地 ComfyUI | `providers/*.js` |

### 1.3 接入的 AI 提供方

| Provider | 文件 | 行数 | 说明 |
|---|---|---|---|
| 通义万相 | `wanxiang.js` | 160 | 阿里云百炼，图像 + 视频 |
| 即梦 | `jiemeng.js` | 51 | 字节即梦 |
| Gemini | `gemini.js` | 79 | Google Gemini |
| OpenAI 兼容 | `openai.js` | 46 | 任意 OpenAI 协议端点 |
| ComfyUI | `comfyui.js` | 222 | 本地部署，含轮询取图 |

> **密钥不入代码**：所有 API Key 写入系统凭据管理器（`vault.js` / @napi-rs/keyring），配置文件里只有脱敏结果。

---

## 2. 快速开始：命令速查

全部命令需在 **`ai-canvas/`** 目录下执行。

### 2.1 脚本清单（package.json 原文）

```json
"scripts": {
  "dev":           "vite",
  "build":         "vite build",
  "server":        "node server/index.js",
  "start":         "npm run build && npm run server",
  "desktop":       "npm run build && electron .",
  "desktop:dev":   "cross-env AI_CANVAS_DEV_URL=http://127.0.0.1:5180 electron .",
  "dist":          "npm run build && electron-builder",
  "dist:oem-a":    "cross-env BRAND=oem-a npm run dist",
  "dist:oem-b":    "cross-env BRAND=oem-b npm run dist",
  "release:upload":"node scripts/upload-release.mjs",
  "test":          "node scripts/run-tests.mjs",
  "test:credits":  "node scripts/run-tests.mjs",
  "test:payments": "node scripts/run-tests.mjs"
}
```

### 2.2 分场景用法

```bash
# ── 开发 ──
npm run dev              # Vite 开发服务器 :5180（API 代理到 :5181）
npm run server           # 只起后端 :5181
npm run desktop:dev      # 桌面壳连开发服务器（改前端不用重打）

# ── 测试 ──
npm test                 # 一键跑批：30 项断言（账本 16 + 支付 14）
                         # 自动起隔离数据目录 + 空闲端口的干净实例

# ── 构建 ──
npm run build            # 前端 → dist/
npm run desktop          # 构建 + 启动桌面端
npm run dist             # 构建 + 打 Windows 安装包 → release/
npm run dist:oem-a       # 打 X.MULO 贴牌包
npm run dist:oem-b       # 打 晶灵服装AI 贴牌包

# ── 发布 ──
npm run release:upload   # 上传安装包到对象存储（自动降级：ossutil → ali-oss → 手动清单）
```

> **Windows 上一键启动**：根目录还有 `run-desktop.bat` 和 `build-installer.bat`，内部带 `cd /d "%~dp0"`，双击即可，**不需要手动 cd**。

### 2.3 端口约定

| 端口 | 用途 | 来源 |
|---|---|---|
| `5180` | Vite 开发服务器 | `vite.config.js` |
| `5181` | Express 后端 | `PORT` 环境变量，默认 5181 |

桌面端不用固定端口 —— `electron/main.cjs` 里的 `pickPort()` 动态挑空闲端口，并把它加进 `ALLOWED_PORTS`（见 §16 坑 4）。

---

## 3. 系统架构：分层与数据流

### 3.1 三层结构

```
┌──────────────────────────── Electron 33 ────────────────────────────┐
│  main.cjs      主进程：单实例锁 / 动态端口 / 窗口状态 / 登录窗 / CSP │
│  preload.cjs   contextBridge → window.desktop（12 个键）            │
│  updater.cjs   electron-updater → 差异更新 + 版本门控               │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ 起本地 Express（127.0.0.1:<动态端口>）
┌──────────────────────────────────▼──────────────────────────────────┐
│                         Vue 3 SPA（dist/）                           │
│  App.vue → LoginView / AppShell(HomeView·StudioView·TemplatesView·  │
│            ProjectsView·MaterialLibrary·AuditView·AdminConsole)     │
│  store.js（响应式全局状态）· api.js（接口封装）                       │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ /api/* 同源请求（带 X-AI-Canvas-Token）
┌──────────────────────────────────▼──────────────────────────────────┐
│                        Express 4（server/）                          │
│  security.js ← 第一道：Host/Origin/令牌/限流/预算                    │
│  index.js    ← 路由 + 鉴权 + SSE 生成                                │
│  admin.js    ← RBAC 后台 17 个接口                                   │
│  credits.js  ← 算力账本（串行化写入）                                │
│  payments.js ← 支付网关适配 + 回调验签                               │
│  templates.js / brand.js / rbac.js / accounts.js / audit.js          │
│  vault.js    ← 系统凭据管理器                                        │
│  providers/  ← 万相 / 即梦 / Gemini / OpenAI / ComfyUI               │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                    ~/.ai-canvas/（可 AI_CANVAS_HOME 覆盖）
```

### 3.2 为什么桌面端要内嵌一个本地后端

不是搭不起云服务，是**成本和合规的权衡**：

| 维度 | 本地 Express | 云端服务 |
|---|---|---|
| 用户图片素材 | 不出本机 | 上传带宽 + 隐私责任 |
| ComfyUI 本地部署 | 直连 localhost | 需要内网穿透 |
| AI 调用密钥 | 用户自己的 | 要替用户保管 |
| 运营成本 | 0 | 随用户涨 |

代价是**更新和账号必须联网** —— 这正是 §11 自动更新和账号体系存在的原因：让「算力」和「文件」留在本地，让「身份」和「钱」走云端。

### 3.3 一条请求的完整路径

以「点生成」为例 —— 这是系统里最复杂的一条链路：

```
用户点【生成】
  │
  ├─ ① security.js    Host 白名单 → Origin 校验 → 会话令牌 → 限流 → 预算熔断
  ├─ ② index.js       鉴权（AUTH_PUBLIC 之外的都要登录）
  ├─ ③ credits.reserve(user, "image.generate", taskId)
  │        └─ 串行队列取锁 → 查余额 → 够则写 pending 流水
  │        └─ 不够 → 返回 { ok:false, code:"INSUFFICIENT_CREDITS", need, balance }
  │             └─ SSE 推 error：「算力不足：本次需要 X 点，当前余额 Y 点」
  ├─ ④ providers/*.js  调模型（万相 / 即梦 / ComfyUI ...）
  │        ├─ 成功 → 落盘 outputs/ → SSE 推 progress → done（含 images + cost + balance）
  │        │          └─ credits.commit(taskId)  ← 预扣转实扣
  │        └─ 失败 → credits.rollback(taskId)    ← 原路退还，refId 去重
  │                   └─ SSE 推 error（含 refunded 字段）
  └─ ⑤ audit.js       全程记审计日志
```

> **为什么先扣后生成而不是先生成后扣**：见 §9 决策 4。
> **为什么失败要回滚而不是不扣**：用户没拿到图就不该付钱，这是最基本的公平。实测 6000 → 6000。

### 3.4 SSE 事件流

`/api/generate` 和 `/api/generate-video` 用 Server-Sent Events 推送：

| 事件 | 载荷 | 时机 |
|---|---|---|
| `progress` | `{ step, total, message }` | 生成中 |
| `done` | `{ images, cost, balance }` | 成功 |
| `error` | `{ error, refunded }` | 失败（含退款额） |

---

## 4. 后端模块详解

### 4.1 文件清单

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.js` | 705 | 主入口：34 个路由、鉴权、SSE 生成、静态托管 |
| `admin.js` | 297 | 运营后台：17 个 RBAC 接口 |
| `accounts.js` | 435 | 账号、会话持久化、密码、踢线 |
| `rbac.js` | 354 | 15 权限码 / 4 内置角色 / 5 部门 / 数据范围 / API Key / Refresh Token |
| `security.js` | 330 | **第一道防线**：Host/Origin/令牌/限流/预算熔断 |
| `credits.js` | 332 | 算力账本（本项目最核心的模块） |
| `payments.js` | 334 | 支付网关适配 + 回调验签 |
| `templates.js` | 138 | 模板双层存储 |
| `brand.js` | 53 | 品牌白标读取 |
| `config.js` | 156 | 系统配置读写 |
| `vault.js` | 123 | 密钥：系统凭据管理器 → 加密文件兜底 |
| `audit.js` | 124 | 审计日志（按天分片） |
| `paths.js` | 18 | **数据目录统一入口**（支持隔离） |
| `update-feed.json` | 7 | 更新源信息 |
| `__credits.test.mjs` | 77 | 账本自测 |
| `__payments.test.mjs` | 176 | 支付安全测试 |

### 4.2 `credits.js` —— 算力账本

这是整个商业化里最需要严谨的地方。四个设计决策，每一条都有代价：

#### 决策 1：只记流水，余额由流水推导

```js
// 不存 balance 字段，每次求和算出来
// 代价：O(n) 查询；收益：不可能出现「余额和流水对不上」
```

> **为什么这么选**：余额字段一旦失真，用户就会质疑整个账。nc 账可以不快，但不可以不对。`balanceAfter` 字段做冗余缓存加速，`reconcile()` 做一致性校验（两者必须相等）。

#### 决策 2：预扣 → 提交 / 回滚 三步

```js
reserve(user, action, refId)  →  写 pending 流水，占住额度
commit(refId)                 →  pending 转实扣
rollback(refId)               →  退还，按 refId 去重（防止重复退款）
```

#### 决策 3：写入串行化

```js
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}
```

> **为什么不是数据库事务**：并发 20 次、余额只够 10 次的场景下，如果不串行化，会全部读到「余额充足」然后全部扣成功，余额变成负数。实测：并发 20 次 / 余额 100 / 单价 10 → **只成功 10 次，余额正好 0**。

#### 决策 4：`refId` 去重

同一个 `taskId` 的 rollback 只会生效一次。防止「SSE 断连重试 + 失败回调」导致重复退款。

### 4.3 `payments.js` —— 支付网关

导出 5 个函数：

| 函数 | 行号 | 作用 |
|---|---|---|
| `payStatus()` | 49 | 支付通道配置状态 / 是否沙箱 |
| `activeGateway()` | 273 | 当前生效网关（wechat / alipay / sandbox） |
| `createPayment(order)` | 284 | 创建支付单，返回二维码 |
| `verifyCallback({gateway, rawBody, headers, params})` | 295 | **回调验签**，解析为统一结构 |
| `sandboxNotifyHeaders(order)` | 329 | 构造沙箱回调签名头（测试用） |

**三条硬规则**：

1. **订单不等于到账** —— 下单只建支付单，**绝不加算力**
2. **加算力的唯一入口是验签通过的回调** —— 没有第二条路径
3. **配了真实凭证就自动关闭沙箱** —— 防止上线后还留着后门

### 4.4 `templates.js` —— 双层模板存储

```js
// 出厂默认 + 用户覆盖
const BUILTIN_FILE = server/data/templates.json;   // 随包发布，升级会覆盖
const USER_FILE    = ~/.ai-canvas/templates.json;  // 用户自建，升级不丢
```

> **为什么分两层**：如果只有出厂文件，用户自建模板会在升级时被冲掉；如果只有用户文件，新版本的官方模板推不下来。两层合并，用 `id` 去重。

导出：`CATEGORIES`、`list`、`listEnabled(category)`、`get(id)`、`grouped()`、`upsert`、`remove`、`reset`。

### 4.5 `paths.js` —— 数据目录统一入口

```js
export const HOME = process.env.AI_CANVAS_HOME
  ? path.resolve(process.env.AI_CANVAS_HOME)
  : path.join(os.homedir(), ".ai-canvas");

export function dataFile(...parts) {
  return path.join(HOME, ...parts);
}
```

> **为什么要这个**：原先九个模块各自硬编码 `path.join(os.homedir(), ".ai-canvas")`。测试会污染真实账本，受限环境写用户目录直接 EPERM 崩。一个开关解决两件事，生产行为完全不变。

### 4.6 `vault.js` —— 密钥保管

优先级：**系统凭据管理器 → 加密文件兜底**

| 平台 | 凭据后端 |
|---|---|
| Windows | Credential Manager |
| macOS | Keychain |
| Linux | Secret Service（失败则加密文件） |

文件兜底用 `secrets.enc.json` + `.vault-salt`，主密钥派生自机器特征。

---

## 5. 后端完整接口参考

### 5.1 鉴权与公开白名单

**必须携带** `X-AI-Canvas-Token` 请求头（令牌由 `GET /api/session` 下发），除非在以下白名单中：

```js
// server/index.js — AUTH_PUBLIC
const AUTH_PUBLIC = new Set([
  "/api/auth/status", "/api/auth/setup", "/api/auth/login",
  "/api/recharge/callback/wechat",
  "/api/recharge/callback/alipay",
  "/api/recharge/callback/sandbox",
  "/api/recharge/pay-status",
  "/api/brand"
]);

// server/security.js — PUBLIC_READ（安全层也要放行，两层校验）
const PUBLIC_READ = new Set(["/api/brand", "/api/recharge/pay-status"]);
```

> ⚠️ **两层都要配**。只配一层会出现「路由放行了但安全层拦下」的 401。这是踩过的坑，见 §16 坑 6。

### 5.2 会话与鉴权类

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/session` | 下发一次性会话令牌，同步写 httpOnly Cookie |
| GET | `/api/auth/status` | 是否需初始化管理员 / 当前登录者 / 会话数 |
| POST | `/api/auth/setup` | 首次初始化管理员并直接登录 |
| POST | `/api/auth/login` | 登录（带限流） |
| POST | `/api/auth/logout` | 退出 |
| POST | `/api/auth/password` | 改密码 |
| GET | `/api/auth/perms` | 当前用户权限清单 / 角色 / 数据范围 |

### 5.3 算力与充值类

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/credits/balance` | 余额（首访自动发新用户赠送） |
| GET | `/api/credits/records` | 流水（limit ≤ 200，可筛 type） |
| GET | `/api/credits/costs` | 计费表 + 赠送额 |
| GET | `/api/credits/reconcile` | 对账：余额必须 == 流水求和 |
| GET | `/api/recharge/plans` | 套餐列表 |
| GET | `/api/recharge/orders` | 我的订单 |
| POST | `/api/recharge/orders` | 按 planId 建单 |
| POST | `/api/recharge/orders/:id/cancel` | 取消订单 |
| POST | `/api/recharge/orders/:id/pay` | 发起支付，返回二维码（**不加算力**） |
| GET | `/api/recharge/pay-status` | 支付通道状态 / 是否沙箱 |
| POST | `/api/recharge/callback/wechat` | 微信回调（验签后到账） |
| POST | `/api/recharge/callback/alipay` | 支付宝回调 |
| POST | `/api/recharge/callback/sandbox` | 沙箱回调（**配真实凭证后 403**） |

### 5.4 模板 / 生成 / 素材类

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/templates` | 分类 + 启用列表 + 分组 |
| POST | `/api/generate` | SSE 图片生成（预扣→提交/回滚） |
| POST | `/api/generate-video` | SSE 视频生成 |
| POST | `/api/upload` | 上传图片到 outputs（image/*，30MB） |
| GET | `/api/materials` | 素材库列表 |
| POST | `/api/materials/upload` | 素材上传（MIME 白名单，200MB） |
| GET | `/api/comfyui/status` | 本地 ComfyUI 状态 |

### 5.5 系统 / 审计 / 版本类

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/settings` | 读取脱敏配置 |
| PUT | `/api/settings` | 更新模型配置与限额（密钥进保险箱） |
| GET | `/api/security` | 安全层状态 + 保险箱状态 |
| GET | `/api/audit` | 审计日志（limit ≤ 500，days ≤ 30） |
| GET | `/api/audit/stats` | 审计统计 |
| GET | `/api/version` | 版本 + 更新源信息 |
| GET | `/api/brand` | 当前品牌配置（白标） |

**静态托管**：`/outputs`（maxAge 7d）、`/materials`（maxAge 1d）、`/`（dist 存在时）。

### 5.6 管理后台类（`admin.js`，需 RBAC 权限）

| 方法 | 路径 | 所需权限 |
|---|---|---|
| GET | `/api/admin/overview` | `admin:dashboard:view` |
| GET / POST | `/api/admin/accounts` | `admin:account:view` / `create` |
| PUT / DELETE | `/api/admin/accounts/:id` | `admin:account:edit` / `delete` |
| POST | `/api/admin/accounts/:id/status` | `admin:account:edit` |
| POST | `/api/admin/accounts/:id/reset` | `admin:account:reset` |
| POST | `/api/admin/accounts/:id/kick` | `admin:account:kick` |
| GET / POST / DELETE | `/api/admin/roles[/:id]` | `admin:role:view` / `edit` |
| GET / POST / DELETE | `/api/admin/depts[/:id]` | `admin:dept:view` / `edit` |
| GET | `/api/admin/logs` | `admin:log:view` |
| GET | `/api/admin/apikeys` | `admin:apikey:view` |
| POST | `/api/admin/apikeys/:id/rotate` | `admin:apikey:rotate`（明文只返回一次） |

**接口总数：34（index.js）+ 17（admin.js）= 51**

---

## 6. 前端组件清单与设计体系

### 6.1 组件清单（35 个文件 / 6,866 行）

#### 入口与状态

| 文件 | 行数 | 说明 |
|---|---|---|
| `main.js` | 31 | 挂载 Vue / Element Plus / Vue Flow 样式 / 嵌入桥 |
| `App.vue` | 225 | 根组件，登录态分支 |
| `store.js` | 419 | 响应式全局状态 |
| `api.js` | 301 | 全部接口封装 |
| `embed.js` | 121 | iframe 嵌入宿主通信 |
| `onboarding.js` | 116 | 新手指引流程 |

#### 主要视图

| 文件 | 行数 | 说明 |
|---|---|---|
| `NodeCanvas.vue` | **797** | ★ 最大组件，Vue Flow 无限画布 |
| `AccountModals.vue` | **559** | ★ 充值 / 算力 / 消费明细 / 订单 |
| `AppShell.vue` | 330 | ★ 主壳：顶栏 + 侧栏 + 路由切换 |
| `StudioView.vue` | 272 | ★ 创作工作台 |
| `HomeView.vue` | 230 | ★ 首页 |
| `TemplatesView.vue` | 230 | ★ 模板广场 |
| `SettingsDialog.vue` | 252 | 模型密钥 / 限额 |
| App.vue | 225 | 根组件 |
| `LoginView.vue` | 162 | 登录 / 初始化管理员 |
| `UpdateToast.vue` | 147 | 更新提示与下载进度 |
| `OnboardingTour.vue` | 188 | 新手指引 UI |
| `AdminConsole.vue` | 178 | 运营后台容器 |
| `ChatDrawer.vue` | 81 | AI 对话抽屉 |
| `ProjectsView.vue` | 77 | 项目列表 |
| `MaterialLibrary.vue` | 116 | 素材库 |
| `AuditView.vue` | 116 | 安全审计 |
| `BootSplash.vue` | 35 | 启动闪屏 |

#### 子节点 `nodes/`（6 个）

`ExecutorNode` 40 · `ProductNode` 78 · `PromptNode` 52 · `ReferenceNode` 110 · `ResultNode` 172 · `StyleNode` 73

#### 后台子模块 `admin/`（6 个）

`AdminAccounts` 355 · `AdminConsole` 178 · `AdminDepts` 165 · `AdminKeys` 109 · `AdminLogs` 95 · `AdminRoles` 227

> `_deprecated/` 下还有 `InfiniteCanvas.vue`（163）和 `PromptPanel.vue`（244），已被 `NodeCanvas.vue` 取代，保留仅为参考。

#### 样式文件

`style.css` 117 KB · `admin.css` 16 KB · `account.css` 15 KB · `templates.css` 10 KB · `rail.css` 2 KB

### 6.2 设计 Token

```css
:root {
  /* 字体：拉丁字形交给系统 UI 字体，再逐级回落中文 */
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI",
    "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Source Han Sans SC",
    "Noto Sans SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", ...;

  --bg: #f3f4f6;              --surface: #ffffff;
  --border: #e5e7eb;          --border-strong: #d1d5db;

  --text: #111827;            --text-2: #4b5563;   --text-3: #6b7280;

  /* 侧边栏（跨多多藏青） */
  --sidebar-bg: #0A1F3D;      --sidebar-item: #93A9C8;

  /* 品牌蓝 */
  --brand-deep: #0A1F3D;      --brand: #2563EB;   --brand-light: #60A5FA;
  --primary: #2563EB;         --primary-hover: #3B82F6;

  /* 圆角对齐 LOOM42：8 / 12 */
  --radius: 8px;              --radius-lg: 12px;
}
```

**字体策略的取舍**：把 `-apple-system / Segoe UI` 放在中文之前，是因为微软雅黑的**西文和数字字形明显粗糙**。中英混排时，先让系统 UI 字体命中拉丁字符，中文再逐级回落。配合 `font-synthesis-weight: none`（禁止浏览器伪造粗体）和 `-webkit-font-smoothing: antialiased`。

### 6.3 画布视觉规范（对齐 LOOM42 实测）

| 元素 | 参数 | 说明 |
|---|---|---|
| 背景点阵 | `gap: 20, size: 1.6` | ⚠️ `size` 是**直径**且会乘缩放倍率，见 §16 坑 2 |
| 点阵颜色 | `#cfd6e2` | 浅灰蓝，不抢内容 |
| 连线 | `stroke: #cbd3e1, width: 1.6, dasharray: 6 5` | 蚂蚁线动效 |
| 蚂蚁线帧动画 | `@keyframes nf-ant { 0 → -11 }`，`0.55s linear infinite` | **位移必须等于周期 11**（6+5），否则会跳 |

### 6.4 深色主题约定

```css
--bg: #000;  --surface: #0d0d0d;  --brand: #ffffff;
```

> 从 LOOM42 线上 CSS 抓到的关键：**深色模式下主色是白色，不是品牌蓝**。这在截图里看不出来 —— 白色主色和白色文字在暗背景上是两回事，必须读 CSS 变量才能发现。

---

## 7. 桌面端：Electron 与 IPC

### 7.1 主进程 `main.cjs`（513 行）

| 能力 | 实现要点 |
|---|---|
| **单实例锁** | `app.requestSingleInstanceLock()`，二次启动聚焦已有窗口 |
| **动态端口** | `pickPort()` 挑空闲端口，并加入 `ALLOWED_PORTS` |
| **窗口状态持久化** | 位置/尺寸存盘，多显示器环境下校验坐标是否仍在有效屏幕内 |
| **无框菜单** | `Menu.setApplicationMenu()`，否则无框窗 Ctrl+C/V/A 失效 |
| **登录独立窗** | `additionalArguments: ["--app-window=login"]`，440×620 |
| **CSP 注入** | `webRequest.onHeadersReceived` 注入响应头 |
| **Windows 日志** | ⚠️ **stdout 在 Windows 被吞**，必须走 stderr + `userData/boot.log` |
| **崩溃兜底** | `render-process-gone` 监听 |

### 7.2 IPC 通道

**窗口控制**（preload 已暴露）：

| 通道 | preload 键 |
|---|---|
| `window:minimize` | `desktop.minimize()` |
| `window:toggle-maximize` | `desktop.toggleMaximize()` |
| `window:close` | `desktop.close()` |
| `window:is-maximized` | `desktop.isMaximized()` |
| `window:state`（推送） | `desktop.onWindowState(cb)` |
| `auth:success` | `desktop.notifyLoginSuccess()` |
| `auth:logout` | `desktop.notifyLogout()` |
| `app:info` | `desktop.info()` |
| `app:open-logs` | `desktop.openLogs()` |

**常量**：`desktop.isDesktop` / `desktop.platform` / `desktop.windowMode`

**更新通道**（`updater.cjs` 内部注册，**当前未在 preload 暴露**）：

| 通道 | 说明 |
|---|---|
| `update:check` | 触发检查 |
| `update:install` | 下载完成后退出并安装 |
| `update:state` | 查询状态 |
| `update:checking`（推送） | 开始检查 |

> ⚠️ **待补**：`UpdateToast.vue` 已写好，`update:*` 三个通道还没接到 preload。要做「界面点检查更新」按钮时需要补这段。

### 7.3 无框窗拖拽

```css
.titlebar  { -webkit-app-region: drag; }
.titlebar button { -webkit-app-region: no-drag; }   /* 按钮必须排除 */
```

---

## 8. 安全体系：四层防护

### 8.1 四层结构

```
请求进来
  │
  ├─ 第 1 层  security.js    传输层：Host / Origin / 令牌 / 限流 / 预算熔断
  ├─ 第 2 层  index.js       会话层：是否登录（AUTH_PUBLIC 白名单）
  ├─ 第 3 层  rbac.js        权限层：15 个权限码 + 行级数据范围
  └─ 第 4 层  audit.js       留痕：所有敏感操作写日志（按天分片）
```

### 8.2 第 1 层细节（`security.js`）

| 防护 | 作用 | 防的攻击 |
|---|---|---|
| **Host 白名单** | `localhost` / `127.0.0.1` / `::1` + `ALLOWED_PORTS` | DNS Rebinding：攻击者域名解析到本地，绕过同源 |
| **Origin 校验** | 同源检查 | CSRF |
| **会话令牌** | `X-AI-Canvas-Token`，持久化到 `~/.ai-canvas/.session-token`（0600） | 未授权调用本地接口 |
| **限流** | 按 IP + 路由 | 暴力破解 / 刷充 |
| **预算熔断** | 累计超阈值即熔断 | API Key 被盗刷光额度 |

```js
const ALLOWED_PORTS = new Set(
  [
    ...String(process.env.AI_CANVAS_ALLOWED_PORTS || "5180,5181").split(","),
    process.env.PORT || ""          // ⚠️ 必须包含动态端口，否则本地服务自己拦自己
  ].map(s => String(s).trim()).filter(Boolean)
);
```

### 8.3 第 3 层：RBAC

**15 个权限码 / 4 个内置角色 / 5 个内置部门**

| 角色 | code | 权限数 |
|---|---|---|
| 超级管理员 | `super_admin` | 15（全） |
| 运营 | `operator` | 8 |
| 审核员 | `auditor` | 3 |
| 设计师 | `designer` | 1 |

**数据范围** `DATA_SCOPES`：`all` / `dept` / `self` / `custom`（行级隔离）

### 8.4 支付回调为什么不需要令牌

回调是**微信/支付宝服务器从公网打过来**的，不可能有本地会话令牌。所以 `/api/recharge/callback/` 前缀在两层都放行 —— **签名本身就是更强的身份证明**。放行令牌 ≠ 不验证，而是把验证交给密码学。

---

## 9. 商业化闭环：算力账本

### 9.1 计费模型

```js
export const COST_TABLE = {
  "image.generate": { cost: 10,  label: "生成图片" },
  "image.edit":     { cost: 6,   label: "图片编辑" },
  "image.upscale":  { cost: 4,   label: "一键高清" },
  "video.generate": { cost: 120, label: "生成视频" },
  "detail-page":    { cost: 60,  label: "详情页制作" }
};

export const SIGNUP_GRANT = 500;   // 新用户赠送
```

> **定价逻辑**：按**成本倍数**而不是按「次」定价。视频 120 点 vs 图片 10 点，是 12 倍，接近真实 API 成本比（视频生成贵一个数量级）。用户也更容易理解「视频贵」这件事。

### 9.2 套餐设计

| id | 算力 | 价格 | 赠送 | 标签 | 折合单价 |
|---|---|---|---|---|---|
| `plan-1000` | 1,000 | ¥19 | 0 | 体验包 | ¥0.0190/点 |
| `plan-5000` | 5,000 | ¥89 | 500 | **标准包（hot）** | ¥0.0162/点 |
| `plan-20000` | 20,000 | ¥299 | 3,000 | 专业包 | ¥0.0130/点 |
| `plan-50000` | 50,000 | ¥699 | 10,000 | 团队包 | ¥0.0116/点 |

> **阶梯设计的目的**：让「多充多省」在数字上肉眼可见。500 赠送放在标准包而不是入门包，是为了把用户从「试试」推向「常用」。

### 9.3 为什么「生成前扣费」而不是「生成后」

| | 生成前扣 | 生成后扣 |
|---|---|---|
| 恶意刷量 | 余额不足即止步 | 可无限刷后欠费跑路 |
| 用户体感 | 先扣再退，用户明确知道这次花了多少 | 事后扣容易被质疑「怎么扣这么多」 |
| 实现复杂度 | 需要 reserve/commit/rollback 三步 | 一步搞定 |

选前者，代价是要写回滚逻辑。这部分有 16 项测试兜底。

### 9.4 实测记录（原文）

```
=== 算力账本自测 ===
✅ 初始余额为 0
✅ 充值 1000 后余额 1000
✅ 预扣成功
✅ 预扣后余额 990
✅ 提交后余额不变 990
✅ 视频预扣 120
✅ 回滚成功
✅ 回滚后余额回到 990
✅ 重复回滚被去重
✅ 余额未被二次退回
✅ 余额不足被拒绝
✅ 并发 20 次 / 余额 100 / 单价 10 → 只成功 10 次
✅ 并发后余额正好为 0
✅ 对账一致（余额 == 流水求和）
✅ 流水可查
✅ 流水倒序（最新在前）

16 通过 / 0 失败
```

---

## 10. 充值与真实支付网关

### 10.1 为什么要重写：旧实现是个白嫖漏洞

改造前有一个 `POST /api/recharge/orders/:id/paid` 接口 —— **前端调一下就加算力，没有任何验证**。任何人打开开发者工具就能无限加余额。现在这个接口**已返回 404**（测试第 14 项专门验证）。

### 10.2 完整链路

```
① 用户选套餐 → POST /api/recharge/orders        → 建订单（状态 pending）
② 用户点支付 → POST /api/recharge/orders/:id/pay → 调网关下单，返回二维码
                                                   ⚠️ 此步不加算力
③ 用户扫码付款 → 支付平台 → POST /api/recharge/callback/wechat|alipay
④ 服务端：verifyCallback() 验签 + 金额比对 + 幂等检查
⑤ 验签通过 → credits 到账 → 返回 success 给支付平台
```

### 10.3 微信支付 APIv3

**签名**：RSA-SHA256（`RSA-SHA256` + PKCS#1 v1.5）

```
待签串 = HTTP方法\nURL\n时间戳\n随机串\n请求体\n
Authorization: WECHATPAY2-SHA256-RSA2048 mchid="...",nonce_str="...",
              signature="...",timestamp="...",serial_no="..."
```

**回调解密**：AES-256-GCM 解 `resource` 字段

```js
resource = { algorithm: "AEAD_AES_256_GCM", nonce, associated_data, ciphertext }
// AAD = associated_data，12 字节 nonce，末尾 16 字节是 GCM tag
```

**防重放**：时间戳偏移必须 ≤ 300 秒

### 10.4 支付宝当面付 precreate

**签名**：RSA2（SHA256withRSA）
**回调验签**：把所有参数按 key 字典序拼成 `k1=v1&k2=v2`，用支付宝公钥验 `sign` 字段
**关键**：必须排除 `sign` 和 `sign_type` 两个参数本身

### 10.5 沙箱模式

没凭证也能跑完整链路 —— `payments.js` 会在 `~/.ai-canvas/pay-keys/` **自动生成一对 RSA 密钥**，用同样的验签逻辑走完全流程。

> **这个设计的价值**：把「能测的部分」和「需要凭证的部分」彻底分开。验签算法、幂等、到账三部曲都能在无凭证状态下验证到 100%，只差替换真实密钥。

**熔断**：一旦配置了真实凭证，沙箱回调自动返回 403。

### 10.6 安全测试实测（原文）

```
=== 支付回调验签 · 安全测试 ===
✅ 能读到支付状态
✅ 未配置凭证时进入沙箱模式
✅ 创建订单成功
✅ 订单初始为待支付
✅ 发起支付成功
✅ 返回二维码
✅ 合法签名回调被接受
✅ 算力已到账（500 → 1500）
❌→ 伪造签名 → 400 拒绝，余额未变
❌→ 无签名头 → 400 拒绝
✅ 重复回调不重复加算力（幂等）
✅ 旧的 /paid 接口已移除（404）
❌→ 金额不匹配 → 400 拒绝

14 通过 / 0 失败
```

### 10.7 必踩的六个坑

| # | 坑 | 后果 | 对策 |
|---|---|---|---|
| 1 | 回调要读 `rawBody` | `express.json()` 会消费 body，验签拿到空串必然失败 | `{ verify: (req,_res,buf) => { req.rawBody = buf.toString("utf8") } }` |
| 2 | 沙箱回调忘了关 | 上线后任何人 POST 一下就加余额 | 配真实凭证即自动 403 |
| 3 | 时间戳不校验 | 抓到旧回调包无限重放 | 偏移 ≤ 300s |
| 4 | 回调未做幂等 | 支付平台重试导致重复到账 | `orderId + out_trade_no` 去重 |
| 5 | 只验签不比金额 | 篡改金额以低价买大额套餐 | 回调金额与订单金额必须一致 |
| 6 | `throw` 没被捕获 | 回调返回 500，支付平台持续重试 24 小时 | 回调里必须 try/catch 并返回明确状态码 |

---

## 11. 自动更新接 OSS

### 11.1 方案来源

照搬 **AI Change 实机拆解**出来的成熟配置（从它解包的 `resources/` 里读出来的）。

### 11.2 三件套

electron-updater 只需要三样东西放在同一个目录下：

```
https://<你的OSS>/releases/
├── latest.yml        ← 版本清单，客户端第一个请求它
├── xxx-setup.exe     ← 完整安装包
└── xxx.blockmap      ← 差异更新索引（决定能否增量）
```

### 11.3 ⚠️ 差异更新必须做版本门控

```js
const DIFFERENTIAL_MIN_VERSION = "0.2.0";
// 低于此版本的客户端强制全量更新
```

> **为什么**：blockmap 差异补丁只对「足够新的旧版本」可靠。让一个 0.1.0 的老客户端去 apply 一个从 0.2.x 算出来的差异包，很可能装出一个坏掉的安装。宁可让用户下一次 90 MB 全量，也不要让他装出一个打不开的程序。

### 11.4 配置项

```json
"build": {
  "publish": [{
    "provider": "generic",
    "url": "https://REPLACE-WITH-YOUR-OSS.oss-cn-beijing.aliyuncs.com/releases/"
  }]
}
```

> 🔴 **当前还是占位符**。不替换的话，客户端永远检测不到更新。这是 P0。

### 11.5 打包与上传

```bash
npm run dist              # → release/ 生成 exe + latest.yml + blockmap
npm run release:upload    # 自动选可用方式上传
```

`upload-release.mjs` 会做四件事：校验三件套齐不齐、校验版本号一致、自动降级选择上传方式（ossutil → ali-oss SDK → 打印手动清单）、**警告 publish URL 是否为占位符**。

### 11.6 不需要 OSS 的本地自测

```bash
# 1) 打一个 0.2.0 装上并运行
# 2) 改 package.json 版本号到 0.2.1，重新打包
# 3) 把 release/ 三件套放到本地静态服务器，模拟 OSS
# 4) 临时把 publish.url 指向 http://127.0.0.1:8899/，重装一次
# 5) 启动旧版 → 8 秒后应看到「发现新版本 0.2.1」→ 下载 → 安装 → 自动重启
```

> **为什么本地能测**：`generic` provider 就是个静态 HTTP 协议的别名。只要能 GET 到 latest.yml，服务端是谁无所谓。

---

## 12. 多品牌白标

### 12.1 零依赖，现在就能用

不引入任何运行时依赖 —— 一个 JSON 配置 + 一个读取模块 + 前端 CSS 变量覆盖。

### 12.2 品牌清单（`config/brand.json`）

| key | name | appName | primary | primaryDeep |
|---|---|---|---|---|
| `kuaduoduo` | 跨多多 | 跨多多 AI 创作台 | `#2563EB` | `#0A1F3D` |
| `oem-a` | X.MULO | X.MULO 智能助手 | `#E8590C` | `#2B1408` |
| `oem-b` | 晶灵服装AI | 晶灵服装AI 创作台 | `#7C3AED` | `#1E1033` |

### 12.3 实测切换

```
可用品牌: kuaduoduo, oem-a, oem-b
  BRAND=kuaduoduo → 跨多多 AI 创作台     主色 #2563EB
  BRAND=oem-a     → X.MULO 智能助手      主色 #E8590C
  BRAND=oem-b     → 晶灵服装AI 创作台    主色 #7C3AED
默认（不设 BRAND）: kuaduoduo
非法 BRAND 兜底: kuaduoduo（不会白屏）
```

> **兜底很重要**：填错品牌 key 时静默回落到默认，而不是渲染出一片空白。白标的买家往往是甲方，白屏比错色更难解释。

### 12.4 打包

```bash
BRAND=oem-a npm run dist      # 或 npm run dist:oem-a
```

前端启动时调 `/api/brand` 拿到配置，写入 CSS 变量。

### 12.5 商业账

| 项 | 成本 | 收益 |
|---|---|---|
| 加一个新品牌 | 改 1 个 JSON 条目 | 一套代码卖多家 |
| 换主色 / Logo / 名 | 0 | 客户感知「专属产品」 |
| 维护成本 | 同一份代码库 | 不是 fork |

---

## 13. 模板体系与 11 张示意图

### 13.1 11 个模板清单

| id | 名称 | 分类 | order | workflow | 角标 |
|---|---|---|---|---|---|
| `ai-studio` | AI 虚拟影棚 | model | 1 | `clothes-model` | 热门 |
| `hot-replicate` | 爆款复刻 | model | 2 | `style-reference` | NEW |
| `detail-page` | 详情页制作 | detail | 3 | `detail-page` | — |
| `use-template` | 使用模板 | product | 4 | `image-replica` | — |
| `pose-split` | 姿势裂变 | model | 11 | `clothes-model-pose` | — |
| `fixed-face` | 固定脸型换背景 | model | 12 | `fixed-face-bg-pose` | — |
| `scene-shot` | 自定义场景 | scene | 21 | `custom-scene` | — |
| `white-bg` | 智能白底图 | product | 22 | `smart-generation` | — |
| `text-to-image` | 文生图 | scene | 23 | `image-generate` | — |
| `ai-video` | 图片转视频 | video | 31 | `ai-video` | — |
| `video-replica` | 爆款视频复刻 | video | 32 | `ai-video-replica` | — |

分组：model 4 / product 2 / scene 2 / video 2 / detail 1

### 13.2 示意图覆盖 11/11

| 文件 | KB | 文件 | KB |
|---|---|---|---|
| `hot-replicate.webp` | 203 | `ai-studio.webp` | 197 |
| `white-bg.webp` | 197 | `fixed-face.webp` | 154 |
| `pose-split.webp` | 140 | `video-replica.webp` | 111 |
| `text-to-image.webp` | 107 | `scene-shot.webp` | 106 |
| `use-template.webp` | 62 | `ai-video.webp` | 49 |
| `detail-page.webp` | 43 | **合计** | **1.4 MB** |

> 改造前只有 4 张，其余走渐变兜底 —— 视觉上参差不齐，像是没做完。

### 13.3 为什么要图片而不是 DOM 拼

从 LOOM42 线上 DOM 扒出来的结论：**它的技能卡预览就是一张 1200×675 的 webp，不是 DOM 拼出来的**。

这决定了复制它是一件「内容任务」而不是「工程任务」：

| 做法 | 成本 | 一致性 | 加载 |
|---|---|---|---|
| DOM 拼色块 / 图标 | 高（每个模板一套样式） | 难统一 | 快 |
| **一张图** | 低（出图即可） | 天然统一 | 一张 HTTP 请求 |

### 13.4 为什么是 WebP

11 张原始 PNG 合计 12.1 MB → WebP q88 压缩后 1.4 MB，**省 88%**。画质在 320px 缩略图尺寸下肉眼无差别。

### 13.5 生成图的处理

生成的 PNG 右下角带 "AI 生成 WORKBUDDY" 水印 → PIL 裁掉底部 52px → WebP q88 压缩。

### 13.6 服务端下发 + 兜底

`preview` 字段由 `/api/templates` 下发，前端 `<img>` 带 `@error` 回落到 `hsl()` 确定性渐变占位：

```js
// 由 id 哈希出色相，同一模板每次兜底色一致，不会闪
const hue = hash(id) % 360;
```

---

## 14. 竞品研究结论归集

三份拆解文档的核心结论在此汇总（原文档保留在根目录供查）。

### 14.1 AI Change（桌面）— 云端运营范式成熟

从它解包的 `resources/` 里读到的关键设计：

| 发现 | 我们的借鉴 |
|---|---|
| **electron-updater + 阿里云 OSS** | §11 整套照搬 |
| **`/api/app/credits` 与 `/api/app/recharge` 分两个接口** | 演化成我们的 `credits.js` / `payments.js` 两个模块——**账和钱必须分开建模** |
| **`brand.json` 白标** | §12 |
| **Go 编译的 `license-tool` 二进制做授权** | 启发了 License 方案；**失败时 exit 0**（很少见的做法，避免客户端崩出堆栈吓到用户） |
| **Markdown 定义 Agent Skill** | `app.asar/tools/*.md` 直接当提示词 |

**核心洞察**：它的产品能力（Agent 编排）未必比我们强，但**商业化基建（更新 / 充值 / 白标 / 授权）比我们完整得多** —— 而这些恰恰是能直接挣钱的部分，且技术含量不高。所以这三项成了我们的首选补齐对象。

### 14.2 LOOM42（网页）— 模板呈现是最好的

| 发现 | 实测数据 |
|---|---|
| 卡片预览是**单张 1200×675 webp** | 见 §13.3，直接决定了我们的图方案 |
| 卡片圆角 **8 / 12** 两级 | 已写入 `--radius` token |
| **深色模式主色是白色 `#FFFFFF`** | 必须抓 CSS 变量才能发现，截图看不出来 |
| hover 位移 2px，160ms ease-out | 已应用于卡片交互 |

### 14.3 网页式操作能否复刻进桌面端

**结论：能，而且有天然优势。**

三个必须先改的点（否则复刻过来是空壳）：

1. **画布节点要能承载「预览 > 参数 > 执行」三段** —— 网页版点开卡片就是参数面板，桌面版必须把参数塞进节点本身
2. **模板必须服务端下发** —— 网页版改模板不用发版，桌面版如果硬编码，每上一个模板就要重打 90 MB 包
3. **素材要能本地直传** —— 这是桌面版相对网页版的优势（不用上传等待），不能反过来做成劣势

我们已经做完 2（§4.4）和 3（`/api/materials/upload`），1 在节点设计里已支持。

---

## 15. 测试体系

### 15.1 一键跑批

```bash
npm test
```

`scripts/run-tests.mjs`（91 行）做四件事：

1. 建临时数据目录（`.testdata/`）
2. 挑一个空闲端口，起干净服务端实例
3. 依次跑两个测试
4. 失败抬非 0 退出码（给 CI 用）

> **为什么要把环境准备塞进脚本**：原来靠人手动「设环境变量 → 起服务 → 跑测试」，三步里漏一步就得出一个假绿或者假红。特别是支付测试，服务端和测试进程**必须指向同一个数据目录**，否则读的沙箱密钥不是一对。

### 15.2 两个测试

| 测试 | 文件 | 行数 | 断言数 | 主题 |
|---|---|---|---|---|
| 算力账本 | `__credits.test.mjs` | 77 | 16 | 预扣 / 提交 / 回滚 / 去重 / 并发安全 / 对账 / 流水 |
| 支付安全 | `__payments.test.mjs` | 176 | 14 | 下单 / 二维码 / 验签 / 伪造 / 幂等 / 金额比对 / 旧口子 404 |

**合计 30 项，全部通过。**

### 15.3 自包含原则

两个测试都能在**全新环境**下直接跑：

- `__payments.test.mjs` 先尝试登录，**失败就自动走 `/api/auth/setup` 初始化**（原先假定已有 admin，换目录就挂）
- 沙箱私钥按同一个 `AI_CANVAS_HOME` 解析（原先写死 homedir）

> ⚠️ 那个私钥路径 bug 很值得记：报错是「沙箱签名校验失败」，看着像验签算法写错了，**实际是两边读的密钥不是同一把**。报错信息把人往完全错误的方向引。见 §16 坑 12。

---

## 16. 踩坑全集

### 代码类

| # | 坑 | 现象 | 根因与对策 |
|---|---|---|---|
| 1 | **画布快捷键全死** | Ctrl+C/V/A 无反应 | `addEventListener("keydown", onKeyDown)` **定义了但从未调用**。之后又发现 Vue Flow 1.48 的 `setSelection(ids)` 静默失效，改用自己遍历 `getNodes().value` 设 `selected` |
| 2 | **画布点阵看不见** | 背景一片空白 | `size` 是**直径**且会乘缩放（0.865），`r = 1 × 0.865 / 2 = 0.43px` —— 亚像素，渲染不出来。改 `size: 1.6` |
| 3 | **蚂蚁线跳动** | 虚线位移不流畅 | `@keyframes` 的位移量必须**等于 dasharray 周期**（6+5=11），写成 10 就会跳 |
| 4 | **白窗 titled "Error"** | 桌面端起不来 | 动态端口不在 `ALLOWED_PORTS`（原先硬编码 5180,5181），**本地服务把自己的请求拦了**。加 `process.env.PORT` |
| 5 | **`net.createServer is not a function`** | Electron 启动崩 | 从 `electron` 里解构了 `net` —— 那是它的 fetch-like API。改用 `require("node:net")` |
| 6 | **`/api/brand` 401** | 明明加了白名单 | **两层校验**：只加了 index.js 的 `AUTH_PUBLIC`，漏了 security.js 的 `PUBLIC_READ` |
| 7 | **支付回调 401 SESSION_REQUIRED** | 上线后**所有真实付款都不到账** | 回调来自支付平台服务器，没有本地令牌。加 callback 前缀放行 |
| 8 | **回调验签失败** | 沙箱测试不通过 | 测试进程和服务端用了不同数据目录 → **读的密钥不是一对**。报错信息极具误导性 |
| 9 | **`d3dcompiler_47.dll: Access is denied`** | 打包失败 | Defender 正在扫 188 MB 的 exe。**同一个命令手动重跑返回 exit 0** —— 不要改配置，等 20 秒重试 |
| 10 | **`rcedit: Unable to commit changes`** | 同上，文件锁 | 同上 |
| 11 | **dist 里两份 `index-*.js`，引用了旧那份** | 改了代码没生效 | `vite.config.js` 的 `emptyOutDir: false`。改回 `true` |
| 12 | **生成的 PNG 只读，删不掉** | EPERM | 生成图带只读属性。构建后加 `stripGeneratedSources()` 插件剔除，源图备份到 `_template-src/` |
| 13 | **Windows 上主进程日志全不见** | 无法诊断启动问题 | **Electron 在 Windows 会吞掉 stdout**。走 stderr + 写 `userData/boot.log` |

### 表述与环境类

| # | 坑 | 对策 |
|---|---|---|
| 14 | **`npm run desktop` 报 `C:\Users\Administrator\package.json` 不存在** | 用户在 home 目录跑命令。补 `run-desktop.bat` / `build-installer.bat`，内部带 `cd /d "%~dp0"` |
| 15 | **heredoc 里的引号被 Python 吃掉** | 改成先 `.py` 文件再执行 |
| 16 | **`__probe.mjs` 等临时产物删不掉** | 沙箱批量删除保护。已写进 `.gitignore`，可手动删 |

### 体验类

| # | 坑 | 对策 |
|---|---|---|
| 17 | **图片水印** "AI 生成 WORKBUDDY" | PIL 裁掉底部 52px |
| 18 | **`.el-overlay` 判断导致快捷键失效** | Element Plus 关闭的 dialog **仍留在 DOM 里**（实测 6 个）。必须查 `getComputedStyle` 的 display/visibility/opacity，不能只查选择器存在与否 |

---

## 17. 上线前必办清单

### 🔴 P0 — 阻断性，不办就不能上线

| # | 事项 | 不办的后果 |
|---|---|---|
| 1 | 替换 `build.publish.url` 的 `REPLACE-WITH-YOUR-OSS` 占位符 | **客户端永远检测不到更新** |
| 2 | 配置公网 HTTPS 回调域名 `PAY_NOTIFY_BASE_URL` | **用户付了钱，余额不动** |
| 3 | 提供微信商户号 / 支付宝 AppId + 密钥 | 一直是沙箱，收不到真钱 |
| 4 | 回调地址做 HTTPS + 域名备案 | 支付平台不接受 HTTP 回调 |

### 🟡 P1 — 上线前应处理

| # | 事项 |
|---|---|
| 5 | 配置 OSS Bucket + AccessKey（否则每次手动上传） |
| 6 | 把 `update:*` 三个 IPC 通道接到 preload（否则界面不能手动点检查更新） |
| 7 | 清理 `release/` 里遗留的 0.1.0 老包（与当前 0.2.0 版本不一致） |
| 8 | 清理临时产物：`.testdata/` `.testdata-srv/` `__probe.mjs` `_template-src/` |
| 9 | 梳理 AI 调用超时与重试策略（当前由各 provider 各自实现） |

### 🟢 P2 — 可以后补

| # | 事项 | 说明 |
|---|---|---|
| 10 | License 授权体系（见 §18） | 借鉴 AI Change 的 `license-tool` 思路 |
| 11 | License 过期策略与离线宽限 | 断网用户不能一到期就锁死，需给宽限期 |
| 12 | 多模型并发队列限流 | 防止同一用户并发打爆 API 配额 |
| 13 | 审计日志归档策略（>30 天） | 当前按天分片，长期会累积 |

---

## 18. 路线图

### 已完成 ✅

| 阶段 | 内容 |
|---|---|
| 一 | 商业闭环：账本 / 充值 / 套餐 / 消费流水 |
| 二 | 界面补齐：充值弹窗接服务端套餐 / 消费明细页 |
| 三 | 生成扣费打通 + 失败退款 |
| 四 | 真实支付网关（微信 APIv3 / 支付宝 / 沙箱）+ 回调验签 |
| 五 | 自动更新接 OSS + 差异更新版本门控 |
| 六 | 多品牌白标（三品牌） |
| 七 | 11 张模板示意图 |

### 待做

| 优先级 | 事项 | 说明 |
|---|---|---|
| **P0** | 填 OSS / 商户号 / 回调域名 | 纯配置，无代码工作量 |
| **P1** | 更新通道接 preload | 让 UI 能触发 `update:check` |
| **P1** | **License 授权体系** | 借鉴 AI Change：`license-tool` 的思路做离线签名校验 + 在线激活 + 过期宽限。约 300 行 |
| **P2** | 增长：邀请返点 / 团队子账号 / 用量报表 | 视售卖模式定 |

---

## 19. 历史文档索引

归集前的文档与此文档章节的对应关系，**原文档保留**：

| 历史文档 | 行数 | 归入章节 |
|---|---|---|
| `README.md` | 62 | §1 产品定位 |
| `使用说明.md` | 159 | §2 快速开始 |
| `1-界面对标与优化方案.md` | 229 | §6.2 / §6.3 / §14.2 |
| `2-商业化技术方案-可跑通.md` | 520 | §4 / §9 / §11 / §12 / §8 |
| `参考工具深度拆解与复刻方案.md` | 390 | §14 |
| `跨多多AI创作台-商业化改造完整实施文档.md` | 634 | §9 / §16 / §17 |
| `4-支付与自动更新与白标-深度实施文档.md` | 925 | §10 / §11 / §12 / §13 |
| `AI_Change_深度分析报告.md` | 133 | §14.1 |
| `NodeAI_Tool_深度拆解.md` | 418 | §3 / §14.3 |
| `ai-canvas/DESIGN-AUDIT.md` | 97 | §6.2 |
| `ai-canvas/design-refresh-report.md` | 124 | §6.2 / §6.3 |
| `ai-canvas/REFERENCE_ANALYSIS.md` | 183 | §14.1 / §14.2 |
| `ai-canvas/REFERENCE_FEATURES.md` | 235 | §14.3 |

> 归集前合计 15 份 / 4,305 行。此文档为唯一的最新事实来源；历史文档若有与此文冲突之处，**以此文为准**（此文数据在 2026-09-23 实跑校准）。

---

## 附录 A：文件职责速查

```
ai-canvas/
├── package.json              版本 0.2.0 / 12 个 scripts / electron-builder 配置
├── vite.config.js            端口 5180 / emptyOutDir: true / stripGeneratedSources 插件
├── index.html                入口
├── .gitignore                临时产物已忽略
│
├── config/brand.json         ★ 三品牌白标配置
│
├── server/                   16 文件 / 3,659 行
│   ├── index.js              705 行｜34 路由 + SSE 生成
│   ├── admin.js              297 行｜17 个 RBAC 接口
│   ├── credits.js            332 行｜★ 算力账本
│   ├── payments.js           334 行｜★ 支付网关 + 验签
│   ├── accounts.js           435 行｜账号与会话持久化
│   ├── rbac.js               354 行｜15 权限 / 4 角色 / 5 部门
│   ├── security.js           330 行｜第一道防线
│   ├── audit.js              124 行｜审计日志
│   ├── config.js             156 行｜配置读写
│   ├── vault.js              123 行｜系统凭据管理器
│   ├── templates.js          138 行｜双层模板存储
│   ├── brand.js               53 行｜品牌读取
│   ├── paths.js               18 行｜数据目录入口
│   ├── data/templates.json    11 个模板
│   ├── providers/             comfyui 222 / wanxiang 160 / gemini 79 / jiemeng 51 / openai 46
│   └── __*.test.mjs          2 个自测（30 项断言）
│
├── src/                      35 文件 / 6,866 行
│   ├── main.js  App.vue  store.js(419)  api.js(301)  embed.js  onboarding.js
│   ├── components/           NodeCanvas(797) AccountModals(559) AppShell(330) ...
│   │   ├── nodes/            6 类节点
│   │   ├── admin/            6 个后台模块
│   │   └── _deprecated/      2 个已废弃
│   └── *.css                 style(117K) admin account templates rail
│
├── electron/                 3 文件 / 712 行
│   ├── main.cjs              513 行｜单实例 / 动态端口 / 登录窗 / CSP
│   ├── updater.cjs           165 行｜差异更新 + 版本门控
│   └── preload.cjs            34 行｜12 个暴露键
│
├── scripts/
│   ├── run-tests.mjs          91 行｜一键跑批
│   └── upload-release.mjs    145 行｜发布上传（三级降级）
│
├── public/
│   ├── templates/            11 个 webp（1.4 MB）
│   ├── brand/                logo.png + logo-mark.png
│   └── host-demo.html        嵌入宿主示例
│
└── dist/  outputs/  release/  reference/  shots/     构建与运行产物
```

---

## 附录 B：一分钟判断「我现在该看哪段」

| 你的问题 | 跳到 |
|---|---|
| 怎么起项目 | §2 |
| 接口有哪些 / 怎么调 | §5 |
| 算力怎么算钱 | §9.1 / §9.2 |
| 支付回调怎么接 | §10.3 / §10.4 |
| 更新发布怎么搞 | §11 |
| 怎么贴牌卖给别人 | §12 |
| 加一个新模板 | §13.1 + §4.4 |
| 改颜色主题 | §6.2 |
| 出 bug 了先查什么 | §16 |
| 能不能上线了 | §17 |
| 某个历史文档去哪了 | §19 |

---

*文档生成：2026-09-23 · 基于 ai-canvas v0.2.0 实跑校准*
*所有测试输出为原文粘贴，可自行 `npm test` 复现*
