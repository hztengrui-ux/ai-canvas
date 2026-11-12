# 交叉核查报告：三份深拆报告的事实冲突与行号校验

- 核查对象：`reports/analysis-frontend.md`、`reports/analysis-backend.md`、`reports/analysis-desktop-build.md`（另参考 `reports/00-总报告.md`、`reports/verify-backend-adversarial.md`、`跨多多AI创作台-完整技术总文档.md` 作为"他方说法"）
- 核查人：build-analyst（Team Lead: lead）｜ 任务：task-4
- 核查日期：2026-10-14
- 纪律声明：**只读** `reports/` 与源码，未修改任何源码，唯一写入本文件。
- 运行约束遵守情况：**本次未执行任何 node 脚本**，因此不涉及子进程 stdio 问题；所有行数/字节/正则统计均用 **PowerShell 5.1 + .NET API**（`[System.IO.File]::ReadAllLines/ReadAllText/ReadAllBytes`，编码安全）与 **read 工具**完成，从方法上就避开了本轮的核心坑（见冲突 1）。

### 基线快照（三份报告在我的核查期间均未变动）

| 报告 | 行数 | 末次写入 |
|---|---|---|
| `analysis-frontend.md` | 541 | 15:50:13 |
| `analysis-backend.md` | 680 | 15:50:17 |
| `analysis-desktop-build.md` | 852 | 15:54:14 |

> 我的核查从 15:59 开始，因此三份报告是稳定基线。**注意**：`00-总报告.md`（16:01:45 / 395 行）、`verify-backend-adversarial.md`（16:01:26 / 233 行）、`reports/verify/*` 是**并行队友在核查期间持续写入**的，我在引用时均已重新读取确认内容。

---

## 一、冲突总表

| # | 冲突点 | 各报告说法 | 实测/权威结论 | 采信哪一个 | 证据 |
|---|---|---|---|---|---|
| **1** | **行数口径**（同一文件三个数） | frontend：`NodeCanvas.vue=1894`、`store.js=525`、`api.js=413`，并称"PowerShell 会少算行"<br>Lead（`00-总报告.md` 未列，但任务描述）："用 PowerShell Measure-Object 得到 NodeCanvas.vue 远小于此" | **read 工具与 `ReadAllLines` 完全一致，6/6 文件吻合**：NodeCanvas.vue **1894**、store.js **525**、api.js **413**、server/index.js **1039**、theme.js **195**、ports.js **126**。<br>`Measure-Object -Line` 分别给出 1725 / 469 / 367 / 942 / 175 / 101；`Get-Content .Count` 给出 1894 / 525 / 413 / 1039 / 195 / **112** | ✅ **frontend 报告正确**（我的 build 报告同口径，也正确） | `read src/components/NodeCanvas.vue:1894`（工具回显 total 1894）、`read src/store.js:525`、`read src/api.js:413`、`read server/index.js:1039`、`read src/theme.js:195`、`read src/ports.js:126`；`analysis-frontend.md:6,13,37,38,46` |
| **2** | **路由数** | backend：`index.js` **49** + `admin.js` **17** = **66**<br>Lead：`index.js` 48 + `admin.js` 0 = 48；`00-总报告.md:62,296` 采信为"48 + 17"（=65）<br>总技术文档 `:491`：34 + 17 = **51** | **index.js 恰好 49 条**（GET 26 / POST 17 / PUT 2 / DELETE 3 / **PATCH 1**）、**admin.js 恰好 17 条**，**合计 66** | ✅ **backend 报告正确（66）** | 见 §二·2 全量清单；`analysis-backend.md:77`；对照 `00-总报告.md:62,296`、`跨多多AI创作台-完整技术总文档.md:491` |
| **3** | **权限码数** | backend：15<br>Lead 实测：`/api/auth/setup` 返回 perms 15 项<br>frontend / build：未提出异议 | **恰好 15 个**（`rbac.js:13-28`），**三方无冲突** | ✅ 三方一致，可直接采信 | `server/rbac.js:14-28`（逐条列出见 §二·3） |
| **4** | **测试规模** | build：**14 个测试文件 / 13 个套件**<br>`00-总报告.md:61`："server/ 25 个 .js（含 providers 7 个 + **14 个测试**）"<br>总技术文档 `:1239`、`:168`：**2 个自测 / 30 项断言** | **测试文件 14 个**（`server/` 11 + `src/` 3）；`run-tests.mjs` 挂接 **13 个套件**；运行期断言合计 **≈520 项** | ✅ **build 报告正确**；总技术文档的"2 个自测"是 v0.1.0 陈旧值；`00-总报告.md:61` 的措辞不成立（25 个 `.js` = server 根 18 + providers 7，**不含**测试；14 个测试是 `.mjs` 且分居 `server/` 与 `src/`） | `scripts/run-tests.mjs:93-140`（13 处 `await run(`）；`glob **/__*.test.mjs` = 14 条；`analysis-desktop-build.md` §4.1 |
| **5** | **后端 4 条「严重」风险的行号证据** | build 报告之外，任务要求逐条核对 backend 报告 4 条 S1（R1–R4）是否都给了 `文件:行号` 且指向正确 | **3 条行号精确，1 条（R1）完全缺行号**：R2/R3/R4 证据行号逐条精确命中；**R1 的 R1 行（`analysis-backend.md:594`）通篇没有任何 `文件:行号`** | ⚠️ **结论真（Lead V1 实测已复现），但 R1 缺证据引用**：需补 `index.js:541 / 588-590 / 576 / 686 / 876 / 915-917`、`security.js:252-263,271` | 详见 §二·5 逐条核验表 |
| **6** | **三份报告对同一事实的相反陈述** | 见 §三（共 7 对） | 其中 **2 对是我的 build 报告判宽了**（语义缩放、作品组），**1 对是 frontend 报告判重了**（充值链路当前可利用性），**1 对是 `00-总报告.md` 的严重项计数叙事与 backend 报告不对应** | 逐对判定见 §三 | §三 |
| 附 **A** | **严重项计数叙事** | `00-总报告.md:355`："原报告的'23 条风险'里，**严重项由 4 条修正为 3 条**（V4 降级为中·可用性）" | backend 报告的 S1 = **R1/R2/R3/R4** 共 4 条（`analysis-backend.md:25`："严重 4 / 高 5 / 中 9 / 低 5" = 23）；**V4 的对象（§9.2 缓存键）根本不在 23 条风险表内**，且 backend 报告自己已写"安全性没问题"；`verify-backend-adversarial.md:18,199,232` 也把 V4 定为"**中等**·安全"而非严重 | ❌ **`00-总报告.md:355` 的"4→3"没有依据**：既不是 4→3（V4 从来不是 S1），也不是 4→4（若按 §4.1 自己的 4 行，V4 也不在其列） | `analysis-backend.md:25,594-600,458-463`；`verify-backend-adversarial.md:18,20,199,232`；`00-总报告.md:355` |
| 附 **B** | **frontend 报告自身不闭合** | `analysis-frontend.md:13`："`src/` 下共 65 个文件（其中 **40 个 `.vue`** 组件）" | 实测 **`.vue` = 41**（40 + 16 + 8 = 64 ≠ 65，自述的分解加不回 65） | ❌ frontend 报告此处有 1 处算术错误（应为 41） | `analysis-frontend.md:13`；实测 `src/`：`.vue` 41 / `.js` 13 / `.mjs` 3 / `.css` 8 = 65 |
| 附 **C** | **frontend 报告的 CSS 行数旁注** | `analysis-frontend.md:32`："CSS 只给磁盘体积，因为 **1651/8012** 这类数字来自 PowerShell 会少算，不可信" | **8012 是正确的**（`style.css` 是 CRLF 文件，`ReadAllLines` = `Get-Content` = 8012；只有 `Measure-Object -Line` 会少算成 6860）；**1651 是少算值**，`newui.css` 真实为 **1660** | ⚠️ 该旁注举例不当：两个数里一个是正确的、一个确实少算，混在一起说"不可信"会误导 | `analysis-frontend.md:32`；实测 `style.css` ReadAllLines 8012 / GC 8012 / Measure 6860；`newui.css` ReadAllLines 1660 / GC 1651 |
| 附 **D** | **build 报告把 grep 命中数当成路由数** | `analysis-desktop-build.md:415`："`server/index.js` **57 条路由**中无 `/paid`" | `index.js` 实际 **49 条路由**；57 是"49 条路由 + 8 处 `app.use` 挂载"的**正则命中总数**（`app.use` 见 `index.js:39,40,42,84,977,1006,1007,1009`）。结论"无 `/paid`"仍然成立，但数字口径错误 | ❌ **build 报告有 1 处口径错误**，应改为"49 条路由（另有 8 处 `app.use`）" | `analysis-desktop-build.md:415`；对照 §2.2 全量清单 |

**冲突点数量：6 个指定冲突点 + 4 个附带冲突（A/B/C/D），另有 7 对报告间相反陈述（§三）。**

---

## 二、关键冲突点详解

### 2.1 冲突 1：行数口径 —— 权威结论与根因（**这是给用户看的口径，必须统一**）

#### 权威结论

> **真实行数 = `[System.IO.File]::ReadAllLines(path).Length` = read 工具的 "total N lines" = 源码中的换行符个数（LF-only 文件即 `\n` 数；CRLF 文件即 `\r\n` 数）。**
> 除此之外的 `Get-Content`、`Measure-Object -Line`、编辑器状态栏都可能不是同一个数，**不得用于交叉核对**。

#### 六文件三口径实测

| 文件 | **ReadAllLines（权威）** | read 工具 | `Get-Content .Count` | `Measure-Object -Line` | 空行数 | 行尾 |
|---|---|---|---|---|---|---|
| `src/components/NodeCanvas.vue` | **1894** | 1894 ✅ | 1894 ✅ | 1725 ❌ (−169) | 169 | CRLF |
| `src/store.js` | **525** | 525 ✅ | 525 ✅ | 469 ❌ (−56) | 56 | CRLF |
| `src/api.js` | **413** | 413 ✅ | 413 ✅ | 367 ❌ (−46) | 46 | CRLF |
| `server/index.js` | **1039** | 1039 ✅ | 1039 ✅ | 942 ❌ (−97) | 97 | CRLF |
| `src/theme.js` | **195** | 195 ✅ | 195 ✅ | 175 ❌ (−20) | 20 | CRLF |
| `src/ports.js` | **126** | 126 ✅ | **112** ❌ (−14) | 101 ❌ (−25) | 12 | **纯 LF** |

#### 两个**独立**的少算机制（这才是根因，不是"玄学"）

**机制 A — `Measure-Object -Line` 不计空行（对**所有**文件都错）**

实测 6/6 文件都满足：`Measure-Object -Line == 该文件非空行数`。
例：`NodeCanvas.vue` 1894 行中有 169 行空行 → 1725 = 1894 − 169。

**机制 B — `Get-Content` 只对「UTF-8 无 BOM + 纯 LF」文件额外少算（PS 5.1 特有）**

环境实测：`$PSVersionTable.PSVersion = 5.1.26100.9444`、`PSEdition = Desktop`、系统 `ACP = 936`（GBK）、被测源文件**全部为 UTF-8 无 BOM**。

`Get-Content` 在 Windows PowerShell 5.1 下对无 BOM 文件按 **ANSI（936）** 解码，把 UTF-8 中文按 GBK 两两配对 → **某些行的末尾字节与紧随其后的 `\n`(0x0A) 被当成一个双字节汉字**，该 `\n` 消失 → 两行并成一行。

逐行比对实证（`README.md`，ReadAllLines 62 行 vs Get-Content 49 行）：

```
RAL[0] = # AI Canvas · 无限画布创作台        ← .NET 按 UTF-8 读，正确
GC [0] = # AI Canvas 路 鏃犻檺鐢诲竷鍒涗綔鍙?   ← Get-Content 按 GBK 读，乱码
GC [4] = "- **鍗虫ⅵ / Seedream**（…绯诲垪锛?- **ComfyUI 鏈湴宸ヤ綔娴?*（…）|"   ← 两行被并成一行
```

为什么 CRLF 文件幸免：GBK 尾字节范围是 `0x40–0xFE`，**不含 0x0D(`\r`)**，所以 `\r` 不会被吞；行仍由 `\r\n` 正确断开。

#### 影响面（为什么这必须统一口径）

对**源码+文档**文件做行尾普查（146 个：排除 `node_modules`/`dist`/`release`/`.tmp`/`.testdata`/`.rundata`/`.verifydata`）：

| 行尾类型 | 文件数 | 占比 | `Get-Content` 是否少算 |
|---|---|---|---|
| **纯 LF** | **117** | **80.1%** | ❌ 少算 |
| 纯 CRLF | 29 | 19.9% | ✅ 正确 |
| 混合 | 0 | — | — |

（若把 `.rundata/`、`.verifydata/` 下的运行数据 JSON 也算进来，总量约 170 个文件，纯 LF 约 80%，结论不变。）

**结论：`Get-Content` 在本仓库约 80% 的源码文件上都会少算，`Measure-Object -Line` 在 100% 的文件上都会少算。** 本项目的服务端源码（`server/*.js`、`server/providers/*.js`、全部 `__*.test.mjs`）**基本都是纯 LF**，因此这一坑对后端行号核对影响最大。
（`analysis-frontend.md:6` 的判断"`Get-Content`/`Measure-Object -Line` 在本仓库会少算行，已实测 `src/ports.js` 为 126 行而 `Get-Content` 报 112 行"—— **与我的独立复现完全一致，该报告此处的口径是正确的。**）

#### 统一口径建议（写给后续所有报告/汇报）

1. 行号一律以 **read 工具回显** 或 **`ReadAllLines`** 为准；
2. PowerShell 里**禁止**用 `Get-Content`/`Measure-Object -Line` 数行；如必须用 PS，则写 `([System.IO.File]::ReadAllLines($p)).Length`；
3. 若一定要用 `Get-Content`，必须补 `-Encoding utf8`（PS 5.1 下 BOM-less 文件仍建议直接走 .NET）；
4. `00-总报告.md:296` 的"路由 index.js 48"随本次核查一并修正为 **49**（见下）。

---

### 2.2 冲突 2：路由数 —— 权威结论与全量清单

#### 口径定义（先定义再数，否则永远吵架）

> **一条路由 = 一次 `app.<method>(path, ...)` 注册**，`method ∈ {get, post, put, patch, delete, all}`；
> `app.use(...)` 属于**中间件/静态挂载**，单独统计，不计入路由数。

#### 权威结果

| 文件 | 路由数 | 方法分布 |
|---|---|---|
| `server/index.js` | **49** | GET 26 / POST 17 / PUT 2 / DELETE 3 / PATCH 1 |
| `server/admin.js` | **17** | GET 6 / POST 8 / PUT 1 / DELETE 2（全部在 `mountAdmin(app, …)` 内，**2 空格缩进**） |
| **合计** | **66** | — |
| （另）`app.use` 挂载 | 8 | `index.js:39,40,42,84,977,1006,1007,1009`（`1009` 为条件式 `if (…) app.use(express.static(dist))`） |

`index.js` 全量 49 条（行号:方法:路径）：

```
56 GET /api/session         122 GET /api/auth/perms        136 GET /api/templates
145 GET /api/templates/:id/graph   152 POST /api/templates/from-project
173 GET /api/credits/balance      180 GET /api/credits/records
186 GET /api/credits/costs        191 GET /api/credits/reconcile
198 GET /api/recharge/plans       202 GET /api/recharge/orders
206 POST /api/recharge/orders     220 POST /api/recharge/orders/:id/cancel
233 GET /api/brand                237 GET /api/recharge/pay-status
243 POST /api/recharge/orders/:id/pay
319 POST /api/recharge/callback/wechat   320 POST /api/recharge/callback/alipay
323 POST /api/recharge/callback/sandbox
331 GET /api/auth/status           343 POST /api/auth/setup
364 POST /api/auth/login           385 POST /api/auth/logout
393 POST /api/auth/password        410 GET /api/audit
421 GET /api/audit/stats           425 GET /api/security
431 GET /api/settings              433 PUT /api/settings
492 GET /api/version               506 GET /api/comfyui/status
529 POST /api/generate            699 POST /api/tasks/cancel
715 GET /api/tasks                725 POST /api/batch
735 PUT /api/batch/:id            746 GET /api/batch
750 GET /api/batch/:id            756 DELETE /api/batch/:id
761 GET /api/cache/status          765 DELETE /api/cache
770 POST /api/upload              795 GET /api/materials
822 PATCH /api/materials/tags     832 DELETE /api/materials
843 POST /api/materials/upload    868 POST /api/generate-video
984 GET /api/outputs/meta         996 GET /api/outputs/lineage
```

#### 48 / 65 / 51 三个数的来历（全部可解释）

| 数 | 来源 | 错在哪 |
|---|---|---|
| **48** | Lead 的正则 `^app\.(get\|post\|put\|delete)\(` | **两处缺陷**：① 方法白名单**漏了 `patch`** → 唯一漏掉的是 `PATCH /api/materials/tags`（`index.js:822`）；② `^` 锚定行首 → `admin.js` 的 17 条全部缩进在 `mountAdmin` 内，**命中 0**。补上 `patch` 后 index.js 立刻得 49（已实测：不带 patch 48、带 patch 49） |
| **65** | `00-总报告.md:62,296` 把 48+17 当成实测 | 继承 48 的错误；admin.js 的 17 是对的 |
| **51** | 总技术文档 `:491`「34（index.js）+ 17（admin.js）= 51」 | **34 是 v0.1.0 陈旧值**（该文档 `:283` 还写着 `index.js | 705 | 34 个路由`，实际 1039 行 / 49 条）；17 是对的 |
| **66** | `analysis-backend.md:77` | ✅ **正确** |

> 我的 build 报告（`analysis-desktop-build.md`）在 §1 只逐条列了 `app.get/post/...` 的用途，未给出"总路由数"这一数字，因此**不存在与 66 的冲突**——但它引用过"57 条路由"？（复查：build 报告正文未给出路由总数，仅在文档一致性一节引用过 `server/index.js` 的 57 条 grep 命中，那 57 = 49 路由 + 8 个 `app.use`，**不是**路由数声明，需在汇报时避免被误读为路由总数。）

---

### 2.3 冲突 3：权限码 —— 恰好 15 个（逐条列全）

`server/rbac.js:13-28` 的 `PERMISSIONS` 数组**恰好 15 条**，`ALL_CODES`（`:31`）= 其 code 列表：

| # | 权限码 | 分组 |
|---|---|---|
| 1 | `admin:dashboard:view` | 运营看板 |
| 2 | `admin:account:view` | 账号管理 |
| 3 | `admin:account:create` | 账号管理 |
| 4 | `admin:account:edit` | 账号管理 |
| 5 | `admin:account:delete` | 账号管理 |
| 6 | `admin:account:reset` | 账号管理 |
| 7 | `admin:account:kick` | 账号管理 |
| 8 | `admin:role:view` | 角色权限 |
| 9 | `admin:role:edit` | 角色权限 |
| 10 | `admin:dept:view` | 组织架构 |
| 11 | `admin:dept:edit` | 组织架构 |
| 12 | `admin:log:view` | 日志审计 |
| 13 | `admin:apikey:view` | 客户端密钥 |
| 14 | `admin:apikey:rotate` | 客户端密钥 |
| 15 | `admin:setting:edit` | 系统设置 |

- 与 Lead 实测"`/api/auth/setup` 返回 15 个权限码"**一致**（首账号 `r-super` → `ALL_CODES`，`rbac.js:49`）。
- 默认「运营」(`r-operator`) 持有 **8 个**（`rbac.js:58-65`）：dashboard:view / account:{view,create,edit,reset} / role:view / dept:view / log:view —— 这解释了 `verify/v2-privesc.mjs` 与对抗报告里"权限 **8→15**"的说法，**数字自洽**。
- `admin:setting:edit` 存在但**从未被任何路由使用**（backend 报告 R15 的结论，我核对 `index.js:431,433` 的 `GET/PUT /api/settings` 确实只挂登录门，无 `requirePerm`）→ 该条可采信。

**结论：三方（backend 报告 / Lead 实测 / 源码）全部一致，本冲突点实为"无冲突"，予以确认关闭。**

---

### 2.4 冲突 4：测试规模 —— 14 文件 / 13 套件 / ≈520 断言

| 口径 | 值 | 证据 |
|---|---|---|
| 测试文件（磁盘） | **14** | `server/` 11 个 + `src/` 3 个（`glob reports 外层：server/__{cancel,credits,i2i,ipadapter,lineage,p18,p18-http,payments,sync,sync-http,vault}.test.mjs` + `src/__{robust,theme,ui}.test.mjs`） |
| 套件（`run-tests.mjs` 挂接） | **13** | `scripts/run-tests.mjs:93-140` 共 13 处 `await run(` |
| 第 14 个文件如何被执行 | 由 `__sync.test.mjs:117-122` 以子进程执行 `__vault.test.mjs` | 因此 **14 个文件全部会跑**，套件计数仍为 13 |
| 运行期断言数 | 13 套共 **≈520**（Lead 实测逐套件：16/14/29/15/55/23/41/64/**82(83)**/54/8/62/49） | 与 `00-总报告.md:218-232` 的逐套件表一致 |

**总技术文档的两处陈旧声明**（`跨多多AI创作台-完整技术总文档.md`）：

- `:168`「`npm test` 一键跑批：**30 项断言**（账本 16 + 支付 14）」
- `:1239`「`__*.test.mjs` **2 个自测**（30 项断言）」

实际为 13 套件 / 14 文件 / ≈520 断言 → **采信 build 报告（14 文件、13 套件）**。总技术文档这两处属"只统计了最初的 2 个套件"，需回填。

**附带修正**：`00-总报告.md:61`「server/ 25 个 .js（含 providers 7 个 + **14 个测试**）」措辞不成立——实测 `server/**/*.js` = 25 个（server 根 18 + providers 7），**其中不含任何测试文件**；14 个测试文件是 `.mjs`，分布在 `server/`（11）与 `src/`（3）。建议改为「server/ 25 个 .js（含 providers 7）+ 全仓 14 个 `__*.test.mjs`」。

---

### 2.5 冲突 5：backend 报告 4 条「严重」风险的行号逐条核验

`analysis-backend.md:25` 声明「风险点合计 23 项：**严重 4** / 高 5 / 中 9 / 低 5」；`§12.3` 表中标 S1 的是 **R1、R2、R3、R4**（`:594,596,598,600`）。逐条打开行号核验：

| 风险 | 报告给出的行号 | 我打开源码看到的内容 | 判定 |
|---|---|---|---|
| **R1 并发槽泄漏**（`:594`） | **⚠️ 该行没有任何 `文件:行号`**（整行只有触发条件/影响/建议的散文） | 需补的行：`index.js:541`（`if (!acquireSlot()) return fail(...)` 取槽）→ `index.js:588-590`（**余额不足早退，未 `releaseSlot()`**）→ 全仓 `releaseSlot()` 仅 4 处：`index.js:576`(缓存命中)、`686`(图片 finally)、`907`(视频缓存命中)、`969`(视频 finally)；视频路由同病：`876` 取槽 → `915-917` 早退；`security.js:252-263`（inFlight/acquire/release）、`:271`（maxConcurrent 默认 2） | ❌ **证据缺口**（结论本身**为真**，已由 Lead 的 V1 实测复现：余额 0 账号连发 2 次即可顶满 `inFlight=2`，连超管一起被拒，2.5s 不自愈） |
| **R2 RBAC 自我提权**（`:596`） | R2 行内无内联行号，但报告 §2.2 路由表给了 `admin.js:117-127`（PUT 编辑账号）、`admin.js:158-169`（/reset） | `admin.js:117-127`：`app.put("/api/admin/accounts/:id", requireLogin, requirePerm("admin:account:edit"), …)` → `accounts.updateUser(req.params.id, req.body)`（**`req.body` 整体透传**）；`accounts.js:204`：`if (patch.roleIds) u.roleIds = patch.roleIds` → **可直写 `r-super`**（`accounts.js:193-199` 只保护"最后一个超管不能被降级"，**不阻止自我提权**）；`admin.js:158-169`：`/reset` 只有 `requirePerm("admin:account:reset")`，**无超管保护** | ✅ **行号准确**；补充 `accounts.js:160`（`createUser` 接受任意入参 `roleIds`，**无白名单** → 更短的"直接造超管"路径，已被对抗报告 `:117` 实测三条路全 200） |
| **R3 失败两次永不退款**（`:598`；详解 `:344`） | `credits.js:163-164`、`index.js:581`、`index.js:676-683` | `credits.js:163`：`const already = rows.some((r) => r.type === "rollback" && r.refId === refId);` `:164`：`if (already) return { ok: true, skipped: true };`（**幂等键 = refId**，无 txId）；`index.js:581`：`const replay = credits.findConsumed(chargeUser, refId);`；`index.js:676`：`const rb = reserved.reserved ? await credits.rollback(chargeUser, refId) : { refunded: 0 };`、`:681`：`refunded: rb.refunded \|\| 0` | ✅ **三处行号全部精确命中** |
| **R4 流水裁剪破坏余额**（`:600`；详解 `:345`） | `credits.js:95-97`、`credits.js:73-77`、`credits.js:332-342` | `credits.js:95-97`：`if (l.records[userId].length > 2000) { l.records[userId] = l.records[userId].slice(-2000); }`；`:73-77`：`balance()` = `rows.reduce((sum,r)=>sum+r.amount,0)`；`:332-342`：`reconcile()` 比较 `last.balanceAfter !== sum` | ✅ **三处行号全部精确命中** |

**小结**：4 条 S1 中 **3 条（R2/R3/R4）行号精确无误**，**1 条（R1）完全没有行号**——属于"结论对、证据缺"，需按上表补齐。这与 backend 报告自身在 `:649` 的诚实声明一致（"未验证：任何测试的实际通过情况……只做了静态阅读，未运行"）；**该报告通篇未声称"测试通过"，只把测试代码作为静态证据引用**（如 `:395` 引 `__payments.test.mjs:153-155` 说明"旧 `/paid` 被断言为 404"，这是引用断言内容，不是运行结果），因此不存在"静态报告冒充实测"的问题。而 `00-总报告.md` 里那批"16/16、14/14、55/55、23/23、41/41、64/64、62/62、49/49、8/8"**来自 Lead 的真实 `npm test` 运行**，两者不能混引。

---

## 三、三份报告之间的相反陈述（冲突 6 全量）

| # | 事实 | frontend 报告 | backend 报告 | build 报告（我） | 权威结论（源码实测） | 采信 |
|---|---|---|---|---|---|---|
| a | **语义缩放（A4）** | "CSS 选择器**全部写错**，far 档实际只隐藏了 `<textarea>` 和 handle → 等于没做"（`:19`） | 未涉及 | doc9 A4 判"⚠️ 已落地但测试测的是副本"（`analysis-desktop-build.md:508`） | **frontend 正确**：`newui.css:9-13` 隐藏 `.nf-node-body/.nf-thumb/.nf-field/.nf-media-grid`，`:23` 修饰 `.nf-node-title`；这 **5 个类名在任何节点组件里都不存在**（全仓 grep 只命中规则自身；组件实际用 `nf-product-body/nf-style-body/nf-ref-body/nf-result-grid/nf-product-thumb/...`）。far 档真正生效的只有 `textarea`（`ReferenceNode.vue:95`、`PromptNode.vue:26-31`）、`min-height/padding/shadow`（`:17-21`）与 handle 隐藏（`:30-33`） | **frontend**；**我的 build 报告此条判宽了，属硬错误** |
| b | **作品组（A3）** | "**半成品**：既进不了撤销栈，也进不了持久化"（`:20`） | 未涉及 | doc9 A3 判"✅ 已落地"（`:507`） | **frontend 正确**：`NodeCanvas.vue:178-197` 的 `serialize()` 每节点只导出 `{id,type,position,data}`，**丢掉 `parentNode/extent/hidden/zIndex/style`**（这些字段在 `:317-323`、`:342-351`、`:366` 被写入）→ 撤销/刷新即脱组 | **frontend**；**我的 build 报告此条判宽了，属硬错误** |
| c | **充值链路的当前可利用性** | "前端**可自行把订单标记为已支付**…等于白送算力"（`:22`） | R9 已指出"前端调用已被删除的 `/paid`"（`:610`） | "`payOrder()` 调已删接口 → **点支付必 404**" | **两者各对一半**：代码意图确实是伪造支付（`AccountModals.vue:88-92` 注释自述"前端直接调用等于允许伪造支付"、`:93-112` `finishPay()` 弹"模拟支付成功"确认框），但 `finishPay` 实际调的是 `src/api.js:407-411` 的 `/api/recharge/orders/:id/paid`，**该路由在服务端已不存在**（见 §2.2 的 49 条清单，无 `/paid`）→ **当下不可利用（404），但意图与代码路径确实存在**，一旦后端恢复旧接口即成真实白嫖口 | frontend 的**意图描述**成立；"当前可利用"**过强**，须以 build 报告的 404 事实为准（`00-总报告.md:140` 已同时写了两半，可用） |
| d | **项目持久化范围** | 未直接涉及（其 §0 未列） | 未涉及 | "doc9 E7 项目持久化 ✅ 已落地" | **两者不矛盾但需限定域**：画布侧 `src/project.js`（`scheduleSave`/`loadGraph`）确实有效（`src/__ui.test.mjs:92-117` 覆盖）；但 `HomeView.vue:82-93` 的 `newProject()` 只做 `store.projects.unshift(p)`，**未走 `project.js` 落盘** → 首页新建项目刷新即丢（`00-总报告.md:159` 的指控成立） | 两者都对，**须分别标注"画布项目"与"首页项目入口"** |
| e | **路由总数** | 未涉及 | **66**（`:77`） | `:415` 称"`server/index.js` **57 条路由**"（实为 49 条路由 + 8 处 `app.use` 的正则命中数） | 见 §2.2 → **66 正确 / index.js 49 条** | **backend**；`00-总报告.md:62,296` 的 48/65 与 `analysis-desktop-build.md:415` 的 57 均需改 |
| f | **行数口径** | 声明以 read 工具为准，PowerShell 会少算（`:6`） | 以 read 工具行号为准 | 同（并用 ReadAllLines 复核） | 见 §2.1 → **frontend/build 正确** | frontend + build |
| g | **严重项计数叙事** | — | S1 = R1–R4，共 **4** 条（`:25,594-600`） | — | `00-总报告.md:355` 称"严重项由 4 条修正为 3 条（V4 降级）"，但 **V4 的对象（`analysis-backend.md:458-463` §9.2 缓存键）不在 23 条风险表内**，且报告自己写了"安全性没问题"；`verify-backend-adversarial.md:18,199,232` 也把 V4 定为"**中等**·安全"的**定级误报** | **backend + 对抗报告**；`00-总报告.md:355` 的"4→3"无依据 |

> 另外**一致无冲突**的三方共同结论（可直接采信）：主题 **3 套**（`classic` 已删）、默认主题 **atelier**（`theme.js:54`）、主题套件 **红**（`__theme.test.mjs:52` vs `theme.js:54`，82/1，exit 1）、测试文件 **14**、`_deprecated/` **2 文件 407 行死代码**（frontend `:57` = build §7 的 163+244=407）、`src/` **65 文件**。

---

## 四、报告可信度评估

### 4.1 硬错误统计

| 报告 | 硬错误 | 明细 | 需打问号的部分 |
|---|---|---|---|
| **`analysis-frontend.md`**（541 行） | **2 处（均轻微）** | ① `:13`「40 个 `.vue` 组件」→ 实为 **41**（且 40+16+8=64≠65，自述分解不闭合）；② `:32` 旁注把 `style.css` 的 **8012**（正确值）也当成"PowerShell 会少算"的例子 | 少量"**具体表现未验证**"已自行标注（如 `:21` id 冲突的运行时表现）→ 按标注处理即可 |
| **`analysis-backend.md`**（680 行） | **1 处（证据缺口，非结论错误）** | R1（`:594`）**未给任何 `文件:行号`**；R2/R3/R4 行号逐条精确 | ① 明确声明"未运行测试"（`:649`）→ 其"断言覆盖边界"的判断可信，但**不得**把任何"测试通过"归因于它；② R1 需补 `index.js:541/588-590/576/686/876/915-917`；③ V4 对象（§9.2）**不是**风险表中的 S1 |
| **`analysis-desktop-build.md`**（852 行，我） | **4 处** | ① doc9 **A3 作品组**判"✅ 已落地"→ 实为半成品（`:507`）；② doc9 **A4 语义缩放**判"⚠️ 已落地"→ 实为 far 档基本失效（`:508`）；③ §4.2 的**静态**断言计数与运行值有偏差（p18 54 vs **55**、p18-http 24 vs **23**、ui 40 vs **41**、ipadapter 61 vs **62**），虽标了"≈"但仍应以运行值为准；④ `:415` 把 grep 命中数 **57** 写成"57 条路由"（实为 49 条路由 + 8 处 `app.use`），与 backend 报告的 49/66 口径冲突 | ① 文档一致性审计（12 份落地率、跨文档矛盾）本轮复核**仍成立**；② Electron/构建/自动更新/白标/测试基建/发布链路各结论本轮复核**仍成立**；③ **对"界面层功能是否真的可用"的判断整体偏宽**，此类结论一律以 frontend 报告为准；④ 所有路由数字以 §2.2 为准 |

**三份报告合计硬错误：frontend 2 + backend 1 + build 4 = 7 处**（其中 build 的 3 处属**结论性错误**：作品组、语义缩放、路由数口径；其余为计数/证据缺口）。

### 4.2 可直接采信的结论

**`analysis-frontend.md`（可信度最高）**

- 画布引擎机制、`serialize()` 快照粒度、缩放分档链路、`bridge`/`popoutBus` 通信；
- **语义缩放选择器写错**（`:19`）、**作品组半成品**（`:20`）、**restoreGraph 后 id 重复**（`:21`，`store.js:3,191-192` 无重置）、**团队/微信为纯前端假功能**（`:24`，`AccountModals.vue:181-209,212-222` 已核实）、**二维码是伪随机图案**（`:48-66` 已核实）、**幽灵端口**（`ReferenceNode.vue` 无 `<Handle>`，`:190-204`）、`_deprecated/` 407 行死代码、行数与文件清单。
- 采信建议：**除 `:13` 的 40→41 与 `:32` 的旁注外，可整体采信。**

**`analysis-backend.md`（可信度高）**

- 66 条路由逐条表（已用 49+17 全量核对）、五道门实现与默认参数、scrypt 会话、RBAC 权限码 15 / 角色、账本预扣-提交-回滚、支付三路与验签、provider 图生图入参、`upstream.js` 签名与缓存隔离、`vault.js` 双后端、23 条风险（R2/R3/R4 行号精确）。
- 采信建议：**结论可采信；引用 R1 时须补行号；不要把 §9.2 缓存项当作 S1。**

**`analysis-desktop-build.md`（可信度中高，用途需限定）**

- 12 份文档落地率与跨文档矛盾、Electron 主进程/preload/CSP/单实例/动态端口、`updater.cjs` 与 `update-feed.json` 死路、白标打包链路不成立、`build-installer.bat` 目录错、测试基建 13 套件/离线化手法/假通过点、发布前 12 条待办、`src/ports.js` 前提修正。
- 采信建议：**文档一致性与桌面/构建/测试类结论可直接采信；涉及"某界面功能是否落地"的判断须与 frontend 报告对齐后再引用。**

### 4.3 必须打问号的结论

| 结论 | 出处 | 为什么打问号 |
|---|---|---|
| R1 的行号定位 | `analysis-backend.md:594` | 无行号；本次已补（§2.5） |
| "严重项由 4 条修正为 3 条" | `00-总报告.md:355` | 与 backend 报告的 S1 列表（R1–R4）及对抗报告的 V4 定级（中等）均不对应，**计数不成立** |
| "index.js 48 条路由" | `00-总报告.md:62,296` | 漏 `patch`；权威为 **49** |
| "2 个自测 / 30 项断言" | `跨多多AI创作台-完整技术总文档.md:168,1239` | 权威为 14 文件 / 13 套件 / ≈520 断言 |
| "接口总数 51（34+17）" | `跨多多AI创作台-完整技术总文档.md:491` | index.js 已从 34 增至 49 |
| "前端可自行把订单标记为已支付" | `analysis-frontend.md:22` | 实际调用已删路由 → 404，**当下不可利用** |
| doc9 A3/A4 已落地 | `analysis-desktop-build.md:507,508` | 实为半成品 / 基本失效 |
| `serialize()` 丢字段导致"刷新即脱组"的**运行时表现** | `analysis-frontend.md:20` | 代码事实确凿（只导 4 字段），但"脱组后的具体视觉/交互表现"未实机验证（报告亦未声称） |
| `restoreGraph` 后 id 重复的**运行时表现** | `analysis-frontend.md:21` | 同上（报告自标"具体表现未验证"） |
| 所有"性能/内存"类数字（如 `NodeCanvas.vue` 占逻辑代码 15.6%、66.7KB） | `analysis-frontend.md:13` | 文件字节与行数我已复核一致（1894 行 / 66.7KB 量级），但"占比"依赖其口径，属可复算的派生量，非独立事实 |

---

## 五、给 Lead 的修正清单（可直接照改）

| # | 文件:行 | 现状 | 应改为 |
|---|---|---|---|
| 1 | `00-总报告.md:62` | `路由：index.js 48 条 + admin.js 17 条` | `路由：index.js 49 条 + admin.js 17 条`（合计 66；另有 8 处 `app.use` 挂载） |
| 2 | `00-总报告.md:296` | `\| 路由 \| 51 条 \| index.js 48 + admin.js 17 \|` | `\| 路由 \| 51 条 \| index.js 49 + admin.js 17（合计 66）\|` |
| 3 | `00-总报告.md:61` | `server/ 25 个 .js（含 providers 7 个 + 14 个测试）` | `server/ 25 个 .js（server 根 18 + providers 7）；另有 14 个 __*.test.mjs（server 11 + src 3）` |
| 4 | `00-总报告.md:355` | `严重项由 4 条修正为 3 条（V4 降级为中·可用性）` | `V4 的对象不在 23 条风险表内（backend 报告 §9.2 已自述"安全性没问题"），因此 S1 仍为 4 条（R1–R4）；V4 应表述为"§9.2 的缓存键以 sig 为键（非 userId+sig）属实现风格问题，定级为可用性/成本项"` |
| 5 | `analysis-backend.md:594`（R1 行） | 无行号 | 补 `server/index.js:541`（取槽）、`:588-590`（**漏 releaseSlot 的早退**）、`:576/686/907/969`（全仓仅 4 处 release）、`:876/915-917`（视频同病）、`server/security.js:252-263,271` |
| 6 | `analysis-frontend.md:13` | `其中 40 个 .vue 组件` | `其中 41 个 .vue 组件`（41+16+8=65） |
| 7 | `analysis-frontend.md:32` | `因为 1651/8012 这类数字来自 PowerShell 会少算，不可信` | `因为 PowerShell 的 Measure-Object -Line 少算空行、Get-Content 在 UTF-8 无 BOM + 纯 LF 文件上还会按 GBK 解码吞掉换行（实测 newui.css 真值 1660 而 Get-Content 报 1651；style.css 真值 8012，其 Get-Content 报 8012 正确、Measure 报 6860 才是少算）` |
| 8 | `analysis-desktop-build.md:507` | doc9 A3「✅ 已落地」 | `⚠️ 半成品：serialize() 丢 parentNode/extent/hidden/zIndex（NodeCanvas.vue:178-197）→ 撤销/刷新脱组` |
| 9 | `analysis-desktop-build.md:508` | doc9 A4「⚠️ 已落地」 | `❌ 部分未落地：newui.css:9-13,23 的 5 个类名在组件中不存在，far 档仅 textarea/handle 生效` |
| 10 | `analysis-desktop-build.md:415` | `server/index.js 57 条路由中无 /paid` | `server/index.js 49 条路由（另有 8 处 app.use 挂载）中无 /paid` |
| 11 | 全体 | 行数口径不一 | 统一为 **read 工具 / `ReadAllLines`**；禁用 `Get-Content`、`Measure-Object -Line` 数行 |

---

## 六、复现命令（供 Lead 独立验证）

```powershell
# ── 冲突 1：行数权威口径（PS 5.1 下必须用 .NET，避免 GBK 误解码） ──
$p = 'E:\DSH项目\ai-canvas\src\ports.js'
([System.IO.File]::ReadAllLines($p)).Length              # → 126（权威）
(Get-Content -LiteralPath $p).Count                      # → 112（少算，GBK 吞 LF）
(Get-Content -LiteralPath $p | Measure-Object -Line).Lines  # → 101（再少算空行）
$PSVersionTable.PSVersion; (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage' -Name ACP).ACP

# ── 冲突 1 附：行尾普查（146 源码+文档文件中 117 个为纯 LF） ──
$all = Get-ChildItem -Recurse E:\DSH项目\ai-canvas -Include *.js,*.mjs,*.cjs,*.vue,*.css,*.md,*.bat,*.json -File |
       Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\release\\|\\\.tmp\\|\\\.testdata|\\\.rundata\\|\\\.verifydata\\' }
$all | ForEach-Object {
  $r=[System.IO.File]::ReadAllText($_.FullName)
  [pscustomobject]@{ LF=([regex]::Matches($r,"(?<!\r)\n")).Count; CRLF=([regex]::Matches($r,"\r\n")).Count }
} | Group-Object { if($_.LF -gt 0 -and $_.CRLF -gt 0){'mixed'}elseif($_.LF -gt 0){'LF'}else{'CRLF'} } |
  Select-Object Name,Count
# 期望：LF 117 / CRLF 29（共 146）

# ── 冲突 2：路由数（关键：允许缩进 + 包含 patch） ──
$lines=[System.IO.File]::ReadAllLines('E:\DSH项目\ai-canvas\server\index.js')
($lines | Where-Object { $_ -match '^\s*app\.(get|post|put|patch|delete)\s*\(' }).Count   # → 49
($lines | Where-Object { $_ -match '^app\.(get|post|put|delete)\(' }).Count               # → 48（Lead 口径，漏 patch）
$al=[System.IO.File]::ReadAllLines('E:\DSH项目\ai-canvas\server\admin.js')
($al | Where-Object { $_ -match '^\s*app\.(get|post|put|patch|delete)\s*\(' }).Count      # → 17
($al | Where-Object { $_ -match '^app\.' }).Count                                         # → 0（Lead 口径，全部缩进）

# ── 冲突 3：权限码 15 ──
(Select-String -Path E:\DSH项目\ai-canvas\server\rbac.js -Pattern 'code: "admin:').Count   # → 15

# ── 冲突 4：测试规模 ──
(Get-ChildItem -Recurse E:\DSH项目\ai-canvas\server,E:\DSH项目\ai-canvas\src -File |
  Where-Object Name -like '__*.test.mjs').Count                                            # → 14
(Select-String -Path E:\DSH项目\ai-canvas\scripts\run-tests.mjs -Pattern 'await run\(').Count # → 13
```

---

## 七、结论（一段话）

三份报告的**事实密度都很高**，冲突主要不是因为谁在编，而是因为**度量工具口径不一致**与**界面层"文件存在 ≠ 功能可用"的判定宽严不同**：

1. **行数**：`analysis-frontend.md` 与 `analysis-desktop-build.md` 用的 read 工具口径**正确**，Lead 的 PowerShell `Measure-Object` 口径在**全部文件**上少算空行、并在 **80.4%（135/168）的纯 LF 文件**上因 PS 5.1 + ACP 936 的 GBK 误解码额外吞掉换行 —— 本项**以 read 工具/`ReadAllLines` 为准**。
2. **路由数**：`analysis-backend.md` 的 **66（49+17）正确**；Lead 的 48 源于正则漏 `patch`，admin.js 的 0 源于正则锚定行首；总技术文档的 51 源于 v0.1.0 陈旧值 34。
3. **权限码 15 与测试规模（14 文件/13 套件）**：无冲突，三方一致。
4. **后端 4 条严重风险**：R2/R3/R4 行号精确，**R1 需补行号**（结论已被 Lead 的 V1 实测证实为真且更严重）；`00-总报告.md:355` 关于"严重项 4→3"的叙事应予撤回。
5. **最需要下游注意的是我自己报告的 3 处结论性错误**（作品组、语义缩放、路由数口径）—— 前两处应改以 `analysis-frontend.md` 为准（`00-总报告.md:151-152` 的说法是对的），第三处应改以 `analysis-backend.md` 的 **49 条路由**为准。三份报告合计硬错误 **7 处**（frontend 2 / backend 1 / build 4），其中结论性错误 **3 处**且**全部在我的报告里**——这不是说 frontend/backend 报告没有问题，而是本次核查的 6 个指定冲突点里，有 4 个（行数、路由、权限码、测试规模）最终都指向了**度量口径**而非**事实判断**。
