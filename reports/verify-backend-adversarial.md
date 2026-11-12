# 后端高危结论 · 对抗性独立复验报告

复验员：`adversarial-verifier`（独立于 `reports/analysis-backend.md` 的作者）
复验方式：**不看结论先看行为** —— 全部用真实服务端 + 真实 HTTP + 真实模块调用来推翻或坐实，不依赖报告作者的推理。
隔离数据目录：`E:\DSH项目\ai-canvas\.verifydata\{v1a,v1b,v2,v3,v4}`（未触碰 `~/.ai-canvas`，未修改 `server/`、`src/` 任何源码）。
运行环境：`& "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" <脚本>`，子进程一律 `stdio: "inherit"`。

---

## 0. 判定总表（先给结论）

| 编号 | 报告结论 | 判定 | 一句话依据（实测） |
|---|---|---|---|
| **V1** | 严重·可用性：`acquireSlot()` 后「算力不足」早退漏 `releaseSlot()`，2 次即锁死全部生成，只能重启 | ✅ **成立（真）** | 余额 0 账号连发 2 次生成 → `inFlight=2`，第 3 次被拒理由变成「并发过多」；等待 2.5s 不自愈；**余额 500 的超管同样被拒**；图片、视频两条路由均可复现 |
| **V2** | 严重·越权：默认「运营」含 `admin:account:edit/reset`，可自我提权到 `r-super`、可重置超管密码接管 | ✅ **成立（真）** | 纯运营账号 `POST .../reset` 重置超管密码 → 200，再用新密码登录超管成功；`PUT` 自己 `roleIds=["r-super"]` → 200，权限 8→15 条立即生效。**另发现更短路径**：运营可直接 `POST` 建一个 `roleIds=["r-super"]` 的新账号 |
| **V3a** | 严重·账务：`rollback` 幂等键是 `refId`，同输入第二次失败永不退款 | ✅ **成立（真）** | 实测流水 `+100 → reserve(-10) → rollback(+10) → reserve(-10) → reserve(-10)`；第 2 次 `rollback` 返回 `{ok:true,skipped:true}`、`refunded=undefined`，余额永久停在 90；第 3 次再丢 10 |
| **V3b** | 严重·账务：流水超 2000 条裁剪破坏「余额=流水求和」不变式 | ✅ **成立（真）**（机制表述需修正一处） | 累计充值 2100 点 → `balance()` 只剩 **2000**（100 点凭空消失）；`reconcile()` 报 `{userB, sum:2000, recorded:2001}` 不一致。修正：`balance()` 恒等于"剩余流水求和"（同义反复，不会破），真正坏掉的是"余额=全部流水求和"与 `reconcile` 的记录值 |
| **V4** | 中等·安全：缓存"注释称按 userId 隔离、实现是单槽覆盖"，有跨用户串结果风险 | ❌ **误报（就安全结论而言）** | `cacheGet` 在 `upstream.js:197` 做严格 `entry.userId !== userId → null`，实测 B 查 A 的签名恒为 `null`（fail-closed）；不同签名可同时共存（实测条目数=2），**"单槽"不成立**。跨用户只会互相挤掉缓存条目（省钱路径被削弱），不会串结果。报告 9.2 自身也写明"安全性没问题" |

**总的对抗性结论**：报告在 V1–V3 上是对的（且 V2 比它写的还严重）；V4 被列为"安全"结论是**定级误报**。

---

## 1. V1 ✅ 成立 —— 并发槽永久泄漏（实测坐实）

### 代码控制流核对（先看代码，再用行为验证）

```
security.js:252   let inFlight = 0;                    // 模块级全局计数
security.js:254-259 acquireSlot(): inFlight >= maxConcurrent → false；否则 +1
security.js:261-263 releaseSlot(): inFlight = max(-1 钳 0)
security.js:271   maxConcurrent 默认 2
security.js:322   securityStatus() 把 inFlight 暴露给 /api/security

index.js:529  /api/generate
index.js:536      const { send, fail } = openStream(res);
index.js:538-540  三个早退（未知 provider / 空提示词 / 预算熔断）—— 都在 acquire 之前，安全
index.js:541      if (!acquireSlot()) return fail(...)      ← 槽已占用
index.js:576      releaseSlot()                              ← 唯一的中途释放点：缓存命中分支
index.js:588-590  if (!reserved.ok) { return fail(`算力不足…`) }   ← ★ 早退，无 releaseSlot()
index.js:684-688  } finally { … releaseSlot(); res.end(); }  ← 唯一的 finally
index.js:876      /api/generate-video 同样的 acquireSlot()
index.js:907      releaseSlot()（视频缓存命中分支）
index.js:915-917  if (!reserved.ok) { return fail(`算力不足…`) }   ← ★ 同病
index.js:968-971  } finally { releaseSlot(); … }
```

**"有没有兜底"的逐项排除**（这是本次复验的重点，因为报告可能漏看兜底）：
- `acquireSlot` 内部**没有** try/finally，只做计数（`security.js:254-259`）。
- 全仓库 `releaseSlot` 的调用点只有 4 处（`grep` 结果）：`index.js:576/686/907/969` —— 全部在上述两个生成路由内，没有任何中间件、错误处理器或定时器会兜底释放。
- `inFlight` 无 TTL、无时间衰减、无启动外重置；`/api/security` 只读不可写。
- 唯一"自愈"手段是进程重启；把 `maxConcurrent` 调大只是抬高天花板，已泄漏的计数不会归还（`security.js:255` 每次都重新读 `limits()`，但无任何递减路径）。

→ **报告没错，代码里确实没有兜底。**

### 实测输出（`reports/verify/out-v1.txt`）

Part A：图片路由（余额 0 的「运营」账号 op1，连发 3 次）

```
  第 2 个账号 op1 的默认角色 roleIds=["r-operator"]（第 1 个是超管，其余默认运营）
  ✅ op1 余额为 0（未访问过赠送接口）  balance=0
  ✅ 初始 inFlight=0，maxConcurrent=2  inFlight=0 maxConcurrent=2
  请求#1: event=error msg="算力不足：本次需要 10 点，当前余额 0 点，请先充值" → inFlight=1
  请求#2: event=error msg="算力不足：本次需要 10 点，当前余额 0 点，请先充值" → inFlight=2
  请求#3: event=error msg="同时进行的生成任务过多，请等前一个完成后再试" → inFlight=2
  ✅ 【缺陷】等待 2.5 秒后仍锁死（无超时自愈）  inFlight=2 msg="同时进行的生成任务过多…"
  ✅ 【缺陷】超管（余额充足）同样被拒：全局锁死，非单账号  boss balance=500 msg="同时进行的生成任务过多…"
```

关键点：第 3 次被拒的文案从 `算力不足` 变成 `同时进行的生成任务过多` —— 这条文案只可能来自 `index.js:541` 的 `!acquireSlot()`，**因果链闭合**：两次"算力不足"各泄漏 1 个槽。
另测出报告未强调的一点：**这是进程级全局锁死**，同一台机器上余额充足的超管也被拒（`inFlight` 不是 per-user 的）。

Part B：视频路由（同病）

```
  请求#1: msg="算力不足：本次需要 120 点…" → inFlight=1
  请求#2: msg="算力不足：本次需要 120 点…" → inFlight=2
  请求#3: msg="同时进行的生成任务过多…" → inFlight=2
```

复现脚本：`reports/verify/v1-slot-leak.mjs`（10 条断言全通过，0 不符）。

---

## 2. V2 ✅ 成立 —— 「运营」角色可越权提权 / 重置超管密码（实测坐实）

### 代码证据链

| 环节 | 证据 |
|---|---|
| 「运营」是**内置**角色 | `rbac.js:52-67`（`id:"r-operator"`, `builtin:true`） |
| 「运营」确实持有 `admin:account:edit` + `admin:account:reset`（还有 `create`） | `rbac.js:57-66` |
| 「运营」是**新账号默认角色**（会被自动授予） | `accounts.js:124-127 defaultRoleIds(isFirst)`：首位 `r-super`，其余 `r-operator`；`accounts.js:160` 无 `roleIds` 时走该默认；`accounts.js:99-102`/`307` 老数据兜底也补成 `r-operator`；`accounts.js:401-404 migrateUsers()`：凡 `role !== "admin"` 一律 `r-operator` |
| 默认 `dataScope = "all"`，连行级过滤的最弱形式都没有 | `accounts.js:138`（默认参数）、`accounts.js:162`、`accounts.js:406` |
| 路由①：`PUT /api/admin/accounts/:id` 只查 `admin:account:edit` | `admin.js:117-127` |
| → `updateUser` 直接落盘 `roleIds`，**无"仅超管可授予 r-super"校验** | `accounts.js:204 if (patch.roleIds) u.roleIds = patch.roleIds;`；唯一保护是"不能把最后一个超管降级"（194-199） |
| 路由②：`POST /api/admin/accounts/:id/reset` 只查 `admin:account:reset` | `admin.js:158-169` |
| → `adminResetPassword` 对**目标无任何超管保护** | `accounts.js:235-245`（只校验新密码长度、目标存在） |
| 写接口**完全不走**行级数据权限（`applyDataScope` 只在 GET 列表用） | 对照 `admin.js:83`（列表用）vs `admin.js:117-181`（写接口无一调用） |
| 权限判定本身无问题（问题在设计） | `index.js:107-119 requirePerm` + `rbac.js:189-194 hasPermission` |

### 实测输出（`reports/verify/out-v2.txt`）

```
  ✅ 首位账号自动成为超管  bossId=8df9c2ed
  ✅ 第 2/3 个账号默认被授予「运营」r-operator  op1=["r-operator"] op2=["r-operator"]
  op1 登录后 roleIds=["r-operator"] perms=[…8 条，含 admin:account:edit / admin:account:reset / admin:account:create]
  ✅ 【越权】运营成功重置超管密码（HTTP 200 ok）  status=200 body={"ok":true}
  ✅ 【越权】用被重置的新密码成功登录超管账号 → 完整接管  status=200 roleIds=["r-super"]
  ✅ 【越权】运营 PUT 自己 roleIds=["r-super"] 成功（HTTP 200 ok）  status=200 roleIds=["r-super"]
  ✅ 【越权】权限立即落地：从运营权限变为全量权限  before=8 条 → after=15 条
  ✅ 【附加】运营 create 接口直接创建 roleIds=["r-super"] 的账号（无 roleIds 白名单）  status=200
  ✅ 【附加】新账号可直接登录并持有超管身份  roleIds=["r-super"]
```

**比报告更严重的一点（复验新增）**：报告只写了"PUT 提权 + reset 接管"两条路。实测还有**第 3 条、更短**的路：`POST /api/admin/accounts` 由 `admin.js:111` 把 `req.body` 整体交给 `createUser`，而 `accounts.js:160` 对入参 `roleIds` 不做任何白名单/权限校验 —— 运营一次请求就能**凭空创建一个超管账号**（无需改自己的角色）。三条路全部 HTTP 200。

复现脚本：`reports/verify/v2-privesc.mjs`（11 条断言全通过）。

---

## 3. V3 ✅ 成立（R3 幂等键 + R4 裁剪，两项均实测坐实）

### V3-A：幂等键到底是什么 → 就是 `refId`，代价是第二次失败不退款

代码：`credits.js:163-164` 的 `already = rows.some(r => r.type==="rollback" && r.refId===refId)` 是**全表按 refId** 判重；而 `reserve`（`credits.js:129-151`）**没有任何幂等判重**，同一 refId 可反复预扣。路由侧 `index.js:581 findConsumed` 只在有 `consume` 记录时才算 replay，而失败路径从不写 `consume`（`credits.js:188-206` 只在成功时调用），所以第二次重试必然重新预扣 —— 然后被第一次的 `rollback` 记录判成"已回滚"。

实测（隔离目录 `.verifydata/v3`，直接调用与路由同一份 `credits.js`）：

```
  第 1 次失败: replay=false 预扣=10 reserve后余额=90 rollback.refunded=10 (skipped=false) 回滚后余额=100
  第 2 次失败: replay=false 预扣=10 reserve后余额=90 rollback.refunded=undefined (skipped=true) 回滚后余额=90
  第 3 次失败: replay=false 预扣=10 reserve后余额=80 rollback.refunded=undefined (skipped=true) 回滚后余额=80
  流水：recharge(+100) → reserve(-10) → rollback(+10) → reserve(-10) → reserve(-10)
  ✅ 对照：不同 refId 的失败能正常退回（证明缺陷根因是 refId 幂等键）  refunded=10
```

三项关键确认：
1. 第 2 次确实**重新预扣**（`reserved=true`，不存在"报告误以为会重扣"的偏差）；
2. `rollback` 返回 `{"ok":true,"skipped":true}`，`refunded` 为 `undefined` → 路由 `index.js:681 refunded: rb.refunded || 0` 给前端报 **0**；
3. **不是"只丢一次"**：第 3 次再丢 10，流水里两笔 `reserve(-10)` 永久裸露，无任何自动补偿接口（`/api/credits/reconcile` 仅 `index.js:191` 只读）。

### V3-B：2000 条裁剪 —— 结论成立，但报告对"不变式"的表述要修正

代码：`credits.js:95-97` `if (length > 2000) rows = rows.slice(-2000)`；`credits.js:73-77 balance() = 剩余 rows.amount 求和`；`credits.js:332-342 reconcile()` 比较"最后一条 `balanceAfter`"与"流水求和"。

实测（同一用户累计 2100 笔 × 1 点）：

```
  累计 grant 2100 笔 × 1 点 → 用户应持有 2100 点
  裁剪后保留条数=2000  剩余流水求和=2000  balance()=2000  最后一条.balanceAfter=2001
  ✅ 【缺陷】用户实际余额比累计充值少 100 点（2100 → 2000，被裁记录凭空消失）
  ✅ 【缺陷】reconcile() 报不一致：最后一条 balanceAfter(2001) ≠ 流水求和(2000)
     实测返回：{"ok":false,"mismatched":[{"userId":"userB","sum":2000,"recorded":2001}]}
```

**判定：报告的后果描述正确，机制措辞需要修正一处**（这是复验要澄清的、容易被下游误用的点）：
- `balance()` 是"对剩余流水求和"，所以 **"余额 = 剩余流水求和"这个式子是同义反复，永远不会破**（实测 `sum=2000 == balance=2000`）。如果按字面理解 R4，会得出"不变式没坏"的错误反驳。
- 真正坏掉的是：① **"余额 = 全部流水求和"**（用户被授予 2100，账上只剩 2000，100 点静默蒸发）；② `reconcile()` 的落盘校验（`last.balanceAfter=2001` vs `sum=2000`）**永久不一致**。
- 即"裁剪让账不可信、余额凭空减少"的**影响判断是对的**，只是不要把它论证成"求和公式自相矛盾"。

复现脚本：`reports/verify/v3-ledger.mjs`（12 条断言全通过）。

---

## 4. V4 ❌ 误报 —— 缓存不存在跨用户串结果（"单槽覆盖"不成立）

### 代码核对

```js
upstream.js:160-167  readCache(): { entries: {…} }            // entries 是"多条目 Map"
upstream.js:191-204  cacheGet(sig, userId):
  194   const entry = c.entries[sig];
  197   if (String(entry.userId||"") !== String(userId||"")) return null;   // ★ 严格隔离
upstream.js:211-234  cachePut(sig, {… userId}):
  216   c.entries[sig] = { …, userId: String(userId||"") };
  226-232 超过 MAX_ENTRIES=500 才按 ts 淘汰最旧
```

调用点也把 userId 传对了：`index.js:557 cacheGet(sig, chargeUser)`、`index.js:650-652 cachePut(sig, {… userId: chargeUser})`（视频同理 888/942）。

### 实测输出（`reports/verify/out-v4.txt`）

```
  ✅ A 自己的缓存能命中
  ✅ 【关键】B 查询同一签名拿不到 A 的结果（跨用户不串结果）  cacheGet(sigA,'userB')=null
  ✅ 同签名被 B 覆盖后，A 再查仍是 null（失败关闭，绝不泄漏 B 的图给 A）
  ✅ B 只能拿到 B 自己的结果
  ✅ 【关键】不同签名可共存（不是『单槽覆盖』）：缓存条目数 = 2  total=2
  缓存文件实际结构：entries 的键 = ["usig_v2_e0c514183a23…","usig_v2_c0eb9ce5c908…"]
  每个条目的 userId：["userB","userA"]
```

三点结论：
1. **零跨用户泄漏**：隔离是 fail-closed 的（不匹配即 `null`），B 无论如何拿不到 A 的 URL；
2. **"单槽覆盖"是错的**：`entries` 是按签名分键的多条目表，实测两个不同签名各自保留自己的 `userId` 并可同时命中；
3. 唯一真实（且轻微）的副作用：**同一签名的跨用户写入会挤掉对方那一条**，A 的省钱缓存被静默失效 → 可用性/成本优化被削弱，属 `S3` 级，**不是安全问题**。报告 9.2 自己已写明"安全性没问题"。
   → 因此把 V4 归入"中等·安全"是**定级误报**；如需保留，应改述为"同签名缓存条目互相挤占（可用性）"。

---

## 5. 复验产物与可重复性

| 文件 | 内容 | 实测结果 |
|---|---|---|
| `reports/verify/v1-slot-leak.mjs` / `out-v1.txt` | 起真实服务端（隔离数据目录），图片+视频两条路由的槽泄漏复现 | 断言 10 通过 / 0 不符 |
| `reports/verify/v2-privesc.mjs` / `out-v2.txt` | 纯运营账号的三条越权路径（reset 超管 / PUT 自提权 / create 造超管） | 断言 11 通过 / 0 不符 |
| `reports/verify/v3-ledger.mjs` / `out-v3.txt` | 直接调用 `credits.js`：refId 幂等 + 2000 条裁剪 | 断言 12 通过 / 0 不符 |
| `reports/verify/v4-cache.mjs` / `out-v4.txt` | 直接调用 `upstream.js`：跨用户隔离 + "单槽"证伪 | 断言 7 通过 / 0 不符 |

复现方式（与本次一致）：

```powershell
$node="C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$env:AI_CANVAS_HOME="E:\DSH项目\ai-canvas\.verifydata"
& $node "E:\DSH项目\ai-canvas\reports\verify\v1-slot-leak.mjs"
& $node "E:\DSH项目\ai-canvas\reports\verify\v2-privesc.mjs"
& $node "E:\DSH项目\ai-canvas\reports\verify\v3-ledger.mjs"
& $node "E:\DSH项目\ai-canvas\reports\verify\v4-cache.mjs"
```

约束遵守情况：未修改 `ai-canvas` 下任何现有源码（`server/`、`src/` 近 30 分钟无写入）；所有脚本用 `stdio:"inherit"`；所有数据写入 `.verifydata/`（工作区内），未触碰 `%USERPROFILE%\.ai-canvas`；唯一新增报告即本文件。

---

## 6. 本次复验改变了什么认知

1. **V1 从"报告说漏了 release"升级为"可被任意人一键瘫痪服务端"**：泄漏的 `inFlight` 是**进程级全局**的，不区分账号 —— 一个余额为 0 的普通账号（新建账号默认余额 0，什么都不用做）发 2 个请求，就能让**全机器所有人**（含超管）永久无法生成，直到重启。报告把它描述成"最容易在演示现场踩到的 bug"，实际上是**未授权 DoS**，严重度被低估。
2. **V2 的利用面比报告写的更宽**：报告给了 2 条路，实测有 3 条，且最短的一条（`create` 直造超管）不需要改动自己的角色、不需要目标账号是超管 —— 只要默认「运营」角色在，权限体系就没有任何一层能挡住它。这也说明修复不能只补 `updateUser` 和 `adminResetPassword`，`createUser` 的 `roleIds` 同样要收口。
3. **V3 的"幂等键"错误是真资损且可累加**：不是"某次特殊情况退不了"，而是"同一输入每失败一次就稳定丢一单的钱"，重试越多丢越多，且没有任何自动对账补偿（`reconcile` 只报不修）。
4. **V4 是一处定级误报**：把"实现与注释的措辞不完全一致"（键是 sig 而非 userId+sig）读成了安全隐患。实测隔离严格 fail-closed，跨用户拿不到任何结果；真实代价只是同签名缓存互相挤占。**结论：V4 不应作为安全风险上报，应降级为可用性/成本优化项。** 这也提醒后续复验要区分"实现风格与注释不符"和"安全边界失效"。
5. **一处需要修正的下游措辞**：V3-B 不要写成"余额=流水求和的自洽性被破坏"，正确表述是"裁剪让余额与累计流水脱钩、`reconcile` 永久报不一致"。否则会被"`sum == balance` 恒成立"轻易反驳掉一个本来成立的结论。
