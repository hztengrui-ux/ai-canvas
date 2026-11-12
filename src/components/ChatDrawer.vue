<script setup>
import { ref } from "vue";
import { bridge } from "../store.js";

defineProps({ modelValue: Boolean });
const emit = defineEmits(["update:modelValue"]);

const chatInput = ref("");
const chatMsgs = ref([]);

const quickChips = [
  { id: "pose", label: "姿势裂变", icon: "MagicStick", text: "帮我把模特换成不同姿势，保持服装和背景不变" },
  { id: "white", label: "白底图生成", icon: "PictureFilled", text: "生成纯白背景的商品图，主体清晰、边缘干净" },
  { id: "detail", label: "细节图生成", icon: "ZoomIn", text: "生成产品细节特写图，突出材质与做工" }
];

function sendChat(text) {
  const t = (text ?? chatInput.value).trim();
  if (!t) return;
  chatMsgs.value.push({ role: "user", text: t });
  chatInput.value = "";
  const ok = bridge.setPrompt?.(t);
  chatMsgs.value.push({
    role: "assistant",
    text: ok
      ? "已把描述写入画布上的「画面描述」节点，点击执行即可生成。"
      : "当前无法写入画布，请先进入创作台并铺开一个工作流。"
  });
}

function useChip(c) {
  sendChat(c.text);
}
</script>

<template>
  <div class="chat-drawer" :class="{ open: modelValue }">
    <div class="chat-head">
      <div class="chat-head-title">
        <el-icon><ChatDotRound /></el-icon>
        <span>新建对话</span>
      </div>
      <div class="chat-head-actions">
        <button title="历史对话"><el-icon><Clock /></el-icon></button>
        <button title="收起对话" @click="emit('update:modelValue', false)"><el-icon><DArrowRight /></el-icon></button>
      </div>
    </div>

    <div class="chat-body">
      <div v-if="!chatMsgs.length" class="chat-welcome">
        <img class="chat-logo" src="/brand/logo-mark.png" alt="跨多多科技" />
        <div class="chat-hi">Hi！</div>
        <div class="chat-hi-sub">今天一起创作点什么。</div>
      </div>

      <div v-else class="chat-list">
        <div v-for="(m, i) in chatMsgs" :key="i" class="chat-msg" :class="m.role">{{ m.text }}</div>
      </div>

      <div class="chat-chips">
        <button v-for="c in quickChips" :key="c.id" class="chat-chip" @click="useChip(c)">
          <el-icon><component :is="c.icon" /></el-icon>
          <span>{{ c.label }}</span>
        </button>
      </div>
    </div>

    <div class="chat-input">
      <button class="chat-plus" title="添加画布素材"><el-icon><Plus /></el-icon></button>
      <input
        v-model="chatInput"
        placeholder="描述创意或需求，点击 + 添加画布素材"
        @keyup.enter="sendChat()"
      />
      <button class="chat-mic" title="语音输入"><el-icon><Microphone /></el-icon></button>
      <button class="chat-send" :disabled="!chatInput.trim()" title="发送" @click="sendChat()">
        <el-icon><Top /></el-icon>
      </button>
    </div>
  </div>
</template>
