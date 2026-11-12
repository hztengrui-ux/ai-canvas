<script setup>
import { inject, computed, watchEffect } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { IMAGE_MODELS, MODEL_GROUPS, modelById } from "../../store.js";

const props = defineProps({ id: String, data: Object });
const exec = inject("exec");
const data = props.data;

const model = computed(() => modelById(data.modelId));

// 模型 id 归一化兜底（2026-10-23）：
// 老项目 / 老工作流模板里可能存着已下线模型（wanxiang、comfyui），
// 或 localStorage 里的旧默认值。此时 <select> 的 value 不在选项里 →
// 下拉框**空白**，用户会以为"模型没加载出来"。这里统一改回第一个可选模型。
// 用 watchEffect 而不是 onMounted：节点数据是响应式的，之后被改坏也能纠正。
watchEffect(() => {
  if (!IMAGE_MODELS.some((m) => m.id === data.modelId)) data.modelId = IMAGE_MODELS[0].id;
});

function modelsByGroup(g) {
  return IMAGE_MODELS.filter((m) => m.group === g);
}

function onModelChange() {
  if (!model.value.ratios.includes(data.ratio)) data.ratio = model.value.ratios[0];
  if (!model.value.counts.includes(data.count)) data.count = model.value.counts[0];
}
</script>

<template>
  <div class="nf-node nf-prompt">
    <Handle type="source" :position="Position.Right" id="prompt" class="nf-handle" data-port="string" title="输出：文本" />

    <textarea
      v-model="data.prompt"
      class="nf-prompt-input"
      rows="3"
      placeholder="请输入画面描述..."
    />

    <div class="nf-prompt-bar">
      <select v-model="data.modelId" class="nf-bar-select" title="生成模型" @change="onModelChange">
        <optgroup v-for="g in MODEL_GROUPS" :key="g" :label="g">
          <option v-for="m in modelsByGroup(g)" :key="m.id" :value="m.id">{{ m.label }}</option>
        </optgroup>
      </select>
      <span class="nf-bar-dot" />
      <select v-model="data.count" class="nf-bar-select" title="生成张数">
        <option v-for="c in model.counts" :key="c" :value="c">{{ c }}张</option>
      </select>
      <span class="nf-bar-dot" />
      <select v-model="data.ratio" class="nf-bar-select" title="画幅比例">
        <option v-for="r in model.ratios" :key="r" :value="r">{{ r }}</option>
      </select>
      <button class="nf-bar-add" title="添加新的画面描述节点" @click="exec.addPromptNode(id)">+</button>
    </div>

    <p v-if="data.error" class="nf-error">{{ data.error }}</p>
  </div>
</template>
