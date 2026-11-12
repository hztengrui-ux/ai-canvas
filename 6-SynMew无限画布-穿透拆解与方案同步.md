# SynMew Infinite Canvas · 穿透拆解与方案同步

> 拆解日期：2026-09-25
> 拆解对象：`C:\Users\Administrator\AppData\Local\SynMewInfiniteCanvas\`（v1.7.9）
> 拆解方式：PE 结构解析 + 安装目录穿透 + `session.json` 数据模型还原 + 128 个前端 chunk 清单提取 + MCP 工具描述提取 + 运行中实机截图 3 张
> 配套文档：`5-统一主方案V1-差距分析与实施路线.md`（本文所有「我们的方案」均指它）

---

## 0. 一页结论

SynMew Infinite Canvas 是一个 **Tauri + Vue 3 的 AI 批量创作画布**，与我们的「统一主方案 V1.0」在产品理念上高度同源（节点画布 + 批量生成 + 结果工作台），但它有三个我们方案里没有的杀手锏：

1. **双画布模型**：批量画布（nodes）与结果画布（cards）是两个独立工作区，各自持久化 viewport 和连线；
2. **workshopUpstreamSignature（上游签名）**：每个结果工作台记录上游拓扑签名，上游变了才知道要重跑——这是防重复扣费的关键机制；
3. **完整 MCP 工具层（60+ 工具）**：AI 不是"给建议"，而是能直接创建节点、连线、运行、重试、读日志——AI Agent 原生。

同时它印证了我们方案的方向：作品组、视图切换、viewport 持久化、任务重试、运行前检查、余额/消费记录，全部都是它的既有实现。

**给我们的行动**：吸收 4 项（上游签名、文件夹批量语义、强类型端口、模板反哺），重排 1 项（P1 批量方案简化），坚持 1 项（Electron 暂不迁 Tauri，理由见 §8）。

---

## 1. 基本盘

| 项 | 事实 |
|---|---|
| 产品名 | SynMew Infinite Canvas（窗口标题 `SynMew Infinite 1.7.9`） |
| 标识 | `com.synvow.canvas`，`main` 入口 |
| 技术栈 | **Tauri 2.x + WebView2 + Vue 3 `<script setup>` + Vite** + Rust 主进程 |
| 安装体积 | **24.6 MB 单 exe**（我们 Electron 等功能形态 ≥126 MB） |
| 附带运行时 | `ffmpeg/ffmpeg.exe`（62 MB，视频/音频拼接、抽帧、镜头分割） |
| AI 端侧模型 | MediaPipe `pose_landmark_full.tflite`（姿态估计，`estimatePoseFromImage` chunk） |
| 数据目录 | 安装目录内 `data/`（便携式设计，不写 Roaming） |
| 凭据 | `data/secrets/*.enc` 加密存储：`auth-session` / `remembered-login` / `connection__<id>__cn_<ts>` |
| 登录方式 | `auth_send_code` 验证码 + `auth_login`，云端账号（界面右上「余额 0.00」） |
| 运行状态 | 截图时正在运行，内存 88 MB |

## 2. 数据模型（session.json 实测还原）

这是本次拆解最有价值的产出——它的**画布持久化格式**是完整可读的 JSON：

```jsonc
{
  "tabs": [                        // 多项目 = 多标签页并存（实测 5 个）
    {
      "name": "全能N_图像批量",
      "filePath": "",              // 可另存为文件（project_export）
      "canvas": {
        "nodes": [ /* 见 §3 */ ],
        "groups": [],              // ★ 分组是一等公民（我们方案的"作品组"）
        "links":  [ /* 见 §4 */ ],
        "viewport": { "scale": 1.1, "x": 473.2, "y": -162.6 }   // ★ 视口持久化
      },
      "lastSavedHash": "{\"nodes\":...}"   // ★ 脏检查（保存三态的基础）
    }
  ],
  "activeIndex": 3,
  "resultTabs": [                  // ★ 第二画布：结果/创作卡画布
    { "name": "新项目", "data": { "cards": [], "links": [], "viewport": {...} }, "lastSavedHash": "..." }
  ],
  "activeResultIndex": 0,
  "viewMode": "node"               // ★ 视图模式（界面顶部「模式: 批量模式」）
}
```

四个设计点直接回应我们方案 P0/P1 的验收项：

| 我们方案的验收项 | SynMew 的实现 |
|---|---|
| 「保存重开后能恢复项目」 | 整个会话（含 viewport、脏检查 hash）落 `session.json` |
| 「项目/作品组/节点/结果的数据关联」 | `canvas.groups` 一等公民 + 双画布分离 |
| 「远景/中景/近景不丢状态」 | viewport `{scale,x,y}` 每画布独立持久化 |
| 多项目并行 | tabs 数组，顶部标签页直接切换（已实测点击切换成功） |

## 3. 节点类型体系：`<域>/<功能>` 双层命名

实测存在的类型（运行时数据 + chunk 名双重印证）：

```
image/    load-image · load-image-folder · load-image-grid · load-image-http
          load-video · load-video-grid · load-video-path · load-audio · load-audio-path
          preview · preview-text · preview-video · preview-audio · preview-result
          workshop（图像工作台）
ai-image/ gpt-image · nanobanana · nanobanana-ibatch · nanobanana-tibatch
          jimeng · jimeng-ibatch · jimeng-tibatch · gk-image(+i/ti)batch
ai-text/  gemini-ibatch · gpt-chat(+ibatch) · reference-layer-split
text/     text-list · text-group · note · string-range-extractor · workshop
```

关键节点的完整字段（实测）：

**`image/load-image-folder`（文件夹即批次）**：
```jsonc
{ "folderPath": "", "index": 0, "batch": 0,
  "batchSize": 5,          // 每批 5 张
  "loadAll": false,        // 或全量
  "sortOrder": "name-asc" }
```

**`ai-image/nanobanana-ibatch`（图生图批量）**：
```jsonc
{ "modelType": "nano-banana-2-稳定", "aspectRatio": "1:1",
  "imageSize": "1K", "prompt": "" }
```

**`ai-image/nanobanana-tibatch`（文+图交叉批量）**：多一个 `"promptOrder": "sequential"`——N 图 × M 提示词按顺序交叉。

**`ai-text/reference-layer-split`（参考图分层 ★）**：
```jsonc
{ "model": "gemini-3.5-flash-2606", "layerCount": 3, "userPrompt": "" }
```
用多模态模型把参考图拆成 N 层——**这正是毛衫印花「底色层/印花层/纹理层」需要的原子能力**。

**`image/workshop`（结果工作台 = 批次结果表）**：
```jsonc
{ "rows": [ { "id": "row-...", "seq": 1, "source": "gemini", "prompt": "...", ... } ],
  "stopOnError": true, "autoSaveEnabled": true,
  "batchLog": "", "runBatchStatus": "", "lastSavedPath": "",
  "workshopUpstreamSignature": "text/workshop#{...}#node-xxx:text->text|ai-tex..." }
```

**`ai-image/gpt-image`**：`modelType / aspectRatio / resolution / quality / transparent / gptStyle / localImages`。

## 4. 强类型端口连线

```jsonc
{ "id": "link-...", "fromNode": "...", "fromPort": "image",
  "toNode": "...", "toPort": "imageGroup1", "dataType": "image" }
```

- `dataType` 取值实测：`image` / `string` / `ai-image`（推测还有 video/audio/text）；
- 端口名自带语义与基数：`imageGroup1`（第 1 图组）、`promptList`、`imageList`、`textList`、`referenceImage`；
- **我们现状**：Vue Flow 连线无类型校验，用户可以把文本接到图片口，运行时才报错。这条是低成本高收益的对齐项。

## 5. 批量执行与结果工作台

从 MCP 中文描述里还原出的执行语义（原文摘录）：

> - 「生成节点 canRun=false，须经末端带运行键的节点」——生成节点不能裸跑，必须从工作台发起
> - 「从作坊跑会带着上游生成」——workshop 是执行入口，自动级联上游
> - 「没有作坊：input=素材，generate=生成+结果」
> - 「run_preflight 运行前检查」——对应我们方案 §7「生成前成本确认」
> - 「task_retry 重试失败或已停止的批量任务。多次仍失败则改节点 model 后再跑」
> - 「task_get_logs 读取批量任务错误」
> - 「canvas_list_outputs 列出最近一次运行输出。含 source：input=原图，generated=生成」

再加上磁盘证据 `cache/batch-progress/project_<id>_<rand>.json`——**批次进度按项目持久化到磁盘**（我们方案 P1 的「批次持久化」它已实现）。

**workshopUpstreamSignature 机制（最高价值发现）**：工作台记录上游节点+连线的签名。重跑前比对：签名没变 → 直接复用上次结果（不重复扣费）；签名变了 → 提示需要重跑。我们方案的账本有 reserve→commit/rollback，但**没有"这次改动是否需要重新生成"的判断**——用户改个备注就重跑 10 张图会白扣费。建议列入 P1。

## 6. MCP / AI Agent 工具层（60+ 工具）

它把整个应用做成了 MCP Server（`DirectorStageMcpHost` chunk + `mcp_native`），AI 可以程序化操作一切：

| 域 | 工具 | 数量 |
|---|---|---|
| canvas（批量画布） | list_nodes / get_node / get_node_type / **search_node_types** / **list_groups** / list_links / list_outputs / get_output_preview / run_node / bind_connection / attach/detach_local_images / get_summary | 13 |
| result（创作卡画布） | create/list/get/update/delete_cards / connect/disconnect_cards / **run/cancel/wait_card** / list_links / list_card_types / get_summary / attach/detach_local_images | 15 |
| project | create / delete / export / import / list / list_files / rename / switch | 8 |
| task | list / get / **get_logs** / **retry** / cancel / wait | 6 |
| workflow | **apply_patch / auto_layout / explain / get_diff / validate** | 5 |
| comfy | import_workflow / queue_status / interrupt / history / clear_queue | 5 |
| workspace | get_context / undo / redo / **set_view_mode** | 4 |
| template | list / get / apply / **save_from_project** | 4 |
| model | search / get_capabilities | 2 |
| auth | login / logout / send_code | 3 |

三个亮点：

1. **`workspace_set_view_mode`** —— AI 能切换视图模式，说明「多视图」在它是被 AI 操控的一等操作；
2. **`workflow_get_diff` / `apply_patch` / `validate`** —— 工作流有 diff/patch/校验，等于给画布上了版本控制的语义；
3. **`template_save_from_project`** —— 用户/AI 可把当前画布另存为模板，**模板体系是活的**（我们方案模板是只读消费）。

描述文案里还有大量防呆约束（「输入卡不能当目标」「先 dryRun」「改正式稿前应先复制项目」），说明这套 Agent 接口是认真做过安全设计的。

## 7. 功能广度（128 个 JS chunk 全景）

| 类别 | 模块 |
|---|---|
| 图像模型（单张/批量三件套） | NanoBanana、Gemini、GptImage、GkImage、即梦 Jimeng、Midjourney、豆包、通义 Qwen、MiniMax、OmniFlash |
| 视频模型 | Seedance（即梦视频）、Veo、WanVideo、GrokVideo |
| 音乐 | Suno + WorkshopMusic |
| 文本 | GptChat、Doubao、MultiLine、SingleLine、ConcatString、StringReplace/Trim/RangeExtractor |
| 视频编辑（ffmpeg） | VideoConcat / VideoSplit / VideoFrameExtract / VideoEditor(+Page) / AudioConcat / smart_split 镜头分割 |
| 图像处理 | ImageEdit / ImageConcat / **StampCutout 抠图** / StampExtract / LightSphere / PanoramaViewer |
| 参考图专项 ★ | **ReferenceLayerSplit 分层** / **ReferenceImageOptimizer 优化** / estimatePoseFromImage 姿态 / FaceExpression 表情 / CharacterCard 角色卡 |
| 电商专项 ★ | **EcommercePrompt** / **GptProductStudio** |
| 办公集成 | FeishuSheetRead/Write、ExcelWrite（xlsx 库）、AliyunOssUpload、DouyinUnwatermark |
| 商业化 | RechargePanel / RechargeRecords / **ConsumptionRecords** / **ModelPricePanel** / ProfilePanel |
| 执行编排 | AppRun / **ComfyAppRun** / ModelRun / ConvertToResult / useRhTaskLimit（并发限制） |
| 导演台 | DirectorStage(+Page/McpHost) / useDirectorScene / Storyboard（3D 场景编排，MCP 描述里出现 updateObject/关键帧） |

注意 **ModelPricePanel**：模型价格是面板化展示的（对应我们方案 §2「2K、4K、模型名称和消耗是展示字段，真实可选项由服务端能力与价格配置提供」——它同样这么做）。**useRhTaskLimit** 印证并发限制是显式模块。

## 8. 技术栈判断：Tauri 的得与失（要不要跟？）

**它的收益**：exe 24.6 MB（我们 1/5）、内存 88 MB、启动快、数据便携。

**我们不跟的理由**：
1. 我们深度依赖 Electron 生态：`electron-updater`（差异更新已接 OSS）、`BrowserWindow` 多窗口登录、`webRequest` CSP 注入、菜单系统——Tauri 全部要重写；
2. WebView2 在 Win10 老版本存在兼容与分发问题，电商卖家旧机器占比不低；
3. 迁移是 2–3 周级别的重构，**不产生用户可感知价值**，P0–P2 的功能缺口才是价值。

**值得抄的轻量做法**：
- 数据目录随安装走（便携），`data/secrets/*.enc` 统一加密凭据——我们现在散在 `~/.ai-canvas` 的明文/半加密文件可以收敛成同样的 `secrets/` 目录结构（我们已有 vault.js，改造成本低）；
- **ffmpeg 按需内置**：我们暂无视频处理需求，列入路线图 P3。

## 9. 与我们方案的逐条同步

### 9.1 被印证的（不用改方案）

| 方案条目 | SynMew 证据 |
|---|---|
| §5 作品组 | `canvas.groups` 一等公民 + `canvas_list_groups` MCP 工具 |
| §4 三种视图切换 | `viewMode` + `workspace_set_view_mode` + 顶部「模式: 批量模式」 |
| §7 viewport/恢复 | 每画布独立 `viewport{scale,x,y}` 持久化 |
| §7 运行前成本确认 | `run_preflight` + 「预计张数×单价」同类机制 |
| §7 失败重试 | `task_retry` / `task_get_logs` / `batchLog` per node |
| §2 模型选项由服务端下发 | `model_get_capabilities` / `ModelPricePanel` |
| §6 拖素材→模板→批量→挑选→导出闭环 | load-image-folder → ibatch → workshop → SaveImage 全链路存在 |
| 批量结果持久化 | `cache/batch-progress/project_*.json` |

### 9.2 要吸收进方案的（4 项，建议排期）

| # | 吸收项 | 插入位置 | 成本 | 价值 |
|---|---|---|---|---|
| 1 | **workshopUpstreamSignature 上游签名** | P1（批量作品组）——重跑前签名比对，不变则复用结果不扣费 | 2 天 | ★★★ 防重复扣费，账本之外的第二道闸 |
| 2 | **文件夹批量语义**（batchSize/index/loadAll/sortOrder） | P1——替代原「批次编排」设计，更简单直接 | 1 天 | ★★★ 电商「一个文件夹=一批 SKU」心智 |
| 3 | **强类型端口 dataType** | P0（画布基础）——Vue Flow 连线加类型校验 | 1 天 | ★★ 消灭「连错口运行才报错」 |
| 4 | **template_save_from_project 模板反哺** | P2——用户画布可另存为模板 | 1 天 | ★★ 模板体系从只读变生态 |

### 9.3 要修正方案的（1 项）

- **P1 的「批次编排」原设计被简化**：原方案设想服务端批次队列 + 编排器；SynMew 证明**客户端文件夹批量（batchSize + 分页 index）+ workshop 结果表**就够支撑「10 场景变体」验收，服务端只需一个批量接口循环。省约 3 人日。

### 9.4 远期跟踪（不进当前排期）

- **MCP 工具层**：等我们 P0–P2 落地后，把 `/api/generate`、模板、账本包装成 MCP 工具是顺路的事（我们已有 51 个 REST 接口，包一层即可）。它证明这条路走得通，且是「AI Agent 原生」的门票；
- **双画布模型**：它是「批量画布 + 结果画布」两个工作区；我们是「一个画布三种视图」。两条路线都成立，等我们审阅视图（P2）做出来再对比决策；
- **Tauri 迁移**：见 §8，暂不；
- **参考图分层**（reference-layer-split）：毛衫印花 P0-0（真图生图）落地后，这个节点是下一步的自然扩展。

### 9.5 我们有、它没有的（保持信心）

- 多用户 RBAC（15 权限码 / 4 角色 / 数据范围）+ 四层安全；
- 算力账本 reserve→commit/rollback + 对账 + 幂等回调（14 项支付安全测试）；
- 微信/支付宝真实支付网关；
- 白标多品牌、OSS 自动更新差异门控；
- 51 个 REST 接口的服务端治理（它是本地单机 + 云端账号，服务端治理弱于我们）。

## 10. 拆解方法备忘（可复用）

1. `.lnk` 不用 COM：直接解析 ShellIDList 二进制拿目标路径；
2. Tauri 应用先看**安装目录三件套**：`data/`（业务数据，通常是明文 JSON）、`cache/`、附带运行时（ffmpeg 等）；
3. `session.json` 这类**会话文件是数据模型的金矿**——比逆向代码快 10 倍；
4. Tauri 前端 chunk 名内嵌在 exe 明文区，`grep -a "/assets/.*\.js"` 可提取**完整功能地图**；
5. MCP 工具描述是明文中文，直接 strings 提取就能还原执行语义；
6. 实机截图：`PrintWindow`（PW_RENDERFULLCONTENT）对最小化窗口无效，需先 `ShowWindow(SW_RESTORE)`；Tauri/WebView2 的浮层要用 **`ImageGrab` 全屏抓**，窗口 DC 抓不到浮层；点击交互需 Alt 技巧绕 `SetForegroundWindow` 限制。

---

**结论一句话**：SynMew 验证了我们方案的产品方向没错，并送来 4 个可直接落地的设计（上游签名、文件夹批量、类型端口、模板反哺）；技术栈各走各路，它的 MCP 层是我们 P2 之后的方向。
