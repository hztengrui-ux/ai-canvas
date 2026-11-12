<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import { fetchVersion } from "../api.js";
import { bridge } from "../store.js";
import { IS_EMBEDDED } from "../embed.js";

// ============================================================================
// 更新提示（第三轮重写：消灭假进度条）
//
// 改造前：setInterval + Math.random 走一个 5.5 秒的假进度条，「立即重启」只是
//         location.reload() —— 用户以为更新了，其实什么都没装。
// 改造后：
//   [真链路 · 桌面端优先] window.desktop.update（electron/preload.cjs 桥接 →
//       electron/updater.cjs 的 electron-updater）。percent 只来自主进程推送的
//       update:progress 事件；「立即重启」调 update.install() → 主进程
//       autoUpdater.quitAndInstall() 真的重启并装包。
//   [兜底 · 仅网页版] 没有 window.desktop.update 时（纯浏览器 / Linux dev），
//       /api/version 只能告诉我们「有没有新版本」，既拿不到也控制不了下载，
//       所以这条路径只如实提示「有新版」，不画进度条、不编百分比、不谎称已下载。
//       代码里所有 web 兜底分支都带 [web 兜底] 标记。
// ============================================================================

// 已下载过的版本（避免每次刷新都重复提示）
const DONE_KEY = "ai-canvas:update-downloaded";

// 桌面真链路句柄。存在 = 走真实更新；不存在 = 只能走 web 兜底。
// 判据用 update.check 是否存在（而不是光看 update 对象在不在），
// 避免 preload 只暴露了一半接口时误判成「真链路可用」。
const desktopUpdate = window.desktop?.update?.check ? window.desktop.update : null;

// idle | checking | downloading | done | error | latest | unavailable | available
// done / downloading 只可能由桌面真链路事件置位（见 markDone / onDownloaded）。
const state = ref("idle");
const info = ref(null);
const percent = ref(0);
const dismissed = ref(false);
const installing = ref(false);
// 真实链路不可用时的原因（dev / no-source / missing-dep），用于如实解释而不是笼统报错
const unavailableReason = ref("");
const isAutoCheck = ref(true);

let resetTimer = null;
let unsubscribers = [];

function clampPercent(v) {
  const n = Math.round(Number(v) || 0);
  return Math.max(0, Math.min(100, n));
}

function rememberDone(version) {
  try {
    if (version) localStorage.setItem(DONE_KEY, String(version));
  } catch {
    /* ignore */
  }
}

function readDone() {
  try {
    return localStorage.getItem(DONE_KEY) || "";
  } catch {
    return "";
  }
}

function clearDone() {
  try {
    localStorage.removeItem(DONE_KEY);
  } catch {
    /* ignore */
  }
}

/** 「已是最新」只短暂提示一下，然后收起（自动检查时不打扰） */
function showLatestBriefly() {
  if (isAutoCheck.value) {
    state.value = "idle";
    return;
  }
  state.value = "latest";
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => (state.value = "idle"), 3200);
}

function reasonText(reason) {
  switch (reason) {
    case "dev":
      return "开发模式下不检查更新。";
    case "no-source":
      return "当前安装包没有配置更新源（app-update.yml 缺失）。";
    case "missing-dep":
      return "更新组件 electron-updater 加载失败。";
    case "busy":
      return "上一次检查还没结束，稍后再试。";
    default:
      return "当前环境的自动更新不可用。";
  }
}

// ---------------------------------------------------------------------------
// 桌面真链路：事件订阅
// 每个订阅函数都返回取消订阅函数（preload.cjs 的 subscribe 工厂），
// 必须在 onBeforeUnmount 里逐个调用，否则监听器堆积。
// ---------------------------------------------------------------------------
function unbindDesktopEvents() {
  for (const off of unsubscribers) {
    try {
      if (typeof off === "function") off();
    } catch {
      /* ignore */
    }
  }
  unsubscribers = [];
}

function bindDesktopEvents() {
  unbindDesktopEvents();
  if (!desktopUpdate) return;

  const offs = [
    desktopUpdate.onChecking?.(() => {
      state.value = "checking";
      percent.value = 0;
    }),
    desktopUpdate.onAvailable?.((payload) => {
      // 主进程发现新版本；electron-updater 的 autoDownload=true，随后会自动开始下载
      info.value = {
        ...(info.value || {}),
        latest: payload?.version || info.value?.latest || "",
        notes: payload?.releaseNotes || info.value?.notes || ""
      };
      percent.value = 0;
      dismissed.value = false;
      state.value = "downloading";
    }),
    desktopUpdate.onNone?.((payload) => {
      info.value = { ...(info.value || {}), current: payload?.version || info.value?.current, hasUpdate: false };
      showLatestBriefly();
    }),
    desktopUpdate.onProgress?.((payload) => {
      // 真实进度：唯一来源，不再有任何随机数
      percent.value = clampPercent(payload?.percent);
      if (state.value === "idle" || state.value === "checking") state.value = "downloading";
    }),
    desktopUpdate.onDownloaded?.((payload) => {
      percent.value = 100;
      state.value = "done";
      installing.value = false;
      const v = payload?.version || info.value?.latest || "";
      info.value = { ...(info.value || {}), latest: v };
      rememberDone(v);
    }),
    desktopUpdate.onError?.((payload) => {
      state.value = "error";
      unavailableReason.value = payload?.message || "";
    })
  ];
  unsubscribers = offs.filter((f) => typeof f === "function");
}

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------
async function check(auto = true) {
  if (state.value === "downloading" || state.value === "done") return;
  isAutoCheck.value = auto;
  state.value = "checking";
  dismissed.value = false;
  unavailableReason.value = "";

  if (desktopUpdate) {
    // 先问能力。dev / 未配置更新源时主进程会返回 enabled:false，
    // 这时不要再去 check()，如实告诉用户为什么没有更新。
    let st = null;
    try {
      st = await desktopUpdate.state();
    } catch {
      st = null;
    }
    if (!st || st.enabled !== true) {
      unavailableReason.value = st?.reason || "";
      state.value = auto ? "idle" : "unavailable";
      return;
    }
    try {
      const r = await desktopUpdate.check();
      // 成功时不改状态：由 update:* 事件驱动（checking → available → progress → downloaded）
      if (!r || r.ok !== true) {
        unavailableReason.value = r?.reason || "";
        state.value = auto ? "idle" : "error";
      }
    } catch (e) {
      state.value = auto ? "idle" : "error";
      unavailableReason.value = e?.message || "";
    }
    return;
  }

  // ------------------------- [web 兜底] -------------------------
  // 浏览器里没有 Electron 更新链路。/api/version 只能回答「有没有新版本」，
  // 不能下载、不能安装，也没有进度。所以这里只显示 available（仅提示）。
  // 注意：这条分支永远不会把 state 置成 downloading / done —— 那是谎报。
  try {
    const data = await fetchVersion();
    info.value = {
      current: data?.current,
      latest: data?.latest,
      notes: data?.notes || "",
      hasUpdate: Boolean(data?.hasUpdate)
    };
    if (!data?.hasUpdate) {
      showLatestBriefly();
      return;
    }
    state.value = "available";
  } catch {
    state.value = auto ? "idle" : "error";
  }
}

function dismiss() {
  dismissed.value = true;
}

/**
 * 「立即重启」。
 * 桌面端必须走 update.install() → 主进程 autoUpdater.quitAndInstall()：
 * 真的关掉进程、跑 NSIS 安装、装完自动拉起。绝不再是 location.reload() ——
 * 刷新网页不会安装任何东西，那正是本轮要消灭的假动作。
 */
async function applyNow() {
  if (desktopUpdate?.install) {
    installing.value = true;
    unavailableReason.value = "";
    try {
      const r = await desktopUpdate.install();
      if (r && r.ok === false) {
        installing.value = false;
        state.value = "error";
        unavailableReason.value = reasonText(r.reason);
      }
      // ok=true：主进程已经安排 quitAndInstall，几秒内进程会被安装程序接管，
      // 这里不做任何跳转（跳转反而会干扰退出流程）。
    } catch (e) {
      installing.value = false;
      state.value = "error";
      unavailableReason.value = e?.message || "";
    }
    return;
  }

  // [web 兜底] 网页版没有安装能力，只能重新加载页面。这条分支不应在桌面端被走到。
  location.reload();
}

onMounted(() => {
  // 嵌入到宿主系统时不弹更新提示（那是独立桌面端的概念，宿主有自己的发布节奏）
  if (IS_EMBEDDED) return;

  // 先订阅真实事件，再触发检查 —— 反了会漏掉最早的那几个事件
  bindDesktopEvents();

  // 手动检查：清掉「已下载」标记，重新走一遍流程
  bridge.checkUpdate = () => {
    clearDone();
    check(false);
  };

  setTimeout(async () => {
    const done = readDone();
    if (desktopUpdate) {
      // 桌面端：已下载过该版本 → 视为待安装，不再重复提示
      let st = null;
      try {
        st = desktopUpdate.state ? await desktopUpdate.state() : null;
      } catch {
        st = null;
      }
      if (done && st?.enabled === true) return;
    } else {
      // [web 兜底] 网页版用 /api/version 判断是否已提示过该版本
      const data = await fetchVersion().catch(() => null);
      if (done && data?.latest === done) return;
    }
    check(true);
  }, 2500);
});

onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer);
  unbindDesktopEvents();
  bridge.checkUpdate = null;
});

defineExpose({ check });
</script>

<template>
  <div v-if="!dismissed && state !== 'idle'" class="update-toast" :class="state">
    <div class="update-toast-head">
      <div class="update-toast-icon">
        <el-icon><Download /></el-icon>
      </div>
      <div class="update-toast-text">
        <div class="update-toast-title">
          <template v-if="state === 'checking'">正在检查更新…</template>
          <template v-else-if="state === 'unavailable'">当前无法自动更新</template>
          <template v-else-if="state === 'error'">检查更新失败</template>
          <template v-else-if="state === 'latest'">已是最新版本 v{{ info?.current }}</template>
          <template v-else-if="state === 'available'">发现新版本 v{{ info?.latest }}</template>
          <template v-else-if="state === 'done'">更新已下载 v{{ info?.latest }}</template>
          <template v-else>正在下载 v{{ info?.latest }}</template>
        </div>
        <div class="update-toast-desc">
          <template v-if="state === 'done'">重启后生效，也可以稍后手动重启。</template>
          <template v-else-if="state === 'latest'">当前 v{{ info?.current }} 已是最新。</template>
          <template v-else-if="state === 'unavailable'">
            {{ reasonText(unavailableReason) }}
          </template>
          <template v-else-if="state === 'error'">
            {{ unavailableReason || '请检查更新源后重试。' }}
          </template>
          <template v-else-if="state === 'checking'">正在获取最新版本信息。</template>
          <template v-else-if="state === 'available'">
            网页版只能提示，不会自动下载安装；请下载新版桌面安装包覆盖安装。
          </template>
          <template v-else>下载完成后可一键重启安装。</template>
        </div>
      </div>
      <button class="update-toast-close" title="关闭" @click="dismiss">
        <el-icon><Close /></el-icon>
      </button>
    </div>

    <!-- 进度条只画真实进度：desktop 的 update:progress / update:downloaded 才会进来。
         [web 兜底] 分支不会出现这个块（state 只会是 available）。 -->
    <div v-if="state === 'downloading' || state === 'done'" class="update-toast-progress">
      <div class="update-toast-bar">
        <span :style="{ width: percent + '%' }" />
      </div>
      <div class="update-toast-pct">{{ Math.round(percent) }}%</div>
    </div>

    <div v-if="state === 'downloading' && info?.notes" class="update-toast-notes">{{ info.notes }}</div>

    <div v-if="state === 'error' || state === 'unavailable'" class="update-toast-actions">
      <button class="update-toast-btn" @click="check(false)">重试</button>
    </div>

    <div v-if="state === 'available'" class="update-toast-actions">
      <button class="update-toast-btn" @click="applyNow">刷新页面</button>
    </div>

    <div v-if="state === 'done'" class="update-toast-actions">
      <button class="update-toast-btn primary" :disabled="installing" @click="applyNow">
        {{ installing ? "正在重启安装…" : "立即重启" }}
      </button>
    </div>
  </div>
</template>
