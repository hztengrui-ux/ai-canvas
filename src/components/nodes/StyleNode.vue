<script setup>
import { inject } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { uploadMaterial } from "../../api.js";
import { NODE_UPLOAD_CATEGORY } from "../../materials.js";

const props = defineProps({ id: String, data: Object });
const exec = inject("exec");

const data = props.data;

function onDrop(evt) {
  const raw = evt.dataTransfer.getData("application/json");
  if (!raw) return;
  try {
    const { material } = JSON.parse(raw);
    if (material.kind !== "image") {
      data.error = "风格节点只接受图片";
      setTimeout(() => (data.error = ""), 2200);
      return;
    }
    if (data.files.length >= 4) return;
    data.files.push(material);
    data.error = "";
  } catch { /* ignore */ }
}

async function onPickFile(evt) {
  const files = [...(evt.target.files || [])];
  evt.target.value = "";
  for (const f of files) {
    if (data.files.length >= 4) break;
    try {
      const up = await uploadMaterial(f, NODE_UPLOAD_CATEGORY.style);
      data.files.push({ url: up.url, name: f.name, kind: up.kind });
    } catch (e) {
      data.error = e.message;
      setTimeout(() => (data.error = ""), 2200);
    }
  }
}
</script>

<template>
  <div class="nf-node nf-style">
    <Handle type="source" :position="Position.Right" id="style" class="nf-handle" data-port="image" title="输出：图片" />

    <div class="nf-style-head">
      <span>参考风格</span>
      <span v-if="data.optional" class="nf-style-tag">可选</span>
    </div>

    <div class="nf-style-body" @drop.prevent.stop="onDrop" @dragover.prevent>
      <div v-if="data.files.length" class="nf-style-thumbs">
        <div v-for="(f, i) in data.files" :key="f.url + i" class="nf-style-thumb">
          <img :src="f.url" :title="f.name" />
          <button class="nf-thumb-remove" @click="data.files.splice(i, 1)">&times;</button>
        </div>
        <label class="nf-style-add">
          <span>+</span>
          <input type="file" hidden multiple accept="image/*" @change="onPickFile" />
        </label>
      </div>

      <label v-else class="nf-style-upload">
        <span class="nf-style-plus">+</span>
        <span class="nf-style-hint">{{ data.uploadText || '点击上传风格图' }}</span>
        <input type="file" hidden multiple accept="image/*" @change="onPickFile" />
      </label>
    </div>

    <p v-if="data.error" class="nf-error">{{ data.error }}</p>
  </div>
</template>
