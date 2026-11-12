<script setup>
import { inject, computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { uploadMaterial } from "../../api.js";
import { NODE_UPLOAD_CATEGORY } from "../../materials.js";

const props = defineProps({ id: String, data: Object });
const exec = inject("exec");
const data = props.data;

// 依据角色显示不同图标：服装 / 模特 / 商品 / 参考图
const iconName = computed(() => {
  const r = data.role;
  if (r === "outfit") return "Goods";
  if (r === "model") return "User";
  if (r === "reference") return "Picture";
  return "Box";
});

const headTitle = computed(() => data.title || "产品图");

function onDrop(evt) {
  const raw = evt.dataTransfer.getData("application/json");
  if (!raw) return;
  try {
    const { material } = JSON.parse(raw);
    if (material.kind !== "image") {
      data.error = `${headTitle.value}节点只接受图片`;
      setTimeout(() => (data.error = ""), 2200);
      return;
    }
    data.file = material;
    data.error = "";
  } catch { /* ignore */ }
}

async function onPickFile(evt) {
  const f = evt.target.files?.[0];
  evt.target.value = "";
  if (!f) return;
  try {
    const up = await uploadMaterial(f, NODE_UPLOAD_CATEGORY.product);
    data.file = { url: up.url, name: f.name, kind: up.kind };
    data.error = "";
  } catch (e) {
    data.error = e.message;
    setTimeout(() => (data.error = ""), 2200);
  }
}
</script>

<template>
  <div class="nf-node nf-product">
    <Handle type="source" :position="Position.Right" id="product" class="nf-handle" data-port="image" title="输出：图片" />

    <div class="nf-product-head">
      <el-icon class="nf-product-icon"><component :is="iconName" /></el-icon>
      <span>{{ headTitle }}</span>
      <span v-if="data.optional" class="nf-product-optional">可选</span>
    </div>

    <div class="nf-product-body" @drop.prevent.stop="onDrop" @dragover.prevent>
      <template v-if="data.file">
        <div class="nf-product-thumb">
          <img :src="data.file.url" :title="data.file.name" />
          <button class="nf-thumb-remove" @click="data.file = null">&times;</button>
        </div>
        <p class="nf-product-name">{{ data.file.name }}</p>
      </template>
      <label v-else class="nf-product-upload">
        <span class="nf-product-plus">+</span>
        <span class="nf-product-hint">点击或拖拽上传</span>
        <input type="file" hidden accept="image/*" @change="onPickFile" />
      </label>
    </div>

    <p v-if="data.error" class="nf-error">{{ data.error }}</p>
  </div>
</template>
