# 跨多多 AI 创作台 · 前端深度拆解报告（深拆 A）

- 拆解对象：`E:\DSH项目\ai-canvas\src\**`（只读，未修改任何源码）
- 拆解人：frontend-analyst（Team Lead: lead）
- 任务：task-1「深拆 A：前端架构（画布引擎/状态/主题/素材库）」
- 证据规则：每条结论后附 `文件路径:行号`。行号以 read 工具输出的行号为准（该工具按 `\n` 计数；PowerShell 的 `Get-Content`/`Measure-Object -Line` 在本仓库会少算行，已实测 `src/ports.js` 为 126 行而 `Get-Content` 报 112 行，故不要用后者核对行号）。
- 标注约定：**未验证** = 需要跑起来才能确认；**推断** = 由代码结构推出的结论，未实测。

---

## 0. 结论摘要（给接手决策用）

**整体画像**：这是一个「界面层完成度很高、但底层能力有若干硬缺口」的 Vue3 + Vue Flow 单体前端。`src/` 下共 65 个文件（其中 40 个 `.vue` 组件），逻辑代码（`.vue/.js/.mjs`，共 57 个文件、427.9KB）里画布引擎 `NodeCanvas.vue`（1894 行 / 66.7KB）一个人就占 **15.6%**，其余 39 个 `.vue` 组件平均不到 170 行。架构干净（store 单例 + bridge 函数表 + 纯逻辑模块可单测），但也因此把过多职责集中在少数几个文件里。

**必须先知道的 6 件事（按接手影响排序）**：

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | **语义缩放的 CSS 选择器全部写错**，`far` 档实际只隐藏了 `<textarea>` 和 handle | `src/newui.css:9-13,23` 选择的 `.nf-node-body/.nf-thumb/.nf-field/.nf-media-grid/.nf-node-title` 在任何节点组件里都不存在（全仓库仅出现在这条规则自身） | 用户缩到 50% 以下时，缩略图、结果大图、参数栏**不会**隐藏，"远看只剩标题"这个核心体验等于没做 |
| 2 | **作品组（A3）是半成品**：既进不了撤销栈，也进不了持久化 | `serialize()` 只导出 `id/type/position/data`（`src/components/NodeCanvas.vue:178-197`），丢掉了 `parentNode/extent/hidden/zIndex/style`（这些字段在 `:317-323`、`:366-374` 使用） | 撤销一次或刷新一次，子节点就从组里脱离、组框尺寸回退；跨会话「作品组」不可用 |
| 3 | **恢复画布后节点 id 会重复**：`nextId` 不随恢复同步 | `nextId` 仅在 `src/store.js:3` 初始化为 1，无任何重置接口；`restoreGraph` 保留原 id（`src/components/NodeCanvas.vue:1713`） | 应用启动恢复上次画布后，新建节点（`newFlowId("p")` → `p1`）与已恢复节点同 id，Vue Flow 会冲突/覆盖（**具体表现未验证**，但 id 冲突是代码事实） |
| 4 | **充值链路是演示态**：前端可自行把订单标记为已支付 | `src/components/AccountModals.vue:93-112`，代码自述"前端直接调用等于允许伪造支付"（`:90-91`），二维码是伪随机图案（`:48-66`） | 上线前若后端未做沙箱/回调验签兜底，等于白送算力；接手时必须与后端 `payments.js` 对照确认 |
| 5 | **主题测试是红的**：82 通过 / 1 失败 | `src/__theme.test.mjs:52` 断言 `DEFAULT_THEME === "aurora"`，但 `src/theme.js:54` 是 `"atelier"`。实跑结果 `主题与批量模式：82 项通过，1 项失败`，exit code 1 | 测试基线不绿，任何人跑 `npm test` 都会以为环境坏了；同时说明"默认主题改回米白"这次改动没有同步测试 |
| 6 | **团队管理 / 微信连接是纯前端假功能** | `src/components/AccountModals.vue:181-209`（成员只 push 本地数组）、`:212-222`（`wechatConnected` 本地布尔） | 演示可以，交付即穿帮；刷新即清空 |

另外：`src/components/_deprecated/` 下 2 个文件（407 行）**确认无任何引用**，且它们 import 的 store 导出（`addNode/placeNode/removeSelected/store.prompt/store.view/store.nodes` 等）在当前 `store.js` 里**已经不存在**，一旦被 import 会直接抛错。

---

## 1. 源码规模与文件清单

按目录（**行数均为 read 工具实测值**；CSS 只给磁盘体积，因为 1651/8012 这类数字来自 PowerShell 会少算，不可信）：

```
src/   共 65 个文件（.vue/.js/.mjs 57 个 = 427.9KB，.css 7 个 = 254KB）
├─ main.js (51行)  App.vue (280行)
├─ store.js (525行/17.2KB)   ← 全局状态唯一真源
├─ api.js (413行/14.1KB)     ← 全部 REST/SSE 封装
├─ theme.js (195行)  themes.css (827行/22.2KB)
├─ ports.js (126行) batch.js (124行) batchmode.js (107行) project.js (329行)
├─ exportkit.js (201行) embed.js (121行) errorboundary.js (156行)
├─ onboarding.js (116行) popoutBus.js (52行)
├─ 样式: style.css (154.2KB) newui.css (31.5KB) admin.css (16.4KB)
│        account.css (14.9KB) templates.css (10.1KB) responsive.css (2.7KB) rail.css (2KB)
├─ components/
│   ├─ NodeCanvas.vue (1894行/66.7KB) ← 核心，占逻辑代码 15.6%
│   ├─ 视图: HomeView(273) AppShell(311) StudioView(435) ProjectsView(222)
│   │        TemplatesView(263) ReviewView(246) AuditView(123) LoginView(225) ErrorFallback(228)
│   ├─ 面板/浮层: InspectorPanel(429) MaterialLibrary(260) BatchDock(157) ChatDrawer(81)
│   │        TaskBar(81) SettingsDialog(268) AccountModals(559) PopoutPanel(83)
│   │        UpdateToast(147) OnboardingTour(188) BootSplash(40) CanvasModeSwitch(36)
│   │        ThemeSwitcher(66) WindowControls(52) EmptyCanvas(87)
│   ├─ nodes/: ProductNode(78) StyleNode(73) PromptNode(52) ExecutorNode(40)
│   │         ResultNode(172) ReferenceNode(110) GroupNode(53)
│   ├─ admin/: AdminConsole(178) AdminAccounts(355) AdminRoles(227) AdminKeys(109)
│   │         AdminLogs(95) AdminDepts(164)
│   └─ _deprecated/: InfiniteCanvas.vue(163行) PromptPanel.vue(244行) ← 死代码，共 407 行
└─ 测试: __theme.test.mjs(219行) __ui.test.mjs(137行) __robust.test.mjs(180行)
```

渲染入口链：`index.html → src/main.js:31 createApp(App)` → `main.js:39-42` 注册 Element Plus（中文 locale、zIndex 3000）与全部图标 → `main.js:26 initTheme()`（**在 mount 之前**，防闪白）→ `main.js:29 installGlobalHandlers()` → `main.js:43 app.mount("#app")` → `main.js:51 initEmbed()`。

---

## 2. 无限画布引擎（重点）

### 2.1 Vue Flow 用法与坐标系

- 通过 `useVueFlow()` 取流实例：`src/components/NodeCanvas.vue:27`，解构出 `addNodes/addEdges/removeNodes/getEdges/findNode/fitView/zoomIn/zoomOut/viewport/getNodes/setSelection/setViewport/updateNode`（`:28-42`）。
- 画布本体在模板 `:1818-1860`，关键配置：
  - `v-model:nodes` / `v-model:edges`（`:1819-1820`）——注意同时存在本组件自己的 `nodes = ref([])`（`:254`）与 `getNodes.value` 两条访问路径，Vue Flow 用 v-model 同步，业务代码用 `getNodes`/`addNodes`，二者一致但混用（**推断**：可读性隐患，不是 bug）。
  - `min-zoom 0.2 / max-zoom 2.5`（`:1822-1823`）、`pan-on-drag`、`zoom-on-scroll`、`zoom-on-double-click=false`（`:1826-1830`）。
  - `selection-key-code=[Shift,Meta,Control]`（`:1824`）、`multi-selection-key-code`（`:1833`）。
  - `delete-key-code=[Delete,Backspace]`（`:1825`）——但组件自己又用 window keydown 处理了 Delete（`:1449-1456`），存在**双通道**：Vue Flow 内部删节点 + 自己的 `removeNodes(sel)`。**推断**：可能重复删除（幂等，无害）或与 `flow.getSelectedNodes` 竞态。
- 节点类型注册：模板插槽 `#node-reference/#node-product/#node-style/#node-prompt/#node-executor/#node-result/#node-group`（`:1851-1859`），与 7 个节点组件一一对应。
- 附着件：`<Background variant="dots" :gap=20 :size=1.6 :pattern-color=dotColor>`（`:1841`）、`<MiniMap v-if=showMinimap>`（`:1842-1849`）、`<Controls>`（`:1850`）。
- 画布背景色：`themes.css:91-97` 把写死的 `#f8f9fb` 与网点色交还给 `--canvas-bg/--canvas-dot`；网点色由 JS 查表给出（`theme.js:186-195 canvasDotColor`，因为 Background 只吃具体色值，读不到 CSS 变量，见 `:183` 注释），调用点在 `NodeCanvas.vue:73`。

坐标换算（三处，公式一致 `world = (screen - viewport)/zoom`）：
- 系统文件拖入：`NodeCanvas.vue:1313-1318`
- 素材库拖入：`:1334-1338`
- 空态上传落点居中：`:1288-1293`
- 快捷键 N 在画布中央新建：`:1548-1550`
- 定位到节点（审阅视图"定位"）：`focusNode` `:1597-1614`，用 `setViewport` 反算平移。

`setViewport` 用的是 `useVueFlow` 的真实 API；而 `setSelection`（`:39` 解构）在 `@vue-flow/core@1.48.2` 里**不存在**（实测 `vue-flow-core.mjs` 中 `setSelection` 0 命中，`getSelectedNodes` 11 命中）。它从未被调用，属于死解构。自研替代品 `applySelection` 直接改节点 `selected` 标记（`:1402-1405`），注释解释了原因（`:1396-1401`）。

`flow.getSelectedNodes?.value`（`:1450`、`:1500`）用法正确：`container/VueFlow/VueFlow.vue.d.ts:586` 声明为 `ComputedRef<GraphNode[]>`。`flow.onEdgesChange?.(...)`（`:402`）也正确：类型为 `EventHookOn<EdgeChange[]>`（同文件 `:315`）。

### 2.2 缩放分档（语义缩放）——**实现与声明不符**

声明（`NodeCanvas.vue:75-86`）：
```
far  (<0.5)  只留标题色块，缩略图与参数全部隐藏
mid  (0.5–1.1) 标准视图
near (>1.1)  显示完整参数与预览图
```
实现：`zoomTier` 计算属性挂在父容器 class 上（`:1812` 的 `` `zoom-${zoomTier}` ``）。

**实际 CSS 只有三条规则**（全仓库 grep 确认 `zoom-far/zoom-near` 仅出现在 `newui.css:9-37`，`zoom-mid` 没有任何规则）：

1. `newui.css:9-13` 在 far 档 `display:none !important` 掉 `.nf-node-body`、`.nf-thumb`、`.nf-field`、`.nf-media-grid` 以及 `textarea`。
   → 前四个类名**在任何组件模板里都不存在**（grep 全仓库：这 4 个选择器只出现在这条规则自身）。真实类名是 `.nf-product-body`、`.nf-product-thumb`、`.nf-style-body`、`.nf-style-thumbs`、`.nf-result-grid`、`.nf-prompt-bar`（见各节点组件）。
   → 因此 far 档**唯一实际生效**的是 `textarea`：`PromptNode.vue:26-31` 的 `.nf-prompt-input`、`ReferenceNode.vue:95` 的 `.nf-ref-prompt`。
2. `newui.css:17-21` far 档把 `.nf-node` 压到 `min-height:44px`、去阴影 —— **生效**。
3. `newui.css:30-33` far 档把 `.vue-flow__handle` 设为透明不可点 —— **生效**。
4. `newui.css:23-28` far 档 `.nf-node-title` 字号 —— **不生效**（无此元素）。
5. `newui.css:35-37` near 档只加了一层 `box-shadow` —— 与"显示完整参数与预览图"的声明不符：near 档相对于 mid 档**没有多显示任何东西**，因为 mid 本来就是完整渲染。

**结论**：语义缩放的骨架（分档 → class）是真的，视觉规则基本落空。修复成本很低（把选择器改成真实类名即可），但当前交付状态下"缩到最小看全局"会看到一堆缩略图糊在一起。

### 2.3 fitView 调用点

| 场景 | 位置 | 参数 |
|---|---|---|
| 快捷键 Ctrl+0 | `:1467` | `padding .2, duration 400` |
| 铺开工作流 | `:1190` | `padding .22, duration 500`（延时 60ms 等节点注册） |
| 铺开模板图 | `:1238` | `padding .22, duration 400` |
| 批量铺节点后 | `:888` | `padding .08, duration 350` |
| 网格整理后 | `:906` | `padding .08, duration 300` |
| 顶栏"恢复视图" | `StudioView.vue:51` → `nodeCanvasRef.fitView({padding:.05,duration:300})` | — |

### 2.4 撤销 / 重做（历史栈）

- 栈结构：`historyStack` / `futureStack` 两个 `ref([])`（`:171-172`），上限 60（`:212` 溢出 shift），`canUndo = length>1`（`:173`）。
- 快照粒度：`serialize()`（`:178-197`）只导出 `nodes[{id,type,position,data}]` + `edges[{id,source,target,sourceHandle,targetHandle,dataType,style}]` + `viewport`。
- 入栈时机（4 类）：
  1. `scheduleSnapshot()`（`:216-220`，260ms 防抖）由「节点数:连线数」变化触发（`:405-408`）；
  2. `patchSelected()` 属性栏改参数（`:1574`）；
  3. `groupSelection/ungroupSelection/importFiles/createBatchFromPrompts/tidyGrid` 显式调用（`:327/355/1280/883/904`）；
  4. 挂载后初始空快照（`:1673`）。
- **关键缺口 A：拖动节点位置不入栈。** 位置变化只触发 `scheduleSave`（`:413-421`），不触发 `pushSnapshot`。所以"移动节点 → Ctrl+Z"不会退回原位。
- **关键缺口 B：快照丢失图的拓扑外信息。** `parentNode/extent/hidden/zIndex/style` 都不在 serialize 里（对比 `:317-323` 设置与 `:370-374` 读写），因此：
  - 编组后按 Ctrl+Z → `restoreSnapshot` 重建节点，子节点 `parentNode` 全丢、组框 `style.width/height` 回退 → **组散架**；
  - 折叠状态、组尺寸同样不参与撤销。
- 恢复实现：`restoreSnapshot`（`:222-230`）先 `removeNodes(所有 id)` 再 `addNodes`，然后 `nextTick` 补 `addEdges`；`restoring` 标志（`:175`）在 120ms 后释放以抑制过程中的脏写入。
- 撤销/重做各弹一次 `ElMessage.info`（`:240`、`:250`）。

### 2.5 跨组件桥接：`bridge` + `popoutBus` + `provide/inject` + `defineExpose`

**四套并行机制**，这是本项目最需要先理清楚的一张图：

| 机制 | 定义 | 注册处 | 清理处 | 用途 |
|---|---|---|---|---|
| `bridge`（普通对象，非 reactive，避免函数被代理） | `store.js:197-238`（25 个槽位） | `NodeCanvas.vue:1623-1658`（onMounted） | `:1731-1748`（onBeforeUnmount 逐个置 null） | 外部组件调用画布能力 |
| `provide("exec", ...)` | `NodeCanvas.vue:1057` | 同上 | Vue 自动 | 节点组件回调生成：`generateImage/generateVideo/addPromptNode/removeNode` |
| `defineExpose` | `:1774-1806`（32 个成员） | — | — | 父组件 `StudioView` 通过 `nodeCanvasRef` 调用：`applyWorkflow/exportGraph/restoreGraph/undo/redo/zoomPct/...` |
| `popoutBus`（BroadcastChannel，channel `ai-canvas:popout`） | `popoutBus.js:10-52` | 发送：`InspectorPanel.vue:212`；接收：`PopoutPanel.vue:18-27` | `PopoutPanel.vue:28` | 双屏独立窗口同步选中结果 |
| `CustomEvent`（`ai-canvas:theme` / `ai-canvas:route`） | 派发：`App.vue:109-111`、`:125`；`theme.js:159` | 监听：`embed.js:107-108` | — | 回传宿主 |
| `postMessage`（embed） | `embed.js:40-47` 发 / `:73-87` 收 | `embed.js:101-116` | — | iframe 宿主双向通信 |

`bridge` 的 25 个槽位按用途分四组（`store.js:197-238`）：提示词写入与更新检查（`setPrompt/checkUpdate/applyWorkflow`）、属性栏（`getSelected/patchSelected/groupSelection/ungroupSelection/rerunNode/cancelTask/requestSave/focusNode/removeSelected`）、批量模式（`batchFromPrompts/runBatchNodes/cancelBatch/tidyGrid/getSelectedIds/setSelectedIds`）。

**注意**：`bridge` 是模块级普通对象，多个画布实例会互相覆盖；当前只有一个画布实例，**推断**可接受。另外 `checkUpdate` 由 `UpdateToast.vue:76-81` 注册、`:97` 清理；`UpdateToast` 只在已登录且非 popout 分支渲染（`App.vue:261`），设置面板里的"检查更新"按钮（`SettingsDialog.vue:31-34`）因此在登录前无效（**推断**：登录前用户看不到设置面板，无实际影响）。

`popoutBus.sendPopout` 先 `JSON.parse(JSON.stringify())` 再 post（`popoutBus.js:30`），注释说明是为了绕过 Vue reactive Proxy 的 `DataCloneError`。`onPopout` 用 `b.onmessage = fn` **单槽赋值**（`:41`），只支持一个监听者——当前只有 `PopoutPanel` 与 `InspectorPanel` 各一处，且二者不在同一页面（主窗/弹窗），暂不冲突，但**这是脆点**。

### 2.6 选中同步与批量模式交互契约

- 选中同步：`watch` 节点 `selected` 标志拼成的字符串（`:274-277`）→ `syncSelection()` 写 `store.selection`（`:271-273`）。属性栏不持有副本，直接读节点引用（`InspectorPanel.vue:9-10` 注释与 `:78-79`）。
- 批量模式的"点击是加选"实现很讲究：`pointerdown` 捕获阶段先快照选中集（`:60-63`），`node-click` 时基于快照做**异或**（`:64-70`），绕开 Vue Flow 先清空选择的行为。这是被 `src/__theme.test.mjs:201` 断言保护的契约。
- 执行状态同步：`syncExecutorInputs()`（`:387-396`）按入边源节点类型回填执行节点的 `hasPrompt/hasProduct/hasStyle`，触发点是边数变化（`:397-401`）与 `flow.onEdgesChange`（`:402`）。执行节点圆环颜色由此驱动（`ExecutorNode.vue:8-17`）。
- 生成前成本二次确认：`estimateCost`（`:491-494`）+ `confirmCost`（`:496-518`）：<30 点不打扰，余额不足弹 alert，否则 confirm。

---

## 3. 工作流模板铺设（applyWorkflow）与端口契约

### 3.1 三套模板数据源

| 来源 | 定义 | 铺设函数 | 触发链 |
|---|---|---|---|
| **内置工作流** `WORKFLOWS`（12 套） | `store.js:359-516` | `applyWorkflow(wfId)` `NodeCanvas.vue:1091-1194` | 左工具条（`StudioView.vue:59-75`）／数字键 1-5（`:1517-1521` → `StudioView.vue:78-82`）／空画布示例卡（`EmptyCanvas.vue:79` → `NodeCanvas.vue:1867`）／首页 pendingWorkflow（`:1675-1680`）／嵌入宿主（`embed.js:57-64`）／`bridge.applyWorkflow` |
| **"我的模板"（用户画布存下）** | 服务端 `store.templates`（`TemplatesView.vue:74-84` 拉取） | `applyTemplateGraph(graph)` `NodeCanvas.vue:1201-1242` | `TemplatesView.launch()` 发现 `t.graph.nodes` 非空 → 写 `pendingTemplateId`（`:98-104`）→ `NodeCanvas` 挂载时 `fetchTemplateGraph(id)`（`:1682-1691`） |
| **画布 → 模板（反哺）** | `exportGraph()` `:200-207`（= serialize + `decorateEdge` 补 dataType） | 服务端 `/api/templates/from-project` | `StudioView.saveAsTemplate()` `StudioView.vue:93-133` |

12 套内置工作流与工具条入口**完全对齐**（无孤儿、无死入口）：`TOOLS`（`store.js:296-342`）的 12 个子项 `clothes-model/style-reference/clothes-model-pose/fixed-face-bg-pose/pose-split/custom-scene/smart-generation/image-generate/detail-page/image-replica/ai-video/ai-video-replica` 与 `WORKFLOWS` 的 12 个 key 一一对应（逐条核对 `store.js:359-516`）。

### 3.2 铺设算法要点（applyWorkflow，`:1091-1194`）

1. **首次铺设是"清屏替换"，之后是"右侧追加"**：`pristine || existing.length===0` 时删掉全部节点并清空 `edges.value`（`:1099-1102`）；否则 `offsetX = max(现有 x) + 1020`（`:1104`）。`pristine` 在铺工作流/加节点/拖入/铺模板/恢复画布时置 false（`:1102/1369/1279/1207/1717`），初始 `true`（`:93`）。
2. **坐标归一化**：所有模板节点坐标先减去 minX/minY 再统一 +80（`:1108-1120`），所以模板定义里的相对坐标可以随便写。
3. **key → 运行时 id 映射** `idMap`（`:1113-1116`），前缀表 `PREFIX = {product:'pd',style:'s',prompt:'p',executor:'e',reference:'ref',result:'r'}`（`:1060`）。
4. **执行节点自动补"生成结果"节点**：每个 executor 右侧 +300px 自动造 result 并连 `result→result`（`:1126-1144`）。这就是 `addResultNode` 能"填已有节点而不是乱建新节点"的原因（`:433-444`）。
5. **数据补全**：`makeNodeData(type, extra)`（`:1062-1084`）为每种类型给出完整默认字段，模板只写差异项。
6. **连线校验后着色**：模板边 `[from,to,sourceHandle,targetHandle]`（`store.js:352` 的 `L()` 构造器）逐条过 `validateConnection`，拿到 `dataType` 再 `edgeStyleFor`（`:1155-1176`）；校验都能过（下表）。
7. **铺完 fitView + 记 activeTool**（`:1186-1191`）。
8. **首页文字带入**：`store.pendingPrompt` 写进第一个 prompt 节点（`:1149-1153`）。

### 3.3 节点 handle 契约（**逐条核对，含一处幽灵端口**）

权威定义在 `ports.js` 的 `NODE_PORTS`（`:36-63`），实际 DOM 在各节点组件：

| 节点 | 方向 | handle id | 声明类型 | DOM 证据 | 一致？ |
|---|---|---|---|---|---|
| product | out | `product` | image | `ProductNode.vue:53` | ✅ |
| style | out | `style` | image | `StyleNode.vue:45` | ✅ |
| prompt | out | `prompt` | string | `PromptNode.vue:24` | ✅ |
| executor | in ×3 | `prompt` / `product` / `style` | string / image / image | `ExecutorNode.vue:22-24`（top 默认 50% / 36% / 64%） | ✅ |
| executor | out | `result` | ai-image | `ExecutorNode.vue:25` | ✅ |
| result | in | `result` | ai-image + video | `ResultNode.vue:96` | ✅（但见下） |
| **reference** | out | `result` | video | **无任何 `<Handle>`** —— `ReferenceNode.vue` 全文 109 行没有渲染 handle（`:3` 只是 import 了 `Handle/Position` 却从未使用） | ❌ **幽灵端口** |

**后果**：`ports.js:47` 声明视频节点有 `result` 输出口，`ports.js:58-61` 声明结果节点接受 video，校验逻辑（`ports.js:89-107`）因此认为"视频 → 结果"合法，但用户在界面上**根本拖不出这条线**（没有源 handle）。视频结果只能靠 `generateVideo` 的 `addResultNode(refId, {videos})` 兜底新建一个结果节点（`NodeCanvas.vue:769`）——因为找不到 `sourceHandle==='result'` 的入边（`:435-438`），会走 `:446-464` 的新建分支。

**`result` 节点两个输入口共用同一 id**（`ports.js:58-61`），`portType` 对输入方向特意返回**类型数组**（`ports.js:74-82`），`validateConnection` 用 `ins.includes(out)` 做"任一匹配即可"（`:97`）。这是有意的设计（`:69` 注释），不是 bug。

连线校验的交互细节：拖拽过程只判断不弹窗（避免刷屏），拒绝原因记在 `lastReject`，松手时 `connect-end` 弹一次（`NodeCanvas.vue:101-121`）；`onConnect` 里还做了**去重**（Vue Flow 在某些配置下会自己先加边，`:138-152`）。

### 3.4 多套流程如何共用同一批节点组件（`data.role`）

- `makeNodeData("product", extra)` 默认 `role:"product"`（`:1065`），工作流模板按用途覆盖：`outfit`（服装图）/`model`（模特图）/`reference`（参考图）——见 `store.js:365-366`、`:382`、`:397-398`、`:412-413`、`:429`、`:444`、`:457`、`:480`、`:493`。
- **角色消费点只有两处**：
  1. 图标：`ProductNode.vue:11-17`（outfit→Goods，model→User，reference→Picture，其余→Box）；
  2. 生成入参分拣：`NodeCanvas.vue:551-556` —— `role==='model'` → `modelNode`，`role==='outfit'` → `outfitNode`，其余 → `productNode`，三者在拼提示词（`:567-604`）与送参考图（`:579-587`）时分别对待。
- `title` 字段（"服装图"/"模特图"）只影响头部文案（`ProductNode.vue:19`）。属性栏可改 role（`InspectorPanel.vue:323-331`）。
- **风格节点是独立组件**（`StyleNode`，多图上限 4 张硬编码于 `StyleNode.vue:21,31`），不靠 role 区分；**视频是独立组件**（`ReferenceNode`）。所以"共用组件靠 role 区分"只适用于 `product` 这一路。

---

## 4. 全局状态结构（store.js）

### 4.1 state 分块（`store.js:82-184`）

| 块 | 字段 | 持久化 | 备注 |
|---|---|---|---|
| 路由/导航 | `route`(84) `activeSkill`(85) | ❌ 内存 | `route` 是自研路由的**唯一真源** |
| 主题 | `theme`(88) `darkMode`(90) | ✅ localStorage `ai-canvas.theme.v2` / `.dark.v2`（`theme.js:56-57`） | 默认 `atelier` / 非暗 |
| 画布模式 | `canvasMode`(93) `batchDockOpen`(95) `batchRows`(97) | `canvasMode` ✅ `ai-canvas.canvas-mode.v1`（`NodeCanvas.vue:803,1662,1754-1768`）；`batchDockOpen`/`batchRows` ❌ | |
| 项目 | `projectName`(100) `currentProjectId`(103) `saveState/saveError/lastSavedAt`(104-106) `pendingRestore`(108) `projects`(122) | ✅ `ai-canvas.project.graph.v1` / `projects.v1` / `project.meta.v1`（`project.js:14-17`） | `pendingRestore` 是启动到画布挂载之间的中转 |
| 资产库 | `assets`(111) | ✅ `ai-canvas.assets.v1`，上限 600（`project.js:20,300`） | 审阅视图数据源 |
| 任务条 | `tasks`(114) `taskBarOpen`(116) | ❌ 内存 | 上限 40（`store.js:255`） |
| 选中 | `selection`(119) | ❌ 内存 | 由画布 watch 回写（`NodeCanvas.vue:271-277`） |
| 首页中转 | `pendingWorkflow`(128) `pendingTemplateId/Name`(130-131) `pendingPrompt`(133) `activeTool/activeSubTool`(135-136) | ❌ 内存 | 首页/模板库 → 创作台的握手通道 |
| 素材库 | `materialPanelOpen`(139) `materialSearch`(140) `materials`(141) | ❌ 内存（服务端为真源，`MaterialLibrary.vue:66-68`） | |
| 视频参数 | `videoModel/Resolution/Mode/Duration`(144-147) | ❌ | 仅节点创建时取默认值（`NodeCanvas.vue:1075-1076`） |
| 图片全局设置 | `imageModel`(150) `imageResolution`(151) `imageRatio`(152) | ❌ 内存 | 顶栏模型面板写（`StudioView.vue:254,271`） |
| 设置/算力/用户 | `settings`(155) `comfyStatus`(156) `credits`(159) `user`(162) `balance`(175) `costTable`(176) | 服务端为真源 | `credits` **从未被读写**（死字段） |
| 品牌/模板 | `brand`(168) `templates`(171) `templateCategories`(172) | 服务端 | |
| 其他 | `searchKeyword`(165) `generating`(179) `history`(180) `flowNodeCount`(183) | ❌ | `generating`/`history` 仅被 `_deprecated/PromptPanel.vue` 使用，**主链路已废弃**；`searchKeyword` 只写不读（见 §7） |

### 4.2 持久化策略（双通道，都在 localStorage）

- **画布图**：`project.js:96-116 scheduleSave` 防抖 800ms 写 `ai-canvas.project.graph.v1`，payload 含 `{name, projectId, savedAt, graph}`。配额超限时先删资产库再试一次（`project.js:40-46`），仍失败进 `error` 态。`flushSave`（`:119-121`）立即写，挂在 `beforeunload`（`NodeCanvas.vue:1669`）与卸载（`:1728`）上。
- **三态保存指示**：`idle/saving/saved/error`（`project.js:53-58`）→ `saveStateLabel()`（`:76-87`）→ 顶栏 `StudioView.vue:298-301`。
- **资产库**：`addAsset` 按 url 去重（`project.js:286-302`），上限 600。
- **项目列表**：`upsertList` 写 `projects.v1`，上限 50（`:160`）；缩略图取每个 result 节点前 2 张、最多 3 张（`:144-147`）。
- **触发点**（`NodeCanvas.vue`）：位置+连线数变化（`:413-421`）、节点 data 变化（`:424-430`，注释说明刻意不 deep watch 整个 data）、编组/改名/折叠（`:377,383`）、批量铺开（`:889`）、bootstrap 恢复（`:1722`）。

### 4.3 与后端的边界

- **前端不算账、不落业务库**：`store.balance`/`costTable` 来自 `fetchBalance/fetchCostTable`（`App.vue:85-93`），注释明确"前端只做展示"（`store.js:174`）。成本预估 `estimateCost`/`estimateBatchCost` 只是弹窗提示（`NodeCanvas.vue:488-494`、`batchmode.js:96-107`），真实扣费在服务端。
- **不重复扣费判定靠服务端回包**：`evt.cached` / `evt.replay` / `evt.savedCost`（`NodeCanvas.vue:473-481`、`batch.js:96-99`），前端据此提示"输入未变化，本次未扣算力"（`NodeCanvas.vue:692-696`）。
- **无长连接、无轮询**：所有生成走 SSE（`api.js:232-277` 手写解析器，按 `\n\n` 切帧），取消走 `POST /api/tasks/cancel`（`api.js:59-72`）。
- **会话令牌**：`api.js:7-23` 先 `GET /api/session` 拿 token，之后所有请求带 `X-AI-Canvas-Token`（`:25-28`）；401 时区分 `LOGIN_REQUIRED` 与 `SESSION_EXPIRED`（`:31-49`）。
- **admin 请求走 `adminReq`**（`api.js:323-336`），非 2xx 抛带 `code`/`need` 的错误。
- `api.js` 共 60+ 导出函数，其中 **4 个无人调用**：`securityStatus`(197)、`uploadImage`(202)、`batchList`(296)、`batchRemove`(298)。

---

## 5. 主题系统（三套 token + 正交明暗）

### 5.1 token 定义位置

- 注册表：`theme.js:23-48`，`THEMES` 3 套 —— `aurora`（极光玻璃，`defaultDark:true`）/ `atelier`（画布工作室，`defaultDark:false`）/ `momentum`（流光灵动，`defaultDark:false`）。
- 实际 token：`themes.css`，每套分**基础块 + 明暗两版**：
  - aurora：基础 `:119`、亮色覆盖 `:187`（`html[data-theme="aurora"]:not(.dark)`）；**没有** `html.dark[data-theme="aurora"]`（因为基础块本身就是暗色，`defaultDark:true`）。
  - atelier：基础 `:230`、暗色 `:303`（`html.dark[data-theme="atelier"]`）。
  - momentum：基础 `:334`、暗色 `:403`。
- token 清单要求写死在 `themes.css:14-20` 的注释里（38 个 token），并由 `src/__theme.test.mjs:92-113` 逐项断言（含 `--primary: var(--brand)` 派生契约、`--accent-grad` 必须是 `linear-gradient`）。
- Element Plus 变量由主题 token 推导：`themes.css:58-88`（用 `color-mix` 自动生成 light-3/5/7/8/9，省掉每套主题手写 5 个色阶）。

### 5.2 切换链路（**不是 body class，是 html 属性 + html/body 双 class**）

```
用户点 ThemeSwitcher（ThemeSwitcher.vue:14-17 pick → setTheme）
  → theme.js:134-162 setTheme(id, {dark})
       ├─ store.theme / store.darkMode 赋值（:141-142）
       ├─ flashTransition()：html 挂 .theme-transition 360ms（:144、:120-126）
       ├─ applyTheme(t) → document.documentElement.dataset.theme  （:93-99）★主题挂在 <html>
       ├─ applyDark(dark) → html.classList + body.classList 同时 toggle('dark')（:109-116）★明暗挂两层
       ├─ localStorage 写 theme.v2 / dark.v2（:148-156）
       └─ window.dispatchEvent('ai-canvas:theme')（:158-160）
```
- App 侧兜底监听：`App.vue:105-114`（darkMode → `applyDark` + 派发事件）、`:117-120`（theme → `applyTheme`）。`embed.js:107` 再把 `ai-canvas:theme` 转成 postMessage 给宿主。
- 启动链路：`main.js:26 initTheme()`（在 `mount` 前，防闪白）→ `theme.js:171-179` 读 localStorage、写 store、挂 DOM。
- 为什么明暗要挂两层：`theme.js:101-108` 注释解释得很清楚 —— `body.dark` 是历史约定（`style.css` 里 200+ 条 `body.dark` 规则），`html.dark` 是为了能写 `html[data-theme="x"]:not(.dark)` 这种一层搞定的明暗分支。

### 5.3 漏覆盖 / 不一致（已核对）

| 项 | 证据 | 严重度 |
|---|---|---|
| **主题测试与代码不一致（测试红）** | `src/__theme.test.mjs:52` 断言 `DEFAULT_THEME === "aurora"`；`src/theme.js:54` = `"atelier"`。实跑：82 通过 1 失败，exit 1 | 中（基线不绿） |
| **`theme.js` 头部注释与代码不一致** | `theme.js:5` 写"默认 Aurora · 暗色"，实际 `:51-54` 已改为 atelier 亮色 | 低 |
| **三处注释仍提"经典蓝"** | `theme.js:6`（说明其已移除，属正常）、`store.js:87`（`theme:` 字段注释仍写 `classic`）、`ThemeSwitcher.vue:4` | 低 |
| `ThemeSwitcher.vue:11` 兜底值仍是 `"aurora"` | `store.theme || "aurora"`，与默认 atelier 不一致（正常路径 store.theme 恒有值，兜底不触发） | 低 |
| **`.mode-switch` 全局类名被两个语义不同的组件复用** | 全局定义 `themes.css:696-724`（胶囊分段控件，为画布模式开关做的，见注释 `:695`）；`CanvasModeSwitch.vue:24` 与 `ThemeSwitcher.vue:51`（亮/暗切换）都用它 | 低（当前视觉正常，改一处会误伤另一处） |
| `App.vue:71-72` 只写 `--brand/--brand-deep`，刻意不写 `--primary` | 注释 `:73-75` 说明原因；`__theme.test.mjs:215` 用断言锁住这条纪律 | ✅ 正确设计 |
| 画布网点色是 JS 查表而非 token | `theme.js:186-195`（三主题 × 明暗 = 6 个色值），新增主题**必须**同步这张表，否则网点色会回落到 aurora 的亮色（`:194`） | 中（易漏） |

---

## 6. 视图与路由（自研切换，非 vue-router）

### 6.1 结论：**没有 vue-router**（`package.json:23-34` 依赖里没有），路由就是 `store.route` 一个字符串。

分发在 `App.vue:248-258`（`v-if / v-else-if` 链），**最后一个分支是 else**，即未知 route 值一律渲染 `StudioView`：

| route 值 | 渲染组件 | 位置 |
|---|---|---|
| `audit` | AuditView（安全记录） | `App.vue:248` |
| `templates` | TemplatesView（模板库） | `:249` |
| `projects` | ProjectsView（我的项目） | `:250` |
| `review` | ReviewView（作品库/审阅+策展） | `:251` |
| `home` | HomeView（工作台） | `:252` |
| **其他/`studio`** | **StudioView（创作台，else 兜底）** | `:253-258` |

**Admin 不是路由**：`AdminConsole` 是 `adminOpen` 控制的**模态全屏浮层**（`App.vue:269`），入口在账号菜单（`AppShell.vue:157-164`），且需 `perms` 里有 `admin:` 前缀（`AppShell.vue:41`，`App.vue:82` 另有同名计算属性但**未被使用**——死代码）。`AdminConsole.vue:21-33` 内部再按 `page` 切 6 个面板，也是自研 `v-if`（`:118-174`）。

### 6.2 外壳与布局

- `AppShell`（`AppShell.vue:99-293`）：`store.route === 'studio'` 时**整个顶栏与侧边栏不渲染**（`:102`、`:201`），`<slot>` 进全屏 main（`:289-291`）；其他路由走"顶栏 + 左侧栏 + main"。
- 侧边栏三组菜单：创作（`mainMenu` `:60-66`）、技能（`SKILLS` 8 项，`:226-238`）、资产（`assetMenu` `:68-72`）、系统（`systemMenu` `:74-78`）。`go()`（`:80-92`）里 `settings` 走 emit、`help` 只是跳首页（`:85-88`，**帮助按钮没有真正的帮助页**）。
- 顶栏：主题切换器、算力胶囊、设置、新建创作、账号 popover、窗口控制（`:115-198`）。
- 登录/闪屏/独立窗口分支：`App.vue:216-280` —— `errorState.fatal` → ErrorFallback（`:218`）；`?window=popout` → PopoutPanel（`:221`）；Electron 登录窗（`window.desktop.windowMode === 'login'`，`App.vue:48`）→ 短闪屏 + LoginView（`:225-228`）；否则闪屏 + 登录 + 主界面（`:230-279`）。`ready = splashDone && authChecked`（`:56`）。

### 6.3 视图清单（10 个页面级 + 15 个浮层/面板级）

**页面级**：HomeView(273行) / StudioView(435行) / ProjectsView(222行) / TemplatesView(263行) / ReviewView(246行) / AuditView(123行) / LoginView(225行) / ErrorFallback(228行) / PopoutPanel(83行) / BootSplash(40行)。
**浮层/面板级**：NodeCanvas / InspectorPanel(429行) / MaterialLibrary(260行) / BatchDock(157行) / ChatDrawer(81行) / TaskBar(81行) / SettingsDialog(268行) / AccountModals(559行，内含 4 个 el-dialog) / OnboardingTour(188行) / UpdateToast(147行) / AdminConsole(178行)+5 子面板 / ThemeSwitcher / CanvasModeSwitch / WindowControls / EmptyCanvas。

### 6.4 路由/导航缺陷

| 问题 | 证据 |
|---|---|
| **`searchKeyword` 只写不读** | 写入：`AppShell.vue:48`（`runSearch`）；读取：`TemplatesView.vue:10` 初始化 `keyword`——但 `runSearch` 已无 UI 入口（顶栏搜索框按 `AppShell.vue:43-44` 注释被移除，模板里也确实没有输入框）。`StudioView.vue` 的搜索同样无入口。**结论：顶栏搜索能力实际不可达**，`searchText`/`runSearch` 是死代码 |
| **首页"新建项目"绕过持久化层** | `HomeView.vue:82-93` 直接 `store.projects.unshift(p)`，不调 `project.js:createProject`，也不设 `currentProjectId`/清画布 → 刷新即丢（对比 `ProjectsView.vue:50-56` 走 `createProject`） |
| **首页"打开项目"不切项目 id** | `HomeView.vue:77-80` 只改 `store.projectName` 和 route，不调 `project.openProject(id)`（`project.js:258-264`）→ `currentProjectId` 仍是旧项目，之后的自动保存会写进旧项目条目 |
| **8 个"技能"入口不改行为** | `startSkill()`（`store.js:186-189`）只设 `activeSkill` + 跳 studio；`StudioView` 从不读 `activeSkill`（grep 确认仅 `AppShell.vue:231` 用于高亮）。`SKILLS` 的 8 个 id 与 `WORKFLOWS` 的 key **没有任何映射**。**结论：侧边栏"技能"组是空转入口**（半成品） |
| **`systemMenu` 的"帮助"是跳首页** | `AppShell.vue:85-88` |
| `pendingRestore` 在有的分支不清空 | `NodeCanvas.vue:1675-1697`：若走了 `pendingWorkflow` 分支会 `return`，`store.pendingRestore` 残留，下次挂载画布会意外恢复旧图（**推断**：可复现路径需实测，中风险） |

---

## 7. 素材库 / 资产 / 血缘（前端侧）

- **素材库面板** `MaterialLibrary.vue`：分类折叠 + 文件名搜索（`:19-22`、`:162-165`）+ **标签筛选**（维度间 AND、维度内精确匹配，`:30-47`，标签口径由服务端 `store.materials.tagGroups` 下发，`:24-25` 注释强调前端不硬编码）+ 标签编辑（`:87-104` 就地更新避免列表刷新丢展开态）+ 删除（二次确认 `:106-123`）。
- **上传口径不一致（小 bug）**：面板内上传用分类 id（`MaterialLibrary.vue:125-141`）；节点内上传一律写死 `"other"`（`ProductNode.vue:41`、`StyleNode.vue:33`、`ReferenceNode.vue:55`、`ResultNode.vue:29`）；画布拖入用 `opts.category || "uploads"`（`NodeCanvas.vue:1259`）。同一张图从三个入口进库会落到三个分类。
- **拖拽协议**：`application/json` → `{material}`（`MaterialLibrary.vue:73-76` 写入；`ProductNode.vue:21-34`、`StyleNode.vue:11-25`、`ReferenceNode.vue:23-31`、`NodeCanvas.vue:1322-1365` 读取）。
- **系统文件拖入**（补的缺口 B5）：`NodeCanvas.vue:1244-1284 importFiles` —— 先 `uploadMaterial` 再在落点建 `product` 节点（`role:reference`）。
- **上传返回结构的字段丢失**：节点内上传只取 `{url,name,kind}`（`ProductNode.vue:42`），而 `generateImage` 送后端的 `referenceImages` 期待 `sha256`（`NodeCanvas.vue:586`）→ 手动上传的图**没有 sha256**，上游内容级去重的收益打折（**推断**：需确认服务端是否回填）。
- **资产库**：`project.js:286-302`（url 去重 + 600 上限）→ ReviewView（`:27`、`:141-143`）。
- **血缘（E6）**：`fetchOutputMeta(url)`（`api.js:177-190`，查不到返回 null，不抛错）→ `InspectorPanel.vue:144-154` watch 选中结果首图 url → 展示模型/画幅/种子/强度/消耗/参考图/时间，并给"可复现"判定（`:159`，需 prompt 与 provider 同时在）。

---

## 8. 三类清单

### 8.1 已实现（可用、逻辑闭环）

| 能力 | 关键证据 |
|---|---|
| 无限画布：拖拽/框选/多选/框选/缩放/平移/小地图/控制条 | `NodeCanvas.vue:1818-1860` |
| 12 套工作流一键铺设（含自动补结果节点、自动连线、自动 fitView、追加不覆盖） | `:1091-1194`、`store.js:359-516` |
| 强类型端口校验（4 种 dataType、拖拽期拒绝+松手提示、按类型着色） | `ports.js:18-125`、`NodeCanvas.vue:103-163` |
| 撤销/重做框架（60 步栈、防抖、恢复抑制脏写） | `:170-251`（但有 §2.4 两个缺口） |
| 作品组的编组/解散/折叠/重命名（**当次会话内**） | `:285-384`、`GroupNode.vue` |
| 自动保存 + 三态指示 + 配额降级 + beforeunload flush | `project.js:96-121`、`StudioView.vue:298-301` |
| 生成前成本确认（<30 点免打扰、余额不足拦截） | `:491-518`、`:933-955` |
| 批量节点模式（Ctrl+B、点击加选异或、串行执行、可取消、网格整理、脏提示词清洗） | `:800-1021`、`batchmode.js:30-53`、`BatchDock.vue` |
| 客户端分批编排 + 磁盘进度断点续跑（10 张拆 4+4+2，逐批落库） | `batch.js:42-124`、`NodeCanvas.vue:662-683` |
| SSE 流式生成 + AbortController 取消 + 服务端任务取消 | `api.js:59-72,232-277`、`:640-641,1036-1042` |
| 底部任务条（4 态、取消、重做、跳结果、省算力统计） | `store.js:245-279`、`TaskBar.vue` |
| 右侧属性栏（按类型出参数、多选只暴露公共项、可拖宽/最小化/记忆宽度/弹出独立窗） | `InspectorPanel.vue:18-128` |
| 资产血缘展示 + 复制提示词 | `InspectorPanel.vue:138-179`、`api.js:177-190` |
| 作品库（网格/对比/大图浏览/筛选/下载/ZIP/定位回画布） | `ReviewView.vue`、`exportkit.js` |
| 零依赖 ZIP（手写 store 模式 + CRC32） | `exportkit.js:15-160` |
| 项目 JSON 导出/导入 | `exportkit.js:181-201`、`StudioView.vue:150-196` |
| 模板反哺（画布 → 服务端模板 → 模板库铺回） | `StudioView.vue:93-133`、`NodeCanvas.vue:1201-1242` |
| 三套主题 × 明暗正交切换 + 白标品牌色 | `theme.js`、`themes.css`、`__theme.test.mjs:92-126` |
| 三层错误边界（Vue errorHandler / onErrorCaptured / window） + fatal/soft 分级 | `errorboundary.js`、`main.js:35-37`、`App.vue:42-45` |
| 会话令牌 + 401 区分（本地会话二次防线） | `api.js:7-49` |
| iframe 嵌入桥（双向 postMessage、来源校验、resize 上报） | `embed.js` |
| 双屏独立窗口（BroadcastChannel 同步选中结果） | `popoutBus.js`、`PopoutPanel.vue` |
| 新手引导（3 章 12 步、按需切路由/铺工作流、自动翻面定位） | `onboarding.js:4-99`、`OnboardingTour.vue:34-108` |
| 桌面端窗口控制（最小化/最大化/关闭/双击标题栏） | `WindowControls.vue`、`AppShell.vue:18-22` |
| 素材库（分类/搜索/标签筛选/标签编辑/删除/拖拽） | `MaterialLibrary.vue` |
| 运营后台 6 个面板（账号/角色矩阵/部门/日志/密钥）对接真实 API | `admin/*.vue`、`api.js:339-412` |

### 8.2 半成品（框架在、关键一环缺失或写错）

| 项 | 现状 | 证据 |
|---|---|---|
| **语义缩放** | 分档逻辑对，CSS 选择器错，far 档只隐藏 textarea | `NodeCanvas.vue:75-86` vs `newui.css:9-28`（详见 §2.2） |
| **作品组的持久化与撤销** | 结构字段不进 serialize → 刷新/撤销即散架 | `NodeCanvas.vue:178-197` vs `:317-323` |
| **视频（reference）节点连线** | 端口已声明但无 handle，拖不出线，只能靠兜底新建结果节点 | `ports.js:46-48` vs `ReferenceNode.vue`（无 Handle） |
| **充值支付** | 下单是真的，支付是模拟：假二维码 + 前端直接标记已付 | `AccountModals.vue:48-66,88-112`；`:343` 按钮文案"我已完成支付（演示）" |
| **团队管理** | 纯本地数组，无 API，刷新清空 | `AccountModals.vue:181-209` |
| **微信连接** | 纯本地布尔开关 | `AccountModals.vue:212-222` |
| **自动更新 UI** | 下载进度是 `setInterval` 模拟的（约 5.5s 走完），"立即重启"= `location.reload()` | `UpdateToast.vue:34-61,67-69` |
| **技能（SKILLS）入口** | 8 个入口只改高亮，不铺工作流 | `store.js:5-14,186-189`、`AppShell.vue:226-238` |
| **顶栏搜索** | 搜索框已删、`runSearch` 无入口、`searchKeyword` 只写不读 | `AppShell.vue:43-50`、`TemplatesView.vue:10` |
| **提示词预设** | 只有标题和"搜索并加载提示词预设"文案，无输入框无数据 | `StudioView.vue:393-396` |
| **空画布/首页的上传按钮** | 首页输入框左侧回形针按钮无 @click | `HomeView.vue:160-162` |
| **对话抽屉的三个按钮** | 历史对话/添加素材/语音输入均无 handler | `ChatDrawer.vue:44,69,75` |
| **结果节点"白底图/姿势裂变/裁剪"** | 只弹提示"需要接入图像编辑模型后可用" | `ResultNode.vue:88-91,131-139` |
| **`ResultNode` 的"放大 2×"** | 是 canvas 双线性放大，不是超分模型 | `ResultNode.vue:54-80` |
| **ComfyUI 连接状态** | `comfyOk`/`checkComfy` 计算了但模板不用（创作台不显示连通状态） | `StudioView.vue:30,41-43`（grep 确认无模板引用） |
| **`ai-video` / `ai-video-replica` 工作流** | 只铺一个 reference 节点、零连线；且 `ai-video-replica` 与 `ai-video` 定义完全相同（同一套参数，无"复刻"逻辑） | `store.js:504-515` |
| **`smart-generation` 与 `custom-scene`** | 节点图完全一样（3 节点同坐标同边），只差 label | `store.js:440-465` |
| **Properties/多选"张数"** | 多选时 `<select :value="1">` 硬编码，永远显示 1 张 | `InspectorPanel.vue:276` |
| **风格节点在属性栏无预览** | `type==='product'||'style'` 共用 `one.data.file?.url`，而 style 用的是 `data.files[]` → 永远显示"未上传图片" | `InspectorPanel.vue:318-322` vs `StyleNode.vue:53` |
| **作品库视频缩略图** | 两个分支都是 `<img>`，视频不会播 | `ReviewView.vue:188-189` |
| **`reference` 节点参数行** | 有 model/resolution/duration 三个下拉，但 `generateVideo` 只把 `resolution/duration` 送后端（`model` 仅在文案里出现） | `ReferenceNode.vue:97-101` vs `NodeCanvas.vue:751-757` |

### 8.3 死代码 / 未接线代码

| 类别 | 明细 | 证据 |
|---|---|---|
| **整个目录废弃** | `src/components/_deprecated/InfiniteCanvas.vue`(163行) 与 `PromptPanel.vue`(244行)，**全仓库零引用**（只在 3 份 .md 里被提及） | grep `_deprecated\|InfiniteCanvas\|PromptPanel` 仅命中 `README.md:47-48`、`完整技术总文档.md:540,1246` |
| **废弃文件连 import 都是坏的** | `InfiniteCanvas.vue:3` import `removeSelected,selectOnly,clearSelection,addNode,removeNode`；`PromptPanel.vue:4` import `addNode,placeGrid` —— **这些在 `store.js` 里全部不存在**；`PromptPanel.vue:42,57,123` 还用了不存在的 `store.prompt/store.generating/store.history/store.nodes` | 若将来被 import 会立即抛错，**不要"清理时顺手接回去"** |
| 未使用 import（`NodeCanvas.vue`） | `typeColor`(`:19`)、`splitPrompts`(`:21`)、`markError`(`:23`) —— 三者在文件内均只出现于 import 行 | grep 逐符号确认 |
| 解构了不存在的 API | `setSelection`(`NodeCanvas.vue:39`)：`@vue-flow/core@1.48.2` 无此导出（实测 0 命中） | 死解构，`applySelection` 已替代 |
| 死计算属性 | `AppShell.vue:52-54` `runningCount/doneCount/errorCount`；`StudioView.vue:30` `comfyOk`；`App.vue:82` `canAdmin`（`AppShell.vue:41` 有同名且被使用） | grep 确认模板未引用 |
| 死函数/变量 | `AppShell.vue:45-50` `searchText`+`runSearch`；`StudioView.vue:41-43` `checkComfy` | 同上 |
| 死 prop | `AppShell.vue:25` `settingsOpen`（只被 emit 更新，组件内不读） | `App.vue:237` 传了 `v-model:settings-open` |
| 死 inject | `ProductNode.vue:7`、`StyleNode.vue:7`、`ResultNode.vue:8` 的 `const exec = inject("exec")` 未被使用（`PromptNode/ExecutorNode/ReferenceNode` 的用法是对的） | 各文件 grep `exec.` |
| 死 export（store） | `RATIO_SIZE`(`store.js:57`)、`credits` 字段(`:159`)、`HOME_TASKS`(`:519-525`) | 全仓库无引用 |
| 死 export（project） | `saveMeta`(`project.js:324-329`) 从未被调用 | grep 确认 |
| 死 export（api） | `securityStatus`(`:197`)、`uploadImage`(`:202`)、`batchList`(`:296`)、`batchRemove`(`:298`) | grep 确认无调用方 |
| 无效 import（节点组件） | `ReferenceNode.vue:3` import `Handle, Position` 却从不使用（因为压根没渲染 handle） | 见 §3.3 |
| 历史残留字段 | `store.generating`(`store.js:179`)、`store.history`(`:180`)：主链路已由 `tasks` 取代，仅废弃的 PromptPanel 在用 | `pushHistory`(`:282-289`) 仍被 `NodeCanvas.vue:688,700,713,777,791` 调用，但只有 `AppShell` 的死计算属性读它 |

**注意**：`store.history` 处于"写多读死"状态——`pushHistory` 被调 5 次，唯一读取者是 `AppShell.vue:52-54` 三个未使用的计算属性。

### 8.4 TODO/FIXME 扫描结果

**`src/**` 下 TODO / FIXME / XXX / HACK 命中数为 0**（正则 `\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b` 全目录 0 匹配）。这**不代表没有未完成项**：本项目的习惯是用**大段中文注释主动声明缺口**，例如：

- `NodeCanvas.vue:577-578`："⚠️ P0-0 仍是阻断项：服务端 provider 目前只发文本，图片还没真正进模型"
- `AccountModals.vue:90-91`："前端直接调用等于允许伪造支付。这里仅为打通流程演示"
- `ResultNode.vue:88`："需要云端能力的操作：这里给出明确提示，接口就绪后即可接入"
- `ThemeSwitcher.vue:4` / `theme.js:5`：过时注释（经典蓝 / 默认 Aurora）

**接手建议**：搜 "⚠️"、"演示"、"待接入"、"就绪后"、"仍是" 比搜 TODO 有效得多。

---

## 9. 深挖：NodeCanvas.vue 的生成执行引擎

（任务要求"真正读完并讲清"，核心逻辑集中在这 1894 行的 4 段）

### 9.1 单节点图片生成 `generateImage(executorId, opts)` `:534-720`

1. **守卫**：节点不存在或 `data.busy` → `{ok:false, skipped:true}`（`:536`），批量模式下会标记"忙碌中，已跳过"（`:990-992`）。
2. **上游分拣**：遍历入边，按源节点 type 归类 `promptNode/styleNode/productNode`，product 再按 `data.role` 细分 `modelNode/outfitNode`（`:541-557`）。
3. **硬校验**：必须有 prompt 节点且文本非空，否则 `d.error = "请先连接「画面描述」节点并输入描述"` 并返回（`:559-562`）。
4. **尺寸换算**：`resolveSize(store.imageResolution, promptNode.data.ratio)`（`:565`），实现在 `store.js:47-54`（长边 2048/4096，按比例算另一边）。
5. **提示词拼装（三层叠加）**：原始 prompt（`:568`）+ 参考素材文件名清单"（参考素材 - 服装图：xx.png；…）"（`:569-574`）+ 一致性要求"（一致性要求：保留原图的针织纹理与褶皱；印花区域限定在前胸）"（`:591-604`）。印花区域中英映射表硬编码在 `:601`。
6. **参考图清单**：outfit/model/product 单图 + style 多图，过滤后送 `{url,name,sha256}`（`:579-587`）。
7. **任务 id 必须在 payload 之前生成**：`:606-613` 的注释点明了 TDZ 坑（`const` 不提升），`taskId` 同时进 payload（`:628`）供服务端登记与取消。
8. **成本确认**（可被批量外层跳过，`:632-638`）。
9. **执行分支**：`total <= MAX_PER_BATCH(4)` 单批走 `generateStream`（`:653-661`）；否则 `runBatches` 客户端分批 + 断点续跑（`:662-683`），逐批 `onBatchDone → recordAssets` 落库（`:677-678`）。
10. **取消检查**：`controller.signal.aborted` 在 await 之后立刻判定（`:685-690`、`:706-709`），避免"取消了还算成功"。
11. **免扣费提示**：`savedCost>0`（输入未变化）→ success「已省 N 点」；`cached/replay` → info「命中历史结果」（`:692-696`）。
12. **收尾**：`addResultNode` 填/建结果节点（`:698`）→ `recordAssets`（`:699`）→ `pushHistory`（`:700`）→ `finishTask`（`:701`）→ `notifyGenerated` 回传宿主（`:703`）→ `finally` 清 controller、复位 busy、4s 后清状态文案（`:715-719`）。

### 9.2 视频生成 `generateVideo(refId)` `:722-798`

与图片流程同构，差异点：输入校验是"prompt 非空 + 至少一种输入"（`:728-735`，其中 `:732` 的条件 `&& !d.prompt` 恒为 false —— 因为上面已校验 prompt 非空，属**冗余条件/小逻辑瑕疵**）；必弹成本确认（120 点/次，`:737-739`）；取首帧 `d.images[0]` 作 `firstFrame`（`:741`）；结果走 `addResultNode(refId,{videos})`（`:769`）。

### 9.3 批量节点模式 `:800-1042`

- 三件套：`createBatchFromPrompts`（把 N 行提示词铺成 N 组 prompt+executor+result 网格并连好线，`:820-892`）、`runBatchNodes`（串行跑选中执行节点，`:920-1007`）、`cancelBatch`（`:1017-1021`）。
- **为什么串行**：`:912-917` 注释 —— 并发会把上游限流打满，且取消时已发出的收不回；串行 + 每步检查中止信号，取消最多浪费当前一张。
- 批量前只弹一次总账（`:932-955`），逐节点用 `skipConfirm:true`（`:981`）。
- 行状态机：`queued → running → done|error|canceled|skipped`（`:959-998`），文案统一走 `batchmode.js:82-94`。
- 画布模式持久化 `ai-canvas.canvas-mode.v1`：读在 `onMounted`（`:1660-1666`），写在 watch（`:1754-1768`），切回 free 时清 `batchRows` 与选中（`:1762-1766`）。
- 取消链路顺序讲究：**先通知服务端停上游（ComfyUI /interrupt），再断本地连接**（`:1036-1042` 与 `api.js:53-58` 注释）。

### 9.4 键盘与交互细节 `:1395-1563`

- 总入口 `window.addEventListener("keydown", onKeyDown)`（`:1620`），注释记录了"以前只定义没注册，导致所有快捷键失效"的坑（`:1617-1619`）。
- 弹窗拦截用**可见性判断**而非选择器命中：`:1407-1417 isModalOpen()` 检查 `.ad`、`.tour-card` 以及 `.el-overlay` 的 computed style，因为 Element Plus 关闭的弹窗仍留在 DOM（实测 6 个 overlay，注释 `:1426`）。
- 快捷键全表：Ctrl+Z / Ctrl+Shift+Z（`:1433-1438`）、Ctrl+A（`:1441-1446`）、Delete/Backspace（`:1449-1456`）、Esc（`:1459-1462`）、Ctrl+0（`:1465-1469`）、Ctrl+±（`:1472-1481`）、Ctrl+G / Ctrl+Shift+G（`:1484-1489`）、Ctrl+B（`:1492-1496`）、Ctrl+D 复制（`:1499-1513`，浅拷贝节点 + 偏移 60px）、1-5 切工具（`:1517-1521`）、D 素材库/M 小地图/F 对话（`:1523-1525`）、N 中央新建 prompt（`:1529-1537`）。
- 与 `StudioView.vue:84-90` 的帮助对话框内容**一致**（逐条核对无出入）。

---

## 10. 缺陷与风险清单（触发条件 + 影响 + 建议）

| 级别 | 缺陷 | 触发条件 | 影响 | 建议 |
|---|---|---|---|---|
| **高** | 恢复画布后新节点 id 冲突 | 启动时有本地画布（`App.vue:210-211` → `NodeCanvas.vue:1693-1697 restoreGraph` 保留原 id）→ 随后加任何节点 | 与已恢复节点同 id，节点丢失/覆盖（Vue Flow 行为**未验证**） | `newFlowId` 前扫一遍现有 id 并抬高 `nextId`，或在 `restoreGraph` 里重生成 id（可参照 `applyTemplateGraph:1211` 的做法），并导出 `bumpFlowId(n)` |
| **高** | 作品组不持久化 | 编组后刷新页面，或编组后 Ctrl+Z | 子节点散开、组框尺寸回退、折叠态丢失 | `serialize()` 补 `parentNode/extent/hidden/zIndex/style`；`restoreGraph` 按原顺序 addNodes 以保住父子关系 |
| **高** | 充值支付可被前端伪造 | 打开充值弹窗 →"生成支付二维码"→"我已完成支付（演示）" | 若后端 `/api/recharge/orders/:id/paid` 在非沙箱环境放开，等于免费充值 | 与 task-2 的 `payments.js` 回调验签方案对齐；非沙箱时前端**不应**持有该调用 |
| **高** | 语义缩放核心规则不生效 | 缩放到 <50% | 远视图塞满缩略图，"全局俯瞰"体验失效 | 把 `newui.css:9-13,23` 的选择器改成真实类名（`.nf-product-body/.nf-product-thumb/.nf-style-body/.nf-style-thumbs/.nf-result-grid/.nf-prompt-bar/.nf-product-head/.nf-style-head/.nf-result-head`），并为 `zoom-near` 补"显示额外参数"的真实规则 |
| **中** | 主题测试红（基线不绿） | `npm test` | 任何人都无法区分"环境坏了"和"真回归" | 改 `__theme.test.mjs:52` 断言为 `atelier`（或在测试里断言 `DEFAULT_THEME === themeById(DEFAULT_THEME)?.id` 之类不写死值） |
| **中** | 拖动节点位置不可撤销 | 拖动节点 → Ctrl+Z | 用户以为撤销可用，实际不动 | 在位置 watch（`:413-421`）里改为"松手后 pushSnapshot"，或在 `onNodeDragStop` 入栈 |
| **中** | 视频节点拖不出连线（幽灵端口） | 用 AI视频 工作流想手动把视频接到结果节点 | 端口表与实际 DOM 不符 | 给 `ReferenceNode.vue` 补 `<Handle type="source" id="result" data-port="video">`，或从 `ports.js:46-48` 删掉声明 |
| **中** | 首页项目操作绕过持久化 | 首页点"新建项目"/点项目卡 | 新建的项目刷新即丢；打开项目不切 `currentProjectId`，后续保存写错条目 | `HomeView.vue:77-93` 改调 `project.js` 的 `createProject/openProject` |
| **中** | 上传分类三套口径 | 同一张图从素材库/节点/拖拽三个入口上传 | 素材库分类混乱，用户找不到图 | 统一成一个常量（建议复用 `MaterialLibrary` 的分类 id） |
| **中** | 上传结果缺 `sha256` | 节点内手选文件上传 | 上游内容级去重（P1-8）对这批图失效 | 让 `uploadMaterial` 返回体带 sha256 并在节点组件里保存 |
| **中** | 8 个技能入口空转 | 侧边栏点"AI 文生图""一键高清"等 | 用户点了没反应（只跳创作台），期望落空 | 要么给 `SKILLS` 加 `workflow` 字段并接通 `pendingWorkflow`，要么先隐藏这一组 |
| **中** | 团队管理/微信连接是假的 | 任意操作后刷新 | 演示穿帮 | 明确标注为"未接入"或在 UI 上禁用 |
| **低** | `App.vue:82 canAdmin` 与 `AppShell.vue:41` 重复 | 维护时改一处漏一处 | 权限入口显隐不一致 | 删掉 App.vue 里的那份（未使用） |
| **低** | `AppShell.vue:25 settingsOpen` prop 无效 | 传了但组件内不读 | 阅读成本 | 删 prop |
| **低** | 多选"张数"硬编码显示 1 张 | 多选 prompt 节点打开属性栏 | 显示与实际不符 | 用第一个 prompt 节点的 count 做 value |
| **低** | 风格节点属性栏预览永远空 | 选中 style 节点 | 用户看不到自己传的参考图 | `InspectorPanel.vue:320` 对 style 分支读 `one.data.files[0]?.url` |
| **低** | 作品库视频用 `<img>` | 生成过视频后在作品库查看 | 视频不显示/裂图 | 换成 `<video>` 或取首帧 |
| **低** | `popoutBus.onPopout` 单监听槽 | 将来第二个组件也订阅 | 后订阅者覆盖前者 | 改成 `addEventListener` 或 `Set<fn>` |
| **低** | `Delete` 双通道删除（Vue Flow `delete-key-code` + 自研 keydown） | 选中节点按 Delete | 理论上重复删除（幂等） | 二选一，建议关掉 `:delete-key-code` 让自研逻辑独占（它还要清 `store.selection`） |
| **低** | `pendingRestore` 残留 | 首页带 `pendingWorkflow` 进入且本地有旧画布 | 再次挂载画布时意外恢复旧图（**推断**） | 在 `:1675-1697` 的三个分支里都清空 `store.pendingRestore` |
| **低** | `store.projects` 有硬编码种子数据 | 全新用户首次打开 | 出现"新手教程""Untitled"两个假项目 | 首启改为空数组，或明确标为示例 |

---

## 11. 未验证 / 待实测清单

1. **节点 id 冲突的具体表现**：Vue Flow 1.48 收到重复 id 时是丢弃新节点、覆盖旧节点还是抛 warning，需实测（代码事实是 id 会重复）。
2. **`pristine` 分支与 `pendingRestore` 的交互**：首页带工作流进入时 `pendingRestore` 是否会残留并影响下一次挂载。
3. **拖动节点后 Ctrl+Z 的真实表现**：理论上不入栈，需确认 vue-flow 是否内部有历史（**推断**：没有）。
4. **删除节点时 Vue Flow 是否连带删除相连边**：影响 `restoreSnapshot` 重建时是否会出现悬挂边（当前用 `restoreSnapshot` 全删全建，风险低）。
5. **视频节点补 handle 后** `restoreSnapshot`/持久化能否保住 `dataType:"video"` 的边（当前无法产生这种边，故未验证）。
6. **`flow.onEdgesChange` 注册后是否需要在卸载时解绑**（`NodeCanvas.vue:402` 没有保存返回的清理函数）。
7. 语义缩放修复后 far 档的实际观感（需要浏览器）。
8. `src/__ui.test.mjs` / `src/__robust.test.mjs` 的通过情况（本次只实跑了 `__theme.test.mjs`；其余属 task-3「测试基建」范围）。

---

## 12. 给接手人的 5 条行动建议

1. **先修 3 个"低成本高收益"**：语义缩放选择器（改 CSS，1 小时）、主题测试断言（改 1 行）、`newFlowId` 冲突（加一个 id 扫描，半天）。这三项直接影响日常体验且风险极低。
2. **把 `serialize()` 当作画布的"契约中心"**：任何新增的节点级语义（父子、尺寸、折叠、锁定）都必须进这个函数，否则撤销与持久化会静默丢信息。当前正因如此，作品组是"半成品中的半成品"。
3. **画布与业务能力要分家**：`bridge`（25 槽）+ `provide("exec")`+`defineExpose`（32 成员）+ 7 个 `CustomEvent`/`postMessage` 通道，四套机制并存。接手后若要做多画布、或把画布抽成独立包，第一步应该是把这四套收成一套。
4. **支付/团队/微信三条线在对外演示前必须定性**：要么明确标"未接入"，要么等后端验签就绪（`AccountModals.vue:88-112` 的注释已经把风险写在脸上了）。
5. **建立"文档注释 vs 代码"的巡检习惯**：本项目文档债很高（`theme.js:5`、`ThemeSwitcher.vue:4` 的过时注释；`__theme.test.mjs:52` 的过时断言；`README.md:47-48` 仍在描述已废弃的自研画布引擎）。搜 `⚠️`/`演示`/`就绪后` 定位声明缺口，比搜 TODO 有效。

---

*报告结束。所有结论均附代码行号证据；标注「未验证」「推断」的条目为需要运行环境才能确认的部分。本次拆解未修改 `ai-canvas` 下任何源码文件。*
