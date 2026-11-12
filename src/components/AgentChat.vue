<script setup>
/**
 * Agent 对话（2026-10-31 内联版）
 *
 * 原来这是一个独立的「对话」抽屉（ChatDrawer）：画布右上角一个浮钮打开它，
 * 右侧面板里又有个 Agent 文本域 —— 同一个能力两个入口，用户让合并。
 * 现在只保留这一个组件，直接嵌在右侧面板的 Agent Tab 里（不再弹层）。
 *
 * 行为保持不变：把描述写进画布上的「画面描述」节点，然后提示点执行。
 */
import { ref } from "vue";
import { bridge } from "../store.js";

const input = ref("");
const msgs = ref([]);

const chips = [
  { id: "pose", label: "姿势裂变", icon: "MagicStick", text: "帮我把模特换成不同姿势，保持服装和背景不变" },
  { id: "white", label: "白底图生成", icon: "PictureFilled", text: "生成纯白背景的商品图，主体清晰、边缘干净" },
  { id: "detail", label: "细节图生成", icon: "ZoomIn", text: "生成产品细节特写图，突出材质与做工" }
];

function send(text) {
  const t = (text ?? input.value).trim();
  if (!t) return;
  msgs.value.push({ role: "user", text: t });
  input.value = "";
  const ok = bridge.setPrompt?.(t);
  msgs.value.push({
    role: "assistant",
    text: ok
      ? "已把描述写入画布上的「画面描述」节点，点击执行即可生成。"
      : "当前无法写入画布，请先铺开一个工作流（技能页点一个技能就行）。"
  });
}
</script>

<template>
  <div class="agent-chat">
    <div class="ac-body">
      <div v-if="!msgs.length" class="ac-welcome">
        <span class="ac-hi">Hi！</span>
        <span class="ac-sub">今天一起创作点什么。</span>
        <p class="ac-tip">说一句话，我会把描述写进画布的「画面描述」节点。</p>
      </div>

      <div v-else class="ac-list">
        <div v-for="(m, i) in msgs" :key="i" class="ac-msg" :class="m.role">{{ m.text }}</div>
      </div>
    </div>

    <div class="ac-chips">
      <button v-for="c in chips" :key="c.id" class="ac-chip" @click="send(c.text)">
        <el-icon><component :is="c.icon" /></el-icon>
        <span>{{ c.label }}</span>
      </button>
    </div>

    <div class="ac-input">
      <input v-model="input" placeholder="描述创意或需求…" @keyup.enter="send()" />
      <button class="ac-send" :disabled="!input.trim()" title="发送" @click="send()">
        <el-icon><Top /></el-icon>
      </button>
    </div>
  </div>
</template>
