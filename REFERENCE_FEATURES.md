# AI Change v2.8.5 完整功能探索报告

> 探索时间：2026-09-10
> 探索方式：独立启动参考工具后端（隔离数据目录 + 隔离配置），通过浏览器进入其真实界面，逐模块截图 + 从打包产物提取真实的数据结构与代码定义。
> 数据安全：全部操作在 `aichange-preview/iso-data` 隔离副本上进行，**未改动用户真实项目与安装目录**。

---

## 一、结论速览

参考工具 **AI Change** 是一款 **Electron + 内嵌 Node 服务** 的桌面应用，定位是「**更高效的 AI 电商设计工具**」。核心是一块**无限节点画布**，左侧 5 个工具箱入口，每点一个就**在画布上生成一整套预置工作流节点**，用户上传素材 + 写描述即可执行。

**一句话范式**：`选工具 → 自动铺工作流节点 → 传素材 → 写描述 → 执行 → 结果`。

---

## 二、技术发现：它自己的本地开发免登录开关

后端 `index.cjs` 中存在官方调试通道：

```js
var LOCAL_DEV_AUTH_USER = { id: 0, phone: "local-dev", balance: 0 };
function isLocalDevAuthBypassEnabled() {
  return process.env.NODE_ENV === "development" && process.env.AUTH_DEV_BYPASS === "1";
}
```

`GET /api/app/auth/session` 逻辑：有持久化会话 → `loggedIn:true`；否则若开发开关开启 → 用 `local-dev` 用户；否则 `loggedIn:false`。

所以手机号登录在架构上是**"用户管理 + 算力计费 + 更新通道"**，不是功能锁——功能本身的后端 API 基本不校验登录（`/api/projects`、`/api/asset-library`、各 `-outputs` 接口均可直接访问）。

**启动它的最小环境变量**（Electron 主进程会注入这些）：
```
APP_DATA_ROOT     数据根目录（projects / outputs / asset-library …）
APP_CONFIG_ROOT   配置目录（license.json / api_keys.json / app_api_session.json）
BACKEND_BASE_URL  http://127.0.0.1:<port>
INTERNAL_CONTROL_TOKEN / MUTATION_TOKEN   双令牌
PORT              业务端口（默认 3100）
```
端口 3100 提供 SPA + API，3101 是只读媒体服务。

**开发模式的一个坑**：`resolveStaticPath()` 在 `NODE_ENV=development` 时指向 `<dist>/../../dist/public`（这是给源码仓库用的），打包后应用里不存在。解决：把后端入口复制到临时目录并按该结构放置 `dist/public`。

---

## 三、完整功能地图

### 3.1 首页 —— 对话式入口

| 区域 | 内容 |
|------|------|
| 顶部 | AI Change logo · v2.8.5 · 历史 · 算力余额/充值 · 账号 |
| 左侧图标栏 | ➕新建 · 首页 · 我的项目 · 账号 · 帮助 |
| 主标题 | **AI Change 更高效的AI电商工具**（橙色强调）／副标题「懂你的AI代理，帮你搞定一切」 |
| 对话输入框 | placeholder「将图中的衣服设计一个合适的欧美模特，在摄影棚中…」+ 上传(最多8张) + 发送 |
| 快捷任务 chips | **AI换衣** · 图片编辑 · 图片编辑 · 详情页制作 · AI视频 |
| 最近项目 | 项目卡片网格 + 「查看全部 →」 |

### 3.2 画布页 —— 核心工作台

| 区域 | 内容 |
|------|------|
| 顶部栏 | logo · 项目名「Untitled」(下拉) · **模型设置**(下拉) · 撤销(Ctrl+Z) · 重做(Ctrl+Shift+Z) · 缩放(— 100% ＋) · 夜间模式 · 算力充值 · 账号 |
| 左侧工具箱 | **AI换衣 / 图生图 / 文生图 / 详情页制作 / AI视频**（数字键 1–5） |
| 左下工具 | 素材库(D) · 小地图(M) · 帮助 |
| 左下卡片 | **提示词预设**（"搜索并加载提示词预设"） |
| 右侧浮钮 | **对话**(F) —— 打开 AI 创作助手抽屉 |
| 画布 | 点阵网格无限画布，可框选、拖拽、缩放 |

**模型设置面板**（真实下拉项）：
- 模型选择：`Nano Banana Pro` / `Nano Banana 2` / `GPT Image 2`（默认）
- 分辨率选择：`2K`（默认） / `4K`

### 3.3 我的项目页

「我的项目 / 管理你的所有设计项目」+ 搜索框 + 项目卡片网格（新建项目卡片 + 素材缩略图拼贴的项目卡）。

---

## 四、工作流模板（从打包产物提取的真实定义）

```js
// 左侧工具箱
const TOOLBOX = [
  { id:"ai-clothes",     label:"AI换衣",      hasSubmenu:true },
  { id:"product-design", label:"图生图",      hasSubmenu:true },
  { id:"image-generate", label:"文生图" },           // 无子菜单，直接铺节点
  { id:"detail-page",    label:"详情页制作",  hasSubmenu:true },
  { id:"ai-video",       label:"AI视频",      hasSubmenu:true },
];

// 各工具的预置工作流（toolType 即节点模板 id）
AI换衣   : clothes-model 服装图模特图换衣
          / style-reference 参考风格换衣
          / clothes-model-pose 服装图模特图换衣+姿势裂变
          / fixed-face-bg-pose 固定面部、背景、参考姿势换衣
          / pose-split 姿势裂变

图生图   : custom-scene 自由创作
          / smart-generation 智能创作

详情页制作: detail-page 详情页制作
          / image-replica 图片复刻

AI视频   : ai-video 视频生成
          / ai-video-replica 视频复刻
```

**典型工作流节点链（实测「服装图模特图换衣」）**：

```
[服装图 上传]   [模特图 上传]   [参考风格(可选) 上传]        ( ○ 执行 )
  点击或拖拽上传   点击或拖拽上传    点击上传风格图          「完善输入后显示算力」
                          ↓
              ┌─ 提示词输入框「请输入画面描述…」
              └─ 工具栏： GPT Image 2 ▾   4张 ▾   3:4 ▾
```

**节点类型**（`type`）：`image` / `images` / `text` / `video` / `upload-boxes` / `image-replica-product` / `image-replica-reference`

**节点业务 kind**：`image-generate` · `ai-video` · `comfy-clothes` · `canvas-upscale` · `agent` · `folder` · `timeline` · `context`
**执行状态**：`ready` · `prepared` · `run` · `estimate` · `error` · `missing` · `skipped` · `save-required`

> 注意 `comfy-clothes`：说明它**深度集成了本地 ComfyUI 做换衣**，与云端模型（Nano Banana / GPT Image 2）并存。

---

## 五、选中图片后的编辑能力

选中画布上的媒体后，可执行（实测提取）：

| 操作 | 说明 |
|------|------|
| 放大 (upscale) | 高清放大 |
| 调整 (adjust) | 参数调整 |
| 裁剪 (crop) | 裁剪 |
| 编辑文字 (text-edit) | 改图内文字 |
| 扩展 (outpaint) | 向外扩展画面 |
| **白底图** (white-background) | 一键去背 |
| **姿势裂变** (pose-variation) | 同一模特多姿势 |
| 下载 / 批量整理 / 对比 | 通用操作 |

对话助手抽屉里的快捷提示 chips 也呼应这些：**姿势裂变 · 白底图生成 · 抠图生成**。

---

## 六、快捷键体系

| 场景 | 操作 |
|------|------|
| 全局 | `1–5` 切换工具组；`D` 素材库；`M` 小地图；`F` 对话 |
| 画布 | 空白处左键拖动=框选；`Ctrl`+拖动=立即框选；`Shift`+框选=追加；`Shift`+点击媒体=加选；方向键微调(Shift 每次 10px)；`Esc` 取消拖拽 |
| 媒体 | 选中后按快捷键触发放大/调整/裁剪/扩展/白底图/姿势裂变/编辑文字 |
| 提示词预设 | 焦点在编辑框时 `Ctrl+Shift+P` 打开预设选择器；`Ctrl+1–9` 加载预设槽位 |
| 通用 | `Ctrl+Z` 撤销；`Ctrl+Shift+Z` 重做 |

---

## 七、素材库

面板标题「素材库 / 跨项目复用的本地图片和视频」，含搜索框与 5 个可折叠分类：

**服装 · 模特 · 场景 · 道具 · 其他** —— 每个分类可「管理文件夹」，空态提示「可拖入素材或点击 + 添加」。

---

## 八、账号 / 计费 / 更新体系（手机号登录的真正用途）

账号菜单内容：
- **已登录手机号**（132****6699，已脱敏）
- **余额**（算力，当前 0）
- **使用详情**（消费记录）
- **团队管理**（多账号/子账号，后端代码里可见 `accountType`、`parentUserId`、`sharedBalance`）
- **新手指引**
- **退出登录**

配套：license 激活（`license-tool` 机器指纹）、充值套餐接口、`electron-updater` + OSS 自动更新、更新日志。

> 所以手机号登录解决的是：**跨设备识别用户 → 算力计费 → 团队协作 → 版本更新**。功能本身在本地可离线跑（依赖本地 ComfyUI 时零成本）。

---

## 九、与 ai-canvas 的对比

| 维度 | AI Change v2.8.5 | ai-canvas（我们的复刻） |
|------|------------------|------------------------|
| 壳 | Electron 桌面 | 浏览器 + Express |
| 画布 | 自研无限节点画布 | Vue Flow |
| 工作流入门 | **点工具 → 自动铺整套节点** ✅ | 手动逐个加节点 ❌ |
| 工具箱 | 5 类工具 × 共 11 套预置工作流 ✅ | 无预置 ❌ |
| 节点类型 | image/text/video/upload-boxes | Prompt/Style/Product/Reference/Executor/Result |
| 图片后处理 | 放大/裁剪/扩展/白底/姿势裂变/文字 ✅ | 无 ❌ |
| 素材库 | 服装/模特/场景/道具/其他 ✅ | 基础 MaterialLibrary（部分） |
| 对话助手 | 右侧 AI 抽屉驱动创作 ✅ | 无（有 ChatDrawer 雏形） |
| 提示词预设 | 预设槽位 + 快捷键 ✅ | 无 ❌ |
| 账号/计费 | 手机号 + 算力 + 团队 ✅ | 无 |
| 更新 | electron-updater + OSS ✅ | 无 |
| 模型 | Nano Banana Pro/2 · GPT Image 2 · ComfyUI ✅ | 万相 · 即梦 · ComfyUI |
| 安全 | 双令牌 + AES + Host/Origin + license ✅ | 单令牌 + 凭据管理器 + Host/Origin（已加固） |

---

## 十、复刻优先级建议

**P0（决定体验差异）**
1. **工具箱 = 工作流模板**：左侧 5 个入口，点击自动在画布铺出对应节点链。这是参考工具最爽的地方，也是我们最缺的。
2. **节点自动连线 + 参数内联**：上传节点 → 提示词节点 → 执行节点自动串联，提示词节点内联「模型 · 张数 · 比例」工具栏。
3. **首页对话式入口 + 快捷任务 chips + 最近项目**。

**P1（专业感来源）**
4. **素材库 5 分类 + 跨项目复用 + 拖拽入画布**。
5. **选中媒体的后处理工具条**：白底图、姿势裂变、放大、裁剪、扩展。
6. **右侧 AI 对话抽屉**：自然语言驱动画布。

**P2（体系化）**
7. 提示词预设槽位 + 快捷键体系（1-5 / D / M / F / Ctrl+Shift+P）。
8. 项目管理页 + 项目卡片（素材拼贴缩略图）。
9. 模型设置面板（模型 × 分辨率）全局化。

---

## 十一、产出物

- 探索截图（15 张）：`ai-canvas/reference/explore/`
  - `01-home.png` 首页对话入口
  - `03-canvas.png` 画布工作台
  - `04-model-settings.png` 模型设置面板
  - `06-clothes-node.png` AI换衣 5 个子工作流
  - `07-workflow-nodes.png` 换衣工作流节点链
  - `09-text2img.png` 完整节点链（上传+提示词+执行）
  - `12-asset-library.png` 素材库
  - `13-chat.png` AI 对话抽屉
  - `14-projects.png` 我的项目
  - `15-account.png` 账号菜单
- 教程项目示例图：`ai-canvas/reference/tutorial-imgs/`（4 张，电商场景/展台/商品/模特）
