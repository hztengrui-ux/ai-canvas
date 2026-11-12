<script setup>
// 磨砂玻璃对比浮层
//
// 设计稿：prototypes/batch-workbench.html 的 .overlay / .glass 段
//   · 全屏毛玻璃遮罩（backdrop-filter: blur(38px)）+ 玻璃面板
//   · 三种模式：滑动对比（clip-path 分割）/ 并排查看 / 只看结果
//   · 右侧胶片条、底部上一张/下一张/重跑/下载
//
// 这里只负责「看」与「翻页」，不自己发请求：
// 重跑、下载都 emit 给父组件（BatchWorkbench），由它决定怎么接后端。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  open: { type: Boolean, default: false },
  /** [{ rel, name, before, after, named, ms, status, meta }] */
  items: { type: Array, default: () => [] },
  index: { type: Number, default: 0 }
});
const emit = defineEmits(["close", "update:index", "retry", "download", "download-all"]);

// slide = 滑动对比 / sbs = 并排查看 / result = 只看结果
const mode = ref("slide");
// 分割线位置（百分比，2~98 之间，避免把手把图完全盖住或贴边看不见）
const pct = ref(50);

const compareEl = ref(null);
const filmEl = ref(null);

const total = computed(() => props.items.length);
const current = computed(() => props.items[props.index] || null);
const pctLabel = computed(() => `${Math.round(pct.value)}%`);

const hasPrev = computed(() => props.index > 0);
const hasNext = computed(() => props.index < total.value - 1);

function go(step) {
  const next = props.index + step;
  if (next < 0 || next >= total.value) return;
  emit("update:index", next);
}

function pick(i) {
  if (i < 0 || i >= total.value) return;
  emit("update:index", i);
}

function close() {
  emit("close");
}

// ---------- 滑动对比 ----------
function setPct(p) {
  pct.value = Math.max(2, Math.min(98, p));
}

let dragging = false;

function pctFromEvent(e) {
  const el = compareEl.value;
  if (!el) return pct.value;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return pct.value;
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  return (x / rect.width) * 100;
}

function onDragStart(e) {
  dragging = true;
  setPct(pctFromEvent(e));
}

function onDragMove(e) {
  if (!dragging) return;
  setPct(pctFromEvent(e));
}

function onDragEnd() {
  dragging = false;
}

// ---------- 键盘：Esc 关、左右翻 ----------
function onKeydown(e) {
  if (!props.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    close();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    go(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    go(1);
  }
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      mode.value = "slide";
      pct.value = 50;
      setPct(50);
    }
  }
);

// 翻页时把胶片条里的当前张滚进可视区（不滚动整页）
watch(
  () => props.index,
  async () => {
    await nextTick();
    const box = filmEl.value;
    if (!box) return;
    const active = box.querySelector(".gx-film.on");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
);

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
  window.addEventListener("touchmove", onDragMove, { passive: true });
  window.addEventListener("touchend", onDragEnd);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("mousemove", onDragMove);
  window.removeEventListener("mouseup", onDragEnd);
  window.removeEventListener("touchmove", onDragMove);
  window.removeEventListener("touchend", onDragEnd);
});

function onImgError(e) {
  // 图挂了不要留一块空白：把 alt 文本亮出来
  if (e?.target) e.target.classList.add("is-broken");
}
</script>

<template>
  <Teleport to="body">
    <Transition name="gx-fade">
      <div v-if="open" class="gx-overlay" @click.self="close">
        <div class="gx-glass" role="dialog" aria-modal="true" aria-label="大图对比">
          <!-- 顶栏 -->
          <header class="gx-hd">
            <span class="gx-hd-file" :title="current?.name || ''">{{ current?.name || "暂无结果" }}</span>
            <span v-if="current" class="gx-badge" :class="{ err: current.status === 'error' }">
              {{ current.status === "error" ? "失败" : "已完成" }}
            </span>
            <span class="gx-dim">{{ current?.meta || "—" }}</span>

            <div class="gx-hd-right">
              <div class="gx-seg" role="tablist">
                <button
                  type="button"
                  :class="{ on: mode === 'slide' }"
                  role="tab"
                  :aria-selected="mode === 'slide'"
                  @click="mode = 'slide'; setPct(50)"
                >
                  滑动对比
                </button>
                <button
                  type="button"
                  :class="{ on: mode === 'sbs' }"
                  role="tab"
                  :aria-selected="mode === 'sbs'"
                  @click="mode = 'sbs'"
                >
                  并排查看
                </button>
                <button
                  type="button"
                  :class="{ on: mode === 'result' }"
                  role="tab"
                  :aria-selected="mode === 'result'"
                  @click="mode = 'result'"
                >
                  只看结果
                </button>
              </div>
              <button type="button" class="gx-icon" title="关闭 (Esc)" @click="close">
                <el-icon><Close /></el-icon>
              </button>
            </div>
          </header>

          <!-- 主体：舞台 + 胶片条 -->
          <div class="gx-bd">
            <div class="gx-stage">
              <p v-if="!current" class="gx-empty">还没有可对比的结果，先跑完一张再来看。</p>

              <!-- 滑动对比 -->
              <div
                v-else-if="mode === 'slide'"
                ref="compareEl"
                class="gx-compare"
                @mousedown="onDragStart"
                @touchstart="onDragStart"
              >
                <img class="gx-img" :src="current.before" alt="原图" draggable="false" @error="onImgError" />
                <img
                  class="gx-img after"
                  :src="current.after"
                  alt="结果"
                  draggable="false"
                  :style="{ clipPath: `inset(0 0 0 ${pct}%)` }"
                  @error="onImgError"
                />
                <span class="gx-lb l">原图</span>
                <span class="gx-lb r">结果</span>
                <div class="gx-handle" :style="{ left: `${pct}%` }">
                  <div class="gx-knob">
                    <el-icon><ArrowLeft /></el-icon>
                    <el-icon><ArrowRight /></el-icon>
                  </div>
                </div>
                <span class="gx-pct">{{ pctLabel }}</span>
              </div>

              <!-- 并排查看 -->
              <div v-else-if="mode === 'sbs'" class="gx-sbs">
                <div class="gx-sbs-cell">
                  <img :src="current.before" alt="原图" draggable="false" @error="onImgError" />
                  <span class="gx-cap">原图 · {{ current.name }}</span>
                </div>
                <div class="gx-sbs-cell">
                  <img :src="current.after" alt="结果" draggable="false" @error="onImgError" />
                  <span class="gx-cap r">结果 · {{ current.named || current.name }}</span>
                </div>
              </div>

              <!-- 只看结果 -->
              <div v-else class="gx-result">
                <img :src="current.after" alt="结果" draggable="false" @error="onImgError" />
                <span class="gx-cap r">结果 · {{ current.named || current.name }}</span>
              </div>
            </div>

            <!-- 右侧胶片条 -->
            <div ref="filmEl" class="gx-filmstrip">
              <button
                v-for="(it, i) in items"
                :key="it.rel || i"
                type="button"
                class="gx-film"
                :class="{ on: i === index }"
                :title="it.name"
                @click="pick(i)"
              >
                <img :src="it.after" alt="" draggable="false" @error="onImgError" />
                <span class="gx-film-n">{{ i + 1 }}</span>
              </button>
              <p v-if="!items.length" class="gx-film-empty">暂无</p>
            </div>
          </div>

          <!-- 底栏 -->
          <footer class="gx-ft">
            <button type="button" class="gx-btn" :disabled="!hasPrev" @click="go(-1)">
              <el-icon><ArrowLeft /></el-icon>
              上一张
            </button>
            <span class="gx-pager">{{ total ? index + 1 : 0 }} / {{ total }}</span>
            <button type="button" class="gx-btn" :disabled="!hasNext" @click="go(1)">
              下一张
              <el-icon><ArrowRight /></el-icon>
            </button>

            <span class="gx-spacer" />

            <button type="button" class="gx-btn" :disabled="!current" @click="current && emit('retry', current)">
              <el-icon><RefreshRight /></el-icon>
              重跑这张
            </button>
            <button type="button" class="gx-btn" :disabled="!current" @click="current && emit('download', current)">
              <el-icon><Download /></el-icon>
              下载
            </button>
            <button
              type="button"
              class="gx-btn lime"
              :disabled="!total"
              @click="emit('download-all')"
            >
              <el-icon><Download /></el-icon>
              下载全部已完成（{{ total }}）
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ============ 全屏磨砂遮罩 ============ */
.gx-overlay {
  position: fixed;
  inset: 0;
  z-index: 2600; /* Element Plus 弹层在 3000，浮层压在页面之上、确认框之下 */
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(226, 231, 237, 0.42);
  backdrop-filter: blur(38px) saturate(1.3);
  -webkit-backdrop-filter: blur(38px) saturate(1.3);
}

.gx-glass {
  width: min(1180px, calc(100% - 64px));
  height: min(760px, calc(100% - 64px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 26px;
  background: color-mix(in srgb, var(--surface, #fff) 62%, transparent);
  border: 1px solid color-mix(in srgb, var(--surface, #fff) 90%, transparent);
  box-shadow:
    0 40px 120px -40px rgba(21, 23, 30, 0.55),
    inset 0 1px 0 rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(30px) saturate(1.24);
  -webkit-backdrop-filter: blur(30px) saturate(1.24);
}

/* ============ 顶栏 ============ */
.gx-hd {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid color-mix(in srgb, var(--surface, #fff) 70%, transparent);
  background: color-mix(in srgb, var(--surface, #fff) 35%, transparent);
}

.gx-hd-file {
  font-size: 14px;
  font-weight: 700;
  color: var(--text, #15171e);
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gx-badge {
  font-size: 11.5px;
  font-weight: 650;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--lime, #d8fa34);
  color: var(--lime-ink, #181a0c);
}
.gx-badge.err {
  background: var(--danger, #e0553f);
  color: #fff;
}

.gx-dim {
  font-size: 12px;
  color: var(--text-3, #838ca0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gx-hd-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.gx-seg {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface, #fff) 60%, transparent);
}
.gx-seg button {
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-2, #5a6274);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.gx-seg button:hover {
  color: var(--text, #15171e);
}
.gx-seg button.on {
  background: var(--surface, #fff);
  color: var(--text, #15171e);
  font-weight: 650;
  box-shadow: var(--shadow, 0 1px 2px rgba(21, 23, 30, 0.05), 0 10px 26px -20px rgba(21, 23, 30, 0.35));
}

.gx-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text-2, #5a6274);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.gx-icon:hover {
  background: var(--surface-hover, #f5f6f8);
  color: var(--text, #15171e);
}

/* ============ 主体 ============ */
.gx-bd {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 108px;
}

.gx-stage {
  position: relative;
  min-width: 0;
  padding: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.gx-empty {
  font-size: 13px;
  color: var(--text-3, #838ca0);
}

/* ---- 滑动对比 ---- */
.gx-compare {
  position: relative;
  width: 100%;
  height: 100%;
  max-width: 860px;
  max-height: 560px;
  border-radius: 18px;
  overflow: hidden;
  background: var(--surface-hover, #e9edf1);
  box-shadow:
    0 30px 70px -40px rgba(21, 23, 30, 0.65),
    0 0 0 1px color-mix(in srgb, var(--surface, #fff) 70%, transparent);
  cursor: ew-resize;
  touch-action: none;
  user-select: none;
}

.gx-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* 图挂了：留一块浅底 + 说明，而不是白屏 */
.gx-img.is-broken {
  background: var(--surface-hover, #e9edf1);
  color: var(--text-3, #838ca0);
  font-size: 12px;
}

.gx-lb {
  position: absolute;
  top: 12px;
  padding: 3px 8px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(21, 23, 30, 0.7);
  color: #fff;
  pointer-events: none;
}
.gx-lb.l {
  left: 12px;
}
.gx-lb.r {
  right: 12px;
  background: var(--lime, #d8fa34);
  color: var(--lime-ink, #181a0c);
}

.gx-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 0 1px rgba(21, 23, 30, 0.18);
  pointer-events: none;
}

.gx-knob {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: #fff;
  color: var(--ink, #15171e);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  font-size: 12px;
  box-shadow: 0 8px 24px -8px rgba(21, 23, 30, 0.6);
}

.gx-pct {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  padding: 2px 8px;
  border-radius: 7px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  background: rgba(21, 23, 30, 0.55);
  color: #fff;
  pointer-events: none;
}

/* ---- 并排 ---- */
.gx-sbs {
  display: flex;
  gap: 14px;
  width: 100%;
  height: 100%;
  max-width: 980px;
  max-height: 560px;
}
.gx-sbs-cell {
  position: relative;
  flex: 1;
  min-width: 0;
  border-radius: 16px;
  overflow: hidden;
  background: var(--surface-hover, #e9edf1);
  box-shadow: 0 20px 50px -30px rgba(21, 23, 30, 0.6);
}
.gx-sbs-cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* ---- 只看结果 ---- */
.gx-result {
  position: relative;
  width: 100%;
  height: 100%;
  max-width: 860px;
  max-height: 560px;
  border-radius: 18px;
  overflow: hidden;
  background: var(--surface-hover, #e9edf1);
  box-shadow: 0 30px 70px -40px rgba(21, 23, 30, 0.65);
}
.gx-result img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.gx-cap {
  position: absolute;
  left: 10px;
  top: 10px;
  max-width: calc(100% - 20px);
  padding: 3px 8px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.9);
  color: var(--text-2, #5a6274);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gx-cap.r {
  background: var(--lime, #d8fa34);
  color: var(--lime-ink, #181a0c);
}

/* ---- 胶片条 ---- */
.gx-filmstrip {
  border-left: 1px solid color-mix(in srgb, var(--surface, #fff) 70%, transparent);
  background: color-mix(in srgb, var(--surface, #fff) 28%, transparent);
  padding: 12px 10px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gx-film {
  position: relative;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 9px;
  overflow: hidden;
  aspect-ratio: 1;
  background: var(--surface-hover, #e9edf1);
  cursor: pointer;
  opacity: 0.72;
  flex: 0 0 auto;
}
.gx-film img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.gx-film.on {
  border-color: var(--lime, #d8fa34);
  opacity: 1;
}
.gx-film-n {
  position: absolute;
  right: 3px;
  bottom: 3px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 9.5px;
  background: rgba(21, 23, 30, 0.6);
  color: #fff;
}
.gx-film-empty {
  font-size: 11.5px;
  color: var(--text-3, #838ca0);
  text-align: center;
}

/* ============ 底栏 ============ */
.gx-ft {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid color-mix(in srgb, var(--surface, #fff) 70%, transparent);
  background: color-mix(in srgb, var(--surface, #fff) 35%, transparent);
}

.gx-pager {
  font-size: 12.5px;
  color: var(--text-2, #5a6274);
  font-variant-numeric: tabular-nums;
  min-width: 56px;
  text-align: center;
}

.gx-spacer {
  flex: 1;
}

.gx-btn {
  height: 32px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border, #e4e7eb);
  background: color-mix(in srgb, var(--surface, #fff) 82%, transparent);
  color: var(--text, #15171e);
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.gx-btn:hover:not(:disabled) {
  border-color: var(--border-strong, #d3d8de);
  background: var(--surface, #fff);
}
.gx-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.gx-btn.lime {
  background: var(--lime, #d8fa34);
  border-color: var(--lime, #d8fa34);
  color: var(--lime-ink, #181a0c);
  box-shadow: 0 8px 18px -12px rgba(188, 230, 0, 1);
}
.gx-btn.lime:hover:not(:disabled) {
  background: var(--lime-deep, #bce600);
  border-color: var(--lime-deep, #bce600);
}

/* ============ 动效 ============ */
.gx-fade-enter-active,
.gx-fade-leave-active {
  transition: opacity 0.18s ease;
}
.gx-fade-enter-from,
.gx-fade-leave-to {
  opacity: 0;
}

@media (max-width: 1100px) {
  .gx-glass {
    width: calc(100% - 24px);
    height: calc(100% - 24px);
  }
  .gx-bd {
    grid-template-columns: minmax(0, 1fr) 88px;
  }
  .gx-ft {
    flex-wrap: wrap;
  }
}
</style>
