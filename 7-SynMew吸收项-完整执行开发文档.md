# 跨多多 AI 创作台 · SynMew 吸收项 —— 完整执行开发文档

> 版本 v1.0 ｜ 日期 2026-09-25 ｜ 状态：**5 项全部落地并通过自测**（不是设计稿，代码已进仓库）
> 上游依据：`6-SynMew无限画布-穿透拆解与方案同步.md`、`5-统一主方案V1-差距分析与实施路线.md`
> 本文回答三件事：**改了什么 / 为什么这么改 / 怎么验收与回滚**

---

## 0. 一页结论

### 0.1 本轮交付的 5 项

| 编号 | 吸收项 | 来源（SynMew 证据） | 落地形态 | 工期 |
|---|---|---|---|---|
| **P0-9** | 强类型端口 | 连线带 `dataType`（image / string / ai-image / video） | 新增 `src/ports.js`，连线阶段校验 + 端口着色 | +1 天 |
| **P1-5** | 批量简化 | 10 变体 = 客户端文件夹批量 + 磁盘进度文件，无服务端编排器 | 新增 `src/batch.js` + `server/batch.js`，10 张拆 4+4+2 | **省 3 天** |
| **P1-8** | 上游签名 | `workshopUpstreamSignature` 防重复扣费 | 新增 `server/upstream.js`，签名作账本 refId + 结果缓存（**第二轮已全面执行**，见 `8-P1-8上游签名-完整执行文档.md`） | +3 天 |
| **P2** | 模板反哺 | `template_save_from_project`（画布存为模板） | 新增 `POST /api/templates/from-project` + 顶栏「存为模板」 | +1 天 |
| **P2** | 凭据结构 | `data/secrets/*.enc` 每条密钥一个加密文件 | 重写 `server/vault.js` + 旧单文件自动迁移 | +0.5 天 |

**净工期：+2.5 天**（P1-5 省下的 3 天抵扣了 P0-9 / P1-8 / P2 共 5 天；P1-8 第二轮全面执行追加 1 天：视频通路扣费、缓存用户隔离、版本化与 sweep、端到端测试）。

### 0.2 不做的事（已决策，不再讨论）

| 项 | 决策 | 理由 |
|---|---|---|
| 迁移 Tauri 2 | **不做** | electron-updater / 多窗口 / CSP / 打包链路全部重写，2–3 周换不来用户可感知价值；SynMew 只有「凭据分文件」这一条结构优势，已单独抄过来 |
| 服务端批量编排器 | **不做** | 客户端分批 + 磁盘进度文件同样能断点续跑，服务端保持无状态 |
| 双画布（tabs / resultTabs） | **暂不做** | 属于方案 §4 三视图范围，不在本轮吸收清单 |
| 128 个 chunk / 60+ MCP 工具 | **不做** | 数量不等于价值，优先补齐 P0-0（真图生图）这条阻断链路 |

### 0.3 验证结果（本次实跑）

```
npm test
  算力账本      通过     （16 项，预扣/回滚/去重/并发）
  支付回调      通过     （14 项，伪造签名 / 无签名 / 金额不符均 400）
  吸收项（单元）  通过     （29 项：签名 7 / 批量 9 / 模板反哺 9 / 保险箱 4）
  吸收项（接口）  通过     （15 项：批量接口 7 / 模板反哺接口 6 / 生成入参透传 2）

npx vite build     ✓ 1648 modules transformed，无报错
```

### 0.4 新增 / 改动文件一览

| 文件 | 类型 | 说明 |
|---|---|---|
| `src/ports.js` | 新增 | 端口类型注册表 + 连线校验 + 边着色 |
| `src/batch.js` | 新增 | 客户端批量编排（分批 + 续跑） |
| `server/upstream.js` | 新增 | 上游签名 + 结果缓存 |
| `server/batch.js` | 新增 | 批量进度落盘 |
| `server/__sync.test.mjs` | 新增 | 吸收项单元测试（29 项） |
| `server/__vault.test.mjs` | 新增 | 保险箱分文件 + 迁移测试 |
| `server/__sync-http.test.mjs` | 新增 | 吸收项 HTTP 端到端（15 项） |
| `server/vault.js` | **重写** | 每条密钥一个 `.enc` + 旧文件迁移 |
| `server/templates.js` | 改动 | `sanitizeGraph` / `saveFromProject` / `graph` 字段 |
| `server/credits.js` | 改动 | 新增 `findConsumed()` |
| `server/index.js` | 改动 | 生成接口幂等改造 + 6 个新路由 |
| `src/components/NodeCanvas.vue` | 改动 | 端口校验 / 分批执行 / 导出图 / 铺模板图 |
| `src/components/StudioView.vue` | 改动 | 顶栏「存为模板」 |
| `src/components/TemplatesView.vue` | 改动 | 点击「我的模板」→ 拉节点图铺开 |
| `src/components/nodes/*.vue` | 改动 | 端口加 `data-port` 类型标记 |
| `src/api.js` / `src/store.js` / `src/style.css` / `scripts/run-tests.mjs` | 改动 | 接口封装 / 待铺模板状态 / 端口配色 / 测试串接 |

---

## 1. 设计总则（5 项共用）

1. **服务端保持无状态**：批量进度、模板图都落在磁盘文件上，服务端不为任何一个用户任务常驻内存结构。
2. **失败可见、扣费可逆**：任何一条改造路径都不允许「用户没拿到结果却扣了算力」。
3. **清洗再落盘**：画布数据进模板前必须剔运行时状态与 base64；密钥进文件前必须加密。
4. **可回滚**：每一项都保留旧结构或旧字段，出问题能退回上一版行为（本文每项都给了回滚步骤）。
5. **不猜、实测**：所有结论（签名是否变化、缓存是否命中、文件是否落盘）都由脚本跑出来，不靠印象。

---

## 2. P0-9 强类型端口（+1 天）

### 2.1 改造前的证据

- `src/components/nodes/ExecutorNode.vue` 声明了三个 target handle：`prompt` / `product` / `style`。
- `ProductNode.vue` / `StyleNode.vue` 的 source handle 分别叫 `product` / `style`，`PromptNode.vue` 叫 `prompt`。
- Vue Flow **只校验 handle 是否存在，不校验语义**：把「产品图」拖到执行节点的 `prompt` 口上，连线照样建立。
- 结果：`NodeCanvas.vue` 的 `generateImage()` 里先按 `src.type` 归类，发现没有 prompt 才提示「请先连接「画面描述」节点并输入描述」——**用户连错了线，要等到点执行才知道，而且提示完全没提"连错口"**。

### 2.2 设计

| 数据类型 | 颜色 | 出现在 |
|---|---|---|
| `image` | `#2563EB` 蓝 | 产品图 / 服装图 / 风格参考（输出），执行节点 product、style 输入 |
| `string` | `#0EA5E9` 青 | 画面描述（输出），执行节点 prompt 输入 |
| `ai-image` | `#7C3AED` 紫 | 执行节点结果输出 → 结果节点输入 |
| `video` | `#DB2777` 粉 | 视频参考节点输出（预留） |
| `audio` | `#F59E0B` 橙 | 音频（预留） |

**放行规则**：输入口可声明多种可接受类型（`result` 节点同时吃 `ai-image` 与 `video`）；未声明类型的端口不拦截（兼容自定义节点），但也不着色。

### 2.3 改动清单

**① 新增 `src/ports.js`（126 行）**

```js
export const NODE_PORTS = {
  product:   { outputs: [{ id: "product", type: "image", label: "产品/服装图" }] },
  style:     { outputs: [{ id: "style",   type: "image", label: "风格参考"  }] },
  prompt:    { outputs: [{ id: "prompt",  type: "string",label: "画面描述"  }] },
  reference: { outputs: [{ id: "result",  type: "video", label: "视频结果"  }] },
  executor: {
    inputs: [
      { id: "prompt",  type: "string", label: "画面描述" },
      { id: "product", type: "image",  label: "产品图"   },
      { id: "style",   type: "image",  label: "风格参考" }
    ],
    outputs: [{ id: "result", type: "ai-image", label: "生成结果" }]
  },
  result: {
    inputs: [
      { id: "result", type: "ai-image", label: "生成结果" },
      { id: "result", type: "video",    label: "视频结果" }
    ]
  }
};

export function validateConnection({ sourceType, sourceHandle, targetType, targetHandle }) { /* … */ }
export function edgeStyleFor(dataType) { return { strokeWidth: 1.6, strokeDasharray: "6 5", stroke: typeColor(dataType) }; }
```

拒绝时给出人话提示，例如：
> 类型不匹配：「产品/服装图」输出的是 图片，而「画面描述」只接受 文本

**② `NodeCanvas.vue`**

| 位置 | 改动 |
|---|---|
| `isValidConnection()`（:51） | 拖拽过程中高频调用，只判断不弹窗，把原因存进 `lastReject` |
| `onConnectEnd()`（:65） | 松手时一次性弹出 `ElMessage.warning(lastReject)`，避免刷屏 |
| `onConnect()`（:72） | 补 `dataType` + 按类型着色；**做一次去重**（Vue Flow 部分配置会自行加边，避免连出两条） |
| `serialize()` / `exportGraph()`（:148） | 序列化保留 `dataType`，撤销重做 / 存模板都不丢语义 |
| `applyWorkflow()`（:495） | 铺工作流时每条边都过一遍 `validateConnection`，得到 `dataType` 与配色 |
| 模板 | `<VueFlow :is-valid-connection="isValidConnection" @connect="onConnect" @connect-end="onConnectEnd">` |

**③ 节点组件**：6 个 Handle 加 `data-port="image|string|ai-image"` 与 `title`（悬停说明），`style.css` 按 `[data-port]` 上色。

### 2.4 自测覆盖（P0-9 相关）

签名/批量/模板测试里对 dataType 的校验：`__sync.test.mjs` 断言「连线保留 dataType」；`sanitizeGraph` 对未声明类型端口放行。

### 2.5 人工验收（3 分钟）

1. `npm run desktop`（或 `npm run dev` + `npm run server`）进入创作台，点左侧「图生图」铺一套工作流。
2. 从**产品图节点的输出口**拖一条线到执行节点的**最上面那个口**（prompt 口）→ 线**连不上**，松手后弹出「类型不匹配…」提示。
3. 改拖到**中间那个口**（product）→ 连上，线呈**蓝色**；从提示词节点连到最上口 → 线呈**青色**；执行节点到结果节点 → **紫色**。
4. 鼠标悬停端口，能看到「输入：图片（产品/服装图）」这类说明。
5. Ctrl+Z 撤销后 Ctrl+Shift+Z 重做 → 连线颜色与类型仍在（证明 `dataType` 进了快照）。

### 2.6 回滚

删除 `NodeCanvas.vue` 上 `:is-valid-connection` / `@connect` / `@connect-end` 三个绑定即回到旧行为；`src/ports.js` 保留不影响（未被引用时不被打包进产物之外的位置）。Handle 上的 `data-port` 只是属性，删不删都不影响功能。

---

## 3. P1-5 客户端批量编排（省 3 天）

### 3.1 为什么不做服务端编排器

| 方案 | 服务端要写什么 | 代价 |
|---|---|---|
| 服务端编排 | 任务队列 + 进度推送 + 断连重放 + 超时清理 + 并发控制 | ≈3 天，且要长期维护一个有状态子系统 |
| **客户端分批 + 进度落盘（选）** | 3 个纯文件读写的路由 | ≈0.5 天，服务端无状态，崩溃可续跑 |

SynMew 的 10 变体就是**客户端把 10 拆成多批顺序调用 + 进度写磁盘**，我们照抄。

### 3.2 数据模型

进度文件：`{AI_CANVAS_HOME}/batches/<batchId>.json`

```json
{
  "id": "bm9xk2ab3c",
  "label": "即梦 Seedream 4.0 × 10 张",
  "total": 10, "perBatch": 4,
  "payload": { "provider": "jiemeng", "prompt": "…", "size": "1024x1024", "referenceImages": [] },
  "items": [ { "index": 0, "status": "ok", "images": [{ "url": "/outputs/1.png" }], "error": "" } ],
  "done": 2, "failed": 0, "status": "running",
  "createdAt": 1758000000000, "updatedAt": 1758000000000
}
```

### 3.3 接口契约

| 方法 | 路径 | 作用 | 备注 |
|---|---|---|---|
| POST | `/api/batch` | 创建进度文件 | body：`{id,total,perBatch,label,payload}` |
| PUT | `/api/batch/:id` | 写回某一批结果 | body：`{index,status:"ok"\|"failed"\|"pending",images,error}` |
| GET | `/api/batch` | 列出可续跑任务 | 按更新时间倒序，20 条 |
| GET | `/api/batch/:id` | 读进度 + 已完成图片 | 续跑入口 |
| DELETE | `/api/batch/:id` | 删除 | |

**安全**：`safeId()` 只保留 `[A-Za-z0-9_-]`，`../../evil` → `evil`，杜绝路径穿越（已断言）。

### 3.4 客户端编排（`src/batch.js`）

```js
export const MAX_PER_BATCH = 4;                     // 必须与服务端一致
export function planBatches(total, perBatch = 4) { /* 10 → [4,4,2] */ }

export async function runBatches({ payload, total, batchId, label, onProgress, stopOnError = true }) {
  const existing = (await batchGet(id))?.batch || null;   // 续跑：读回进度
  // …
  for (let i = 0; i < plans.length; i++) {
    if (prev?.status === "ok") { images.push(...prev.images); continue; }  // 已成功批次直接复用，不再扣费
    await generateStream({ ...payload, n: plans[i], batchId: id, batchIndex: i }, …);
    await batchUpdate(id, { index: i, status: "ok", images: got });
  }
}
```

**`NodeCanvas.vue` 的 `generateImage()`（:296）**：

- `total ≤ 4` → 单批直调 `/api/generate`（不多一次 IO）；
- `total > 4` → `runBatches()`，状态栏实时显示 `批量 6/10 张 · 第 2/3 批完成`；
- 若读到已有进度 → 提示「已恢复上次未完成的批量任务，只对缺失批次计费」。

**配套**：`store.js` 各模型 `counts` 由 `[1,2,4]` 放开到 `[1,2,4,8,10]`（国内/本地模型为 `[1,2,3,4,8,10]`）。

### 3.5 自测覆盖（9 项，`__sync.test.mjs`）

创建 10 项 / 完成 8 张 / 失败 1 批 / 结果取回 / 重复提交不回退 / 文件落盘 / 可列出 / 穿越 id 净化 / 删除后不可读。

### 3.6 人工验收

1. 提示词节点把张数选到 **10 张**，点执行。
2. 观察状态栏：`批量 4/10 张 · 第 1/3 批完成` → 第 2 批 → 第 3 批（**不再出现「一次只能 4 张」的限制**）。
3. 生成到第 2 批时**直接关掉应用**；重开、再点一次执行 → 提示「已恢复上次未完成的批量任务」，第 1 批不再重新扣费（`GET /api/batch` 能看到那条任务）。

### 3.7 回滚

`NodeCanvas.vue` 里把 `total <= MAX_PER_BATCH` 的判断删掉、恢复成直接传 `n: promptNode.data.count` 即可；服务端 `/api/batch/*` 路由不调用就零影响。

---

## 4. P1-8 上游签名（+2 天）

### 4.1 要解决的场景

用户在结果节点改个备注、改个标题，再点一次「重新生成」→ 服务端当成全新任务重新预扣 10 点。用户视角：**什么都没变，又被扣了一次**。

### 4.2 设计

**签名 = 只把影响模型输出的字段规范化后取 sha256**，用这个哈希作为账本 `refId`。

| 参与签名 | 不参与（改了也不扣费） |
|---|---|
| provider、model、prompt、negativePrompt、size、n、steps、cfg、seed、referenceImages | **remark（备注）**、任务标题、batchId、时间戳、UI 状态 |

参考图取文件内容 `sha256`（本地 `/outputs/…` 读文件；远程直链退化为 URL 字符串），**顺序不敏感**（换参考图顺序不算新任务）。

### 4.3 三级判定链（`/api/generate`，`server/index.js:523`）

```
① 命中结果缓存（文件仍在 + TTL 内）  → 零扣费，直接返回上次图片（cached=true）
② 缓存没了，但账本里该 refId 已 consume → 重跑，不预扣（replay=true）
③ 都没有                              → 正常预扣 → 成功 commit / 失败 rollback
```

关键防御：**`rollback` 只在真的预扣过时才执行**。否则 replay 场景会把历史上那笔预扣重复退掉（凭空刷出算力）。

```js
const rb = reserved.reserved ? await credits.rollback(chargeUser, refId) : { refunded: 0 };
```

**缓存** `gen-cache.json`：TTL 12 小时（`AI_CANVAS_CACHE_TTL` 可调），最多 500 条 LRU 淘汰，返回前逐个校验落地文件是否还在（outputs 被清理则自动失效）。

### 4.4 契约变化

`/api/generate` 请求新增字段（全部可选，旧客户端不受影响）：

| 字段 | 说明 |
|---|---|
| `model` | 模型 id，进签名 |
| `referenceImages` | `[{url,name,sha256}]`，进签名（P0-0 修好后即为真图来源） |
| `remark` | 备注，**不进签名** |
| `batchId` / `batchIndex` | 批量溯源，不进签名 |

SSE `done` 事件新增：`cached`（命中缓存）、`replay`（已付费重跑）、`signature`。

### 4.5 自测覆盖

首轮 7 项断言已并入全面版：

```
✅ 签名非空且带版本号 usig_v2_xxx
✅ 改备注重跑 → 签名不变（不重复扣费）
✅ 改任务标题 → 签名不变
✅ 改提示词 → 签名变化（正常计费）
✅ 参考图顺序不同 → 签名相同
✅ 空入参不产生签名
✅ 落地文件已丢失时缓存不命中
```

> **第二轮已做「全面执行」，本节不再是最权威说明。**
> 见 **`8-P1-8上游签名-完整执行文档.md`**：
> 补齐视频通路扣费（原来完全没扣）、缓存按 userId 隔离（原为全局共享漏洞）、
> 签名版本化 + 启动全量 sweep、素材只按内容哈希、前端显示省了多少点，
> 测试扩到 **55 项单元 + 23 项 HTTP 端到端**。

### 4.6 人工验收（P1 验收新增项）

1. 生成 4 张 → 记录算力余额 A。
2. 在结果节点改备注 → 再点执行 → 提示「命中历史结果，本次未扣算力」→ 余额 **仍为 A**。
3. 改一个字（提示词）→ 再执行 → 正常扣费，余额下降。
4. 后台 `GET /api/credits/records` 能看到 `refId` 是 `usig_` 开头的哈希（不是随机 id）。

### 4.7 回滚

`server/index.js` 里把 `const refId = sig || newId()` 改回 `const refId = newId()`，即退回「每次都算新任务」的旧行为；`upstream.js` 保留不动。

---

## 5. P2 模板反哺（+1 天）

### 5.1 设计要点

**画布不能直接存**：直接 `JSON.stringify` 会把 `busy: true`、`status: "生成中"`、上一次的 `images`、base64 缩略图全带进去 —— 铺出来的模板一上来就是「执行中」，还带着别人的图。

**落盘前强制清洗**（`server/templates.js`）：

| 清洗项 | 规则 |
|---|---|
| 运行时字段 | `busy / status / error / errors / saving / saveMsg / progress / images / videos / audios / hasPrompt / hasProduct / hasStyle` 全部剔除 |
| 素材引用 | 只留 `id/name/url/kind/size/mime/w/h`，**绝不存 base64** |
| 悬空连线 | 两端有任一不在图里就丢弃 |
| 节点 id | 存为 `key`，铺开时重新生成真实 id（避免 id 冲突） |
| 幂等 | `sanitizeGraph` 对已清洗过的图再跑一次结果不变（`id/key`、`source/from` 两种写法都认） |

### 5.2 数据结构

```json
{
  "nodes": [ { "key": "n1", "type": "product", "position": {"x":0,"y":0}, "data": { "title":"毛衫", "role":"outfit", "file": {"name":"a.png","url":"/materials/clothing/a.png"} } } ],
  "edges": [ { "from":"n1", "to":"n3", "sourceHandle":"product", "targetHandle":"product", "dataType":"image" } ],
  "viewport": { "x": 0, "y": 0, "zoom": 1 }
}
```

模板记录新增字段：`graph`、`source: "project"`、`author`、`createdAt`、`updatedAt`。

### 5.3 接口与 UI

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/templates/from-project` | 需登录；空图 / 无名称 → 400 |
| GET | `/api/templates/:id/graph` | 铺开时拉节点图；无图 → 404 |

UI：创作台顶栏新增「存为模板」按钮（`Collection` 图标）→ 弹窗填名称 → 保存后**立即刷新模板库缓存**。
回收：首页模板库点击该模板 → `store.pendingTemplateId` → 进入工作台后 `fetchTemplateGraph()` → `applyTemplateGraph()` 铺开（`NodeCanvas.vue:605`）。

### 5.4 自测覆盖（9 + 6 项）

```
单元：节点图保存 / 悬空边丢弃 / 运行时字段剔除 / base64 不入库 /
      dataType 保留 / source=project / 可查回 / 空图拒绝 / 无名称拒绝
HTTP：存为模板 200 / 运行时状态被清洗 / 保留 count=10 /
      节点图可读回 / 出现在列表 / 空图 400 / 无名称 400
```

### 5.5 人工验收

1. 铺一套工作流 → 点执行生成几张图 → 顶栏「存为模板」→ 命名保存。
2. 返回首页 → 模板库能看到它；点开 → 画布铺出同样节点与连线，**结果是空的、没有任何「执行中」状态**（证明清洗生效）。
3. 检查 `{AI_CANVAS_HOME}/templates.json`：确认里面**没有** `base64`、没有 `status: "生成中"`。
4. 在该模板里选 10 张 → 能正常分批生成（证明 `count` 等配置字段被保留）。

### 5.6 回滚

删除 `templates.js` 里 `normalize()` 的 `graph` 字段与两个路由即可；已存的 `graph` 会被静默忽略（`normalize` 不再返回该字段）。

---

## 6. 凭据分文件保险箱（+0.5 天）

### 6.1 改造前后

| | 改造前 | 改造后 |
|---|---|---|
| 文件 | `secrets.enc.json`（**一个大 JSON** 装全部密钥） | `secrets/provider.wanxiang.apiKey.enc`（**每条一个**） |
| 改一个 Key | 整体解密 → 改 → 整体重写 | 只写那一个文件 |
| 坏一处 | 整个保险箱解不开 | 只丢那一条 |
| 备份/同步 | 整包搬走 | 可逐条操作 |
| 排查 | 看不出哪个 Key 最后被改 | 每个文件带 `name` + `updatedAt` |

### 6.2 文件格式

```
{AI_CANVAS_HOME}/secrets/provider.wanxiang.apiKey.enc
{
  "v": 1, "alg": "aes-256-gcm",
  "name": "provider.wanxiang.apiKey",
  "iv": "…", "tag": "…", "data": "…",
  "updatedAt": 1758000000000
}
```

密钥派生：`scrypt(hostname | username | COMPUTERNAME | USERDOMAIN | salt)`，salt 在 `.vault-salt`（0600）。**后端优先级不变**：系统凭据管理器可用就用它，不可用才落文件。

### 6.3 迁移（自动）

启动时 `migrateLegacy()`：读旧 `secrets.enc.json` → 逐条拆成单文件 → **旧文件改名 `secrets.enc.json.migrated-<ts>` 保留（不删）**，可回滚。已存在于新结构的条目以新结构为准，不覆盖。

### 6.4 新增能力

- `listSecrets()`：只返回条目名，绝不给值；
- `selfTest()`：写→读→删探针，返回 `{ok, backend, dir}`，排障用；
- `AI_CANVAS_VAULT=file`：强制走文件后端（本机装了 keyring 也要能验证分文件路径，测试就是这么跑的）；
- `vaultStatus()` 增加 `dir` 与 `fileCount`，服务端启动日志会打印条数。

### 6.5 自测覆盖（13 项，`__vault.test.mjs`）

```
✅ 两条密钥各自读回一致          ✅ 改一条不影响另一条
✅ 一条密钥一个文件              ✅ 文件名保留可读的点分结构
✅ 文件内不含明文                ✅ AES-256-GCM 四要素齐全（iv/tag/data/alg）
✅ 记录条目名与更新时间          ✅ 清单里能查到条目
✅ 自检通过                      ✅ 删掉新结构后读不到（模拟待迁移）
✅ 启动时自动迁回                ✅ 旧文件被改名保留（可回滚）
✅ 删除后读不到
```

> 注：本机 `@napi-rs/keyring` 可用，默认走系统凭据管理器；`__sync.test.mjs` 会**额外起一个 `AI_CANVAS_VAULT=file` 的子进程**把文件后端这条路径也跑一遍，两条路径都被覆盖。

### 6.6 回滚

把 `server/vault.js` 换回旧版即可；新结构产生的 `secrets/*.enc` 在旧版下会被忽略，而旧版要读的 `secrets.enc.json` 我们只是**改名保留**，改回来就能用。

---

## 7. 接口契约汇总（本轮新增 7 个）

| # | 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|---|
| 1 | POST | `/api/batch` | 本地会话 + 限流 | 创建批量进度文件 |
| 2 | PUT | `/api/batch/:id` | 同上 | 写回批次结果 |
| 3 | GET | `/api/batch` | 会话 | 列出可续跑任务 |
| 4 | GET | `/api/batch/:id` | 会话 | 读进度 + 已完成图片 |
| 5 | DELETE | `/api/batch/:id` | 会话 | 删除任务 |
| 6 | POST | `/api/templates/from-project` | **需登录** | 画布存为模板 |
| 7 | GET | `/api/templates/:id/graph` | 会话 | 读模板节点图 |
| 8 | GET | `/api/cache/status` | 需 `admin:dashboard:view` | 结果缓存统计 |
| 9 | DELETE | `/api/cache` | 需 `admin:dashboard:view` | 清空结果缓存 |

已有接口变更：`POST /api/generate` 增加 `model / referenceImages / remark / batchId / batchIndex` 入参，`done` 事件增加 `cached / replay / signature`。

---

## 8. 数据目录变化

```
{AI_CANVAS_HOME}/
├── batches/                    ← 新增（批量进度，7 天自动清理）
│   └── bm9xk2ab3c.json
├── secrets/                    ← 新增（每条密钥一个 .enc）
│   ├── provider.wanxiang.apiKey.enc
│   └── provider.jiemeng.apiKey.enc
├── secrets.enc.json            ← 旧版（迁移后改名 .migrated-<ts> 保留）
├── gen-cache.json              ← 新增（上游签名 → 结果缓存，上限 500 条）
├── templates.json              ← 新增 graph / source / author / createdAt 字段
└── …
```

---

## 9. 全量测试与执行方式

```bash
cd ai-canvas
npm test          # 一键：起干净实例 → 账本 + 支付 + 吸收项单元 + 吸收项接口 → 汇总退出码
npx vite build    # 前端构建校验
```

新增的测试文件全部走 `scripts/run-tests.mjs` 统一调度（临时数据目录 + 空闲端口 + 抬 exit code），**不会污染 `~/.ai-canvas` 真实数据**。

| 测试文件 | 项数 | 覆盖 |
|---|---|---|
| `server/__credits.test.mjs` | 16 | 预扣 / 回滚 / 去重 / 并发 |
| `server/__payments.test.mjs` | 14 | 伪造签名 / 无签名 / 金额不符 |
| `server/__sync.test.mjs` | 29 | 签名 7 / 批量 9 / 模板 9 / 保险箱 4 |
| `server/__vault.test.mjs` | 13 | 分文件加密 + 迁移（子进程强制文件后端） |
| `server/__sync-http.test.mjs` | 15 | 批量接口 7 / 模板接口 6 / 入参透传 2 |
| `server/__p18.test.mjs` | **55** | P1-8 专项：签名规则 22 / 素材哈希 5 / 缓存隔离 9 / sweep 5 / 账本协同 12 |
| `server/__p18-http.test.mjs` | **23** | P1-8 端到端：图片幂等 8 / 视频幂等 4 / 运维 3 |

---

## 10. 排期与工时

| 项 | 计划 | 实际 | 说明 |
|---|---|---|---|
| P0-9 强类型端口 | +1 天 | +1 天 | 含端口着色与去重处理 |
| P1-5 批量简化 | 省 3 天 | 省 3 天 | 未写编排器，只写 5 个路由 + 1 个客户端模块 |
| P1-8 上游签名 | +2 天 | **+3 天** | 首轮含缓存 TTL / LRU / 文件存活；第二轮全面执行追加：视频通路扣费、缓存用户隔离、签名版本化 + sweep、78 项测试 |
| P2 模板反哺 | +1 天 | +1 天 | 含清洗规则与回收链路 |
| 凭据分文件 | （不在原清单） | +0.5 天 | 结构优势单独抄 |
| **净增** | **+1.5 天** | **+2.5 天** | |

**与 P0-0 的关系**：本轮**不解决** P0-0（参考图没真正进模型）。上游签名已经把 `referenceImages` 纳入签名，P0-0 打通后签名立刻升级为「内容级去重」，无需返工 —— 这是本轮为它预留的接口。

---

## 11. 风险与遗留

| 风险 / 遗留 | 影响 | 应对 |
|---|---|---|
| **P0-0 未解**：图片仍未真正传给模型 | 毛衫验收的前置阻断，本轮只把 `referenceImages` 送到了服务端（provider 侧还没接） | 下一步：provider 增加图生图入参 + ComfyUI `/upload/image`；签名已就绪，改完即生效 |
| 缓存占用磁盘 | 500 条 × 若干张图 | TTL 12h + LRU 500 上限 + `DELETE /api/cache` 手动清理 |
| 缓存返回旧图 | 用户想要「同参数再抽一次」 | 需要时加「强制重新生成」按钮，请求带 `force=1` 跳过缓存（未实现，预留） |
| 批量中途断电 | 已完成批次结果仍在，未完成的需重跑 | 进度文件每批写一次；续跑只对缺失批次计费 |
| 端口校验误伤 | 自定义节点端口未声明类型 | 未声明一律放行（只不上色） |
| 模板 base64 | 早期素材可能带 dataUrl | 清洗时只保留 `url/name`，`preview` 之类字段不入库 |
| Windows 文件权限 | `.enc` 的 0600 在 NTFS 上不一定生效 | 已改为：非 Windows 才断言权限；安全性仍由 AES-GCM 保证 |

---

## 附 A：关键代码索引

| 主题 | 文件:位置 |
|---|---|
| 端口类型表 | `src/ports.js` `NODE_PORTS` |
| 连线校验 | `src/ports.js` `validateConnection()` |
| 边着色 | `src/ports.js` `edgeStyleFor()` |
| 拖拽拦截 | `src/components/NodeCanvas.vue` `isValidConnection()` :51 |
| 拒绝提示 | 同上 `onConnectEnd()` :65 |
| 连线落库 | 同上 `onConnect()` :72 |
| 单批执行 | 同上 `generateOnce()` :277 |
| 分批执行 | 同上 `generateImage()` :296 |
| 导出节点图 | 同上 `exportGraph()` :148 |
| 铺模板图 | 同上 `applyTemplateGraph()` :605 |
| 分批算法 | `src/batch.js` `planBatches()` / `runBatches()` |
| 进度落盘 | `server/batch.js` `create()` / `update()` / `results()` |
| 上游签名 | `server/upstream.js` `upstreamSignature()` |
| 缓存读写 | `server/upstream.js` `cacheGet()` / `cachePut()` |
| 幂等判定 | `server/index.js` `/api/generate` :523（①②③ 三级链） |
| 已消费查询 | `server/credits.js` `findConsumed()` |
| 图清洗 | `server/templates.js` `sanitizeGraph()` :92 |
| 存为模板 | `server/templates.js` `saveFromProject()` :208 |
| 保险箱文件 | `server/vault.js` `fileOf()` :67 / `migrateLegacy()` :153 |
| 自检 | `server/vault.js` `selfTest()` :225 |

## 附 B：命令速查

```bash
# 全量自测（含本轮新增 57 项断言）
npm test

# 只跑吸收项单元
AI_CANVAS_HOME=$(mktemp -d) node server/__sync.test.mjs

# 只跑保险箱（强制文件后端）
AI_CANVAS_VAULT=file AI_CANVAS_HOME=$(mktemp -d) node server/__vault.test.mjs

# 前端构建
npx vite build

# 桌面版
npm run desktop
```

---

**文档结束** ｜ 下一步建议：先解 P0-0（真图进模型），毛衫印花工作流的六项人工核对才有意义；上游签名与批量编排已为它铺好路。
