<script setup>
import { inject, computed } from "vue";
import { Handle, Position } from "@vue-flow/core";

const props = defineProps({ id: String, data: Object });
const exec = inject("exec");

const dotClass = computed(() => ({
  ready: props.data.hasPrompt,
  waiting: !props.data.hasPrompt
}));

const hintText = computed(() => {
  if (props.data.busy) return "执行中…";
  if (props.data.hasPrompt) return "执行";
  return "完善输入后执行";
});
</script>

<template>
  <div class="nf-node nf-exec" :class="{ busy: data.busy }">
    <Handle type="target" :position="Position.Left" id="prompt" class="nf-handle nf-handle-target" data-port="string" title="输入：文本（画面描述）" />
    <Handle type="target" :position="Position.Left" id="product" class="nf-handle nf-handle-target" data-port="image" title="输入：图片（产品/服装图）" style="top: 36%" />
    <Handle type="target" :position="Position.Left" id="style" class="nf-handle nf-handle-target" data-port="image" title="输入：图片（风格参考）" style="top: 64%" />
    <Handle type="source" :position="Position.Right" id="result" class="nf-handle nf-handle-source" data-port="ai-image" title="输出：AI 图片" />

    <div class="nf-exec-ring" :class="dotClass">
      <button class="nf-exec-btn" :disabled="data.busy" :title="data.busy ? '执行中…' : '执行生成'" @click="exec.generateImage(id)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </button>
    </div>

    <p v-if="!data.status && !data.error" class="nf-exec-hint">{{ hintText }}</p>
    <p v-if="data.status" class="nf-status">{{ data.status }}</p>
    <p v-if="data.error" class="nf-error">{{ data.error }}</p>
  </div>
</template>
