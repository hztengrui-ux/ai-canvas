<script setup>
/**
 * 批量面板（批量节点模式的控制台）
 *
 * 核心动作就一个：把「一堆提示词」变成「一堆节点」，然后整批跑掉。
 * 典型用法是运营从 Excel 复制 20 条卖点描述，粘进来，一键铺成 20 组
 * 提示词+执行+结果，全选运行，去泡杯茶回来收图。
 *
 * 面板自己不碰画布，一切都走 bridge —— 画布没挂载时按钮自动禁用。
 */
import { ref, computed } from "vue";
import { ElMessage } from "element-plus";
import { store, bridge, modelById } from "../store.js";
import { splitPrompts, BATCH_LIMITS, batchRowStateLabel } from "../batchmode.js";

const text = ref("");
const cols = ref(3);
const count = ref(1);

const rows = computed(() => store.batchRows);
/** 实时预览：用户还在打字时就告诉他会被拆成几条 */
const parsed = computed(() => splitPrompts(text.value));
const busy = computed(() => rows.value.some((r) => r.state === "running" || r.state === "queued"));
const finished = computed(() =>
  rows.value.filter((r) => ["done", "error", "canceled", "skipped"].includes(r.state)).length
);
const progress = computed(() =>
  rows.value.length ? Math.round((finished.value / rows.value.length) * 100) : 0
);
const modelLabel = computed(() => modelById(store.imageModel).label);

function close() {
  store.batchDockOpen = false;
}

function spread() {
  const list = parsed.value;
  if (!list.length) {
    ElMessage.warning("先粘贴提示词，一行一条");
    return;
  }
  if (!bridge.batchFromPrompts) {
    ElMessage.warning("画布还没准备好，请稍等一下");
    return;
  }
  const ids = bridge.batchFromPrompts({ prompts: list, count: count.value, cols: cols.value });
  ElMessage.success(`已铺开 ${ids.length} 行，点「运行选中」开始批量生成`);
}

async function run() {
  if (!bridge.runBatchNodes) return;
  // 还没铺过节点就先铺 —— 用户粘完提示词直接点「运行这批」是最自然的动作
  if (!rows.value.length && parsed.value.length) spread();
  // 铺开时会自动选中这批执行节点，所以这里不传 id，跑当前选中即可
  await bridge.runBatchNodes();
}

function cancel() {
  bridge.cancelBatch?.();
}

function clearRows() {
  store.batchRows = [];
}

function tidy() {
  bridge.tidyGrid?.();
}

function fillExample() {
  text.value = [
    "雪尼尔毛衫，圆领，胸前小面积几何印花，柔和自然光",
    "同款毛衫改成 V 领，印花放大到整幅",
    "同款毛衫袖部加条纹印花，其余保持不变"
  ].join("\n");
}
</script>

<template>
  <div class="bd-dock">
    <div class="bd-head">
      <el-icon><Grid /></el-icon>
      <span>批量生成</span>
      <span class="bd-sub">{{ modelLabel }}</span>
      <button class="bd-close" title="收起" @click="close">
        <el-icon><Close /></el-icon>
      </button>
    </div>

    <div class="bd-body">
      <label class="bd-label">
        提示词（一行一条，自动忽略序号与空行）
        <a v-if="!text" class="bd-link" @click="fillExample">填个示例</a>
      </label>
      <textarea
        v-model="text"
        class="bd-textarea"
        :placeholder="'雪尼尔毛衫，圆领，胸前小面积几何印花\n同款毛衫改成 V 领，印花放大到整幅\n…'"
      />
      <div class="bd-hint">
        已识别 <b>{{ parsed.length }}</b> 条{{ parsed.length >= BATCH_LIMITS.maxRows ? "（已到上限）" : "" }}
      </div>

      <div class="bd-row">
        <span class="bd-field">
          <label class="bd-label">每行张数</label>
          <el-input-number v-model="count" class="bd-num" :min="1" :max="BATCH_LIMITS.maxPerNode" size="small" />
        </span>
        <span class="bd-field">
          <label class="bd-label">每行几列</label>
          <el-input-number v-model="cols" class="bd-num" :min="1" :max="6" size="small" />
        </span>
      </div>

      <div class="bd-actions">
        <button :disabled="!parsed.length || busy" @click="spread">铺到画布</button>
        <button :disabled="busy" @click="tidy">网格整理</button>
        <button class="primary" :disabled="(!rows.length && !parsed.length) || busy" @click="run">
          {{ busy ? "运行中…" : "运行这批" }}
        </button>
      </div>
      <div v-if="busy" class="bd-actions">
        <button @click="cancel">取消批量</button>
      </div>

      <div v-if="rows.length" class="bd-list">
        <div v-for="r in rows" :key="r.id" class="bd-item" :class="`is-${r.state}`">
          <span class="bd-idx">{{ r.index }}</span>
          <span class="bd-prompt" :title="r.prompt">{{ r.prompt || "（空提示词）" }}</span>
          <span class="bd-state">{{ batchRowStateLabel(r.state) }}</span>
        </div>
        <div class="bd-progress"><i :style="{ width: `${progress}%` }" /></div>
      </div>

      <div v-if="rows.length && !busy" class="bd-actions">
        <button @click="clearRows">清空状态</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bd-hint {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.bd-hint b {
  color: var(--primary);
}
.bd-link {
  margin-left: 8px;
  color: var(--primary);
  cursor: pointer;
  font-weight: 400;
}
</style>
