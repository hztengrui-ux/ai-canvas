<script setup>
/**
 * 空画布引导（补齐差距 B2 / B3 / B4 / B5）
 *
 * 2026-10-23 重做视觉：用户反馈"无限画布界面设计不好看"。
 * 旧版是**两块不等高的白卡片**硬拼（上传 177px + 输入 545px），
 * 左边文案被迫换行成两行，右边输入框像搜索条，"生成"还是灰色 ——
 * 看起来像拼错的两个组件，而不是一个"开始创作"的入口。
 *
 * 现在合成一张卡，信息层级自上而下：
 *   标题 → 一行输入区（上传 / 描述 / 开始生成）→ 流程起点 → 快捷键说明
 * 行为、事件、拖拽逻辑都没动，只改结构与样式。
 */
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { semanticTask } from "../api.js";

const emit = defineEmits(["upload", "quickstart", "pick"]);

const draft = ref("");
const dragOver = ref(false);
const fileInput = ref(null);

const SAMPLES = [
  { id: "clothes-model", label: "AI换衣", hint: "服装图 + 模特图" },
  { id: "custom-scene", label: "图生图", hint: "参考图 + 描述" },
  { id: "detail-page", label: "详情页制作", hint: "产品图 + 卖点" },
  { id: "ai-video", label: "AI视频", hint: "首帧 + 运镜" }
];

// ---------- 提示词优化 / 强化（2026-10-31，对齐 workbuddy 输入框内的 AI 按钮） ----------
const enhancing = ref("");      // 正在跑的任务名，空 = 空闲
const lastDraft = ref("");      // 上一版原文，用于"撤销"
const aiMenuOpen = ref(false);

const AI_ACTIONS = [
  { key: "optimize-prompt", label: "优化表达", hint: "把口语需求扩写成结构清晰的提示词" },
  { key: "strengthen-prompt", label: "强化细节", hint: "补镜头、布光、材质、后期等拍摄参数" },
  { key: "translate-prompt", label: "转英文", hint: "翻成英文关键词式提示词" }
];

/**
 * 跑一个语义任务并把结果写回输入框。
 * 保留上一版，用户点「撤销」能回到原句 —— 改写类功能必须可回退，否则用户不敢点。
 */
async function runAI(action) {
  const text = draft.value.trim();
  if (!text || enhancing.value) return;
  aiMenuOpen.value = false;
  enhancing.value = action.key;
  try {
    const r = await semanticTask({ task: action.key, text });
    const out = String(r?.result || "").trim();
    if (!out) {
      ElMessage.warning("没有拿到改写结果，稍后再试");
      return;
    }
    lastDraft.value = draft.value;
    draft.value = out;
    ElMessage.success(`${action.label}完成${action.key === "strengthen-prompt" ? "，已补全拍摄参数" : ""}`);
  } catch (e) {
    ElMessage.error(e?.message || "改写失败");
  } finally {
    enhancing.value = "";
  }
}

function undoAI() {
  if (!lastDraft.value) return;
  draft.value = lastDraft.value;
  lastDraft.value = "";
}

function pickFiles() {
  fileInput.value?.click();
}

function onPicked(e) {
  const files = [...(e.target.files || [])];
  if (files.length) emit("upload", files);
  e.target.value = "";
}

function onDrop(e) {
  dragOver.value = false;
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) emit("upload", files);
}

function start() {
  const text = draft.value.trim();
  if (!text) return;
  emit("quickstart", { prompt: text });
  draft.value = "";
}

function openSample(id) {
  emit("pick", id);
}
</script>

<template>
  <div
    class="canvas-empty rich"
    :class="{ 'is-drag': dragOver }"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
    <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onPicked" />

    <div class="ce-panel">
      <div class="ce-head">
        <div class="ce-title">开始一次创作</div>
        <div class="ce-sub">拖入图片，或直接描述你想要的画面</div>
      </div>

      <div class="ce-box">
        <button class="ce-upload" title="上传素材" @click="pickFiles">
          <el-icon><Plus /></el-icon>
        </button>
        <textarea
          v-model="draft"
          class="ce-input"
          rows="2"
          placeholder="例如：杏色圆领毛衫，胸前有小面积抽象印花，柔和自然光，针织纹理清晰"
          @keydown.ctrl.enter.prevent="start"
        />
        <!-- 提示词 AI：优化 / 强化 / 转英文（对齐 workbuddy 输入框里那颗闪星） -->
        <el-popover
          v-model:visible="aiMenuOpen"
          placement="bottom-end"
          :width="268"
          trigger="click"
          popper-class="ce-ai-pop"
          :show-arrow="false"
          :offset="8"
        >
          <template #reference>
            <button
              class="ce-ai"
              :class="{ busy: !!enhancing }"
              :disabled="!draft.trim() || !!enhancing"
              :title="draft.trim() ? '提示词优化 / 强化' : '先写一句需求，再用 AI 改写'"
            >
              <el-icon v-if="enhancing" class="is-loading"><Loading /></el-icon>
              <el-icon v-else><MagicStick /></el-icon>
            </button>
          </template>

          <div class="ce-ai-menu">
            <div class="ce-ai-head">提示词助手</div>
            <button
              v-for="a in AI_ACTIONS"
              :key="a.key"
              class="ce-ai-row"
              @click="runAI(a)"
            >
              <span class="ce-ai-ic">
                <el-icon><component :is="a.key === 'strengthen-prompt' ? 'Sunny' : a.key === 'translate-prompt' ? 'ChatLineSquare' : 'MagicStick'" /></el-icon>
              </span>
              <span class="ce-ai-text">
                <b>{{ a.label }}</b>
                <em>{{ a.hint }}</em>
              </span>
            </button>
          </div>
        </el-popover>

        <button class="ce-go" :disabled="!draft.trim()" @click="start">开始生成</button>
      </div>

      <!-- 改写后可一键回到原句（改写类功能必须可回退） -->
      <div v-if="lastDraft" class="ce-undo">
        <span>已改写</span>
        <button @click="undoAI">撤销，用回原句</button>
      </div>

      <div class="ce-samples">
        <span class="ce-samples-label">或者从一套流程开始</span>
        <div class="ce-chips">
          <button v-for="s in SAMPLES" :key="s.id" class="ce-chip" @click="openSample(s.id)">
            <b>{{ s.label }}</b>
            <i>{{ s.hint }}</i>
          </button>
        </div>
      </div>

      <div class="ce-tip">
        <span>Ctrl + Enter 快速生成</span>
        <span>数字键 1–5 切换工具</span>
      </div>
    </div>

    <!-- 拖拽时的提示：整块染色 + 明确文案，避免用户以为"没反应" -->
    <div v-if="dragOver" class="ce-drop-mask">松开即可上传素材</div>
  </div>
</template>

<style scoped>
/* ⚠️ 这里**不能**改 .canvas-empty.rich 的 position/width/height：
   它的定位来自 newui.css 的 position:absolute; inset:0（整屏 flex 居中），
   style.css 里还残留 left/top/transform，靠 redesign.css 归零。
   第一次改版我在这里写了一句 `position: relative`，直接把绝对定位顶掉，
   结果卡片掉到顶部、画布高度塌陷，底部还多出一条白色横条（同一次事故）。
   所以只保留"让单张卡片居中"这一件事。 */

.ce-panel {
  width: min(720px, calc(100% - 96px));
  padding: 26px 26px 16px;
  border-radius: 22px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow:
    0 1px 2px rgba(21, 23, 30, 0.04),
    0 30px 60px -40px rgba(21, 23, 30, 0.45);
}

.ce-head {
  text-align: center;
  margin-bottom: 18px;
}
.ce-title {
  font-size: 20px;
  font-weight: 750;
  letter-spacing: 0.2px;
  color: var(--text);
}
.ce-sub {
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--text-3);
}

/* 一行输入区：上传 / 描述 / 开始生成，是整张卡的视觉重心 */
.ce-box {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-hover) 70%, var(--surface));
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.ce-box:focus-within {
  border-color: color-mix(in srgb, var(--lime, #d8fa34) 65%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--lime, #d8fa34) 22%, transparent);
}

.ce-upload {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  border: 1.5px dashed var(--border-strong);
  background: var(--surface);
  color: var(--text-2);
  font-size: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
}
.ce-upload:hover {
  border-color: var(--lime, #d8fa34);
  border-style: solid;
  background: color-mix(in srgb, var(--lime, #d8fa34) 22%, var(--surface));
  color: var(--ink-panel, #15171e);
}

.ce-input {
  flex: 1 1 auto;
  min-height: 40px;
  max-height: 132px;
  padding: 2px 2px;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.65;
  font-family: inherit;
}
.ce-input::placeholder {
  color: var(--text-4);
}

/* AI 改写按钮：墨黑底 + 荧光绿星，和"开始生成"区分开（它是加工，不是提交） */
.ce-ai {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--ink-panel, #15171e);
  font-size: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  position: relative;
  transition: all 0.15s ease;
}
.ce-ai::after {
  /* 一颗小绿点：暗示"这是 AI 功能" */
  content: "";
  position: absolute;
  right: 5px;
  bottom: 5px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--lime, #d8fa34);
  box-shadow: 0 0 0 2px var(--surface);
}
.ce-ai:hover:not(:disabled) {
  border-color: var(--lime, #d8fa34);
  background: color-mix(in srgb, var(--lime, #d8fa34) 20%, var(--surface));
}
.ce-ai:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ce-ai.busy::after {
  display: none;
}

.ce-undo {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 2px 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.ce-undo button {
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 11.5px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  padding: 0;
}
.ce-undo button:hover {
  color: var(--text);
}

.ce-go {
  flex: 0 0 auto;
  height: 40px;
  padding: 0 18px;
  border: none;
  border-radius: 12px;
  background: var(--lime, #d8fa34);
  color: var(--lime-ink, #15171e);
  font-size: 13px;
  font-weight: 750;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.ce-go:hover:not(:disabled) {
  background: var(--lime-deep, #bce600);
  box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--lime-deep, #bce600) 80%, transparent);
}
.ce-go:active:not(:disabled) {
  transform: translateY(1px);
}
.ce-go:disabled {
  background: var(--surface-hover);
  color: var(--text-4);
  cursor: not-allowed;
}

.ce-samples {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  flex-wrap: wrap;
}
.ce-samples-label {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
}
.ce-chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ce-chip {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 7px 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  transition: all 0.15s ease;
}
.ce-chip:hover {
  border-color: color-mix(in srgb, var(--lime, #d8fa34) 70%, var(--border));
  background: color-mix(in srgb, var(--lime, #d8fa34) 12%, var(--surface));
  transform: translateY(-1px);
}
.ce-chip b {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text);
}
.ce-chip i {
  font-style: normal;
  font-size: 11px;
  color: var(--text-3);
}

.ce-tip {
  display: flex;
  justify-content: space-between;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-4);
}

/* 拖拽态 */
.ce-drop-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 22px;
  border: 2px dashed color-mix(in srgb, var(--lime, #d8fa34) 80%, transparent);
  background: color-mix(in srgb, var(--lime, #d8fa34) 10%, transparent);
  color: var(--text);
  font-size: 14px;
  font-weight: 650;
  pointer-events: none;
}

</style>
