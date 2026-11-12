# 跨多多 AI 创作台 · 手机端（原生微信小程序）

原生微信小程序：**不用 uni-app / Taro，不用 npm，没有构建步骤**，目录拷进微信开发者工具即可运行。
直连电脑端自带的本机服务，接口契约唯一依据是 `docs/mobile-api.md`（本目录不发明字段）。

## 一、目录结构

```
miniprogram/
  app.js / app.json / app.wxss / project.config.json / sitemap.json / README.md
  utils/request.js              # 统一请求层 + URL 拼接 + 保存到相册 + 时间格式化
  pages/login/login.*           # 登录
  pages/home/home.*             # 首页
  pages/gallery/gallery.*       # 看图
  pages/create/create.*         # 出图
  pages/job/job.*               # 进度
  pages/me/me.*                 # 我的
  pages/recharge/recharge.*     # 充值（从首页/我的余额进入，不在 tabBar）
```

- 4 个 tab：首页 / 看图 / 出图 / 我的（纯文字 tabBar，无图标文件）。
- 视觉跟随桌面端「棱镜 Prism」：底 `#ECEFF9`、卡片 `#FFFFFF`、墨黑 `#15171E`、
  柠檬绿 `#D8FA34`（主按钮底 + 墨黑字，不用白字）、钴蓝 `#4361EE`、
  正文 `#5A6274`、次要 `#838CA0`、边框 `#E5E9F4`、圆角 24rpx 起、阴影很淡。
- 不引用任何外部图片 / 字体 / CDN；图标全部用 emoji 或纯 CSS。

## 二、电脑端准备

1. 启动服务端（桌面版自带，或源码里跑）：

   ```powershell
   cd E:\DSH项目\ai-canvas
   npm run server
   ```

   手机真机联调时服务端必须监听非回环地址，否则手机连不上：

   ```powershell
   $env:AI_CANVAS_BIND = "0.0.0.0"
   npm run server
   ```

2. 查电脑局域网 IP：`ipconfig` →「IPv4 地址」，例如 `192.168.1.8`。
   **手机和电脑必须在同一个 WiFi**，Windows 防火墙放行 5199 端口。
3. 首次使用先有管理员账号：在电脑端首屏按引导创建，或调用 `POST /api/auth/setup`（自行设置管理员账号密码）。

## 三、在微信开发者工具里从零跑起来（5 步）

1. 打开微信开发者工具 →「+」→ **导入项目**，目录选 `E:\DSH项目\ai-canvas\miniprogram`
   （就选这一层，不要再往里套）。
2. AppID 选**测试号**（或游客模式）。`project.config.json` 已写 `"appid": "touristappid"`，不需要真 AppID。
3. 右上角「详情」→「本地设置」→ 勾选 **「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**。
4. 点「编译」。模拟器停在登录页，默认地址 `http://127.0.0.1:5199` 在开发者工具里直达本机，
   输入你在电脑端创建的管理员账号密码 → 登录成功进首页。
5. （手机真机）点登录页的「服务端地址 → 修改」，填 `http://<电脑局域网IP>:5199` 保存，
   然后开发者工具点「真机调试」（手机与电脑同一 WiFi）再登录。
   > 「预览」二维码对 HTTP 域名校验更严；局域网 HTTP 直连优先用「真机调试」。

登录成功后，「我的」页也提供同一个地址调试入口（写入 storage，**重启小程序生效**）。

## 四、请求层约定（utils/request.js）

- `request()` 统一封装 `wx.request`：自动带 `X-AI-Canvas-Token`、20s 超时、JSON 解析。
- 相对 `url`（如 `/outputs/x.png`）自动拼成 `baseUrl + url`；`buildUrl()` 供 image / previewImage 用。
- 非 2xx：`wx.showToast` 出服务端返回的 `error` 中文文案；`showError:false` 可静默（轮询用）。
- `401` 或 `code === 'LOGIN_REQUIRED'`：清 token → `wx.reLaunch` 到登录页；
  登录/改密/退出这三个接口传 `noAuthRedirect:true`，避免密码输错被当成「登录过期」踢走。
- 另导出 `saveMedia()`（下载后保存相册，处理相册授权被拒→引导设置页）、`formatTime()`。
- `baseUrl` 读取顺序：`app.globalData.baseUrl` → storage `ac_base_url` → 默认 `http://127.0.0.1:5199`。

## 五、页面功能

| 页面 | 主要行为 |
|---|---|
| 登录 | 账号密码、错误内联提示（不弹 toast 抢焦点）、storage 有 token 自动跳首页、登录前可改服务端地址 |
| 首页 | 问候+角色、余额（墨黑卡+柠檬绿数字）、累计/今日产出、正在生成任务（可进详情）、最近 6 张、快捷入口、下拉刷新 |
| 看图 | 两列瀑布流（`widthFix` 保比例）、**吸顶筛选条**（时间：全部/今天/近 7 天/近 30 天，`from` 用设备本地 0 点；项目：全部/未归属 `__none`/各项目，横向滚动 + 全量计数）、下拉刷新、触底 offset 分页、点击全屏预览（当页全部图片一起传，可左右滑）、长按保存（相册权限被拒会引导设置）、空态随筛选条件变化 |
| 出图 | bootstrap 拿 skills/models/costs；技能点一下套**提示词模板**（不覆盖已有内容）并把技能名写进 `remark`；提示词必填；1–4 张；参考图 ≤3（`wx.chooseMedia`→读 ArrayBuffer→`POST /api/m/upload`，content-type 按真实类型 png/jpeg/webp…）；显示本次消耗与余额；算力不足可直接去充值；提交成功后 `wx.redirectTo` 进度页 |
| 进度 | 1500ms 轮询 `/api/m/jobs/:id`，渲染最后 3 条 progress；进度条（生成中为不确定动画，完成满格）；done 展示结果图（点击预览、长按保存、再生成/去图库）；error 显示原因+「返回重试」；取消后继续轮询以服务端状态为准；`onHide`/`onUnload` 都 `clearInterval` |
| 我的 | 头像/用户名/角色、余额（**余额行可点进充值页**）、改密码（成功后弹窗「其他设备已下线」并带被踢台数）、退出登录、服务端地址调试（保存/恢复默认）、底部版本号 |
| 充值 | 余额大字 + `creditName`；套餐网格（价格 / credits + bonus / total，`hot` 角标）；创建订单后进入待支付面板；沙箱模式显示「模拟支付（沙箱）」→ 到账并刷新；真实模式不显示模拟支付，`/pay` 的 `error` 原样展示 +「请到电脑端完成支付」+ 订单号；最近 10 单状态标签（`pending` 可取消） |

## 六、自检结果（本机实测）

- `node --check`：**9 个 .js 全部通过**（app.js、utils/request.js、7 个页面 js）。
- `JSON.parse`：**10 个 .json 全部通过**（app.json、sitemap.json、project.config.json、7 个页面 json）。
- `app.json.pages` 7 个路径 × 4 个文件 = 28 个文件**全部存在**；tabBar 仍是 4 项，充值页**不在** tabBar。
- WXML 标签配对：7 个页面全部通过；`bind*/catch*` 事件共 47 个，全部能在对应页面 JS 里找到方法；
  `{{}}` 表达式共 228 个，全部能被 JS 解析（template 展开写法单独跳过）。
- `utils/request.js` 用 stub `wx` 动态实测 **11/11 通过**：URL 拼接、token 头、401 清 token+reLaunch、
  非 2xx 弹服务端 error、登录接口 401 不误跳、网络失败、ArrayBuffer 上传的 content-type、
  保存相册走完整 URL、creditName 覆盖、formatTime。
- 无 BOM、无外部资源引用（wxml/wxss 里 0 处 http(s) 图片/字体/CDN）、无 `TODO/FIXME/debugger/console.*`、无重复页面方法。
- 临时自检脚本跑完已删除。
- 共 **35 个文件、4538 行**（第一轮 31 个 / 3459 行，第二轮 +4 个充值页文件）。

## 七、v1 的设计取舍（原契约疑问已逐条定案）

1. **`skills` 不作为提交字段** —— 已定案：手机端把技能降级成**提示词模板**
   （点技能 → 往提示词里套一版该技能的起始描述，提示词已有内容则不覆盖）；
   同时把技能名写进 `remark`（`手机端 · 模特换装`），电脑端血缘里能看出这条是手机上按什么技能起的。
   原因：电脑端技能是"铺一张画布"，手机上没有画布，服务端无从执行 —— 提交一个 skillId 是假动作。
2. **`job.progress` 没有百分比** —— 上游只吐文本进度，没有可信的 0-100 数字，
   所以进度条是「不确定动画」，完成才满格。硬造百分比就是骗人。
3. **取消以服务端为准** —— 取消会真的停上游并回滚预扣；客户端提交取消后**不本地写死 canceled**，
   继续轮询 `/api/m/jobs/:id`，直到服务端返回 canceled / done / error（余额取服务端返回值）。
4. **上传接受 `image/*`** —— 服务端按 `content-type` 决定落地扩展名，png/jpeg/webp 都收，上限 30MB。
5. **`rows[].owner` 是可选字段** —— 超管看全部时才有值，客户端已做兜底。
6. **`brand.primary` 与 Prism** —— v1 固定 Prism，不跟随品牌主色；将来要白标跟随需在契约里
   明确"哪些颜色可以被 brand 覆盖"（桌面端是 `--brand`）。
7. **`/api/m/home` 只给任务数量** —— 要跳任务详情就多拉一次 `/api/m/tasks`，两请求比一个大接口更好改。
8. **bootstrap 每个主要页面各拉一次** —— 余额会变，每次显示都刷新更稳；请求数不是这版瓶颈。
9. **看图的 `filters` 是全量统计** —— chip 上的项目数量不会随筛选跳；「今天」用设备本地 0 点算 `from`
   （不是 UTC），「近 7 / 30 天」按本地自然日回推；`project=__none` 表示未归属。
   `from/to` 都是可选参数，筛选只传 `from`（`to` 由服务端决定是否使用）。
10. **充值页按 `status.sandbox` 分流** —— 沙箱才显示「模拟支付」；非沙箱不显示模拟口，
    创建订单后调 `/pay`，把服务端返回的 `error` 原样展示 +「请到电脑端完成支付」+ 订单号方便对账。

## 八、充值链路（联调验证用）

1. 「我的」页点余额行（或首页余额卡）→ `wx.navigateTo` 到 `pages/recharge/recharge`（不在 tabBar）。
2. 页面 `GET /api/m/recharge`：余额大字 + 套餐网格（`hot` 角标）+ 状态卡。
   `status.sandbox === true` 显示「沙箱模式」；否则显示「真实支付未接入」。
3. 点套餐卡片选中 → 底部按钮变「立即充值 ¥xx」→ 点击 `POST /api/m/recharge/orders {planId}`；
   成功后页面顶部出现「待支付订单」面板（套餐 / 金额 / 到账 / 订单号）。
4. **沙箱**：点「模拟支付（沙箱）」→ `POST /api/m/recharge/orders/:id/simulate-paid`
   → 服务端返回 `{ order.status: "paid", balance }` → toast「已到账」→
   自动重新 `GET /api/m/recharge`：余额变大、该单在订单列表变「已支付」、待支付面板收起。
5. **真实模式**：创建订单后自动 `POST .../pay`；服务端返回 `501 PAY_IN_MINIAPP_UNSUPPORTED` 时
   toast 统一错误 + 页面内原样展示 `error` +「请到电脑端完成支付」+ 订单号；页面**不出现**模拟支付按钮。
6. 订单列表最近 10 单：`pending` 黄色「待支付」+「取消」（`POST .../cancel`）；`paid` 绿色；`cancelled` 灰色。
7. 任何请求失败都走 `utils/request.js` 的统一 toast；充值页首次加载失败有整页「重试」。

## 九、已知限制

- 第一版局域网 HTTP 只能勾「不校验合法域名」，仅用于开发/体验；正式版必须 HTTPS + 已备案域名。
- token 存在小程序 storage（明文）。服务端会话落在本机数据目录（`sessions.json`），
  **有效期 7 天并滑动续期**；登出、改密、删号、停用会立即失效。
- 视频任务只做预览/保存入口，没有出视频的专属参数界面（契约 3.8 也只有图片字段）。
- 充值第一版只到「沙箱能完整走通到账 / 真实模式引导到电脑端」；小程序内真实支付需要微信商户号 + JSAPI 下单，不在本轮范围。
- 出图依赖电脑端已配置模型（云厂商 Key 或本机 ComfyUI）；没配会失败并提示原因，这是预期行为。
