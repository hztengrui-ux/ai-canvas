<script setup>
import { ref, computed, inject } from "vue";
import { ElMessage } from "element-plus";
import { Handle, Position } from "@vue-flow/core";
import { uploadMaterial } from "../../api.js";
import { NODE_UPLOAD_CATEGORY } from "../../materials.js";

const props = defineProps({ id: String, data: Object });
const exec = inject("exec");
const data = props.data;

const activeUrl = ref("");
const busyOp = ref("");
const compareOpen = ref(false);

// 还没有任何结果时展示占位态
const isEmpty = computed(() => !data.images?.length && !data.videos?.length);

function selectImg(img) {
  activeUrl.value = activeUrl.value === img.url ? "" : img.url;
}

async function saveToLibrary() {
  data.saving = true;
  data.saveMsg = "";
  try {
    for (const img of data.images) {
      const blob = await (await fetch(img.url)).blob();
      const name = img.url.split("/").pop();
      await uploadMaterial(new File([blob], name, { type: blob.type || "image/png" }), NODE_UPLOAD_CATEGORY.result);
    }
    data.saveMsg = "已存入素材库";
  } catch (e) {
    data.saveMsg = "保存失败：" + e.message;
  } finally {
    data.saving = false;
    setTimeout(() => (data.saveMsg = ""), 2500);
  }
}

function download(img, idx) {
  const a = document.createElement("a");
  a.href = img.url;
  a.download = `ai-canvas-${Date.now()}-${idx + 1}.png`;
  a.target = "_blank";
  a.rel = "noopener";
  a.click();
}

function downloadAll() {
  data.images.forEach((img, i) => setTimeout(() => download(img, i), i * 180));
  ElMessage.success(`开始下载 ${data.images.length} 张`);
}

async function upscale(img) {
  busyOp.value = img.url;
  try {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.src = img.url;
    await new Promise((res, rej) => {
      im.onload = res;
      im.onerror = () => rej(new Error("图片加载失败"));
    });
    const scale = 2;
    const c = document.createElement("canvas");
    c.width = im.naturalWidth * scale;
    c.height = im.naturalHeight * scale;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(im, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/png");
    data.images.push({ url, name: `upscaled-${Date.now()}.png` });
    ElMessage.success("已放大 2×");
  } catch (e) {
    ElMessage.error("放大失败：" + e.message);
  } finally {
    busyOp.value = "";
  }
}

function removeImg(img) {
  const i = data.images.indexOf(img);
  if (i >= 0) data.images.splice(i, 1);
  if (activeUrl.value === img.url) activeUrl.value = "";
}

// 需要云端能力的操作：这里给出明确提示，接口就绪后即可接入
function pendingOp(label) {
  ElMessage.info(`「${label}」需要接入图像编辑模型后可用`);
}
</script>

<template>
  <div class="nf-node nf-result" :class="{ empty: isEmpty }">
    <Handle type="target" :position="Position.Left" id="result" class="nf-handle nf-handle-target" data-port="ai-image" title="输入：AI 图片 / 视频" />

    <div class="nf-result-head">
      <span>生成结果</span>
      <span v-if="!isEmpty" class="nf-result-count">{{ data.images.length + (data.videos?.length || 0) }}</span>
      <span v-else class="nf-result-state">待生成</span>
    </div>

    <!-- 空态：等待上游执行 -->
    <div v-if="isEmpty" class="nf-result-placeholder">
      <span class="nf-result-placeholder-icon">
        <el-icon><PictureFilled /></el-icon>
      </span>
      <span class="nf-result-placeholder-text">点击左侧执行，结果会出现在这里</span>
    </div>

    <div v-else class="nf-result-grid">
      <div
        v-for="(img, idx) in data.images"
        :key="img.url"
        class="nf-result-item"
        :class="{ active: activeUrl === img.url }"
        @click="selectImg(img)"
      >
        <img :src="img.url" :alt="`result-${idx}`" />
        <span v-if="busyOp === img.url" class="nf-result-busy">处理中…</span>
      </div>
      <video v-for="v in data.videos" :key="v.url" :src="v.url" controls class="nf-result-video"></video>
    </div>

    <!-- 选中图片后的操作工具条 -->
    <div v-if="activeUrl" class="nf-media-bar">
      <button class="nf-media-btn" title="放大 2×" @click="upscale(data.images.find(i => i.url === activeUrl))">
        <el-icon><ZoomIn /></el-icon><span>放大</span>
      </button>
      <button class="nf-media-btn" title="白底图" @click="pendingOp('白底图')">
        <el-icon><PictureFilled /></el-icon><span>白底图</span>
      </button>
      <button class="nf-media-btn" title="姿势裂变" @click="pendingOp('姿势裂变')">
        <el-icon><MagicStick /></el-icon><span>姿势</span>
      </button>
      <button class="nf-media-btn" title="裁剪" @click="pendingOp('裁剪')">
        <el-icon><Crop /></el-icon><span>裁剪</span>
      </button>
      <button class="nf-media-btn" title="下载" @click="download(data.images.find(i => i.url === activeUrl), data.images.findIndex(i => i.url === activeUrl))">
        <el-icon><Download /></el-icon><span>下载</span>
      </button>
      <button class="nf-media-btn danger" title="移除" @click="removeImg(data.images.find(i => i.url === activeUrl))">
        <el-icon><Delete /></el-icon>
      </button>
    </div>

    <div v-if="data.images?.length" class="nf-result-actions">
      <button class="nf-mini-btn" :disabled="data.saving" @click="saveToLibrary">
        {{ data.saving ? '保存中…' : '存入素材库' }}
      </button>
      <button class="nf-mini-btn" @click="downloadAll">全部下载</button>
      <button v-if="data.images.length > 1" class="nf-mini-btn" @click="compareOpen = true">对比</button>
    </div>
    <p v-if="data.saveMsg" class="nf-status">{{ data.saveMsg }}</p>

    <!-- 对比模态 -->
    <Teleport to="body">
      <div v-if="compareOpen" class="nf-compare-mask" @click.self="compareOpen = false">
        <div class="nf-compare-modal">
          <div class="nf-compare-head">
            <span>对比 · {{ data.images.length }} 张</span>
            <button @click="compareOpen = false"><el-icon><Close /></el-icon></button>
          </div>
          <div class="nf-compare-body">
            <img v-for="(img, i) in data.images" :key="i" :src="img.url" />
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
