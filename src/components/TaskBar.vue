<script setup>
/**
 * 任务中心（2026-10-16 重做）
 * --------------------------------------------------------------------------
 * 以前它是**常驻底部的一条横条**：没有任务也占着一条（"暂无任务"），
 * 一有任务还自动展开成一大片列表 —— 用户的评价是"底部这个不要"。
 *
 * 现在改成：**底下一个像素都不占**，任务入口挪到顶栏（图标 + 徽标），
 * 点开才是一个浮层面板。没有任务时入口本身也不显示（不制造"零任务"的噪音）。
 *
 * 任务本身也一并优化：
 *   · 重复失败折叠成一组（密钥失效时连点三次不再刷屏三行）
 *   · 失败行显示「已退回 N 算力」—— 失败看得见，钱回没回来以前看不见
 *   · 相对时间、批量「全部重做」、单条 ✕ 移除、进行中可取消
 *   · 已完成只留最近几条，其余折叠成「还有 N 条」
 *
 * 分组/统计/文案全是 src/tasklist.js 里的纯函数，这套判断有单测覆盖。
 */
import { computed, ref } from "vue";
import { store, bridge, clearFinishedTasks, clearFailedTasks, dismissTask } from "../store.js";
import { taskRows, taskStats, summaryOf, subtitleOf, statusOf, friendlyTime, retryableTasks } from "../tasklist.js";

const tasks = computed(() => store.tasks || []);
const stats = computed(() => taskStats(tasks.value));
const summary = computed(() => summaryOf(stats.value));
const open = computed({
  get: () => Boolean(store.taskBarOpen),
  set: (v) => {
    store.taskBarOpen = v;
  }
});

// 展开过的失败分组（默认折叠：重复失败只占一行）
const expanded = ref([]);
function toggleGroup(row) {
  const k = row.key;
  expanded.value = expanded.value.includes(k) ? expanded.value.filter((x) => x !== k) : [...expanded.value, k];
}

const rows = computed(() => {
  const list = taskRows(tasks.value);
  const out = [];
  for (const row of list) {
    out.push(row);
    if (row.kind === "group" && expanded.value.includes(row.key)) {
      for (const t of row.tasks) out.push({ kind: "task", key: `t:${t.id}`, task: t, nested: true });
    }
  }
  return out;
});

const retryable = computed(() => retryableTasks(tasks.value));
const clearLabel = computed(() => (stats.value.error ? `清除已完成 + ${stats.value.error} 失败` : "清除已完成"));

function cancel(t) {
  bridge.cancelTask?.(t.id);
}
function retry(t) {
  bridge.rerunNode?.(t.nodeId);
}
function focusResult(t) {
  if (t.nodeId && bridge.focusNode) {
    bridge.focusNode(t.nodeId);
    store.route = "studio";
  }
}
function retryAll() {
  for (const t of retryable.value) bridge.rerunNode?.(t.nodeId);
}
</script>

<template>
  <!-- 没有任务时入口本身不出现：不制造"暂无任务"这种噪音，也不占任何位置 -->
  <el-popover
    v-if="stats.total"
    v-model:visible="open"
    placement="bottom-end"
    :width="380"
    trigger="click"
    popper-class="task-popover"
  >
    <template #reference>
      <button class="task-entry" :class="{ 'has-error': stats.error, 'is-running': stats.running }" title="任务">
        <span v-if="stats.running" class="task-entry-spin" />
        <el-icon v-else><List /></el-icon>
        <span v-if="stats.running" class="task-entry-count">{{ stats.running }}</span>
        <span v-else-if="stats.error" class="task-entry-badge">{{ stats.error }}</span>
      </button>
    </template>

    <div class="tp">
      <div class="tp-head">
        <span class="tp-title">任务</span>
        <span class="tp-summary">{{ summary }}</span>
        <span v-if="stats.refunded" class="tp-refund" title="失败任务的算力已退回">已退 {{ stats.refunded }}</span>
      </div>

      <div class="tp-actions">
        <button v-if="retryable.length" class="tp-btn" @click="retryAll">全部重做（{{ retryable.length }}）</button>
        <button v-if="stats.error" class="tp-btn danger" @click="clearFailed">清除失败</button>
        <button class="tp-btn" @click="clearFinished">{{ clearLabel }}</button>
      </div>

      <div class="tp-list">
        <template v-for="row in rows" :key="row.key">
          <!-- 重复失败：折叠成一行，点开看每一条 -->
          <button v-if="row.kind === 'group'" class="tp-item is-error is-group" @click="toggleGroup(row)">
            <span class="tp-dot" />
            <div class="tp-main">
              <div class="tp-label">{{ row.label }}</div>
              <div class="tp-text">{{ row.text }} · <b>{{ row.count }} 次相同失败</b></div>
            </div>
            <span class="tp-group-caret">{{ expanded.includes(row.key) ? "▾" : "▸" }}</span>
          </button>

          <div v-else-if="row.kind === 'more'" class="tp-more">还有 {{ row.count }} 条已完成</div>

          <div v-else class="tp-item" :class="[`is-${statusOf(row.task)}`, { nested: row.nested }]">
            <span class="tp-dot" />
            <div class="tp-main">
              <div class="tp-label">{{ row.task.label }}</div>
              <div class="tp-text">{{ subtitleOf(row.task) }}</div>
            </div>
            <div class="tp-meta">
              <span v-if="row.task.ts" class="tp-time">{{ friendlyTime(row.task.ts) }}</span>
              <span v-if="row.task.cost" class="tp-cost">扣 {{ row.task.cost }}</span>
            </div>
            <div v-if="(row.task.images || []).length" class="tp-thumbs" @click="focusResult(row.task)">
              <img v-for="(im, i) in row.task.images.slice(0, 3)" :key="i" :src="im.url" alt="" />
            </div>
            <button v-if="statusOf(row.task) === 'running'" class="tp-btn" @click.stop="cancel(row.task)">取消</button>
            <button v-else-if="statusOf(row.task) === 'error' && row.task.nodeId" class="tp-btn" @click.stop="retry(row.task)">重做</button>
            <button
              v-if="statusOf(row.task) !== 'running'"
              class="tp-dismiss"
              title="从列表移除这条"
              @click.stop="dismissTask(row.task.id)"
            >
              ✕
            </button>
          </div>
        </template>
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
/* 顶栏入口：进行中转圈，失败显红点徽标 */
.task-entry {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.16s ease, color 0.16s ease;
}
.task-entry:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.task-entry.has-error {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 40%, transparent);
}
.task-entry-spin {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in srgb, var(--primary) 30%, transparent);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: task-spin 0.8s linear infinite;
}
@keyframes task-spin {
  to {
    transform: rotate(360deg);
  }
}
.task-entry-count,
.task-entry-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
}
.task-entry-count {
  background: var(--primary-soft);
  color: var(--primary);
}
.task-entry-badge {
  background: var(--danger);
  color: #fff;
}

/* 面板 */
.tp {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tp-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.tp-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.tp-summary {
  font-size: 12px;
  color: var(--text-3);
}
.tp-refund {
  margin-left: auto;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--success-soft, rgba(47, 158, 104, 0.12));
  color: var(--success, #2f9e68);
  font-size: 11px;
  font-weight: 600;
}
.tp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.tp-btn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.16s ease, border-color 0.16s ease;
}
.tp-btn:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.tp-btn.danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 34%, transparent);
  background: var(--danger-soft);
}
.tp-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 420px;
  overflow-y: auto;
}
.tp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  width: 100%;
  font-family: inherit;
  cursor: default;
  transition: background-color 0.16s ease;
}
.tp-item:hover {
  background: var(--surface-hover);
}
.tp-item.nested {
  margin-left: 16px;
  width: calc(100% - 16px);
  opacity: 0.9;
}
.tp-item.is-group {
  cursor: pointer;
}
.tp-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-4);
}
.tp-item.is-running .tp-dot {
  background: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent);
}
.tp-item.is-done .tp-dot {
  background: var(--success, #2f9e68);
}
.tp-item.is-error .tp-dot {
  background: var(--danger);
}
.tp-main {
  flex: 1;
  min-width: 0;
}
.tp-label {
  font-size: 12.5px;
  font-weight: 550;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tp-text {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tp-text b {
  color: var(--danger);
  font-weight: 600;
}
.tp-meta {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  font-size: 11px;
  color: var(--text-4);
  font-variant-numeric: tabular-nums;
}
.tp-thumbs {
  display: flex;
  gap: 3px;
  cursor: pointer;
}
.tp-thumbs img {
  width: 26px;
  height: 26px;
  border-radius: 4px;
  object-fit: cover;
}
.tp-group-caret {
  color: var(--text-4);
  font-size: 11px;
}
.tp-dismiss {
  flex: none;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-4);
  font-size: 11px;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}
.tp-item:hover .tp-dismiss {
  opacity: 1;
}
.tp-dismiss:hover {
  background: var(--surface);
  color: var(--danger);
}
.tp-more {
  padding: 6px 8px;
  font-size: 11.5px;
  color: var(--text-4);
}
</style>
