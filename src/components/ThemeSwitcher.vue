<script setup>
/**
 * 外观切换器。
 *
 * 2026-10-23 起只保留一套主题（棱镜 Prism），所以这里**只剩亮色/暗色**；
 * 主题卡片改成条件渲染：只有 THEMES 多于一套时才显示 —— 以后要加第二套，
 * 这里零改动就能重新出现。
 * 只改 <html data-theme> 与 <body class="dark">，不碰任何业务组件。
 */
import { computed } from "vue";
import { store } from "../store.js";
import { THEMES, setTheme, toggleDark } from "../theme.js";

const current = computed(() => store.theme || "prism");
const currentName = computed(() => THEMES.find((t) => t.id === current.value)?.name || "主题");
// 只有一套主题时，按钮显示「外观」而不是主题名 —— 否则用户会以为还有别的可选
const triggerLabel = computed(() => (THEMES.length > 1 ? currentName.value : "外观"));
const multiTheme = computed(() => THEMES.length > 1);

function pick(id) {
  if (id === current.value) return;
  setTheme(id);
}
</script>

<template>
  <el-popover placement="bottom-end" :width="268" trigger="click" popper-class="theme-popover">
    <template #reference>
      <button class="ts-trigger" title="亮色 / 暗色">
        <el-icon><component :is="store.darkMode ? 'Moon' : 'Sunny'" /></el-icon>
        <span>{{ triggerLabel }}</span>
      </button>
    </template>

    <div v-if="multiTheme" class="ts-cards">
      <button
        v-for="t in THEMES"
        :key="t.id"
        class="ts-card"
        :class="{ on: current === t.id }"
        @click="pick(t.id)"
      >
        <span class="ts-swatches">
          <i v-for="c in t.swatch" :key="c" :style="{ background: c }" />
        </span>
        <span>
          <div class="ts-name">{{ t.name }}<span class="ts-en">{{ t.en }}</span></div>
          <div class="ts-desc">{{ t.desc }}</div>
        </span>
        <el-icon v-if="current === t.id"><Check /></el-icon>
      </button>
    </div>

    <div class="ts-dark" :class="{ 'ts-dark--solo': !multiTheme }">
      <el-icon><component :is="store.darkMode ? 'Moon' : 'Sunny'" /></el-icon>
      <span>外观</span>
      <div class="mode-switch">
        <button :class="{ on: !store.darkMode }" @click="toggleDark(false)">亮色</button>
        <button :class="{ on: store.darkMode }" @click="toggleDark(true)">暗色</button>
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
.ts-en {
  margin-left: 6px;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-4);
}
</style>
