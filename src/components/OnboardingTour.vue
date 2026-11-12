<script setup>
// 新手引导浮层：卡片 + 目标元素高亮
// 高亮用「超大 box-shadow 制造遮罩」的技巧，省去复杂的四块遮罩拼接
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { store } from "../store.js";
import { ONBOARDING_STEPS, CHAPTER_COUNT } from "../onboarding.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  startAt: { type: Number, default: 0 }
});
const emit = defineEmits(["close"]);

const index = ref(0);
const cardRef = ref(null);
const cardStyle = ref({});
const activeSelector = ref("");

const step = computed(() => ONBOARDING_STEPS[index.value] || null);
const isFirst = computed(() => index.value === 0);
const isLast = computed(() => index.value === ONBOARDING_STEPS.length - 1);

const primaryText = computed(() => {
  if (isLast.value) return "完成";
  if (step.value?.isChapterEnd) return "继续下一章";
  return "下一步";
});

// ---------- 定位 ----------
function clearHighlight() {
  document.querySelectorAll(".tour-highlight").forEach((el) => el.classList.remove("tour-highlight"));
}

function placeCard() {
  const el = activeSelector.value ? document.querySelector(activeSelector.value) : null;
  if (!el) {
    cardStyle.value = { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
    return;
  }

  el.classList.add("tour-highlight");
  const r = el.getBoundingClientRect();
  const cardW = cardRef.value?.offsetWidth || 420;
  const cardH = cardRef.value?.offsetHeight || 200;
  const gap = 16;
  const pad = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 候选位置：优先用声明的位置，放不下再依次回退
  const order = [step.value?.placement || "bottom", "bottom", "top", "right", "left"];
  const seen = new Set();
  const candidates = [];

  for (const p of order) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    let left = 0;
    let top = 0;
    if (p === "bottom") {
      left = r.left + r.width / 2 - cardW / 2;
      top = r.bottom + gap;
    } else if (p === "top") {
      left = r.left + r.width / 2 - cardW / 2;
      top = r.top - cardH - gap;
    } else if (p === "right") {
      left = r.right + gap;
      top = r.top + r.height / 2 - cardH / 2;
    } else if (p === "left") {
      left = r.left - cardW - gap;
      top = r.top + r.height / 2 - cardH / 2;
    }
    candidates.push({ left, top, fits: left >= pad && top >= pad && left + cardW <= vw - pad && top + cardH <= vh - pad });
  }

  const best = candidates.find((c) => c.fits) || candidates[0];
  const left = Math.max(pad, Math.min(best.left, vw - cardW - pad));
  const top = Math.max(pad, Math.min(best.top, vh - cardH - pad));

  cardStyle.value = { left: `${left}px`, top: `${top}px`, transform: "none" };
}

async function goTo(i) {
  if (i < 0 || i >= ONBOARDING_STEPS.length) return;
  index.value = i;
  const s = ONBOARDING_STEPS[i];
  if (!s) return;

  // 需要的话先切页面 / 铺工作流
  if (s.route && store.route !== s.route) {
    if (s.workflow) store.pendingWorkflow = s.workflow;
    store.route = s.route;
  } else if (s.workflow && s.isChapterStart) {
    store.pendingWorkflow = s.workflow;
    store.route = "studio";
  }

  await nextTick();
  clearHighlight();
  activeSelector.value = s.target;

  setTimeout(() => {
    // 先把目标滚进视野，再算卡片位置，避免位置随滚动偏移
    const el = document.querySelector(s.target);
    el?.scrollIntoView({ block: "center", behavior: "auto" });
    setTimeout(placeCard, 60);
  }, 160);
}

function next() {
  if (isLast.value) return finish();
  goTo(index.value + 1);
}

function prev() {
  goTo(index.value - 1);
}

// 跳过本章：跳到下一章第一步
function skipChapter() {
  const cur = step.value;
  if (!cur) return finish();
  let i = index.value;
  while (i < ONBOARDING_STEPS.length && ONBOARDING_STEPS[i].chapterIndex === cur.chapterIndex) i++;
  if (i >= ONBOARDING_STEPS.length) return finish();
  goTo(i);
}

function finish() {
  clearHighlight();
  emit("close");
}

function onResize() {
  if (props.open) placeCard();
}

watch(
  () => props.open,
  (v) => {
    if (v) {
      goTo(props.startAt || 0);
      window.addEventListener("resize", onResize);
    } else {
      clearHighlight();
      window.removeEventListener("resize", onResize);
    }
  }
);

onBeforeUnmount(() => {
  clearHighlight();
  window.removeEventListener("resize", onResize);
});

onMounted(() => {
  if (props.open) goTo(props.startAt || 0);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open && step" class="tour" @click.self="finish">
      <div ref="cardRef" class="tour-card" :style="cardStyle">
        <div class="tour-head">
          <span class="tour-chapter">
            第 {{ step.chapterNo }} 章 / 共 {{ CHAPTER_COUNT }} 章 · {{ step.chapterTitle }}
          </span>
          <button class="tour-exit" @click="finish">退出 ✕</button>
        </div>

        <h3 class="tour-title">{{ step.title }}</h3>
        <p class="tour-desc">{{ step.desc }}</p>

        <div class="tour-foot">
          <div class="tour-foot-left">
            <button v-if="!isFirst" class="tour-ghost" @click="prev">上一步</button>
            <button v-if="!isLast" class="tour-ghost" @click="skipChapter">跳过本章</button>
          </div>
          <button class="tour-primary" @click="next">
            {{ primaryText }}
            <span class="tour-arrow">›</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
