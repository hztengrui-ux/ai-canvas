<script setup>
import { inject } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { store, REF_LIMITS, VIDEO_OPTIONS } from "../../store.js";
import { uploadMaterial } from "../../api.js";
import { NODE_UPLOAD_CATEGORY } from "../../materials.js";

const props = defineProps({ id: String, data: Object });
const exec = inject("exec");
const data = props.data;

function switchTab(tab) {
  data.tab = tab;
}

function limitOf(tab) {
  return tab === "images" ? REF_LIMITS.images : tab === "videos" ? REF_LIMITS.videos : REF_LIMITS.audios;
}

function currentList() {
  return data[data.tab];
}

function onDrop(evt) {
  const raw = evt.dataTransfer.getData("application/json");
  if (!raw) return;
  try {
    const { material } = JSON.parse(raw);
    const tab = material.kind === "image" ? "images" : material.kind === "video" ? "videos" : "audios";
    addRef(tab, material);
  } catch { /* ignore */ }
}

function addRef(tab, item) {
  const list = data[tab];
  if (list.length >= limitOf(tab)) {
    data.error = `最多 ${limitOf(tab)} 个`;
    setTimeout(() => (data.error = ""), 2200);
    return;
  }
  data.error = "";
  list.push(item);
}

function removeRef(tab, idx) {
  data[tab].splice(idx, 1);
}

async function onPickFiles(evt) {
  const files = [...(evt.target.files || [])];
  evt.target.value = "";
  const tab = data.tab;
  for (const f of files) {
    if (currentList().length >= limitOf(tab)) break;
    try {
      const up = await uploadMaterial(f, NODE_UPLOAD_CATEGORY.reference);
      addRef(tab, { url: up.url, name: f.name, kind: up.kind });
    } catch (e) {
      data.error = e.message;
      setTimeout(() => (data.error = ""), 2200);
    }
  }
}
</script>

<template>
  <div class="nf-node nf-ref">
    <!--
      ⚠️ 2026-10-14 修复（幽灵端口）：
      ports.js:47 声明 reference 节点有 outputs [{ id: "result", type: "video" }]，
      但这里以前**一个 <Handle> 都没渲染** —— 端口表与实际 DOM 不符，
      于是「把生成的视频接到结果节点」这条线根本拖不出来（用户看到的是拖不动）。
      视频是从底部「生成视频」按钮产出的，所以输出口放在右下角。
      id 必须与 ports.js 的声明一致，否则 validateConnection 会拒掉这条线。
    -->
    <Handle
      type="source"
      :position="Position.Right"
      id="result"
      class="nf-handle nf-handle-source"
      data-port="video"
      title="输出：视频结果"
    />

    <div class="nf-ref-head">多模态参考</div>

    <div class="nf-ref-tabs">
      <button :class="{ on: data.tab === 'images' }" @click="switchTab('images')">图 {{ data.images.length }}/{{ REF_LIMITS.images }}</button>
      <button :class="{ on: data.tab === 'videos' }" @click="switchTab('videos')">视频 {{ data.videos.length }}/{{ REF_LIMITS.videos }}</button>
      <button :class="{ on: data.tab === 'audios' }" @click="switchTab('audios')">音频 {{ data.audios.length }}/{{ REF_LIMITS.audios }}</button>
    </div>

    <div class="nf-ref-body" @drop.prevent.stop="onDrop" @dragover.prevent>
      <template v-if="currentList().length">
        <div class="nf-ref-thumbs">
          <div v-for="(item, i) in data[data.tab]" :key="item.url + i" class="nf-ref-thumb">
            <img v-if="item.kind === 'image'" :src="item.url" :title="item.name" />
            <video v-else-if="item.kind === 'video'" :src="item.url" muted preload="metadata" />
            <span v-else class="nf-ref-audio">&#9835;</span>
            <button class="nf-thumb-remove" @click="removeRef(data.tab, i)">&times;</button>
          </div>
        </div>
      </template>
      <div v-else class="nf-ref-empty">
        从素材库拖入或上传
      </div>
      <label class="nf-ref-upload">
        <span>+ 上传{{ data.tab === 'images' ? '图片' : data.tab === 'videos' ? '视频' : '音频' }}</span>
        <input ref="file" type="file" hidden multiple :accept="data.tab === 'images' ? 'image/*' : data.tab === 'videos' ? 'video/*' : 'audio/*'" @change="onPickFiles" />
      </label>
    </div>

    <textarea v-model="data.prompt" class="nf-ref-prompt" rows="2" placeholder="输入文字即可生成视频…" />

    <div class="nf-ref-params">
      <select v-model="data.model"><option v-for="m in VIDEO_OPTIONS.models" :key="m">{{ m }}</option></select>
      <select v-model="data.resolution"><option v-for="r in VIDEO_OPTIONS.resolutions" :key="r">{{ r }}</option></select>
      <select v-model="data.duration"><option v-for="d in VIDEO_OPTIONS.durations" :key="d">{{ d }}</option></select>
    </div>

    <p v-if="data.error" class="nf-error">{{ data.error }}</p>
    <p v-if="data.status" class="nf-status">{{ data.status }}</p>

    <button class="nf-ref-generate" :disabled="data.busy" @click="exec.generateVideo(id)">
      {{ data.busy ? '生成中…' : '生成视频' }}
    </button>
  </div>
</template>
