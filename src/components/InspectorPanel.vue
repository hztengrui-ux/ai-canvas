<script setup>
/**
 * 右侧属性栏（补齐差距 C3）
 *
 * 方案 §3：「右侧不要在没有选择对象时永久摆满参数」。
 * 所以这里的规则是 —— 没有选中就不渲染（v-if 在父组件），选中后才出现，且只显示
 * 与选中类型相关的参数。多选时只暴露可批量改的公共项（模型 / 比例 / 张数）。
 *
 * 所有修改通过 bridge.patchSelected 回写画布节点 data，组件本身不持有副本，
 * 避免「面板改了、节点没改」的双份状态。
 */
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { store, bridge, IMAGE_MODELS, MODEL_GROUPS, modelById } from "../store.js";
import { ElMessage } from "element-plus";
import { fetchOutputMeta } from "../api.js";
import { sendPopout, onPopout } from "../popoutBus.js";

// embedded：被塞进右侧 dock 当「属性」页用（不再自己占一列、不再有自己的拖宽/最小化/关闭）
defineProps({
  embedded: { type: Boolean, default: false }
});

// ---------- 窗口化：拖宽 / 最小化 / 关闭 / 弹出独立窗口（双屏） ----------
const W_KEY = "ai-canvas:inspector-w";
const width = ref(clampW(Number(localStorage.getItem(W_KEY)) || 268));
const minimized = ref(false);
const resizing = ref(false);

function clampW(v) {
  return Math.min(560, Math.max(232, Number.isFinite(v) ? v : 268));
}

// 行内样式覆盖 .studio-inspector 的固定 flex-basis（行内优先级更高）
const panelStyle = computed(() =>
  minimized.value
    ? { flex: "0 0 46px", width: "46px" }
    : { flex: `0 0 ${width.value}px`, width: `${width.value}px` }
);

let resizeCleanup = null;
function startResize(e) {
  if (minimized.value) return;
  resizing.value = true;
  const startX = e.clientX;
  const startW = width.value;
  const move = (ev) => {
    // 面板在右侧，向左拖 = 变宽
    width.value = clampW(startW + (startX - ev.clientX));
  };
  const up = () => {
    resizing.value = false;
    try {
      localStorage.setItem(W_KEY, String(width.value));
    } catch { /* 记不住就用默认值 */ }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up, { once: true });
  resizeCleanup = () => window.removeEventListener("pointermove", move);
}
onBeforeUnmount(() => resizeCleanup?.());

function toggleMin() {
  minimized.value = !minimized.value;
}

/** 关闭 = 取消选中，画布与面板一起回到无选中状态 */
function closePanel() {
  if (bridge.setSelectedIds) bridge.setSelectedIds([]);
  else store.selection = [];
}

/** 弹出独立窗口（双屏）：Electron 里是原生窗口，浏览器里是新标签页 */
const popoutOpen = ref(false);
function openPopout() {
  const w = window.open("?window=popout", "ai-canvas-popout", "width=460,height=780");
  if (!w) {
    ElMessage.warning("弹出被浏览器拦截，请允许弹出窗口");
    return;
  }
  popoutOpen.value = true;
}

const sel = computed(() => store.selection || []);
const one = computed(() => (sel.value.length === 1 ? sel.value[0] : null));
const type = computed(() => one.value?.type || "");

const TYPE_LABEL = {
  product: "产品 / 参考图",
  style: "风格参考",
  prompt: "画面描述",
  executor: "执行器",
  result: "生成结果",
  reference: "视频参考",
  group: "作品组"
};

const title = computed(() => {
  if (!one.value) return `${sel.value.length} 个对象`;
  return TYPE_LABEL[one.value.type] || one.value.type || "对象";
});

/** 多选时：这些类型共享「模型/比例/张数」 */
const promptLike = computed(() => sel.value.filter((n) => n.type === "prompt"));
const multi = computed(() => sel.value.length > 1);

function patch(partial) {
  if (!bridge.patchSelected) return;
  bridge.patchSelected(partial);
  bridge.requestSave?.();
}

// ---------- 提示词节点参数 ----------
const curModel = computed(() => (one.value?.data?.modelId ? modelById(one.value.data.modelId) : modelById(store.imageModel)));
const counts = computed(() => curModel.value.counts || [1, 2, 4]);
const ratios = computed(() => curModel.value.ratios || ["1:1"]);
const promptText = computed({
  get: () => one.value?.data?.prompt || "",
  set: (v) => patch({ prompt: v })
});

// ---------- 参考强度 / 印花区域（F6） ----------
const strength = computed({
  get: () => Number(one.value?.data?.strength ?? 0.75),
  set: (v) => patch({ strength: Number(v) })
});
const printArea = computed({
  get: () => one.value?.data?.printArea || "auto",
  set: (v) => patch({ printArea: v })
});
const keepTexture = computed({
  get: () => one.value?.data?.keepTexture !== false,
  set: (v) => patch({ keepTexture: Boolean(v) })
});

const PRINT_AREAS = [
  { value: "auto", label: "自动识别" },
  { value: "front", label: "前胸" },
  { value: "full", label: "整幅" },
  { value: "sleeve", label: "袖部" },
  { value: "custom", label: "自定义遮罩" }
];

// ---------- E6 血缘：这张图当初是拿什么跑出来的 ----------
// 选中的结果变了就去问一次服务端。查不到是**正常情况**（外部导入的图本来就没来源），
// 所以这里一律返回 null 而不是报错，界面上给的是提示而不是错误。
const lineage = ref(null);
const lineageLoading = ref(false);

watch(
  () => (type.value === "result" ? one.value?.data?.images?.[0]?.url || "" : ""),
  async (url) => {
    lineage.value = null;
    if (!url) return;
    lineageLoading.value = true;
    lineage.value = await fetchOutputMeta(url);
    lineageLoading.value = false;
  },
  { immediate: true }
);

const lineageModel = computed(() => lineage.value?.model || lineage.value?.provider || "");
const refCount = computed(() => lineage.value?.references?.length || 0);
// 「可复现」的前提是提示词和提供方都还在 —— 少一样就别给用户假的指望
const lineageOk = computed(() => Boolean(lineage.value?.prompt && lineage.value?.provider));
const when = computed(() => {
  const t = lineage.value?.createdAt;
  if (!t) return "";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(t) : d.toLocaleString("zh-CN", { hour12: false });
});

async function copyLineagePrompt() {
  const text = lineage.value?.prompt || "";
  if (!text) {
    ElMessage.warning("该来源没有记录提示词");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success("提示词已复制");
  } catch {
    ElMessage.error("复制失败，请手动选中文本");
  }
}

function rerun() {
  if (!one.value) return;
  bridge.rerunNode?.(one.value.id);
}

function groupUp() {
  bridge.groupSelection?.();
}

function ungroup() {
  bridge.ungroupSelection?.();
}

function removeSelected() {
  if (!bridge.removeSelected) {
    ElMessage.info("当前画布不支持此操作");
    return;
  }
  bridge.removeSelected();
}

// ---------- 双屏广播（放在末尾：title / lineage / when 都已声明） ----------
// 选中内容变化 → 广播给独立窗口；弹窗发来 ready 时立刻补发当前状态
const popState = computed(() => ({
  title: title.value,
  dark: !!store.darkMode,
  images: (one.value?.data?.images || []).map((i) => i.url).filter(Boolean),
  videos: one.value?.data?.videos || [],
  lineage: lineage.value,
  when: when.value
}));
watch(popState, (v) => sendPopout({ type: "state", payload: v }));
onPopout((msg) => {
  if (msg?.type === "ready") sendPopout({ type: "state", payload: popState.value });
});
</script>

<template>
  <aside
    class="inspector"
    :class="{ 'is-min': minimized && !embedded, 'is-resizing': resizing, 'is-embedded': embedded }"
    :style="embedded ? undefined : panelStyle"
  >
    <!-- 左缘拖拽条：向左拖变宽，宽度记忆在 localStorage（嵌入 dock 时由 dock 决定宽度） -->
    <div
      v-if="!minimized && !embedded"
      class="ins-resize"
      :class="{ on: resizing }"
      title="拖拽调整宽度"
      @pointerdown.prevent="startResize"
    />

    <!-- 最小化态：收成右侧竖条，点击恢复（嵌入 dock 时没有这个态） -->
    <div v-if="minimized && !embedded" class="ins-min" @click="toggleMin">
      <el-icon><Expand /></el-icon>
      <span class="ins-min-label">{{ title }}</span>
    </div>

    <template v-else>
    <header class="inspector-head">
      <div class="inspector-head-row">
        <div class="inspector-titles">
          <div class="inspector-title">{{ title }}</div>
          <div class="inspector-sub">{{ multi ? `已选中 ${sel.length} 个对象` : one?.id || "" }}</div>
        </div>
        <div v-if="!embedded" class="ins-head-ctl">
          <button class="ins-ctl" title="弹出独立窗口（双屏）" :class="{ on: popoutOpen }" @click="openPopout">
            <el-icon><Monitor /></el-icon>
          </button>
          <button class="ins-ctl" title="最小化" @click="toggleMin"><el-icon><Minus /></el-icon></button>
          <button class="ins-ctl danger" title="关闭面板" @click="closePanel"><el-icon><CloseBold /></el-icon></button>
        </div>
      </div>
    </header>

    <!-- 选中已失效（项目重载 / 节点被删）：不留一块空白面板 -->
    <section v-if="!one && !multi" class="inspector-body">
      <div class="ins-empty">
        <el-icon><Pointer /></el-icon>
        <p>在画布上点一个节点<br />这里会显示它的参数</p>
      </div>
    </section>

    <!-- 多选：只给公共项 -->
    <section v-else-if="multi" class="inspector-body">
      <div class="ins-tip">多选编辑只影响「画面描述」节点（{{ promptLike.length }} 个）</div>

      <label class="ins-field">
        <span class="ins-label">模型</span>
        <select class="ins-select" :value="store.imageModel" @change="patch({ modelId: $event.target.value })">
          <optgroup v-for="g in MODEL_GROUPS" :key="g" :label="g">
            <option v-for="m in IMAGE_MODELS.filter((x) => x.group === g)" :key="m.id" :value="m.id">
              {{ m.label }}
            </option>
          </optgroup>
        </select>
      </label>

      <label class="ins-field">
        <span class="ins-label">画幅</span>
        <select class="ins-select" :value="store.imageRatio" @change="patch({ ratio: $event.target.value })">
          <option v-for="r in ['1:1', '4:3', '3:4', '16:9', '9:16', '5:4', '3:2', '2:3']" :key="r" :value="r">{{ r }}</option>
        </select>
      </label>

      <label class="ins-field">
        <span class="ins-label">张数</span>
        <select class="ins-select" :value="1" @change="patch({ count: Number($event.target.value) })">
          <option v-for="c in [1, 2, 4, 8, 10]" :key="c" :value="c">{{ c }} 张</option>
        </select>
      </label>

      <div class="ins-actions">
        <button class="ins-btn primary" @click="groupUp">编为作品组</button>
        <button class="ins-btn" @click="removeSelected">删除所选</button>
      </div>
    </section>

    <!-- 单选：按类型给完整参数 -->
    <section v-else-if="one" class="inspector-body">
      <!-- 画面描述 -->
      <template v-if="type === 'prompt'">
        <label class="ins-field col">
          <span class="ins-label">提示词</span>
          <textarea v-model="promptText" class="ins-textarea" rows="5" placeholder="描述你想生成的画面" />
        </label>
        <label class="ins-field">
          <span class="ins-label">模型</span>
          <select class="ins-select" :value="one.data.modelId || store.imageModel" @change="patch({ modelId: $event.target.value })">
            <optgroup v-for="g in MODEL_GROUPS" :key="g" :label="g">
              <option v-for="m in IMAGE_MODELS.filter((x) => x.group === g)" :key="m.id" :value="m.id">{{ m.label }}</option>
            </optgroup>
          </select>
        </label>
        <label class="ins-field">
          <span class="ins-label">画幅</span>
          <select class="ins-select" :value="one.data.ratio || store.imageRatio" @change="patch({ ratio: $event.target.value })">
            <option v-for="r in ratios" :key="r" :value="r">{{ r }}</option>
          </select>
        </label>
        <label class="ins-field">
          <span class="ins-label">张数</span>
          <select class="ins-select" :value="one.data.count || 1" @change="patch({ count: Number($event.target.value) })">
            <option v-for="c in counts" :key="c" :value="c">{{ c }} 张</option>
          </select>
        </label>
      </template>

      <!-- 产品图 / 风格图：商品一致性参数（F6） -->
      <template v-else-if="type === 'product' || type === 'style'">
        <div class="ins-preview">
          <img v-if="one.data.file?.url" :src="one.data.file.url" alt="" />
          <div v-else class="ins-preview-empty">未上传图片</div>
        </div>
        <label class="ins-field">
          <span class="ins-label">素材角色</span>
          <select class="ins-select" :value="one.data.role || 'reference'" @change="patch({ role: $event.target.value })">
            <option value="product">产品图</option>
            <option value="outfit">服装图</option>
            <option value="model">模特图</option>
            <option value="reference">参考图</option>
          </select>
        </label>
        <label class="ins-field col">
          <span class="ins-label">参考强度 <b>{{ strength.toFixed(2) }}</b></span>
          <input type="range" min="0.1" max="1" step="0.05" :value="strength" @input="strength = $event.target.value" />
          <span class="ins-hint">越低越自由发挥，越高越贴近原图（毛衫印花建议 0.8 以上）</span>
        </label>
        <label class="ins-field">
          <span class="ins-label">印花区域</span>
          <select class="ins-select" :value="printArea" @change="printArea = $event.target.value">
            <option v-for="a in PRINT_AREAS" :key="a.value" :value="a.value">{{ a.label }}</option>
          </select>
        </label>
        <label class="ins-field row">
          <input type="checkbox" :checked="keepTexture" @change="keepTexture = $event.target.checked" />
          <span>保留针织纹理与褶皱</span>
        </label>
      </template>

      <!-- 执行器 -->
      <template v-else-if="type === 'executor'">
        <div class="ins-kv"><span>状态</span><b>{{ one.data.busy ? "生成中" : one.data.status || "待运行" }}</b></div>
        <div class="ins-kv"><span>已接提示词</span><b>{{ one.data.hasPrompt ? "是" : "否" }}</b></div>
        <div class="ins-kv"><span>已接产品图</span><b>{{ one.data.hasProduct ? "是" : "否" }}</b></div>
        <div class="ins-kv"><span>已接风格图</span><b>{{ one.data.hasStyle ? "是" : "否" }}</b></div>
        <div v-if="one.data.error" class="ins-error">{{ one.data.error }}</div>
        <div class="ins-actions">
          <button class="ins-btn primary" :disabled="one.data.busy" @click="rerun">重新生成</button>
        </div>
      </template>

      <!-- 结果 -->
      <template v-else-if="type === 'result'">
        <div class="ins-kv"><span>图片</span><b>{{ (one.data.images || []).length }} 张</b></div>
        <div class="ins-kv"><span>视频</span><b>{{ (one.data.videos || []).length }} 个</b></div>
        <div class="ins-grid">
          <img v-for="(im, i) in (one.data.images || []).slice(0, 6)" :key="i" :src="im.url" alt="" />
        </div>

        <!-- E6 血缘：这张图当初是拿什么跑出来的 -->
        <div class="ins-section">
          <div class="ins-section-head">
            <span>来源</span>
            <em v-if="lineage" :class="lineageOk ? 'ins-ok' : 'ins-dim'">
              {{ lineageOk ? "可复现" : "信息不全" }}
            </em>
            <em v-else-if="lineageLoading" class="ins-dim">查询中…</em>
          </div>

          <template v-if="lineage">
            <div class="ins-src-prompt">{{ lineage.prompt || "（当时没有填写提示词）" }}</div>
            <div class="ins-kv" v-if="lineageModel"><span>模型</span><b>{{ lineageModel }}</b></div>
            <div class="ins-kv" v-if="lineage.size"><span>画幅</span><b>{{ lineage.size }}</b></div>
            <div class="ins-kv" v-if="lineage.seed != null">
              <span>种子</span><b>{{ lineage.seed }}</b>
            </div>
            <div class="ins-kv" v-else><span>种子</span><em class="ins-dim">未提供</em></div>
            <div class="ins-kv" v-if="Number(lineage.strength) > 0">
              <span>重绘强度</span><b>{{ lineage.strength }}</b>
            </div>
            <div class="ins-kv" v-if="Number(lineage.cost) > 0">
              <span>消耗</span><b>{{ lineage.cost }} 点</b>
            </div>
            <div class="ins-kv" v-if="refCount">
              <span>参考图</span><b>{{ refCount }} 张</b>
            </div>
            <div class="ins-kv" v-if="lineage.createdAt">
              <span>生成于</span><b>{{ when }}</b>
            </div>
            <div class="ins-actions">
              <button class="ins-btn" @click="copyLineagePrompt">复制提示词</button>
            </div>
          </template>

          <!-- 查不到是正常情况：这张图可能是手工放进来的，别把空话说成错误 -->
          <div v-else-if="!lineageLoading" class="ins-tip">没有来源记录（外部导入或早期产出）</div>
        </div>
      </template>

      <!-- 作品组 -->
      <template v-else-if="type === 'group'">
        <div class="ins-kv"><span>成员</span><b>{{ one.data.count || 0 }} 个</b></div>
        <div class="ins-kv"><span>状态</span><b>{{ one.data.collapsed ? "已折叠" : "展开" }}</b></div>
        <div class="ins-actions">
          <button class="ins-btn" @click="ungroup">解散作品组</button>
        </div>
      </template>

      <template v-else>
        <div class="ins-tip">该类型暂无可调参数</div>
      </template>

      <div class="ins-actions">
        <button class="ins-btn" @click="groupUp">编为作品组</button>
        <button class="ins-btn" @click="removeSelected">删除</button>
      </div>
    </section>
    </template>
  </aside>
</template>
