<script setup>
/**
 * 桌面端窗口控制（最小化 / 最大化 / 关闭）。
 *
 * 抽成组件的原因：主窗口顶栏（AppShell）与创作台顶栏（StudioView 的
 * .clean-topbar）是两套完全不同的顶栏，之前只有 AppShell 有按钮 ——
 * 一旦进入创作台就没法最小化/最大化/关闭了。两处都挂这一个组件。
 *
 * 浏览器里 window.desktop 不存在，组件整体不渲染，不影响网页版。
 * 样式在 style.css 的 .win-controls / .win-btn（全局，非 scoped）。
 */
import { ref, onMounted } from "vue";

const desktop = window.desktop;
const isDesktop = Boolean(desktop?.isDesktop);
const maximized = ref(false);

onMounted(() => {
  if (!isDesktop) return;
  desktop.isMaximized?.().then((v) => (maximized.value = Boolean(v)));
  desktop.onWindowState?.((s) => (maximized.value = Boolean(s?.maximized)));
});
</script>

<template>
  <div v-if="isDesktop" class="win-controls">
    <button class="win-btn min" title="最小化" aria-label="最小化" @click="desktop.minimize()">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8h9" />
      </svg>
    </button>
    <button
      class="win-btn max"
      :title="maximized ? '向下还原' : '最大化'"
      :aria-label="maximized ? '向下还原' : '最大化'"
      @click="desktop.toggleMaximize()"
    >
      <svg v-if="!maximized" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3" y="3" width="10" height="10" rx="1.5" />
      </svg>
      <svg v-else viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2.5" y="4.5" width="8" height="8" rx="1.5" />
        <path d="M5.5 4.5V2.5h8v8h-2" />
      </svg>
    </button>
    <button class="win-btn close" title="关闭" aria-label="关闭" @click="desktop.close()">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
      </svg>
    </button>
  </div>
</template>
