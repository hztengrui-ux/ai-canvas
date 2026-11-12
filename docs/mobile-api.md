# 手机端（微信小程序）接口契约 v1

> 这份文档是**前后端共同的唯一依据**。服务端按它实现，小程序按它调用。
> 任何一边想改字段，先改这份文档。

## 0. 运行形态（第一版：局域网直连）

```
手机（微信小程序，开发者工具「预览/真机调试」）
        │  http://192.168.x.x:5199   ← 同一 WiFi，免域名、免备案
        ▼
电脑（Electron 桌面版自带的本机服务，或 npm run server）
        │  AI_CANVAS_BIND=0.0.0.0   ← 只在手机联调时打开
        ▼
   data/ outputs/ materials/（原有存储，不动）
```

- 正式版小程序**必须** HTTPS + 已备案域名；开发/体验版可以在开发者工具里勾选
  「不校验合法域名」直连局域网，第一版就走这条路（用户已确认）。
- 服务端默认仍只监听 `127.0.0.1`；只有显式设 `AI_CANVAS_BIND=0.0.0.0`
  或 `AI_CANVAS_MOBILE=1` 时才接受非回环地址。

## 1. 鉴权

- 登录：`POST /api/m/auth/login`，拿 `token`。
- 之后所有请求带同一个 header：`X-AI-Canvas-Token: <token>`
  （与桌面端用的是同一个 header 名，服务端统一校验）。
- token 默认 7 天有效；桌面端里「踢下线/改密」会让它失效。
- 服务端会把 token 解析成真实用户，后续接口的 `req.user` 与桌面端完全一致，
  **RBAC 权限不打折**（小程序能调的，取决于这个账号有什么权限）。

## 2. 通用约定

- 请求：`Content-Type: application/json`（上传除外）
- 成功：`200` + JSON
- 失败：`4xx/5xx` + `{ "error": "给用户看的中文文案", "code": "MACHINE_CODE" }`
- 图片：服务端返回的 `url` 是**相对路径**（`/outputs/x.png`）。
  小程序要自己拼成 `baseUrl + url`（因为 `wx.previewImage` 只认完整 URL）。
- 时间：epoch 毫秒（number）

---

## 3. 接口清单

### 3.1 登录

`POST /api/m/auth/login`

```jsonc
// 请求
{ "username": "admin", "password": "admin888" }
// 200
{
  "ok": true,
  "token": "m_9f2c...",              // 只在这里出现一次，客户端存 storage
  "expiresIn": 604800000,            // 毫秒
  "user": { "id": "u_x", "username": "admin", "nickname": "", "roleNames": ["超级管理员"] },
  "brand": { "key": "kuaduoduo", "appName": "跨多多 AI 创作台", "primary": "#2563EB" }
}
```

错误：`401 BAD_CREDENTIALS`（账号或密码错）、`423 LOCKED`（锁定）、
`409 NO_ACCOUNTS`（还没建过管理员，提示"请先在电脑端创建管理员"）、
`429 RATE_LIMITED`（登录太频繁）。

### 3.2 退出

`POST /api/m/auth/logout` → `{ "ok": true }`（服务端立刻吊销这个 token）

### 3.3 一次拿全（首屏用，减少请求数）

`GET /api/m/bootstrap`

```jsonc
{
  "ok": true,
  "brand": { "appName": "...", "primary": "#2563EB", "slogan": "...", "key": "kuaduoduo" },
  "me": {
    "user": { "id": "u_x", "username": "admin", "roleNames": ["超级管理员"] },
    "balance": 500,
    "creditName": "算力"
  },
  "skills": [ { "id": "txt2img", "label": "AI 文生图", "desc": "...", "available": true } ],
  "models": [ { "id": "wanx-v1", "label": "通义万相", "provider": "wanxiang", "kind": "image" } ],
  "costs": { "image": 10, "video": 60 },     // 每次生成消耗，用于按钮上显示
  "server": { "version": "0.2.0", "mobile": true }
}
```

### 3.4 首页聚合

`GET /api/m/home`

```jsonc
{
  "ok": true,
  "balance": 500,
  "creditName": "算力",
  "activeTasks": 1,
  "stats": { "outputsTotal": 42, "todayCount": 3 },
  "recent": [ /* 最多 6 条 output，结构见 3.6 */ ]
}
```

### 3.5 进度（正在跑的任务）

`GET /api/m/tasks`

```jsonc
{
  "ok": true,
  "count": 1,
  "rows": [ { "id": "t_abc", "kind": "image", "state": "running", "startedAt": 1760000000000 } ]
}
```

> 桌面端发起的任务也会出现在这里（同一套 tasks 注册表）。
> `state`: `running` | `done` | `error` | `canceled`

### 3.6 看图（我生成的图/视频，倒序分页 + 筛选）

`GET /api/m/outputs?offset=0&limit=24&from=&to=&project=`

| 参数 | 说明 |
|---|---|
| `offset` / `limit` | 分页，`limit` 上限 60 |
| `from` | 可选，epoch 毫秒，**含**（`mtime >= from`） |
| `to` | 可选，epoch 毫秒，**不含**（`mtime < to`） |
| `project` | 可选，项目 id；传 `__none` 表示「未归属项目」 |

```jsonc
{
  "ok": true,
  "total": 42,              // 当前筛选条件下的总数
  "offset": 0,
  "hasMore": true,
  "filters": {              // 筛选项，**始终基于未筛选的全量**算，这样 chip 上的数字不会跳
    "projects": [ { "id": "p_ab12", "name": "秋冬毛衫", "count": 12 },
                  { "id": "",        "name": "",         "count": 30 } ],  // id 为空 = 未归属
    "days":     [ { "day": "2026-10-18", "count": 5 }, { "day": "2026-10-17", "count": 9 } ]
  },
  "rows": [
    {
      "file": "ab12cd34.png",
      "url": "/outputs/ab12cd34.png",
      "size": 183424,
      "mtime": 1760000000000,
      "isVideo": false,
      "prompt": "杏色圆领毛衫…",     // 有血缘记录时才有，可能为 null
      "cost": 10,
      "projectId": "p_ab12",        // 可能为空字符串（老图 / 未在项目里生成）
      "projectName": "秋冬毛衫"      // 同上
    }
  ]
}
```

> 只返回**当前登录账号**的产出；超级管理员可看到全部（`owner` 字段会带用户名）。
> `owner` / `prompt` / `cost` 都可能为空字符串：老图没有血缘记录，属于正常情况。
> **项目名靠桌面端上报**：桌面端生成时会带 `projectId` + `projectName` 写进血缘。
> 2026-10-18 之前生成的图没有这两个字段，会统一落到「未归属项目」——这是历史数据，补不回来。

### 3.7 上传参考图

`POST /api/m/upload`

- `Content-Type` 用真实图片类型（`image/png` / `image/jpeg` / `image/webp` ……都收，
  服务端按 content-type 决定落地扩展名），body 是**图片二进制原始字节**（不是 multipart）。
  小程序用 `wx.request({ method:'POST', data: arrayBuffer })` 发。
- 上限 30 MB。
- 返回：`{ "ok": true, "url": "/outputs/xxx.png" }`

### 3.8 出图：提交任务

`POST /api/m/jobs`

```jsonc
{
  "prompt": "杏色圆领毛衫，胸前小面积抽象印花",
  "model": "wanx-v1",          // 可选，来自 bootstrap.models
  "n": 1,                      // 1..4
  "size": "1024x1024",         // 可选
  "referenceUrls": ["/outputs/xxx.png"],  // 可选：参考图（先走 3.7 上传）
  "remark": ""                 // 可选
}
```

返回 `{ "ok": true, "job": { "id": "j_x", "state": "queued", "cost": 0 } }`

> ⚠️ **v1 没有 `skill` 字段**：电脑端的「技能」是"铺一张画布"（素材节点 → 提示词链 → 执行节点），
> 手机上没画布，服务端也无从执行。所以小程序把技能降级成**客户端提示词模板**，
> 并把技能名写进 `remark`（如 `"手机端 · 模特换装"`），这样在电脑端血缘/审计里还能看出
> "这条是手机上按哪个技能起的"。
> `model` 不传时，服务端会自己挑一个可用模型（优先已配密钥的，跳过 ComfyUI）。

错误：`400 BAD_PROMPT`（提示词为空）、`400 INSUFFICIENT_CREDITS`
（附 `need`/`balance`）、`401 LOGIN_REQUIRED`。

### 3.9 出图：查任务

`GET /api/m/jobs/:id`

```jsonc
{
  "ok": true,
  "job": {
    "id": "j_x",
    "state": "running",        // queued | running | done | error | canceled
    "progress": [ { "text": "正在通过 通义万相 生成 1 张…", "at": 1760000000000 } ],
    "images": [ /* 结构见 3.6，done 时才有 */ ],
    "cost": 10,
    "balance": 490,
    "error": "",
    "createdAt": 1760000000000,
    "endedAt": 0
  }
}
```

> 轮询建议：提交后每 **1500ms** 查一次；`state` 变成 `done/error/canceled` 就停。
> 进度 `progress` 是**追加**数组，客户端只渲染最后 3 条。
> **没有百分比**：上游只吐文本进度（"正在生成第 2/4 张…"），没有可信的 0-100 数字，
> 所以进度条只能做"不确定动画"，`done` 时才拉满 —— 硬造一个百分比就是在骗人。

### 3.10 出图：取消

`POST /api/m/jobs/:id/cancel` → `{ "ok": true }`

取消是**真的停上游并回滚预扣**（服务端会再调一次 `/api/tasks/cancel`），
所以立刻查 `GET /api/m/jobs/:id` 可能看到 `state=done/error` 与退回的余额 —— 以服务端为准。

### 3.11 改密码

`POST /api/m/auth/password` `{ "oldPassword": "...", "newPassword": "..." }`
→ `{ "ok": true, "kicked": 1 }`（`kicked` 是被踢掉的其他设备数；当前这台保持登录）

### 3.12 联调信息（桌面端用）

`GET /api/m/info` → `{ "ok": true, "enabled": true, "bind": "0.0.0.0", "port": 5199,
"urls": ["http://192.168.1.5:5199"], "hint": "" }`

桌面端「设置 → 手机端联调」读它显示地址；小程序不需要调这个接口。

---

## 3B. 充值（手机端）

> **先说清楚能力边界**：微信小程序里做"真实支付"必须有商户号 + 小程序 AppID，
> 由服务端走 **JSAPI 下单**再调 `wx.requestPayment`。当前版本没有这些凭证，
> 所以手机端充值页的定位是：**看得见套餐与订单、沙箱模式能完整走通到账**；
> 一旦电脑端配了真实商户号，手机端会明确提示"请到电脑端完成支付"，而不是假装能付。

### 3.13 充值页一次拿全

`GET /api/m/recharge`

```jsonc
{
  "ok": true,
  "balance": 500,
  "creditName": "算力",
  "plans": [
    { "id": "plan-5000", "label": "标准包", "price": 89, "credits": 5000, "bonus": 500, "total": 5500, "hot": true }
  ],
  "status": {
    "mode": "sandbox",        // sandbox | wechat | alipay
    "sandbox": true,
    "hint": "未配置支付凭证，当前为沙箱模式…",
    "channels": [ { "id": "wechat", "label": "微信支付", "ready": false } ]
  },
  "orders": [                 // 最近 10 单，倒序
    { "id": "ord_x", "planId": "plan-5000", "planLabel": "标准包", "price": 89,
      "credits": 5000, "bonus": 500, "status": "pending",   // pending | paid | cancelled
      "createdAt": 1760000000000, "paidAt": 0 }
  ]
}
```

### 3.14 创建订单

`POST /api/m/recharge/orders` `{ "planId": "plan-5000" }`
→ `{ "ok": true, "order": { …同上… } }`；价格与算力**以服务端套餐表为准**，客户端传的价格一概不采信。

### 3.15 发起支付

`POST /api/m/recharge/orders/:id/pay`

- 沙箱模式：`{ "ok": true, "sandbox": true, "hint": "沙箱模式：点「模拟支付」即刻到账" }`
- 已配真实商户号：`501` + `{ "code": "PAY_IN_MINIAPP_UNSUPPORTED",
  "error": "小程序内支付需商户号 + JSAPI 下单；当前版本请到电脑端完成支付" }`

### 3.16 模拟支付（**仅沙箱**）

`POST /api/m/recharge/orders/:id/simulate-paid`
→ `{ "ok": true, "order": { "status": "paid", … }, "balance": 5500 }`

- 只有 `status.sandbox === true` 时可用；配了真实凭证后返回 `403`。
- 服务端走的是**和真实网关完全相同的回调链路**（验签 → 对账金额 → 幂等），不是直接改余额。

### 3.17 取消订单

`POST /api/m/recharge/orders/:id/cancel` → `{ "ok": true, "order": { "status": "cancelled", … } }`

---

## 4. 服务端实现要点（给实现者看）

- token 用 `m_` 前缀 + 32 字节随机 hex；存在内存 Map 里，带 `userId/createdAt/lastSeen/ip/ua`，
  定时清扫过期项。**不落盘**（重启即失效，符合"本机工具"的安全预期）。
- 登录复用 `accounts` 的密码校验（不要另写一套哈希）。
- 复用机制：把 `m_xxx` 当作 `localToken` 传给 `accounts.login({ localToken })`，
  这样 `accounts.currentUser(m_xxx)` 就是真实用户，**整条 RBAC 链零改动**。
- `security.js` 需要加一个「额外令牌校验器」钩子（`setExtraTokenVerifier`），
  否则 `guard` 只认桌面端那枚机器令牌，小程序请求会在第一层就被 401。
- 非回环访问的额外约束：
  - `/api/session`（返回机器令牌）**只允许回环地址**，否则局域网里任何设备都能拿到
    能绕过登录的机器令牌。
  - 生成任务走服务端代理：`POST /api/m/jobs` 在服务端内部用**该用户的 mobile token**
    自调 `/api/generate`（SSE），把进度写进 job 注册表。这样计费/幂等/退款逻辑
    **一行都不用改**，小程序也不必自己解 SSE。

## 5. 小程序页面（前端照此实现）

| 页面 | 路径 | 内容 |
|---|---|---|
| 登录 | `pages/login/login` | 账号/密码、错误提示、自动登录（storage 里有 token 就跳首页） |
| 首页 | `pages/home/home` | 顶部问候+余额；「正在生成」区块（有任务才显示，可进详情）；最近 6 张图；快捷入口 |
| 看图 | `pages/gallery/gallery` | 两列瀑布网格、下拉刷新、触底加载、点击全屏预览（支持左右滑）、长按保存 |
| 出图 | `pages/create/create` | 技能/模型选择、提示词输入、张数 1-4、参考图上传（最多 3 张）、显示本次消耗、提交后跳进度页 |
| 进度 | `pages/job/job?id=` | 进度文本滚动、进度条、完成展示结果图（可保存/再生成一张）、失败展示原因 |
| 我的 | `pages/me/me` | 头像/用户名/角色、余额、改密码、退出登录、服务端地址（调试用，可改） |

- `tabBar` 四项：首页 / 看图 / 出图 / 我的（纯文字，不用图标）。
- 主题色跟桌面端「棱镜 Prism」一致：底 `#ECEFF9`、卡片 `#FFFFFF`、墨黑 `#15171E`、
  柠檬绿 `#D8FA34`（主按钮底 + 墨黑字）、钴蓝 `#4361EE`（链接/强调）、
  正文 `#5A6274`、边框 `#E5E9F4`。圆角 24rpx 起。
- 服务端地址放在 `app.js` 的 `globalData.baseUrl`，并在「我的」页提供调试改写入口
  （写进 storage，下次启动生效）。
