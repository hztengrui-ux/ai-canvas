<script setup>
/**
 * 作品组节点（补齐差距 A3）
 *
 * 方案 §5 要求「作品组为一等公民」：一组同批次的图要能整体移动、折叠、命名。
 * 实现要点：
 *   - 子节点设 parentNode + extent:'parent'，位置改为相对组左上角
 *   - 折叠时把子节点 hidden，并把组高度压到只剩标题条
 *   - 组本身不参与连线（无 Handle），拖拽整组即拖全部子节点
 */
import { computed } from "vue";

const props = defineProps({
  id: { type: String, default: "" },
  data: { type: Object, default: () => ({}) },
  selected: { type: Boolean, default: false }
});

const emit = defineEmits(["toggle", "rename"]);

const label = computed(() => props.data?.label || "作品组");
const collapsed = computed(() => Boolean(props.data?.collapsed));
const count = computed(() => Number(props.data?.count) || 0);
const tint = computed(() => props.data?.color || "#2563EB");

function onToggle(e) {
  e.stopPropagation();
  emit("toggle", props.id);
}

function onRename(e) {
  e.stopPropagation();
  const next = window.prompt("作品组名称", label.value);
  if (next !== null) emit("rename", { id: props.id, label: String(next).trim() || label.value });
}
</script>

<template>
  <div
    class="nf-group"
    :class="{ 'is-collapsed': collapsed, 'is-selected': selected }"
    :style="{ '--nf-group-tint': tint }"
  >
    <div class="nf-group-bar">
      <button class="nf-group-fold" :title="collapsed ? '展开' : '折叠'" @mousedown.stop @click="onToggle">
        <span class="nf-group-caret">{{ collapsed ? "▸" : "▾" }}</span>
      </button>
      <span class="nf-group-label" @dblclick.stop="onRename">{{ label }}</span>
      <span class="nf-group-count">{{ count }} 项</span>
    </div>
    <div v-if="collapsed" class="nf-group-hint">双击标题可重命名 · 点击 ▸ 展开</div>
  </div>
</template>
