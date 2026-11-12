# 深拆 B：后端架构（安全 / 账号 / 支付 / 账本 / 血缘 / provider）

> 项目：跨多多 AI 创作台（`E:\DSH项目\ai-canvas`）
> 审计范围：`server/**` 全部源码 + 为判定前后端契约所必需的 `src/api.js`、`src/components/AccountModals.vue`、`electron/main.cjs`、`package.json`
> 审计方式：**只读源码**。未执行 `npm install` / `npm run build` / 任何测试或写盘构建命令（另一名队友正在占用构建链路）。
> 代码总规模：`server/` 非测试源码约 **6,300 行**（`index.js` 1,039 行、`comfyui.js` 439 行、`accounts.js` 435 行、`credits.js` 343 行、`payments.js` 334 行、`security.js` 330 行、`rbac.js` 354 行、`upstream.js` 274 行、`ipadapter.js` 286 行，其余 <300 行）。
> 证据格式：`文件路径:行号`，路径相对 `ai-canvas/` 根。带「未验证」标记的结论表示仅静态阅读得出、无运行态证据。

---

## 0. 一页摘要（给接手决策用）

**整体判断：这是一个「架构设计远好于工程收口」的后端。** 关键机制（五道门、预扣-提交-回滚账本、上游签名幂等、结果缓存、密钥保险箱、ComfyUI 真实图生图）**确实存在且实现思路正确**，注释里写的设计意图基本能在代码里找到对应实现。但存在 **1 个会锁死服务的并发槽泄漏、1 个运营角色可自我提权到超管的越权链、2 个账务正确性缺陷、2 条支付链路实际不可用** —— 这些都不是"打磨不足"，而是**上手后立刻会踩到的硬伤**。

| 维度 | 结论 | 最坏情况 |
|---|---|---|
| 安全五道门 | 五道**全部真实存在**并有默认参数；但第 1/2 道被拒时不留审计，限流是全局单桶 | 内网/嵌入部署下认证边界只剩 Host 头 |
| 账号/会话 | scrypt 加盐哈希（正确）；但**会话主键是全局单机令牌**，多账号实际退化为单会话 | 后登录者静默顶掉先登录者 |
| RBAC | 权限码矩阵、角色种子、部门树、接口级校验齐全；**写接口无行级校验** | 默认「运营」角色可把自己改成超管、可重置超管密码 |
| 算力账本 | 预扣→提交/回滚 + refId 幂等 + 缓存命中零扣费，串行写入有效 | 同一输入「失败两次」后永不退款；流水裁剪破坏余额不变式 |
| 支付 | 微信/支付宝/沙箱三路适配 + 验签 + 金额校验 + 幂等（**单进程内成立**） | 支付宝回调 100% 验签失败；前端调已删除的 `/paid` 接口 |
| provider | 四家云端入参差异处理到协议级（万相新老协议/负向词位置）；ComfyUI 图生图与 IPAdapter 动态签名探测是亮点 | 视频任务取消完全无效，取消后照扣 120 点 |
| 契约完整性 | 大量「注释声称已完成」的功能是**死代码**（无路由/无调用方） | 主动查单兜底、API Key 校验、RefreshToken、任务超时清扫均未接线 |

**风险点合计 23 项**：严重 4 / 高 5 / 中 9 / 低 5（逐项见第 12 节，均含触发条件 + 影响 + 建议）。

---

## 1. 运行形态与数据边界

### 1.1 进程与监听

| 项 | 值 | 证据 |
|---|---|---|
| 端口 | `process.env.PORT \|\| 5181` | `server/index.js:1011` |
| 绑定地址 | `process.env.AI_CANVAS_BIND \|\| "127.0.0.1"`（默认仅本机） | `server/index.js:1013` |
| 桌面端动态端口 | Electron 先探测空闲端口，再用 `PORT` 传给子进程 | `electron/main.cjs:91,107` |
| HTTP 框架 | Express 4.21（`package.json` 依赖 `express: ^4.21.0`） | `package.json:24` 区（dependencies） |
| body 解析 | `express.json({limit:"4mb"})` + 各上传路由 `express.raw`（30mb / 200mb） | `server/index.js:42-51,770,846-849` |
| **未挂载 `express.urlencoded`** | 全仓无 `express.urlencoded` | grep 结果为空（见第 11 节 R5） |

**中间件顺序（`server/index.js:38-96`）**：`securityHeaders`(39) → `guard`(40) → `express.json`(42-51，`verify` 钩子保留 `req.rawBody` 供微信验签) → `GET /api/session`(56) → **登录门** `app.use`(84-96) → 各业务路由（`mountAdmin` 在 131 行挂载）。

`req.rawBody` 的保留是必要设计：注释明确指出「解析后再 `JSON.stringify` 会因空格/键序变化导致验签失败」（`server/index.js:45-49`），实现无误。

### 1.2 数据目录（`paths.js`）

```
HOME = process.env.AI_CANVAS_HOME ? resolve(...) : ~/.ai-canvas      server/paths.js:12-14
dataFile(...) = path.join(HOME, ...)                                  server/paths.js:16-18
```

落盘清单（全部 `0600`，但见 R-lite：Windows 上 POSIX 位基本无效）：

| 文件/目录 | 内容 | 证据 |
|---|---|---|
| `.session-token` | 全局本地会话令牌（64 hex） | `server/security.js:16-35` |
| `.vault-salt` | 保险箱盐（与密文同目录） | `server/vault.js:24,91-100` |
| `secrets/*.enc` | 每密钥一个 AES-256-GCM 文件 | `server/vault.js:23,145-148` |
| `users.json` / `sessions.json` | 账号（scrypt salt+hash）/ 会话表 | `server/accounts.js:7,20` |
| `credits-ledger.json` | 算力流水（余额由流水求和推导） | `server/credits.js:12,73-77` |
| `recharge-orders.json` | 充值订单 | `server/credits.js:13` |
| `gen-cache.json` | 上游签名 → 结果缓存（TTL 12h，上限 500 条） | `server/upstream.js:25,50,53` |
| `batches/<id>.json` | 批量进度（**无 userId 字段**） | `server/batch.js:15,55-72` |
| `audit/<YYYY-MM-DD>.jsonl` | 审计日志，保留 30 天 | `server/audit.js:6-7,102-119` |
| `usage.json` | 每日生成计数（预算熔断用） | `server/security.js:84,280-291` |
| `pay-keys/sandbox-*.pem` | 沙箱支付 RSA 私钥/公钥（**明文 PEM**） | `server/payments.js:69-83` |
| `pay-config.json` | 支付配置（优先环境变量） | `server/payments.js:18-47` |
| `outputs/` `materials/` | 产物与素材（`materials` 默认在 `~/ai-canvas-materials`） | `server/config.js:40-43` |

`outputs/` 与 `materials/` 为**无鉴权静态目录**（`server/index.js:1006-1007`），仅靠 8 位随机文件名（`newId()` = `crypto.randomUUID().slice(0,8)`，32 bit）抗枚举 → 见 R14。

---

## 2. 完整路由表（逐条列全）

统计：**`index.js` 49 条 API 端点 + `admin.js` 17 条 = 66 条**，另有 3 个静态挂载与 1 个副作用中间件。
「门禁」列含义：`Token` = `security.js:guard` 要求 `X-AI-Canvas-Token`/cookie 命中全局令牌；`登录` = `index.js:84` 登录门；`权限码` = `requirePerm`；`本机` = 额外 IP 限制；`验签` = 支付回调验签替代令牌。

### 2.1 会话 / 账号 / 权限（`index.js`）

| # | 方法 | 路径 | 权限/门禁 | 用途 | 证据 |
|---|---|---|---|---|---|
| 1 | GET | `/api/session` | **豁免 Token**（`guard` 特例） | 下发本地会话令牌 + 写 `aic_session` cookie | `server/index.js:56`、`server/security.js:195,212-224` |
| 2 | GET | `/api/auth/perms` | Token + `requireLogin` | 当前用户权限码/角色/数据范围 | `server/index.js:122-128` |
| 3 | GET | `/api/auth/status` | AUTH_PUBLIC（仍需 Token，见下注） | 是否需要初始化 / 是否已登录 | `server/index.js:60-73,331-340` |
| 4 | POST | `/api/auth/setup` | AUTH_PUBLIC（需 Token） | 首次创建管理员（已有账号则 400） | `server/index.js:343-362` |
| 5 | POST | `/api/auth/login` | AUTH_PUBLIC + `rateLimit` | 登录（5 次失败锁定 5 分钟） | `server/index.js:364-383` |
| 6 | POST | `/api/auth/logout` | Token | 删除会话 | `server/index.js:385-391` |
| 7 | POST | `/api/auth/password` | Token | 改密（校验原密码） | `server/index.js:393-407` |

> 注：`AUTH_PUBLIC`（`index.js:60-73`）只作用于 **登录门**（第 84 行那个 `app.use`），**不豁免 `guard` 的令牌校验**。因此 3/4/5 号端点仍必须携带本地令牌；`guard` 只豁免 `/api/session`、`/api/recharge/callback/*`、`/api/brand`、`/api/recharge/pay-status`（`server/security.js:195,201,204`）。

### 2.2 运营后台（`admin.js`，全部 `requireLogin` + `requirePerm(...)` 双层）

| # | 方法 | 路径 | 权限码 | 用途 | 证据 |
|---|---|---|---|---|---|
| 8 | GET | `/api/admin/overview` | `admin:dashboard:view` | 看板（账号/角色/部门/审计统计） | `server/admin.js:51-71` |
| 9 | GET | `/api/admin/accounts` | `admin:account:view` | 账号列表（**唯一应用行级数据权限的接口**） | `server/admin.js:74-104` |
| 10 | POST | `/api/admin/accounts` | `admin:account:create` | 新增账号 | `server/admin.js:106-115` |
| 11 | PUT | `/api/admin/accounts/:id` | `admin:account:edit` | 编辑账号（**可写 `roleIds`**） | `server/admin.js:117-127` |
| 12 | DELETE | `/api/admin/accounts/:id` | `admin:account:delete` | 删除账号 + 撤销会话/令牌 | `server/admin.js:129-141` |
| 13 | POST | `/api/admin/accounts/:id/status` | `admin:account:edit` | 启停账号（停用即踢） | `server/admin.js:143-156` |
| 14 | POST | `/api/admin/accounts/:id/reset` | `admin:account:reset` | **重置任意账号密码** | `server/admin.js:158-169` |
| 15 | POST | `/api/admin/accounts/:id/kick` | `admin:account:kick` | 强制下线 | `server/admin.js:171-181` |
| 16 | GET | `/api/admin/roles` | `admin:role:view` | 角色列表 + 权限码 + 数据范围枚举 | `server/admin.js:184-199` |
| 17 | POST | `/api/admin/roles` | `admin:role:edit` | 新增/编辑角色（权限码白名单过滤） | `server/admin.js:201-210` |
| 18 | DELETE | `/api/admin/roles/:id` | `admin:role:edit` | 删除角色（内置不可删） | `server/admin.js:212-222` |
| 19 | GET | `/api/admin/depts` | `admin:dept:view` | 部门列表 | `server/admin.js:225-238` |
| 20 | POST | `/api/admin/depts` | `admin:dept:edit` | 新增/编辑部门 | `server/admin.js:240-249` |
| 21 | DELETE | `/api/admin/depts/:id` | `admin:dept:edit` | 删除部门（有子部门则拒） | `server/admin.js:251-261` |
| 22 | GET | `/api/admin/logs` | `admin:log:view` | 审计日志查询 | `server/admin.js:264-276` |
| 23 | GET | `/api/admin/apikeys` | `admin:apikey:view` | 客户端密钥列表（只给 hash 外的字段） | `server/admin.js:279-284` |
| 24 | POST | `/api/admin/apikeys/:id/rotate` | `admin:apikey:rotate` | 轮换密钥（明文只返回一次） | `server/admin.js:286-296` |

### 2.3 模板 / 算力 / 充值 / 支付（`index.js`）

| # | 方法 | 路径 | 权限/门禁 | 用途 | 证据 |
|---|---|---|---|---|---|
| 25 | GET | `/api/templates` | 仅登录门 | 模板分类 + 启用列表 + 分组 | `server/index.js:136-142` |
| 26 | GET | `/api/templates/:id/graph` | 仅登录门 | 取模板节点图 | `server/index.js:145-150` |
| 27 | POST | `/api/templates/from-project` | `requireLogin` | 画布存为模板（清洗 graph） | `server/index.js:152-164` |
| 28 | GET | `/api/credits/balance` | `requireLogin` | 余额（**顺带发放新用户赠送**） | `server/index.js:173-178` |
| 29 | GET | `/api/credits/records` | `requireLogin` | 流水（limit ≤ 200） | `server/index.js:180-183` |
| 30 | GET | `/api/credits/costs` | 仅 Token | 计费表 + 赠送额 | `server/index.js:186-188` |
| 31 | GET | `/api/credits/reconcile` | `admin:dashboard:view` | 对账（余额 vs 流水） | `server/index.js:191-193` |
| 32 | GET | `/api/recharge/plans` | 仅 Token | 充值套餐 | `server/index.js:198-200` |
| 33 | GET | `/api/recharge/orders` | `requireLogin` | 本人订单 | `server/index.js:202-204` |
| 34 | POST | `/api/recharge/orders` | `requireLogin` | 创建待支付订单 | `server/index.js:206-218` |
| 35 | POST | `/api/recharge/orders/:id/cancel` | `requireLogin` | 取消订单（已支付不可取消） | `server/index.js:220-226` |
| 36 | GET | `/api/brand` | **豁免 Token**（PUBLIC_READ） | 品牌配置 | `server/index.js:233-235`、`security.js:39` |
| 37 | GET | `/api/recharge/pay-status` | **豁免 Token**（PUBLIC_READ） | 支付通道是否已配置 | `server/index.js:237-239` |
| 38 | POST | `/api/recharge/orders/:id/pay` | `requireLogin` | 发起支付拿二维码（**只创建支付单，不加算力**） | `server/index.js:243-257` |
| 39 | POST | `/api/recharge/callback/wechat` | **验签**（豁免 Token + 登录） | 微信 V3 回调 → 加算力唯一合法入口 | `server/index.js:319`、`server/index.js:268-317` |
| 40 | POST | `/api/recharge/callback/alipay` | **验签** | 支付宝回调 | `server/index.js:320` |
| 41 | POST | `/api/recharge/callback/sandbox` | **验签 + 沙箱模式开关** | 本地演示回调（已配置真实支付则 403） | `server/index.js:322-328` |

### 2.4 审计 / 设置 / 版本 / 生成（`index.js`）

| # | 方法 | 路径 | 权限/门禁 | 用途 | 证据 |
|---|---|---|---|---|---|
| 42 | GET | `/api/audit` | 仅登录门（**无权限码**） | 审计事件查询 | `server/index.js:410-419` |
| 43 | GET | `/api/audit/stats` | 仅登录门 | 审计统计 | `server/index.js:421-423` |
| 44 | GET | `/api/security` | 仅登录门 | 安全层状态（**已剥离 token 字段**）+ vault 状态 | `server/index.js:425-428` |
| 45 | GET | `/api/settings` | 仅登录门（**无权限码**） | 掩码配置 | `server/index.js:431` |
| 46 | PUT | `/api/settings` | 仅登录门（**无权限码**） | 改 provider/limits/密钥（**`admin:setting:edit` 从未被使用**） | `server/index.js:433-457` |
| 47 | GET | `/api/version` | 仅 Token | 版本 + 更新 feed | `server/index.js:492-504` |
| 48 | GET | `/api/comfyui/status` | 仅 Token | ComfyUI 探测（profiles + IPAdapter 能力） | `server/index.js:506-508` |
| 49 | POST | `/api/generate` | 仅 Token + `rateLimit`（**SSE**） | 图片生成主链路 | `server/index.js:529-689` |

### 2.5 任务 / 批量 / 缓存 / 素材 / 视频 / 血缘（`index.js`）

| # | 方法 | 路径 | 权限/门禁 | 用途 | 证据 |
|---|---|---|---|---|---|
| 50 | POST | `/api/tasks/cancel` | `rateLimit` | 真取消（钩子 + abort → 回滚） | `server/index.js:699-712` |
| 51 | GET | `/api/tasks` | `rateLimit`? —— **本机 IP 限制** | 排障：活动任务快照 | `server/index.js:714-720` |
| 52 | POST | `/api/batch` | `rateLimit` | 建批量进度文件 | `server/index.js:725-733` |
| 53 | PUT | `/api/batch/:id` | `rateLimit` | 更新某批结果 | `server/index.js:735-744` |
| 54 | GET | `/api/batch` | 仅 Token | **全量**批量列表（无用户过滤） | `server/index.js:746-748` |
| 55 | GET | `/api/batch/:id` | 仅 Token | 单个批量 + 结果 | `server/index.js:750-754` |
| 56 | DELETE | `/api/batch/:id` | 仅 Token | 删进度文件 | `server/index.js:756-758` |
| 57 | GET | `/api/cache/status` | `admin:dashboard:view` | 生成缓存统计 | `server/index.js:761-763` |
| 58 | DELETE | `/api/cache` | `admin:dashboard:view` | 清空缓存 | `server/index.js:765-767` |
| 59 | POST | `/api/upload` | `rateLimit` + `raw image/*` 30mb | 上传产物图 | `server/index.js:770-776` |
| 60 | GET | `/api/materials` | 仅 Token | 素材列表（**返回绝对路径 root**） | `server/index.js:795-819` |
| 61 | PATCH | `/api/materials/tags` | `rateLimit` | 打标签（颜色/品类/季节/SKU） | `server/index.js:822-829` |
| 62 | DELETE | `/api/materials` | `rateLimit` | 删素材（文件 + 标签） | `server/index.js:832-840` |
| 63 | POST | `/api/materials/upload` | `rateLimit` + MIME 白名单 `raw` 200mb | 上传素材 | `server/index.js:843-865` |
| 64 | POST | `/api/generate-video` | `rateLimit`（**SSE**） | 视频生成（万相单家） | `server/index.js:868-972` |
| 65 | GET | `/api/outputs/meta` | `requireLogin` | 读血缘 sidecar（带 userId 归属校验） | `server/index.js:984-994` |
| 66 | GET | `/api/outputs/lineage` | `requireLogin` | 按 taskId 反查血缘（过滤他人） | `server/index.js:996-1003` |

**非端点中间件**：`app.use("/outputs")` 拦截 `*.meta.json` 直读（`server/index.js:977-982`，`lineage.js:23`）；静态挂载 `/outputs`(1006)、`/materials`(1007)、`dist`(1009)。

**门禁一致性观察（不是漏洞，但要知道）**：
- `guard` 的 Token 校验**先于**登录门，所以「未建账号」时所有 41 个 `requireLogin/requirePerm` 端点仍返回 401（`index.js:84-96` 与 `index.js:99-102` 的语义差异）→ 首次体验时**血缘面板、算力余额、充值、模板反哺全部不可用**（见 R22）。
- `PUBLIC_READ` 集合（`security.js:39`）与 `AUTH_PUBLIC` 集合（`index.js:60-73`）是两套白名单，**必须同步维护**；目前 `AUTH_PUBLIC` 多出 6 条（auth/status、auth/setup、auth/login、3 条回调、pay-status 共 7 条 vs 2 条），语义正确（前者是"免登录"，后者是"免令牌"），但容易改错一边。

---

## 3. 安全层五道门（逐门：实现在哪 / 默认参数 / 绕过风险）

### 门 1：Host 校验（防 DNS rebinding）

- 实现：`server/security.js:183-187`（`guard` 第一关）→ `isLocalHost`(94-99) / `isTrustedHost`(102-110) → `parseHost`(87-92) 正则 `^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$`。
- 允许名单：`LOCAL_NAMES = {127.0.0.1, localhost, ::1, [::1]}`（`security.js:41`）；端口集合 `ALLOWED_PORTS = AI_CANVAS_ALLOWED_PORTS(默认 "5180,5181") + process.env.PORT`（`security.js:47-54`）。
- 动态端口已正确纳入（`electron/main.cjs:107` 注入 `PORT`），注释里记录的"服务把自己拦掉导致白窗"历史坑已修复（`security.js:44-46`）。
- 嵌入模式：`AI_CANVAS_EMBED_HOSTS` 或从 `AI_CANVAS_EMBED_ORIGINS` 推导 host（`security.js:60-80`），`isTrustedHost` 兼容带不带端口两种写法（`security.js:106-109`）。
- 拒绝响应：`403 {code:"BAD_HOST"}`（`security.js:161-163,186`）。
- **绕过/风险**：① 仅本机监听时该门有效；一旦按注释设 `AI_CANVAS_BIND=0.0.0.0` **且**配置了 `EMBED_HOSTS`，Host 门即放行远端，此时 `/api/session` 是免令牌的，**任何能连上的人都能拿到有效令牌**（见 R-嵌入）。② `parseHost` 对 `Host: 127.0.0.1:5181@evil.com` 之类畸形输入返回 null，走向拒绝，安全方向正确。③ 被拒**不留审计**（`security.js` 未 import `audit`）。

### 门 2：Origin 校验（防跨站调用）

- 实现：`server/security.js:188-192` → `isAllowedOrigin`(112-120)：`origin === "null"` 直接拒（113 行，防 sandbox iframe/`file://`），命中 `EMBED_ORIGINS` 白名单，或 `isLocalHost(new URL(origin).host)`。
- **关键语义**：`if (origin && !isAllowedOrigin(origin))`（189-190 行）—— **没有 Origin 头就直接放行**。这是有意的（curl / 本机进程 / 同源表单），但也意味着「门 2 只对浏览器跨站生效」。
- **绕过风险**：`isLocalHost` 认的是「本机名 + 允许端口」，因此**任何占用 5180 或 5181 的本机进程，其页面都被视为可信来源**。实际可利用性低（改状态的接口还需 `X-AI-Canvas-Token` 头，而读 `api/session` 的响应受 CORS 限制——服务端从不设置任何 `Access-Control-Allow-*` 头，见 `securityHeaders` `security.js:165-181`），但属于"白名单过宽"的残留面：建议把 Origin 白名单与 Host 白名单解耦，不再复用 `isLocalHost`。

### 门 3：令牌与会话

- **本地令牌**：`dataFile(".session-token")`，首次运行 `crypto.randomBytes(32).toString("hex")`，权限 `0600`，**持久化**以支持桌面端重启后保持登录（`security.js:12-35`）。
- 读取：header `x-ai-canvas-token` 或 cookie `aic_session`，均走 `crypto.timingSafeEqual` 且长度不等/空串直接 false（`security.js:133-138,140-145,148-154`）——**常量时间比较，写法正确**。
- 下发：`GET /api/session`（`security.js:212-224`）返回 `{token}` 并写 httpOnly cookie；嵌入模式 + HTTPS 时 `sameSite:"none"; secure:true`，否则 `strict`（215-221）——判断合理。
- **账号会话**：`accounts.sessions`，主键 = 本地令牌（`accounts.js:277-287`）。TTL 12h，落盘 `sessions.json`（`accounts.js:9,20-45`）。
- **绕过风险（重要）**：令牌对**任何本机进程**都是可获取的（直接 `GET /api/session`，只需伪造 Host 头）。这是设计的接受边界（注释只说防跨站），但必须写进交接说明：**本机令牌不是"用户身份"，只是"防跨站"层**。真正的身份边界是账号会话 + RBAC，而后者在第 6/11 节有越权缺陷。

### 门 4：令牌桶限流 + 并发上限

- **限流**：`rateLimit(req,res,next)`（`security.js:243-249`）→ `takeToken("global", perMinute, perMinute/60)`（229-241）。**桶 key 恒为字符串 `"global"`**，即全站单一令牌桶；`perMinute` 默认 30（`security.js:270`，来自 `config.js:44` 的 `limits.perMinute`）。
- 挂载点（9 处）：`auth/login`(364)、`generate`(529)、`tasks/cancel`(699)、`batch` POST/PUT(725,735)、`upload`(770)、`materials/tags` PATCH(822)、`materials` DELETE(832)、`materials/upload`(843)、`generate-video`(868)。**未挂载**：`recharge/orders`(206)、`templates/from-project`(152)、`settings` PUT(433)、`audit`(410)。
- 并发闸门：`inFlight` 计数 + `acquireSlot/releaseSlot`（`security.js:252-263`），`maxConcurrent` 默认 2（`security.js:271`、`config.js:44`）。
- **风险**：① 全局单桶 → 单个客户端可把全站打到 429（R17）；② 登录与生成共用一个桶 → 一次批量生成就能挤掉登录重试；③ 并发槽**存在泄漏路径**（第 11 节 R1，严重）。

### 门 5：每日预算熔断

- 实现：`readUsage/writeUsage/budgetRemaining/budgetExceeded/bumpUsage`（`security.js:280-309`），数据在 `usage.json`，按本地日期分桶（`today()` 275-278），跨天自动归零（`readUsage` 283 行比对 `raw.date === today()`）。
- 阈值：`dailyGenerations = AI_CANVAS_DAILY_LIMIT || config.limits.dailyGenerations || 200`（`security.js:269`）。
- 拦截点：`/api/generate`(540) 与 `/api/generate-video`(875)，返回 SSE `error` 事件；计数只在**成功后** `bumpUsage`（`index.js:648,941`）。
- **风险**：① `readUsage`+`writeUsage` 是非原子 read-modify-write，并发成功时可能丢计数（R21 低）；② 缓存命中路径**不** `bumpUsage`（`index.js:556-578`），是有意设计（零成本），但也意味着"疯狂重放同一输入"不受每日预算约束——由限流兜底。

### 五道门总评

`securityStatus()`（`security.js:311-330`）如实反馈五道门状态与剩余额度，`/api/security` 在 `index.js:426` 用解构 **剥离了 `token` 字段**后才返回——这个细节做对了。整体门禁设计是"纵深防御 + 严格默认（只绑本机）"，前提是**别开 `AI_CANVAS_BIND=0.0.0.0`**。

---

## 4. 账号 / 会话

| 项 | 实现 | 证据 |
|---|---|---|
| 密码哈希 | `crypto.scryptSync(password, salt, 64)`，salt = 16 字节 hex 随机 | `server/accounts.js:69-72` |
| 校验 | 重新派生 + `timingSafeEqual`，长度不等先返 false | `server/accounts.js:74-80` |
| 口令策略 | 用户名 ≥2 字符、密码 ≥6 位、邮箱/手机号正则 | `server/accounts.js:141-144,181-184` |
| 登录失败锁定 | `MAX_FAIL=5`、`LOCK_MS=5min`，按用户名小写键；达阈值后 `fail` 归零并写 `lockedUntil` | `server/accounts.js:10-11,252-268` |
| 停用账号 | 即使密码正确也拒（`code:"DISABLED"`），且 `currentUser` 命中停用即删会话 | `server/accounts.js:273-275,350-353` |
| 会话落盘 | `sessions.json`，启动 `loadSessions()` 只恢复未过期项 | `server/accounts.js:22-48` |
| 首位账号 | `defaultRoleIds(users.length===0)` → `r-super`，其余 `r-operator` | `server/accounts.js:124-127,160` |
| 迁移 | `migrateUsers()`：老账号补 `roleIds/status/dataScope/nickname`，`role==="admin"` 视为超管，并兜底保证至少一名超管 | `server/accounts.js:395-418`（启动时调用 `index.js:1036`） |
| 改密 | 校验原密码后重新加盐 | `server/accounts.js:371-388` |
| 管理员重置 | `adminResetPassword`：**无超管保护、无数据范围校验** | `server/accounts.js:235-245` |

### 4.1 `admin / admin888` 首次初始化到底在哪？

**代码里没有硬编码的默认管理员。** 全仓 `admin888` 只出现在文档与测试：

- `使用说明.md:29` 写明"密码 `admin888`"；
- 测试用 `admin888` 走 `/api/auth/setup` 建号：`server/__sync-http.test.mjs:36-38`、`server/__payments.test.mjs:49-55`、`server/__p18-http.test.mjs:41-42`。

即：**首次管理员由用户在首屏引导里自行设置**（`index.js:343-362` → `accounts.createUser`，首位自动 `r-super`）。`admin888` 是**约定俗成的测试/演示口令**，不是代码兜底。风险提示：文档与测试共同固化了这个弱口令，生产交付前必须改掉（`使用说明.md:29`）。

### 4.2 会话主键设计缺陷（R12）

```js
// accounts.js:277-287
const token = localToken || crypto.randomBytes(32).toString("hex");
sessions.set(token, { userId: user.id, ... });
```

`localToken` 来自 `readLocalToken(req)`，返回的**永远是同一个全局常量 `SESSION_TOKEN`**（`security.js:148-154`）。后果：

1. `sessions` Map 实际只有 1 个有效键 → **同一台机器上多账号无法并存**：B 登录会覆盖 A 的会话，A 的请求随后被识别成 B（`currentUser` 按 token 查 userId，`accounts.js:345-355`）。
2. `POST /api/auth/logout` 删的是这个共享键 → **一个人登出，所有人被登出**（`index.js:385-391`）。
3. `sessionCount()` 恒 ≤1（`accounts.js:433-435`），`/api/auth/status` 的 `sessionCount` 与实际在线数不等价。
4. `token = random` 分支**不可用**：若客户端不带令牌登录，拿到的随机 token 无法通过 `guard` 的 `hasValidToken`（只比对 `SESSION_TOKEN`），后续请求 401 `SESSION_REQUIRED`（`security.js:206-209`）。

结论：**"账号体系"目前是"单机会话 + 用户身份映射"，不是真正的多用户在线体系。** 若目标是多人 SaaS，这里必须重做（会话键改为独立随机 token，并把 `guard` 的令牌校验与账号会话校验分成两层）。

---

## 5. RBAC

### 5.1 权限码清单（15 个，`rbac.js:13-29`）

`admin:dashboard:view`、`admin:account:view|create|edit|delete|reset|kick`、`admin:role:view|edit`、`admin:dept:view|edit`、`admin:log:view`、`admin:apikey:view|rotate`、`admin:setting:edit`。

**`admin:setting:edit` 定义了但全仓无任何使用点**（grep 仅命中定义行 `rbac.js:28`）→ `GET/PUT /api/settings` 实际只要登录即可（R15）。

### 5.2 角色映射（内置 4 个，`rbac.js:42-84`）

| 角色 | id | 权限 |
|---|---|---|
| 超级管理员 | `r-super` | `ALL_CODES`（且 `hasPermission` 直通，`rbac.js:192`） |
| 运营 | `r-operator` | dashboard:view、account:view/create/edit/reset、role:view、dept:view、log:view ← **含 `admin:account:edit` 与 `admin:account:reset`** |
| 设计师 | `r-designer` | 仅 dashboard:view |
| 审核员 | `r-auditor` | dashboard:view、account:view、log:view |

- 权限计算：`permissionsOf(roleIds)` 按角色并集（`rbac.js:174-182`）；`hasPermission` 先判 `r-super` 直通（189-194）——"避免角色数据异常把管理员锁死"的兜底是有意的。
- `upsertRole` 用 `clean = perms.filter(p => ALL_CODES.includes(p))` 过滤野权限码（`rbac.js:129`），内置角色不允许改 `code`（134-136），内置角色不可删（165）。
- 部门树：`deptSubtree(deptId)` 递归收集子部门（`rbac.js:213-223`），种子 5 个部门（`rbac.js:86-92`）。

### 5.3 行级数据权限

- 唯一实现：`applyDataScope(rows, user)`（`admin.js:19-35`）——`all` 全量、`self` 仅本人、`dept` 本部门子树、`custom` 指定部门集合；超管直通。
- **只作用于一个读接口**：`GET /api/admin/accounts`（`admin.js:83`）。
- **写接口完全没有 scope 校验**：`PUT/DELETE/status/reset/kick`（`admin.js:117-181`）只查权限码，不查目标是否在操作者的数据范围内 → R2/R13。

### 5.4 客户端密钥与 RefreshToken（两套都是死代码）

- `listApiKeys()` 种子一条 `k-desktop`，`hash = sha256("ak_desktop_default")`（`rbac.js:258-278`）——**明文默认密钥写死在源码注释里**；`verifyApiKey()`（293-302）**全仓无调用方** → 密钥体系目前不起作用（R21）。
- `issueRefreshToken()`（`rbac.js:309-326`）**无调用方**；但 `revokeUserTokens`/`activeTokenCount`/`pruneTokens` 被 `admin.js:136,151,165,177`、`admin.js:63,100`、`index.js:1035` 使用 → 结果：**后台"在线"列恒为 0**，强制下线只能靠 `killSessions`。

---

## 6. 算力账本 `credits.js`

### 6.1 数据模型

- **只记流水，余额 = 流水求和**（`credits.js:3-7,73-77`）；条目字段 `{id,userId,type,amount,balanceAfter,reason,refId,ts}`（100-111）。
- `type` ∈ `grant | recharge | consume | reserve | refund | rollback`（注释 104 行；实际写入用到 grant/recharge/reserve/consume/rollback）。
- 计费表（`credits.js:17-23`）：图片 10、图片编辑 6、高清 4、视频 120、详情页 60；新用户赠送 500（26）；4 档套餐（29-34）。
- 单用户流水超 2000 条裁旧（91-98）→ **破坏余额不变式**（R4）。

### 6.2 串行化

```js
let chain = Promise.resolve();
function serial(fn) { const next = chain.then(fn, fn); chain = next.catch(()=>{}); return next; }
```
（`credits.js:63-70`）

`grant/reserve/rollback/commit/ensureSignupGrant` 全部走 `serial` → **单进程内写操作严格串行，`__credits.test.mjs:56-64` 的"并发 20 次只成功 10 次"验证成立**。
但 **读操作 `balance()`(73-77)、`records()`(79-84)、`findConsumed()`(213-217) 不入队**，会读到写队列未落的中间态 → R11。

### 6.3 预扣 → 提交 / 回滚（含 `index.js` 调用点）

| 阶段 | 函数 | 逻辑 | 证据 |
|---|---|---|---|
| 幂等键 | `upstreamSignature(...)` | 只签名影响输出的字段，`remark` 等排除；形如 `usig_v2_<32hex>` | `server/upstream.js:120-147` |
| 缓存命中 | `cacheGet(sig, userId)` | 命中则 `cost:0` 直接返回、**不扣费** | `index.js:556-578` |
| 已消费重跑 | `findConsumed(userId, refId)` | 有 `consume` 记录 → `replay=true`，**不预扣** | `index.js:581,585-587` |
| 预扣 | `reserve(userId, action, refId)` | `cost<=0` 直接 ok；余额 < cost → `{ok:false,code:"INSUFFICIENT_CREDITS"}`；否则写 `reserve(amount=-cost)` | `credits.js:129-151` |
| 提交 | `commit(userId, action, refId)` | 找到最后一条同 refId 的 `reserve`，追加 `consume(amount=0)`（金额已在预扣时扣掉，此处只标语义） | `credits.js:188-206` |
| 回滚 | `rollback(userId, refId)` | 若已存在同 refId 的 `rollback` → 跳过；否则找 `reserve` 并按 `Math.abs(rs.amount)` 退回 | `credits.js:157-185` |
| 调用点 | `index.js:587`（预扣）、`647`（提交）、`676`（回滚）；视频 `914/940/962` | — | — |

**缓存命中不重复扣费的判定条件（4 条全部满足才命中）**：
1. 签名属于当前版本 `usig_v2_`（`upstream.js:155-157,192`）；
2. `entry.userId === userId`（严格字符串比较，197）；
3. TTL 未过期：`AI_CANVAS_CACHE_TTL`，默认 12h（`upstream.js:50,177`）；
4. 所有本地产物文件仍存在（`stillValid` 逐条 `fs.existsSync`，175-184）；远程直链不校验（180）。
不命中时若 `findConsumed` 有记录，则走"重跑但不预扣"（`index.js:581-587,599`）——**这是"缓存被清但钱已付过"的补偿路径，设计正确**。

### 6.4 账务正确性缺陷

- **R3（严重）同一输入"失败两次"后永不退款**：`rollback` 的幂等键是 `refId`（`credits.js:163-164`）。时序：`reserve(X)` → 失败 `rollback(X)` → 再 `reserve(X)`（因为此时**没有** `consume`，`findConsumed` 返回 null，`index.js:581` 判定非 replay）→ 再失败 → `rollback(X)` 发现 `already=true` 直接 `{skipped:true}`，**`refunded` 为 undefined**，前端收到 `refunded:0`（`index.js:676-683`）。结果：第二次预扣的 10 点永久蒸发。触发条件极常见：**上游故障后用户点"重新生成"**。
- **R4（严重）流水裁剪破坏余额**：`append` 保留最后 2000 条（`credits.js:95-97`），而 `balance()` = 剩余流水求和（73-77）→ 第 2001 笔起余额会**少算被裁掉的净额**；`reconcile()`（332-342）随之报不一致。
- **R11（中）同 refId 并发双扣**：`findConsumed` 在 `reserve` 之前且不入队（`index.js:581→587`），两个同输入并发请求都会预扣并各自产出（`commit` 追加两条 `consume`）；并发下还会互相"偷"回滚目标（`rollback` 取"最后一条同 refId 的 reserve"，`credits.js:167-169`）。

### 6.5 充值订单与到账

- `createOrder` 只写 pending 订单（`credits.js:241-261`）；`findOrder` 不限用户（263-266，回调无用户上下文，正确）；`cancelOrder` 校验归属且已支付不可取消（300-308）。
- `markPaid(orderId, payMethod)`：`status==="paid"` 直接 `{already:true}`；否则改状态 → `await grant(userId, credits+bonus, ..., order.id)`（`credits.js:279-298`）。
  - **幂等性在单进程内成立**：读订单 → 判状态 → 写状态 → `grant` 之间**没有 `await`**（280-288 全同步），Node 单线程不会交错；`grant` 才入 `serial` 队列。所以"重复回调不重复发放"（`__payments.test.mjs:139-151`）可复现。
  - **多进程/多实例部署下失效**：文件无锁，两个进程会同时看到 pending → 双倍发放。当前架构是单进程（Electron 内嵌 / 单 `node server/index.js`），可接受；一旦上 PM2 cluster 必须加文件锁或改用 DB。
- `ensureSignupGrant` 在 `GET /api/credits/balance` 里惰性发放（`index.js:176`、`credits.js:311-329`），以 `reason==="新用户赠送"` 去重，走 `serial`，**安全**。
- 匿名态 `userIdOf(req)` 返回 `"local"`（`index.js:169-171,544`）→ 未建账号时所有人共享 `local` 账本（含 500 赠送）。

---

## 7. 支付 `payments.js`

### 7.1 三路适配

| 网关 | 下单 | 回调验签 | 证据 |
|---|---|---|---|
| 微信 Native V3 | `POST /v3/pay/transactions/native`，`amount.total` 单位分，`Authorization: WECHATPAY2-SHA256-RSA2048 ...`（RSA-SHA256 签名串 = `method\nurl\ntimestamp\nnonce\nbody\n`） | 头 `wechatpay-timestamp/nonce/signature`，验签串 `timestamp\nnonce\nrawBody\n`，再用 `aes-256-gcm(apiV3Key, nonce)` 解 `resource`（authTag 取密文末 16 字节、`setAAD(associated_data)`） | `payments.js:88-167`（签名 93-103、验签 110-128、解密 131-140、下单 142-166） |
| 支付宝当面付 | `alipay.trade.precreate`，参数 `key` 升序拼接后 RSA2 签名 | `verifyCallback(params)`：剔除 `sign/sign_type` 后按同规则拼串 + `RSA-SHA256` 验签 | `payments.js:172-231`（拼串 177-183、验签 190-199、下单 201-230） |
| 沙箱 | 生成 `sandbox://pay?...` 假二维码，并用本地 RSA 私钥对 `{out_trade_no,total}` 签名 | 头 `x-sandbox-payload` + `x-sandbox-signature`，用本地公钥验签 | `payments.js:236-265`（密钥 69-83、下单 240-252、验签 254-264） |

网关选择：`activeGateway()` 显式 `PAY_PROVIDER` 优先，否则按"配了哪个用哪个"自动探测，都没有才沙箱（`payments.js:273-282`）；`payStatus()` 的 `ready` 判定见 51-54。

### 7.2 回调链路（`index.js:268-328`）

```
verifyCallback(gateway, rawBody, headers, params)
  → !ok → 记审计 recharge.callback.rejected → 400 {code:"FAIL"}（网关会重试）
  → findOrder(v.outTradeNo)（不限用户）→ 404 无订单
  → 金额校验 Math.round(order.price*100) === v.amount → 不一致记审计 + 400
  → tradeState 非成功态 → 200 接收但忽略
  → credits.markPaid(order.id, gateway) → 审计 recharge.order.paid
  → 微信回 {code:"SUCCESS",balance}；支付宝回 text "success"
```

### 7.3 防重放

- 微信：时间戳偏移 > **300 秒** 直接拒（`payments.js:117-121`）。
- 支付宝：**无**时间戳/重放校验（`payments.js:190-199`）——靠 `markPaid` 幂等兜底。
- 微信：**未校验 `Wechatpay-Serial`** 与平台证书序列号的对应关系（只用配置的公钥验签，110-127）→ 实践中可接受（单证书场景），但多证书轮换期会失效。

### 7.4 支付层的 6 个问题

1. **R5（高）支付宝回调必然失败**：回调是 `application/x-www-form-urlencoded`，而服务端**只挂了 `express.json`**（`index.js:42-51`，无 `express.urlencoded`）。body-parser 在类型不匹配时会先把 `req.body` 置为 `{}`，于是 `params={}` → `!sign` → `"缺少 sign"` → 400（`index.js:274`→`payments.js:191-192`）。**且此时 `ready.alipay` 为 true → `sandbox` 关闭**（`payments.js:53-55`）→ 沙箱回调被 403（`index.js:324-326`）→ **配了支付宝就再也无法完成任何一笔到账**。
2. **R6（高）微信 `ready` 判定漏了验签公钥**：`ready.wechat = mchId && privateKey && apiV3Key`（`payments.js:52`），而验签必须 `platformPublicKey`（`payments.js:298,110-127`）。配了前三项但没填公钥时：`payStatus().sandbox=false`（沙箱关闭）＋ `createVerify(...).verify("")` 抛异常 → `handleCallback` catch → **500 FAIL**，用户付了钱到不了账，且只能改配置恢复。
3. **R7/R8（高）沙箱回调是默认部署下的实际"加算力入口"**：沙箱模式 = 未配任何真实凭证 = **默认单机部署形态**；`/api/recharge/callback/sandbox` 同时豁免 **登录门**（`index.js:68`）与 **本地令牌门**（`security.js:201`），安全性完全依赖一把**明文躺在 `~/.ai-canvas/pay-keys/sandbox-private.pem` 的私钥**（`payments.js:69-83`）。测试 `__payments.test.mjs:93-110` 正是"读该私钥 → 伪造合法回调 → 到账 1000"的完整演示。**本机任意进程/任意用户会话都能白嫖算力**。
4. **注释声称的"主动查单兜底"不存在**：文件头第 8 行写「主动查单兜底：回调丢了也能靠轮询补上」，但 `payments.js` 全文**没有任何查单/轮询实现**（无 `queryOrder`、无 `trade/query` 调用），路由层也没有订单状态查询端点（`GET /api/recharge/orders` 只读本地文件）。→ 回调丢失 = 订单永远 pending。
5. **R9（高）前后端契约断裂**：前端 `payOrder()` 打的是 `/api/recharge/orders/:id/paid`（`src/api.js:407-411`，由 `AccountModals.vue:102` 的"模拟支付成功"按钮调用），而服务端**只有** `/pay`（`index.js:243`）；测试还专门断言旧 `/paid` 已移除返回 404（`__payments.test.mjs:153-155`）。→ UI 充值链路 100% 失败（`adminReq` 对 404 HTML 解析失败 → 抛"操作失败"，`src/api.js:328-334`）。且 `sandboxNotifyHeaders()`（`payments.js:329-334`）**无调用方** → 沙箱回调没有任何"按钮"能触发。
6. **R20（低）金额校验可被"缺字段"绕过**：`if (v.amount && v.amount !== expectCents)`（`index.js:290`）——`amount` 为 0/undefined/NaN 时整条校验被跳过（沙箱解析失败会得到 `NaN`，`payments.js:322`）。建议改成 `Number.isFinite(v.amount) && v.amount !== expectCents` 即拒。

---

## 8. provider 层

### 8.1 四家云端「图生图」入参构造差异（这一层做得相当扎实）

| provider | 有参考图时的端点/协议 | 关键差异 | 证据 |
|---|---|---|---|
| 通义万相 | **换端点**：文生图 `text2image/image-synthesis`（异步 task + 轮询，`X-DashScope-Async: enable`）→ 图生图 `multimodal-generation/generation`（同步，`input.messages[0].content=[{text},{image:dataUri}...]`）；模型从 `wanx2.1-t2i-turbo` 自动切到 `i2iModel`（默认 `wan2.6-image`） | **负向词位置两代不同**：`wan2.6+` 在 `parameters.negative_prompt`，旧版在 `input.negative_prompt`（`useNewProtocol = /^wan2\.[6-9]/`）；尺寸用 `*` 分隔；最多 6 张参考图 | `providers/wanxiang.js:24-26,28-64,96-137,139-184` |
| 即梦/Seedream（火山方舟） | 同端点 `/images/generations`，靠 `image` 字段（**URL 或 data URI**）；单图传字符串、多图传数组（≤14 张，这里取 6） | 尺寸映射 `toArkSize`：方脸 → `2K/1024x1024`，横 → `1280x720/4K`，竖 → `720x1280`；因 n 参数部分模型不支持 → **逐张并发 fetch** | `providers/jiemeng.js:7-12,28-36,40-62` |
| OpenAI 兼容 | **必须换端点**：`/images/generations`(JSON) → `/images/edits`(`multipart/form-data`，`image` 字段可重复)，用 `new Blob([buf],{type:mime})` + filename，**不手动设 Content-Type**（boundary 由运行时生成） | 独有 `input_fidelity`（strength ≥0.7 → high，否则 low）；有参考图时 max 8 张 | `providers/openai.js:32-55` |
| Gemini（Nano Banana） | 同端点 `:generateContent`，参考图作为 `inline_data{mime_type,data:<裸base64>}` 与文本 part 并列（**不是 data URI**） | 尺寸反推 `aspectRatio` 枚举（8 档最接近匹配）；`responseModalities:["IMAGE"]` + `imageConfig.aspectRatio`；n 张逐张串行请求 | `providers/gemini.js:4-30,47,54-56,59-91` |

共用预处理：`loadReferences()`（`providers/refimage.js:73-133`）统一处理 data URI / http(s) 下载 / 本地 `outputs|materials` 读盘，统一 8MB 上限（18）与 MIME 推断（20-35），并通过 `withProductIntent()` 把「印花位置 + 保留针织纹理 + 保持版型」拼进提示词（136-167）——与 ComfyUI 的硬参数形成互补，思路正确。

### 8.2 ComfyUI 工作流注入（`comfyui.js`）

- **模型档案自动探测**：从 `/object_info` 读 `UNETLoader/VAELoader/CLIPLoader/CheckpointLoaderSimple/LoraLoaderModelOnly`，产出 4 套 profile（Z-Image Turbo / Flux 2 Klein / Qwen-Image 2.5.12(+Lightning LoRA) / 传统 checkpoint），每套带已验证的 `steps/cfg/sampler/scheduler`（`comfyui.js:31-103`）。
- **真实图生图**：`LoadImage`(40) →（可选 `ImageScale`(41)，依赖 `object_info.ImageScale` 存在）→ `VAEEncode`(42) → `KSampler(denoise=强度)`（`comfyui.js:142-268`）。
- **序号规划**：底图占 40/41/42，额外参考图从 43 起自增（157-170），恰好避开 40/41/42，注释明确说明"别随手改"。
- **重绘强度**：`strength>0` 用之，否则 0.75；`keepTexture===false` +0.15、`printArea==="full"` +0.1（`comfyui.js:367-369`）。
- **参考图上传**：本地读盘 → `POST /upload/image`（multipart，文件名 `[^A-Za-z0-9._-]` 清洗）→ 拿 ComfyUI input 目录文件名（106-140）；单张失败只跳过（134-137）。
- **轮询**：`/history/{prompt_id}` 每 1.5s，`sleep(1500, signal)` 可被取消打断，10 分钟超时（411-436）。

### 8.3 IPAdapter 多图融合（`ipadapter.js`）—— 本层最亮的模块

- **绝不硬编码节点签名**：`detectIPAdapter` 从 `/object_info` 读真实 `input.required`，按 `canChain = required 同时含 model 与 image` 过滤（`ipadapter.js:91-95`）；SD 生态用 `IPAdapter/IPAdapterSimple/IPAdapterApplyV2/IPAdapterApply`（69），DiT 用 `ApplyFluxIPAdapter/IPAdapterApplyFlux/IPAdapterApplyProtected`（72），后者只在检测到 DiT 专用节点或本架构 preset 时才启用，否则诚实降级（101-113）。
- **端口索引按输出类型名查**：`outIndex(objectInfo, cls, "MODEL")`（47-52），避免 UnifiedLoader 的 `MODEL/IPADAPTER/CLIP_VISION` 三口写死下标。
- **链式串联**：model → IPAdapter(图1) → IPAdapter(图2) → …，权重递减 `weightsFor(count, 0.85, 0.8, min 0.3)`（170-174,248-266）；权重别名兼容 `weight/strength/amount`（258）。
- **只在 ≥2 张时启用**（`comfyui.js:176-190,356`），单张走底图通路 —— 避免重复同图。
- 降级文案是"说明"而非"报错"（`ipadapter.js:272-277`）—— 用户体验设计到位。

### 8.4 取消（`/interrupt`）链路

- 任务登记：仅当请求带 `taskId` 时 `tasks.register(taskId, {...})`（`index.js:594-596`），把 `task.controller.signal` 传给 provider（615），并给 provider `registerCancel` 钩子（617）。
- ComfyUI 钩子：`registerCancel(async () => fetch(baseUrl + "/interrupt", {method:"POST"}))`（`comfyui.js:314-322`）。
- 取消顺序：**先跑钩子停上游，再 `controller.abort()`**（`tasks.js:99-112`）——注释解释了这个顺序的必要性，实现一致。
- 回滚：`abort` 让 provider 抛 `AbortError`（或各家显式 `if (signal?.aborted) throw new Error("已取消")`：万相 70、Gemini 60、ComfyUI 398/415）→ `generate` catch → `reserved.reserved` 为真才 `rollback`（`index.js:670-683`）；文案区分 `canceled` 与失败（673,679）。
- **缺口（R10，高）**：`/api/generate-video` **完全没有接入这条链路** —— 没有 `tasks.register`、没有 `signal`、`wanxiang.generateVideo`/`pollVideoTask` 也不接受 signal（`index.js:868-972`；`wanxiang.js:224-244,246-273`，轮询是裸 `setTimeout(4000)`）。用户取消 = SSE 断开，服务端继续轮询到完成并 `commit` 120 点（`index.js:940`），结果丢失。这与代码注释宣称的"取消会退回预扣"（`index.js:691-698`）**只对图片成立**。

### 8.5 provider 层其他风险

- **R7（高）SSRF**：`loadReferences` 对 `http(s)` URL 直接 `await fetch(url)`，**无域名/IP 白名单、无超时、无响应体上限**（`refimage.js:93-105`），8MB 检查在**下载完成后**才做（120）。触发方只需能调 `/api/generate`（未建账号时免登录）。
- **R19（低）视频首帧路径穿越读取**：`path.join(process.cwd(), firstFrame.url.replace(/^\//,""))`（`wanxiang.js:256-267`）——`url` 由前端提供，`../../..` 可直接越出工作目录，读到的文件被 base64 内联进请求体。与 `refimage.resolveLocalFile`（41-61）和 `lineage.metaPathFor`（33-43）的严格校验形成鲜明反差。
- **R18（中）base64 图片撑爆缓存与响应**：OpenAI（`openai.js:84-89`）与 Gemini（`gemini.js:89`）返回 `data:image/...;base64,...`；`index.js:641` 把它塞进 `saved[].remoteUrl`，再经 `cachePut`（`index.js:650-652`）写入 `gen-cache.json` 的 `remoteUrl` 字段（`upstream.js:216-224`）→ **单条缓存可达数 MB × 500 条**；缓存命中时该 data URI 还会原样塞进 SSE 的 `done` 事件（`index.js:568-575`）。
- 万相 `size` 处理不对称：t2i 路径 `size.replace("x","*")`（`index.js:178` 传参 → `wanxiang.js:178`），i2i 路径 `String(size).replace("x","*")`（113）——一致性可接受，但**未做尺寸合法性校验**（R23 低）。

---

## 9. 上游签名 `upstream.js` 与缓存隔离

### 9.1 签名规则（P1-8）

- 版本：`SIG_VERSION = "v2"`，输出 `usig_v2_<sha256 前 32 hex>`（`upstream.js:29,145-146`）。
- 参与字段（**顺序固定**，`SIGNED_FIELDS` 32-47）：`kind, provider, model, prompt, negativePrompt, size, n, steps, cfg, seed, referenceImages, firstFrame, resolution, duration`；`remark/title/nodeId/projectId` **一律排除** —— 对应"改备注重跑不该重复扣费"的需求（`upstream.js:5-10`）。
- 规范化 `norm()`：数字保留 3 位小数、布尔转 `true/false`、字符串 trim（55-60）。
- **素材签名（亮点）**：本地 `/outputs|/materials` 路径 → **取文件内容 sha256 前 32 位，不带文件名**（"同一张图重新上传不应算成两个任务"，`upstream.js:76-97`）；远程直链用 URL 本身；文件缺失退化为 `<url>@missing`（95）。参考图列表**顺序不敏感**（`parts.sort().join("|")`，112）。
- 空任务保护：除 `kind` 与参考图外全空 → 返回 `""` → 调用方 `refId = newId()` 随机（`upstream.js:138-142`；`index.js:554`）——"绝不共享同一个 refId"，逻辑正确。
- 版本切换：`isCurrent(sig)` 只认当前版本前缀，`sweep()` 启动时清掉旧版本与失效条目（155-157,241-253）——签名规则变更不会与新条目撞车。

### 9.2 缓存隔离键设计（**与注释不符**）

- 注释宣称"缓存按 userId 隔离"（`upstream.js:16-17,189`），但实现是**单一 Map，键只有 sig**：`c.entries[sig] = {..., userId}`（`upstream.js:216`）；`cacheGet` 用 `entry.userId !== userId → null`（197）。
- 后果：**A、B 同参数时，B 的生成会覆盖 A 的缓存条目**（`cachePut` 直接赋值）。安全性没问题（A 再查会被 userId 比较拦住，`__p18-http.test.mjs:155-169` 验证了这一点），但 A 缓存被静默失效，A 重跑只能走 `findConsumed` 的"replay 不扣费"路径（`index.js:581`）——**能省钱的路径被削弱，且只省一次**（replay 后 `commit` 找不到新 reserve 就 `skipped`，`credits.js:193`；下次仍会 replay）。
- 建议：键改为 `${userId}::${sig}`，或条目改成 `entries[sig][userId]`。
- 其他：`MAX_ENTRIES=500` 按 `ts` 淘汰最旧（227-232）；`cacheClear` 无二次确认（271-273）但受 `admin:dashboard:view` 保护。

---

## 10. 密钥存储 `vault.js`

| 项 | 实现 | 证据 |
|---|---|---|
| 后端选择 | 启动时探测 `@napi-rs/keyring`：`new Entry("ai-canvas-probe","probe").getPassword()` 不抛错 → `keyring`，否则 `file` | `server/vault.js:37-47` |
| 强制文件后端 | `AI_CANVAS_VAULT=file`（测试/排障用） | `server/vault.js:32-38` |
| 系统凭据管理器 | `SERVICE="ai-canvas"`，条目名如 `provider.wanxiang.apiKey` | `server/vault.js:22,184-209` |
| 本地加密文件 | **一条密钥一个文件** `secrets/<safe>.enc`，AES-256-GCM，`{v,alg,name,iv,tag,data,updatedAt}` | `server/vault.js:23,114-148` |
| 密钥派生 | `scrypt(hostname\|username\|COMPUTERNAME\|USERDOMAIN\|salt, salt, 32)`，salt 存 `.vault-salt` | `server/vault.js:102-112,91-100` |
| 文件名安全 | `[^A-Za-z0-9._-] → _`，拒绝空/`.`/`..` | `server/vault.js:67-71` |
| 旧版迁移 | 单文件 `secrets.enc.json` → 拆分为多文件，旧文件改名保留（不删） | `server/vault.js:153-181` |
| 明文迁移 | `config.js` 启动时把 `config.json` 里的明文 `apiKey` 搬进保险箱并抹除 | `server/config.js:75-90` |
| 读失败语义 | 解密失败（换机/被改）当作"没有这条密钥"，绝不抛给调用方 | `server/vault.js:135-143` |
| 自检 | `selfTest()` 写→读→删（**无调用方**，未接线到 `/api/security`） | `server/vault.js:225-237` |
| 列表 | `listSecrets()`（**无调用方**） | `server/vault.js:85-88` |

**安全评估（重要，容易高估）**：文件后端的派生材料（hostname、username、COMPUTERNAME、USERDOMAIN）与盐**全部在同一台机器、同一个数据目录里**（`.vault-salt` 就在密文旁边，`vault.js:24,91-100`）。因此**能读 `~/.ai-canvas` 的攻击者就能解密所有密钥** —— 这层加密的实际防护目标是「配置文件被误读/被同步到别处/日志泄露」，**不是抵御本机文件读取**。且 `vaultStatus()` 会把 `dir`（绝对路径）通过 `/api/settings`、`/api/security` 暴露出去（`vault.js:53-62`；`config.js:138`、`index.js:427`）。另外 Windows 上 `mode: 0o600` 基本不生效（NTFS 不遵循 POSIX 位）。

密钥读写路径本身是干净的：`config.js` 的 `DEFAULT_CONFIG`/`loadConfig`/`saveConfig`/`maskedConfig` **四处都显式删除 `apiKey`**（`config.js:18,101,108-115`），`maskedConfig` 用 `slice(0,6)+"****"+slice(-4)` 掩码（135），且 `PUT /api/settings` 对掩码值有"含 `****` 视为保持原值"的保护（`index.js:444-446`）—— 这一层实现正确。

---

## 11. 其他模块要点

### 11.1 `tasks.js`（任务注册表）

- `sleep(ms, signal)` 可中断等待（29-42），被万相与 ComfyUI 轮询复用 —— 取消后不必睡满间隔。
- `cancel(id)` 先钩子后 abort（92-114），`already` 幂等（95）。
- **`sweepStale()`（143-157）无调用方** → 注释承诺的"任务泄漏兜底扫描"没接（`STALE_MS=30min` 形同虚设）。
- `/api/tasks/cancel` **不校验任务归属**（`index.js:699-703`）：知道 taskId 即可取消他人任务（taskId 由前端生成，属弱凭据）→ R-低（DoS/干扰）。

### 11.2 `batch.js`（批量进度）

- 纯文件存储，"服务端不做编排"（注释 1-10 行），断点续跑靠客户端驱动。
- `safeId` 白名单 `[A-Za-z0-9_-]{1,64}`（27-31）→ 路径穿越已防。
- `update` 有"已成功不回退"保护（81）。
- **无 `userId` 字段**（55-72）→ `GET /api/batch` 返回全部用户的任务（`index.js:746-748`），含 prompt 快照（payload）→ R14。
- `sweep(7)` 只在启动时跑一次（`index.js:1024`）。

### 11.3 `materials.js`

- 路径安全做得对：`parseMaterialUrl` 白名单分类 + 拒 `..`/绝对路径/以 `.` 开头/含 `\0`（52-62），`materialAbsPath` 再兜一次穿越（65-70）。
- 标签口径 4 组（颜色/品类/季节/SKU，22-44），`setTags` 只保留白名单键且截断 40 字（107-118），`removeMaterial` 文件+元数据一起清（125-137）。
- **素材库是全局共享的**：无 userId 概念，任何登录用户可删任何素材（`index.js:832-840`）→ R14。

### 11.4 `lineage.js`（E6 血缘）

- **sidecar 设计**：每张图旁 `<file>.meta.json`，与图同生死（注释 9-12）。
- **双重穿越防护**：`path.basename` 压平 + `startsWith(dir + sep)` 前缀校验，注释还专门解释"/a/b 与 /a/bc 同前缀"的坑（33-43）——写得比多数项目认真。
- **写失败绝不影响生成**：全 catch + warn（97-109），`index.js:641` 用 `entry?.id || ""` 兜底。
- 读接口鉴权：`/api/outputs/meta` 按 `entry.userId !== req.user.id && !isSuper` 拒绝（`index.js:990-992`），`/api/outputs/lineage` 用 filter 过滤（1001）。
- **`readByTask` 只扫前 500 个 sidecar**（`listAll(limit=500)`，130-150）：`fs.readdirSync` 顺序不稳定 → 图多了以后按 taskId 反查会漏 → R-低。
- 图片本体**不受保护**（静态目录无鉴权，`index.js:1006`），只挡住了 meta 侧车（977-982）。

### 11.5 `templates.js` / `brand.js` / `audit.js`

- 模板：内置 `server/data/templates.json` + 用户覆盖 `~/.ai-canvas/templates.json` 按 id 合并（41-58）；`sanitizeGraph` 清运行时垃圾（`RUNTIME_KEYS` 64 行含 busy/images/error 等）、校验边两端存在、viewport 钳制 0.2~2.5（92-131）；`saveFromProject` 强制带 graph、名称 ≤40 字、id 为 slug+时间戳（208-253）。
  - **`upsert`(188-199)/`remove`(255-261)/`reset`(264-271) 均无路由调用** → 注释里"运营后台用"（187 行）的模板管理功能**不存在**（R21）。且 `POST /api/templates/from-project` 只有 `requireLogin`，任何用户都能往全局模板列表写（`index.js:152`）。
- 品牌：`BRAND` 环境变量 + `config/brand.json`，字段兜底完整（`brand.js:30-48`）；`GET /api/brand` 免令牌（登录页需要）。
- 审计：JSONL 按天分文件、`appendFileSync` 追加、保留 30 天（`audit.js:38-56,102-119`）；`query` 倒序扫最近 N 天、上限 5000（59-88）。
  - **`EVENT_META` 只登记了 12 类事件**（`audit.js:10-23`），而代码实际写入的类型还有 `recharge.order.created/paid`、`recharge.pay.created`、`recharge.callback.rejected/amount_mismatch/error`、`generate.cache_hit`、`task.cancel`、`template.from_project`、`material.remove` 等 → **这些全部落到 `level:"info"`、`label=类型名`**（43-44）。最要命的两个支付安全事件（验签失败、金额不匹配）**不是 danger 级**，安全看板不会告警（`index.js:278,291-295`）。
  - `/api/audit`（`index.js:410`）无 `requirePerm("admin:log:view")` → 任何登录用户可读全部审计（含 IP、UA、失败用户名）。

### 11.6 `config.js` / `paths.js`

- `DEFAULT_CONFIG`（`config.js:19-45`）：万相 `wanx2.1-t2i-turbo` + `i2iModel: wan2.6-image` + `videoModel: wanx2.1-t2v-turbo`；即梦 `doubao-seedream-4-0`；OpenAI `gpt-image-2` + `https://api.openai.com/v1`；Gemini `nano-banana-pro`；ComfyUI `http://127.0.0.1:8188`。
- 产物目录默认 `cwd/outputs`，可用 `AI_CANVAS_OUTPUTS` 覆盖（40-42）；素材默认 `~/ai-canvas-materials`（43）。
- `outputsDir()`/`materialDir()` 每次调用都 `loadConfig()` 并 `mkdirSync`（153-166）—— **每次请求多次读盘**，量级下会成为热点（性能项，非正确性）。

---

## 12. 三类清单

### 12.1 已实现（代码可验证、逻辑闭环）

| 功能 | 证据 |
|---|---|
| 五道安全门（Host/Origin/令牌/限流+并发/预算）全部落地并带默认参数 | `security.js:183-210,227-309` |
| 本地令牌持久化 + 常量时间比较 + httpOnly cookie | `security.js:12-35,133-145,212-224` |
| scrypt 加盐哈希（64 字节派生、16 字节盐）+ 5 次失败锁定 + 停用即踢 | `accounts.js:69-80,9-11,248-303,358-368` |
| RBAC 权限码矩阵 / 4 内置角色 / 部门树 / 接口级 `requirePerm` | `rbac.js:13-92,174-223`；`admin.js` 全 17 路由 |
| 行级数据权限实现（all/dept/self/custom + 部门子树） | `admin.js:19-35`、`rbac.js:213-223` |
| 账本"只记流水、余额由流水推导"+ 串行写队列 + 对账 | `credits.js:3-7,63-70,73-77,332-342` |
| 预扣 → 提交 / 回滚三步 + refId 幂等 + replay 免扣 | `credits.js:129-217`；`index.js:581-590,646-647,670-683` |
| 新用户赠送惰性发放（去重） | `credits.js:311-329`；`index.js:176` |
| 上游签名 v2（含素材内容哈希、顺序不敏感、空任务保护、版本作废） | `upstream.js:29-157,241-253` |
| 结果缓存（TTL + 产物存在校验 + 用户隔离比较 + 500 条上限） | `upstream.js:175-253` |
| 支付三路适配 + 回调验签 + 金额校验 + 幂等 + 微信时间戳防重放（300s） | `payments.js:88-334`；`index.js:268-328` |
| 微信 V3 回调 rawBody 保留 + AES-256-GCM 解密 | `index.js:45-49`；`payments.js:122,131-140,301-303` |
| 密钥保险箱双后端 + 每密钥一文件 + 明文迁移 + 掩码配置四处删 key | `vault.js:37-47,114-181`；`config.js:75-90,101,108-115,133-151` |
| ComfyUI 图生图/多图融合 + 4 套模型档案自动探测 + `/interrupt` 真取消 | `comfyui.js:31-268,314-322,399-436` |
| IPAdapter 动态签名探测 + 链式融合 + 优雅降级 | `ipadapter.js:86-157,180-269` |
| 四家云端图生图入参差异处理（含万相新老协议负向词位置） | `wanxiang.js:24-26,96-137`；`jiemeng.js:7-12,28-36`；`openai.js:32-55`；`gemini.js:4-30,54-56` |
| 参考图统一预处理（data URI / http / 本地 + 8MB 上限 + 商品一致性后缀） | `refimage.js:41-133,136-167` |
| 结果本地落地（避免远程 URL 过期） | `index.js:620-645,928-939` |
| 血缘 sidecar + 双重路径穿越防护 + 按用户过滤的读接口 + meta 直读拦截 | `lineage.js:33-43,97-150`；`index.js:977-1003` |
| 素材标签体系 + 严格 url 白名单解析 + 文件/元数据同删 | `materials.js:22-137` |
| 审计 JSONL 按天分文件 + 30 天清理 | `audit.js:38-56,102-119` |
| 模板服务端下发 + graph 清洗（去运行时垃圾/悬空边/viewport 钳制） | `templates.js:41-58,64-131,208-253` |
| 多品牌白标（BRAND + config/brand.json） | `brand.js:24-52` |
| SSE 全事件化（失败也走 `error` 事件，前端不悬挂） | `index.js:510-523,678-683` |

### 12.2 半成品 / 死代码（有实现无入口，或注释声称有但代码没有）

| 项 | 现象 | 证据 |
|---|---|---|
| **主动查单兜底** | 文件头声称"回调丢了也能靠轮询补上"，**无任何查单实现** | `payments.js:8` vs 全文 |
| **前端支付按钮** | 调 `/api/recharge/orders/:id/paid`（服务端已删除该路由） | `src/api.js:407-411`；`AccountModals.vue:102`；`__payments.test.mjs:153-155` |
| **沙箱模拟回调** | `sandboxNotifyHeaders()` 无调用方 → 界面无法触发沙箱到账 | `payments.js:329-334` |
| **客户端 API Key** | `verifyApiKey()` 无调用方；种子密钥 `ak_desktop_default` 的 sha256 硬编码在源码 | `rbac.js:258-302` |
| **RefreshToken 体系** | `issueRefreshToken()` 无调用方 → 后台"在线"列恒 0 | `rbac.js:309-326` vs `admin.js:63,100` |
| **任务泄漏清扫** | `tasks.sweepStale()` 无调用方 | `tasks.js:143-157` |
| **保险箱自检 / 列密钥** | `selfTest()`、`listSecrets()` 无调用方 | `vault.js:85-88,225-237` |
| **模板运营后台** | `templates.upsert/remove/reset` 无路由 → 无后台模板管理 | `templates.js:188-199,255-271` |
| **`admin:setting:edit`** | 权限码定义后从未校验 | `rbac.js:28` vs `index.js:431-457` |
| **视频取消** | `/api/generate-video` 未接 `tasks.register`/`signal` | `index.js:868-972`；`wanxiang.js:224-244` |
| **`security.localToken()`** | 无调用方 | `security.js:156-158` |
| 首次体验 | 未建账号时 `requireLogin` 端点全 401（血缘/余额/充值/模板反哺） | `index.js:84-96` vs `99-102,173,984` |
| 血缘按任务反查 | `listAll` 只扫前 500 个 sidecar | `lineage.js:130-150` |
| 模板 id 生成 | `Math.random()` 作随机源（非 crypto） | `templates.js:251` |

### 12.3 风险点清单（23 项，含触发条件 / 影响 / 建议）

> 严重度：**S1 严重**（上手即炸 / 直接越权 / 资损）、**S2 高**、**S3 中**、**S4 低**。

| ID | 级别 | 风险 | 触发条件 | 影响 | 建议 |
|---|---|---|---|---|---|
| R1 | S1 | **并发槽永久泄漏**：`acquireSlot()` 之后、`try/finally` 之前的「算力不足」早退**没有 `releaseSlot()`** | 余额不足时调用 `/api/generate`（或 `/api/generate-video`）2 次（默认 `maxConcurrent=2`） | `inFlight` 永久 = 2 → **之后所有生成请求被拒"同时进行的生成任务过多"**，只能重启服务；这是最容易在演示现场踩到的 bug | 把 `acquireSlot` 之后的全部早退路径纳入 `try/finally`，或改为 `const slot = acquireSlot(); if(!slot) return fail(...)` 且所有分支统一 `finally releaseSlot()`。建议加一条回归测试：余额为 0 时连续请求 N 次后仍能正常受理有余额的请求 | 
| | | 证据 | `server/index.js:541`（acquire）→ `588-590`（早退无 release）→ `684-688`（唯一 finally）；视频 `876 → 915-917 → 968-971` | | |
| R2 | S1 | **RBAC 写路径可自我提权 / 重置超管密码**：`PUT /api/admin/accounts/:id` 允许直接写 `roleIds`；`POST .../reset` 无任何超管保护，且两者都不校验行级数据范围 | 用默认「运营」角色（含 `admin:account:edit` + `admin:account:reset`）登录：① `PUT /api/admin/accounts/<自己id> {roleIds:["r-super"]}`；② `POST /api/admin/accounts/<超管id>/reset {password:"..."}` | 权限体系形同虚设：低权账号 1 次请求即取得全部权限，或重置超管口令后接管系统 | ① `updateUser` 增加"仅超管可授予/取消 `r-super`"与"操作者数据范围必须覆盖目标"的校验；② `adminResetPassword` 增加同样的保护；③ 把 `applyDataScope` 提升为所有 `/api/admin/accounts/*` 写接口的前置检查；④ 关键动作（改角色/重置密码）强制二次审计告警 |
| | | 证据 | `server/rbac.js:57-66`；`server/admin.js:117-127,158-169`；`server/accounts.js:194-207,235-245` | | |
| R3 | S1 | **同一输入"失败两次"后永不退款**：`rollback` 的幂等键是 `refId`，第二次预扣的新 `reserve` 会被第一次的 `rollback` 记录判定为"已回滚" | 上游故障 → 用户对同一参数重试并再次失败（第二次 `findConsumed` 仍为 null → 会重新预扣） | 用户被静默扣费且无产出，前端提示 `refunded: 0`；属直接资损/投诉来源 | 幂等键改为 `reserve` 的 `txId`（函数已支持 `reserveTxId` 形参，`credits.js:157`），或"已回滚"判定改为"该 refId 且金额已配平的 reserve 集合"。补测试：reserve→rollback→reserve→rollback 必须退两次 |
| | | 证据 | `server/credits.js:157-185`（163-170 去重逻辑）；`server/index.js:581,676-683` | | |
| R4 | S1 | **流水裁剪破坏余额不变式**：单用户超 2000 条时裁旧，而余额 = 剩余流水求和 | 单用户累计 >2000 笔流水（重度用户/测试环境很容易达到） | 余额凭空减少（或被裁记录净额），`/api/credits/reconcile` 永久不一致；账不可信 | 改为"裁剪时写入一条 `carryover` 期初余额条目"或直接不做裁剪（改按天分文件）；`reconcile` 应改为对比"流水求和 + carryover" |
| | | 证据 | `server/credits.js:91-98`（裁剪）、`73-77`（余额=求和）、`332-342`（对账） | | |
| R5 | S2 | **支付宝回调 100% 验签失败**：回调为 `application/x-www-form-urlencoded`，服务端未挂 `express.urlencoded` | 配置真实支付宝凭证后，任何用户完成支付 | `req.body = {}` → "缺少 sign" → 400 → **钱付了算力不到账**；同时 `sandbox=false` 使沙箱回调被 403，本地也无从补账 | 在 `express.json` 旁增加 `express.urlencoded({extended:false, verify: rawBody 钩子})`；补一条 form-urlencoded 的支付宝回调集成测试 |
| | | 证据 | `server/index.js:42-51`（无 urlencoded）；`server/payments.js:191-192,308-317`；`server/index.js:322-328` | | |
| R6 | S2 | **微信 `ready` 判定漏 `platformPublicKey`**，导致"看起来配好了、实际验不了签" | 填了 mchId + 商户私钥 + apiV3Key，但未填微信平台证书公钥 | `payStatus().sandbox=false`（沙箱关闭）＋ `createVerify().verify("")` 抛异常 → 回调 500 FAIL → 网关反复重试、永不入账 | `ready.wechat` 增加 `platformPublicKey`；缺公钥时降级为"未配置完全"并在 `payStatus().hint` 明确提示；验签前先判空并返回可读 reason |
| | | 证据 | `server/payments.js:52-53,110-127,298`；`server/index.js:313-316` | | |
| R7 | S2 | **SSRF**：参考图预处理对任意 `http(s)` URL 直接 `fetch`，无域名/IP 白名单、无超时、无下载中体积上限（8MB 仅事后检查） | 任意能调 `/api/generate` 的客户端（未建账号时免登录）把 `referenceImages:[{url:"http://169.254.169.254/..."}]` 或内网地址传入 | 服务端替攻击者发起任意内网请求（探测/打击内网接口）、无超时下载拖住并发槽与内存 | ① 禁止私网/环回/链路本地地址（解析后校验 IP 段）；② 加 `AbortSignal.timeout` 与"读满 N 字节即中断"；③ 域名白名单或要求参考图先走 `/api/upload` 落本地 |
| | | 证据 | `server/providers/refimage.js:93-105`（fetch）、`120`（事后体积检查） | | |
| R8 | S2 | **沙箱回调 = 默认部署下的白嫖入口**：该路由同时豁免登录门与本地令牌门，安全性依赖一把明文躺在数据目录的私钥 | 未配置真实支付（默认形态）时，本机任意进程读取 `~/.ai-canvas/pay-keys/sandbox-private.pem`，对任意 pending 订单伪造 `x-sandbox-payload/signature` | 可无限给自己/任意订单"充值"算力（真实资损）；测试已演示该路径可行 | ① 沙箱能力改为必须显式 `AI_CANVAS_ENABLE_SANDBOX=1` 才注册（默认关闭）；② 沙箱回调也要求本地令牌；③ 生产构建不打包 `pay-keys` 生成逻辑 |
| | | 证据 | `server/security.js:201`；`server/index.js:68,322-328`；`server/payments.js:69-83`；`server/__payments.test.mjs:93-110` | | |
| R9 | S2 | **充值链路前后端契约断裂**：前端调用已被删除的 `/api/recharge/orders/:id/paid` | 用户在充值弹窗点"模拟支付成功" | 请求 404 → 前端抛"操作失败" → **界面无法完成任何充值到账**（沙箱后端能力在，但没有入口） | 前端改调 `/api/recharge/orders/:id/pay` 并在沙箱模式下走真正的沙箱回调（可暴露一个仅开发模式可见的"模拟回调"按钮，复用 `sandboxNotifyHeaders`） |
| | | 证据 | `src/api.js:407-411`；`src/components/AccountModals.vue:93-112`；`server/index.js:243`；`server/__payments.test.mjs:153-155` | | |
| R10 | S2 | **视频生成不可取消**：`/api/generate-video` 未注册任务、未传 signal，provider 轮询也不接受 signal | 用户对视频任务点"取消" | SSE 断开但服务端继续跑到完成并 `commit` **120 点**，产物落盘而前端拿不到 → "取消了还扣 120 点"（与代码注释承诺相反） | 视频路由接 `tasks.register`/`onCancel`，`generateVideo/pollVideoTask` 全链路传 signal（`sleep` 已支持），把 `wanxiang.i2v` 的取消映射到 DashScope 的任务取消接口（若可用） |
| | | 证据 | `server/index.js:868-972`；`server/providers/wanxiang.js:224-244,246-273`；对照 `server/index.js:592-596`（图片路径做对了） | | |
| R11 | S3 | **同 refId 并发重复计费**：`findConsumed` 在 `reserve` 之前且不参与串行队列 | 两个同参数请求同时到达（客户端批量/重试） | 两次预扣、两条 consume、缓存互相覆盖；极端情况下回滚目标被对方"抢走"，导致该退的没退 | 把"查重 + 预扣"合并为一个原子操作（如 `reserveIdempotent(userId, action, refId)` 在 `serial` 内完成查重）；`rollback` 按 `txId` 精确定位 |
| | | 证据 | `server/index.js:581,587`；`server/credits.js:167-169,213-217` | | |
| R12 | S3 | **会话主键 = 全局本地令牌**，多账号退化单会话 | 同机 A 登录后 B 登录；或任一人登出 | B 顶掉 A（A 后续请求被识别为 B）；一人登出全体掉线；`sessionCount` 恒 ≤1 | 会话键改为独立随机 token（不落 header 不得用），`guard` 把"本地令牌校验"与"账号会话校验"拆成两层；`/api/auth/status` 返回真实会话数 |
| | | 证据 | `server/accounts.js:277-287`；`server/security.js:148-154`；`server/index.js:331-340,385-391` | | |
| R13 | S3 | **行级数据权限只覆盖列表读**，写接口无 scope 校验（与 R2 同源但影响面更广） | 部门受限的运营对任意 id 执行编辑/删除/停用/重置/踢下线 | 越权操作他人数据；审计里只留"后台操作"看不出越界 | 抽出 `assertInScope(actor, targetUser)` 中间件，所有 `/api/admin/accounts/*` 复用 |
| | | 证据 | `server/admin.js:19-35`（仅列表用）vs `117-181` | | |
| R14 | S3 | **数据隔离缺失三处**：批量进度无 `userId`（全量列表）、素材库全局共享（可删他人素材）、`/outputs` 静态无鉴权（且 `/api/materials` 回显绝对路径 `root`） | 多账号同机使用；或某个图片 URL 被分享/泄露 | 用户间可看到/删除彼此的任务快照与素材；图片本体无访问控制（仅靠 32bit 随机名） | 批量记录写入 `userId` 并在列表过滤；素材按 `ownerId` 或至少记录上传者；产物目录改为鉴权下发（或签名 URL）；不返回绝对路径 |
| | | 证据 | `server/batch.js:55-72`；`server/index.js:746-758,832-840,795-819,1006` | | |
| R15 | S3 | **`GET/PUT /api/settings` 无权限校验**，`admin:setting:edit` 从未使用 | 任意已登录用户（含设计师角色）改 provider 密钥、`limits`、以及 **`comfyui.baseUrl`** | 可改每日额度/并发（绕过门 4/门 5），可把 `comfyui.baseUrl` 指向任意主机 → 服务端对该主机发起 `/object_info`、`/upload/image`、`/prompt`（等于第二个 SSRF），并可注入任意工作流 | `GET` 要求 `admin:setting:edit`（或至少按字段分级），`PUT` 强制 `requirePerm("admin:setting:edit")`；`baseUrl` 做 scheme/私网校验 |
| | | 证据 | `server/index.js:431-457`；`server/rbac.js:28`；`server/index.js:506-508`、`server/providers/comfyui.js:17-24,399-404` | | |
| R16 | S3 | **审计盲区**：`guard` 拒绝 BAD_HOST/BAD_ORIGIN 时不留痕；支付安全事件未登记为 danger 级 | 出现 DNS rebinding/跨站尝试；或回调验签被反复攻击 | 安全看板看不到最外层攻击；验签失败/金额不匹配只以 info 级混在流水里，无人告警 | `security.js` 在 `reject` 前调用 `audit.record("security.blocked", {code, host, origin})`；把 `recharge.callback.rejected`/`amount_mismatch`/`error`、`security.blocked` 补进 `EVENT_META` 并设 `danger` |
| | | 证据 | `server/security.js:183-210`（无 audit import）；`server/audit.js:10-23`；`server/index.js:278,291-295` | | |
| R17 | S3 | **限流是全局单桶 + 登录锁定可反向利用** | ① 单客户端高频打 `/api/generate`；② 攻击者对已知管理员用户名连发 5 次错误登录 | ① 全站 30 次/分钟被一个人吃满，其他人 429；② 管理员账号被锁 5 分钟（可反复触发做拒绝服务），且 `failures` 是内存态、重启即清 | 限流键改为 `ip`/`userId`（或分层：全局兜底 + 单用户）；登录失败计数按 `ip+username` 并持久化；锁定可用指数退避而非硬锁 |
| | | 证据 | `server/security.js:243-249,227-241`；`server/accounts.js:9-11,252-268` | | |
| R18 | S3 | **缓存条目被 base64 图片撑爆**：OpenAI/Gemini 的 data URI 被写入 `remoteUrl` 并缓存，命中时原样回吐 | 使用 Gemini/OpenAI 的 b64 通路（`gpt-image-*`、`nano-banana-*`） | `gen-cache.json` 单条数 MB × 500 条；SSE 响应体积翻倍；启动 `sweep` 变慢 | `remoteUrl` 对 `data:` 一律置空（只保留本地 `/outputs/...`）；缓存文件加总大小上限 |
| | | 证据 | `server/providers/openai.js:84-89`；`server/providers/gemini.js:89`；`server/index.js:641,650-652`；`server/upstream.js:216-224` | | |
| R19 | S4 | **视频首帧路径穿越读本地文件**：`path.join(process.cwd(), firstFrame.url.replace(/^\//,""))` 无校验 | `POST /api/generate-video {firstFrame:{url:"../../../(任意文件)"}}` | 服务端读取任意本地文件并 base64 内联进上游请求（盲读、可能把敏感文件送给第三方 API） | 复用 `refimage.resolveLocalFile()`（已实现 outputs/materials 白名单 + 穿越校验），删掉这处手写拼接 |
| | | 证据 | `server/providers/wanxiang.js:256-267`；对照 `server/providers/refimage.js:41-61` | | |
| R20 | S4 | **金额校验可被缺字段绕过**（`if (v.amount && ...)`）；支付宝无重放校验 | 回调体缺 `amount`/`total`（解析得 `NaN`） | 金额一致性检查被跳过（仍需有效签名，故危害有限） | 改为 `if (!Number.isFinite(v.amount) \|\| v.amount !== expectCents) reject`；支付宝增加 `out_trade_no` 幂等 + 时间戳校验 |
| | | 证据 | `server/index.js:289-297`；`server/payments.js:314,322` | | |
| R21 | S4 | **死代码/未接线 8 处**（见 12.2）：主动查单、API Key 校验、RefreshToken、任务清扫、保险箱自检、模板后台、沙箱通知、`admin:setting:edit` | 维护者按注释/文档以为功能存在 | 接手时评估失真；安全承诺（如 API Key 校验）实际为零 | 要么接线，要么删掉并把注释/文档同步改掉（建议在报告与 README 里明确标注"未接线"） |
| | | 证据 | `payments.js:8,329-334`；`rbac.js:28,293-326`；`tasks.js:143-157`；`vault.js:85-88,225-237`；`templates.js:188-199,255-271` | | |
| R22 | S4 | **未建账号时"需要登录"的功能全 401**：`guard` 只发 Token，`requireLogin` 判 `req.user`（此时恒空） | 全新安装、首次进入（还没建管理员） | 血缘面板、算力余额、充值、模板反哺、"我的"页全部不可用，用户会以为是 bug | 要么把 `requireLogin` 在"无账号"时放行（保持单机免登录语义），要么首屏强制引导建号后再进入工作台 |
| | | 证据 | `server/index.js:84-96`（无账号→next）、`99-102`；受影响的 `173,202,206,220,984,996` 等 | | |
| R23 | S4 | **入参缺校验**：`size`/`n`/`strength`/`printArea` 基本直传；`prompt` 无长度上限；`nodeId` 等在 `lineage` 里原样落盘 | 传入 `size:"abc"` 或超长 prompt | ComfyUI 工作流 `width/height=NaN`；百炼/Gemini 尺寸非法报错；`lineage` 侧车膨胀（虽有 4MB body 限制） | 在 `/api/generate` 入口做白名单化校验（size 枚举、prompt 长度、printArea 枚举），错误以 SSE `error` 明确回给前端 |

---

## 13. 未验证项（必须标注，勿当作结论）

1. **未验证**：真实微信/支付宝网关端到端（无商户凭证，且 R5/R6 表明配置齐全会失败）。R5 的"body 为空"结论来自 Express 4 body-parser 行为 + 源码静态推断，**未在运行态复现**。
2. **未验证**：ComfyUI 实际工作流能否跑通、IPAdapter 融合效果（需本机 ComfyUI + 对应模型；本报告只验证了工作流 JSON 结构与探测逻辑）。
3. **未验证**：Electron 打包态的动态端口 + Host 校验（`electron/main.cjs:91,107` 与 `security.js:47-54` 在代码层吻合，未实机跑桌面端）。
4. **未验证**：多实例/PM2 cluster 部署下的账本与 `markPaid` 幂等（本报告结论基于"单进程"假设；代码为文件存储，无锁）。
5. **未验证**：`@napi-rs/keyring` 在本机的可用性（决定 vault 走 keyring 还是 file 后端）；`node_modules` 正被另一名队友安装中，我未执行任何安装/探测脚本。
6. **未验证**：任何测试的实际通过情况（`server/__*.test.mjs` 我只做了静态阅读用于判定覆盖边界，未运行）。
7. **未验证**：`spec` 中提到的 `refund` 流水类型（`credits.js:104` 注释列出）无任何写入路径，是否为预留设计待与作者确认。

---

## 14. 接手建议（按优先级）

**P0（接手当天必须处理，否则随时炸）**
1. R1 并发槽泄漏 —— 5 行内可修，但会造成"服务突然不能生成"的现场事故。
2. R2 越权链（自我提权 + 重置超管密码）—— 涉及权限根基，必须先堵。
3. R3/R4 账务两处（重试不退款、流水裁剪）—— 直接资损且不可逆。
4. R5/R9 支付两处 —— 决定"充值到底能不能用"，也决定演示能否讲通。

**P1（第一个迭代内）**
5. R6 微信 ready 判定、R8 沙箱回调收口、R7 SSRF 兜底、R10 视频取消、R15 设置页权限。
6. 把 `/api/generate`、`/api/generate-video` 的两条 SSE 主链路各补一条"余额不足/取消/失败"的端到端回归测试（现有测试恰好漏掉了 R1、R3、R10 的触发路径）。

**P2（架构债，决定了这产品能不能做多租户）**
7. R12 会话模型重做（本地令牌层 vs 账号会话层分离）+ R13 行级权限补齐 + R14 数据隔离（batch/素材/outputs）+ R11 原子幂等。**这四项不做，"多账号 SaaS"这个说法在代码层是不成立的。**

**P3（清理与可信度）**
8. R16 审计补全（否则安全能力无法被证明）、R17 限流分层、R18/R19/R20/R23 加固、R21 死代码接线或删除、R22 首屏体验、`office`/文档层同步"未接线"事实。

---

### 附：本次审计使用的关键交叉证据

- 前后端契约：`src/api.js:407-411` ↔ `server/index.js:243` ↔ `server/__payments.test.mjs:153-155`
- 安全边界分工：`server/security.js:195,201,204`（令牌豁免）↔ `server/index.js:60-73`（登录豁免）
- 帐实相符：`server/credits.js:73-77` ↔ `332-342` ↔ `server/index.js:191-193`
- 取消链路对照：图片路径 `server/index.js:592-596,670-688` **vs** 视频路径 `server/index.js:868-972`
- 路径安全对照：严（`refimage.js:41-61`、`lineage.js:33-43`、`materials.js:52-70`、`batch.js:27-31`）**vs** 松（`wanxiang.js:256-267`）
