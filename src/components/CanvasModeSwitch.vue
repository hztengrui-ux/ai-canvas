<script setup>
/**
 * 画布顶栏的模式区（2026-10-23 调整）
 *
 * 原来是「无限画布 / 批量节点」二选一：
 *   free  点一下选中一个，随手摆、随手连
 *   batch 点一下是加选，顶部出批量条，整批串行跑
 *
 * 现在批量这件事已经由**独立的「全自动批量」页**承接（按文件夹跑、带对比预览），
 * 画布里的「批量节点」就成了第二套批量入口 —— 用户反馈"两个批量会混"。
 * 所以这里把第二个按钮从"切模式"改成"去批量页"：
 *   · 画布始终是无限画布（不再有 canvasMode=batch 的加选契约）
 *   · 「全自动批量」点击后切到 route=batch
 * 旧的批量条与 BatchDock 代码保留（数据/逻辑没坏），只是不再有入口进入。
 */
import { store } from "../store.js";

function goBatch() {
  // 离开画布前把批量模式清掉，避免下次回来还停在加选状态
  store.canvasMode = "free";
  try {
    localStorage.setItem("ai-canvas:canvas-mode", "free");
  } catch {
    /* 隐私模式忽略 */
  }
  store.route = "batch";
}
</script>

<template>
  <div class="mode-switch">
    <button class="on" title="自由创作：随手摆放节点、连线、微调">
      <el-icon><Aim /></el-icon>
      <span>无限画布</span>
    </button>
    <button class="mode-switch-go" title="按文件夹批量出图：全自动批量" @click="goBatch">
      <el-icon><Files /></el-icon>
      <span>全自动批量</span>
      <svg class="mode-switch-arrow" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6 10l4-4M10 6H6.6M10 6v3.4" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* ⚠️ 这两条必须写在 <template> 外面（第一次改版把 <style> 塞进了 template，
   Vue 把它当普通 DOM 节点渲染，样式一条没生效，按钮文字被挤成竖排）。 */
.mode-switch {
  flex: 0 0 auto;
}
.mode-switch button {
  white-space: nowrap;
}

/* 「全自动批量」不是模式，是去另一个页面 —— 用一个小箭头说清楚，
   否则它跟左边高亮的「无限画布」看起来像同一组单选钮。 */
.mode-switch-arrow {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.55;
}
.mode-switch-go:hover .mode-switch-arrow {
  opacity: 1;
}
</style>
