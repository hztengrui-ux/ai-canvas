# AI Canvas · 无限画布创作台

对标 "AI Change" 架构的自研第一版：**Vue 3 + Element Plus** 前端 + **Express 本地后端**，生成能力三路全接：

- **通义万相**（阿里云百炼 DashScope，wanx2.1 系列，异步任务轮询）
- **即梦 / Seedream**（火山方舟 Ark Images API，doubao-seedream 系列）
- **ComfyUI 本地工作流**（自动发现 checkpoint，标准 SD 文生图，历史轮询取图）

## 功能

- 无限画布：滚轮缩放（围绕光标）、空白拖拽平移、卡片拖动、Delete 删除、缩放 HUD
- 拖入本地图片直接上画布（自动按宽高比排版）
- 生成面板：提示词 / 负面词 / 尺寸 / 张数（1-4），ComfyUI 额外支持步数与 CFG
- SSE 流式进度（排队 → 生成中 → 落画布），占位卡片实时更新
- 所有产出自动落地 `outputs/`，避免远程 URL 过期
- 设置抽屉：三路 Key/地址/模型，保存于 `~/.ai-canvas/config.json`（仅本机）

## 运行

```bash
npm install
npm run build      # 构建前端
npm run server     # 启动后端 http://127.0.0.1:5181（同时服务前端产物）
```

开发模式（两个终端）：

```bash
npm run dev        # Vite http://localhost:5180，/api 代理到 5181
npm run server
```

## 各提供方准备

| 提供方 | 需要什么 | 获取方式 |
|---|---|---|
| 通义万相 | DashScope API Key（sk-...） | 阿里云百炼控制台 → API-KEY |
| 即梦/Seedream | 火山方舟 API Key | 火山引擎控制台 → 方舟 → 开通 doubao-seedream 模型 |
| ComfyUI | 本地跑起的 ComfyUI（默认 127.0.0.1:8188） | `python main.py` 启动即可，至少放一个 checkpoint 到 models/checkpoints |

首次使用点右上角「设置」填 Key；ComfyUI 只需本机在跑，点「测试」即可发现模型。

## 架构

```
src/                     Vue3 + Element Plus（Vite）
  components/InfiniteCanvas.vue   自研无限画布引擎（transform+scale，无第三方画布库）
  components/PromptPanel.vue      生成面板 + SSE 进度
  components/SettingsDialog.vue   三路配置
server/
  index.js              Express：/api/generate(SSE) /api/settings /api/upload /outputs
  providers/            wanxiang.js / jiemeng.js / comfyui.js 各自独立
  config.js             ~/.ai-canvas/config.json 读写（Key 掩码回显）
```

## 路线图（下一版候选）

- 图片卡右键菜单：设为参考图（图生图）、下载、删除
- ComfyUI 自定义工作流模板上传（JSON）
- 画布项目持久化（保存/恢复布局）
- 批量任务队列与并行 fan-out
- 接入你的图像资产提取管线（左侧资产栏拖拽上布）
