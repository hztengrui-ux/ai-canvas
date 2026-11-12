<script setup>
// 启动动画：logo 浮现 → 呼吸光环 → 品牌名滑出 → 淡出
// 参考 AI Change 的启动页：白底居中 LOGO + 右下角加载小字。
// V1003.08：登录窗也要走这个动画（原来只有主窗有），时长可配。
import { ref, onMounted } from "vue";

const props = defineProps({
  /** 总时长（淡出前的停留），登录窗用短的，主窗保持原节奏 */
  duration: { type: Number, default: 2000 }
});

const emit = defineEmits(["done"]);
const leaving = ref(false);

onMounted(() => {
  setTimeout(() => {
    leaving.value = true;
    setTimeout(() => emit("done"), 420);
  }, props.duration);
});
</script>

<template>
  <div class="splash" :class="{ leaving }">
    <div class="splash-stage">
      <div class="splash-logo-wrap">
        <span class="splash-ring" />
        <span class="splash-ring splash-ring-2" />
        <img class="splash-logo" src="/brand/logo-mark.png" alt="跨多多科技" />
      </div>

      <div class="splash-brand">
        <span class="splash-brand-cn">跨多多科技</span>
        <span class="splash-brand-en">KUADUO TECH · AI VISUAL STUDIO</span>
      </div>
    </div>

    <div class="splash-product">正在准备创作环境…</div>
  </div>
</template>
