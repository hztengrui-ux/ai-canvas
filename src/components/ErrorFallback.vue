<script setup>
/**
 * 致命错误兜底页。
 *
 * 设计取向：**让用户能自救，而不是只能重开程序。**
 * 三个出口，按代价从小到大排：
 *   1. 重试渲染 —— 代价最小，很多瞬时错误重试就好，画布内容还在
 *   2. 回到工作台 —— 如果创作台某块坏了，先退回安全区
 *   3. 复制错误 —— 要反馈问题时用（含时间、位置、堆栈）
 *
 * 刻意不给「自动重载」：那会把用户没保存的画布直接清零，
 * 一次自动重载造成的信任损失，比一次手动点击大得多。
 */
import { ref, computed } from "vue";
import { errorState, clearFatal, errorReportText } from "../errorboundary.js";
import { store } from "../store.js";

const showStack = ref(false);
const copied = ref(false);

const err = computed(() => errorState.fatal || { title: "界面出错", message: "发生了未知错误", stack: "", at: "" });

async function copy() {
  const text = errorReportText();
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1800);
  } catch {
    // 剪贴板不可用（非 https / 无权限）时退回选中文本，让用户自己 Ctrl+C
    const el = document.getElementById("err-stack-raw");
    if (el) {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
}

function retry() {
  clearFatal();
}

function goHome() {
  clearFatal();
  store.route = "home";
}
</script>

<template>
  <div class="ef-wrap">
    <div class="ef-card">
      <div class="ef-icon">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path
            d="M12 9v4m0 4h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z"
            fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round"
          />
        </svg>
      </div>

      <h2 class="ef-title">界面出了点问题</h2>
      <p class="ef-sub">
        已拦下这次崩溃，没有白屏。你的画布内容还在本地，重新加载即可继续。
      </p>

      <div class="ef-msg">{{ err.message }}</div>

      <div class="ef-meta">
        <span>{{ err.source || "未记录位置" }}</span>
        <span class="ef-dot">·</span>
        <span>{{ err.at ? err.at.replace("T", " ").slice(0, 19) : "" }}</span>
      </div>

      <button v-if="err.stack" class="ef-toggle" @click="showStack = !showStack">
        {{ showStack ? "收起技术细节" : "展开技术细节" }}
      </button>
      <pre v-if="showStack && err.stack" id="err-stack-raw" class="ef-stack">{{ err.stack }}</pre>

      <div class="ef-ops">
        <button class="ef-btn primary" @click="retry">重试渲染</button>
        <button class="ef-btn" @click="goHome">回到工作台</button>
        <button class="ef-btn" @click="copy">{{ copied ? "已复制" : "复制错误信息" }}</button>
      </div>

      <div class="ef-foot">
        错误已记录在本地日志（最近 {{ errorState.log.length }} 条），不会自动上传。
      </div>
    </div>
  </div>
</template>

<style scoped>
.ef-wrap {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: var(--bg);
  overflow: auto;
}

.ef-card {
  width: min(560px, 100%);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  padding: 28px 30px 24px;
}

.ef-icon {
  width: 46px;
  height: 46px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--warning);
  background: var(--warning-soft);
  margin-bottom: 16px;
}

.ef-title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 650;
  color: var(--text);
}

.ef-sub {
  margin: 0 0 16px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text-2);
}

.ef-msg {
  background: var(--surface-hover);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-1);
  word-break: break-word;
}

.ef-meta {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-3);
  display: flex;
  gap: 6px;
  align-items: center;
}
.ef-dot { opacity: .5; }

.ef-toggle {
  margin-top: 14px;
  background: none;
  border: 0;
  padding: 0;
  font-size: 12.5px;
  color: var(--primary);
  cursor: pointer;
  font-family: inherit;
}
.ef-toggle:hover { text-decoration: underline; }

.ef-stack {
  margin: 10px 0 0;
  padding: 12px 14px;
  background: var(--canvas-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-2);
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, Consolas, "Courier New", monospace;
}

.ef-ops {
  display: flex;
  gap: 10px;
  margin-top: 20px;
  flex-wrap: wrap;
}

.ef-btn {
  flex: 1;
  min-width: 116px;
  height: 38px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-1);
  font-size: 13.5px;
  cursor: pointer;
  font-family: inherit;
  transition: background-color .16s ease, border-color .16s ease;
}
.ef-btn:hover { background: var(--surface-hover); border-color: var(--border-strong); }
.ef-btn.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  font-weight: 600;
}
.ef-btn.primary:hover { background: var(--primary-hover); }

.ef-foot {
  margin-top: 16px;
  font-size: 11.5px;
  color: var(--text-4);
  line-height: 1.6;
}
</style>
