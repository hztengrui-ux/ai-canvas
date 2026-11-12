<script setup>
import { ref, computed, watch, onMounted, onErrorCaptured } from "vue";
import ErrorFallback from "./components/ErrorFallback.vue";
import AppShell from "./components/AppShell.vue";
import HomeView from "./components/HomeView.vue";
import ProjectsView from "./components/ProjectsView.vue";
import AuditView from "./components/AuditView.vue";
import TemplatesView from "./components/TemplatesView.vue";
import ReviewView from "./components/ReviewView.vue";
import StudioView from "./components/StudioView.vue";
import BatchWorkbench from "./components/BatchWorkbench.vue";
import SettingsDialog from "./components/SettingsDialog.vue";
import UpdateToast from "./components/UpdateToast.vue";
import LoginView from "./components/LoginView.vue";
import PopoutPanel from "./components/PopoutPanel.vue";
import BootSplash from "./components/BootSplash.vue";
import OnboardingTour from "./components/OnboardingTour.vue";
import AccountModals from "./components/AccountModals.vue";
import AdminConsole from "./components/admin/AdminConsole.vue";
import { store, loadServerModels } from "./store.js";
import { applyTheme, applyDark } from "./theme.js";
import { errorState, reportFatal } from "./errorboundary.js";
import { bootstrap as bootstrapProject } from "./project.js";
import { fetchSettings, fetchAuthStatus, logoutAccount, fetchMyPerms, fetchBalance, fetchCostTable, fetchBrand } from "./api.js";

const settingsOpen = ref(false);
const authed = ref(false);
const authUser = ref(null);
const tourOpen = ref(false);
const rechargeOpen = ref(false);
const usageOpen = ref(false);
const teamOpen = ref(false);
const wechatOpen = ref(false);
const adminOpen = ref(false);
const myPerms = ref([]);
const TOUR_KEY = "ai-canvas:tour-done";

// ---------- 截图/自动化预览开关（只读，不影响正常使用）----------
// `?screenshot=1`          跳过新手引导弹窗，便于无头浏览器截图与界面回归对比
// `?screenshot=1&view=xxx` 直接落到指定页面（home/studio/templates/projects/review/audit）
// 正常用户 URL 里没有这个参数，行为与之前完全一致。
//
// 2026-11-03 安全加固：打包版（import.meta.env.PROD）直接关掉这个旁路。
// 它本身无害，但属于「内部调试入口」，逆向时能当跳板直接落到任意页面 / 跳过引导，
// 白送一份产品结构图。开发态（vite dev）保持可用 —— 界面回归全靠它。
const PREVIEW_QS = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const PREVIEW_MODE = !import.meta.env.PROD && PREVIEW_QS.get("screenshot") === "1";
if (PREVIEW_MODE) {
  const target = PREVIEW_QS.get("view");
  const VALID = new Set(["home", "studio", "templates", "projects", "review", "audit", "batch"]);
  if (target && VALID.has(target)) store.route = target;
}

/**
 * 错误边界第二层：拦下子组件树的错误，就地渲染兜底页。
 * 返回 false 阻止继续上抛 —— 否则会再触发一次 app.config.errorHandler，
 * 日志里出现两条一模一样的记录，排查时很误导。
 */
onErrorCaptured((err, instance, info) => {
  reportFatal(err, info || "组件树");
  return false;
});

// 桌面端：主进程会给登录窗带上 --app-window=login
const IS_LOGIN_WINDOW = window.desktop?.windowMode === "login";

// 双屏独立窗口：属性栏「弹出独立窗口」打开的子窗口，只渲染结果大图面板
const IS_POPOUT_WINDOW = new URLSearchParams(location.search).get("window") === "popout";

// 闪屏播完 + 登录态查完，两者都完成才进入应用
const splashDone = ref(false);
const authChecked = ref(false);
const ready = computed(() => splashDone.value && authChecked.value);

// V1003.08：登录窗自己的开屏动画（1300ms，比主窗的短）
const loginSplashDone = ref(false);

/**
 * 应用品牌配置（白标）。
 * 必须在最早期调用：登录页在认证之前就要显示正确的品牌名与主色。
 */
async function applyBrand() {
  try {
    const b = await fetchBrand();
    store.brand = b;
    document.title = b.appName;
    const root = document.documentElement;
    if (b.primary) root.style.setProperty("--brand", b.primary);
    if (b.primaryDeep) root.style.setProperty("--brand-deep", b.primaryDeep);
    // 注意：不要再内联写 --primary。
    // themes.css 里每套主题都把 --primary 写成 var(--brand)，
    // 有白标时按钮跟品牌走、没有时跟主题走；内联覆盖会把三套主题的差异抹平。
  } catch {
    /* 品牌拉取失败用默认值，不影响使用 */
  }
}

// 有任一后台权限才显示「运营系统」入口（后端仍会逐接口校验）
const canAdmin = computed(() => myPerms.value.some((p) => p.startsWith("admin:")));

/** 拉取算力余额与计费表；余额是服务端账本，前端只做展示 */
async function loadCredits() {
  try {
    const [b, c] = await Promise.all([fetchBalance(), fetchCostTable()]);
    store.balance = b.balance ?? 0;
    store.costTable = c.rows || {};
  } catch {
    store.balance = 0;
  }
}

async function loadPerms() {
  try {
    const p = await fetchMyPerms();
    myPerms.value = p.perms || [];
  } catch {
    myPerms.value = [];
  }
}

// 夜间模式：走 theme.js 的 applyDark，html / body 两层一起挂（原因见 theme.js 注释）
watch(
  () => store.darkMode,
  (v) => {
    applyDark(v);
    window.dispatchEvent(
      new CustomEvent("ai-canvas:theme", { detail: { theme: store.theme, dark: !!v } })
    );
  },
  { immediate: true }
);

// 主题：data-theme 挂 <html>，切换时由 setTheme 负责，这里只兜住外部改动
watch(
  () => store.theme,
  (v) => applyTheme(v)
);

// 路由变化回传嵌入宿主
watch(
  () => store.route,
  (v) => window.dispatchEvent(new CustomEvent("ai-canvas:route", { detail: { route: v } }))
);

async function bootstrap() {
  // 品牌要在最早期应用：登录页也要显示正确的品牌名与主色
  await applyBrand();

  // 独立登录窗：不播闪屏，直接进登录页
  if (IS_LOGIN_WINDOW) splashDone.value = true;

  try {
    const status = await fetchAuthStatus();
    authed.value = Boolean(status.loggedIn);
    authUser.value = status.user || null;
    store.user = status.user || null;
  } catch {
    authed.value = false;
  } finally {
    authChecked.value = true;
  }

  if (authed.value) {
    try {
      store.settings = await fetchSettings();
    } catch {
      /* 设置读取失败不阻塞进入 */
    }
    await loadPerms();
    await loadCredits();
    // 模型目录要**登录之后**拉：/api/models 有账号时受登录保护，
    // 启动时未登录会拿到 401，若不在这里补一次，本次会话就永远用回落价格了。
    void loadServerModels();
    // 已登录但还没看过引导，同样展示一次
    if (!PREVIEW_MODE && !localStorage.getItem(TOUR_KEY)) {
      setTimeout(() => (tourOpen.value = true), 900);
    }
  }
}

function onAuthed(user) {
  authUser.value = user || null;
  store.user = user || null;
  authed.value = true;

  // 独立登录窗：登录成功就交给主进程切主窗口，本窗随即被销毁
  if (IS_LOGIN_WINDOW) {
    window.desktop?.notifyLoginSuccess?.();
    return;
  }

  fetchSettings()
    .then((s) => (store.settings = s))
    .catch(() => {});
  loadPerms();
  loadCredits();
  // 登录成功后补拉模型目录（与 bootstrap 里同一原因：受登录保护的接口不能在启动时拉）
  void loadServerModels();

  // 首次登录后自动展示新手引导
  if (!PREVIEW_MODE && !localStorage.getItem(TOUR_KEY)) {
    setTimeout(() => (tourOpen.value = true), 700);
  }
}

function closeTour() {
  tourOpen.value = false;
  try {
    localStorage.setItem(TOUR_KEY, "1");
  } catch {
    /* 忽略 */
  }
}

async function onLogout() {
  try {
    await logoutAccount();
  } catch {
    /* 忽略 */
  }
  authed.value = false;
  authUser.value = null;
  store.user = null;
  store.route = "home";

  // 桌面端：回到独立登录窗
  window.desktop?.notifyLogout?.();
}

onMounted(() => {
  // 先把上次没关掉的画布读出来，StudioView 挂载后自己恢复（E7）
  const restored = bootstrapProject();
  if (restored.hasSaved) store.pendingRestore = restored.graph;
  return bootstrap();
});
</script>

<template>
  <!-- 致命错误：整棵树换成兜底页，不留白屏 -->
  <ErrorFallback v-if="errorState.fatal" />

  <!-- 双屏独立窗口：跳过闪屏与外壳，直接渲染结果面板 -->
  <PopoutPanel v-else-if="IS_POPOUT_WINDOW" />

  <!-- 桌面端独立登录窗：先放一遍启动动画（原来登录窗是"裸进"的，
       对比 AI Change 少了开屏仪式感），再渲染登录页 -->
  <template v-else-if="IS_LOGIN_WINDOW">
    <BootSplash v-if="!loginSplashDone" :duration="1300" @done="loginSplashDone = true" />
    <LoginView v-else class="login-standalone" @authed="onAuthed" />
  </template>

  <template v-else>
    <BootSplash v-if="!ready" @done="splashDone = true" />

    <LoginView v-else-if="!authed" @authed="onAuthed" />

    <template v-else>
      <AppShell
        v-model:settings-open="settingsOpen"
        :user="authUser"
        :perms="myPerms"
        @logout="onLogout"
        @open-tour="tourOpen = true"
        @open-recharge="rechargeOpen = true"
        @open-usage="usageOpen = true"
        @open-team="teamOpen = true"
        @open-wechat="wechatOpen = true"
        @open-admin="adminOpen = true"
      >
        <AuditView v-if="store.route === 'audit'" />
        <TemplatesView v-else-if="store.route === 'templates'" />
        <ProjectsView v-else-if="store.route === 'projects'" />
        <ReviewView v-else-if="store.route === 'review'" />
        <HomeView v-else-if="store.route === 'home'" />
        <BatchWorkbench v-else-if="store.route === 'batch'" />
        <StudioView
          v-else
          @open-settings="settingsOpen = true"
          @open-recharge="rechargeOpen = true"
          @open-account="adminOpen = true"
        />
        <SettingsDialog v-model="settingsOpen" />
      </AppShell>
      <UpdateToast />
      <OnboardingTour :open="tourOpen" @close="closeTour" />
      <AccountModals
        v-model:recharge="rechargeOpen"
        v-model:usage="usageOpen"
        v-model:team="teamOpen"
        v-model:wechat="wechatOpen"
      />
      <AdminConsole v-if="adminOpen" :user="authUser" @close="adminOpen = false" />

      <!-- 非致命错误（接口失败 / 异步拒绝）：轻提示，不掀桌，手上的活不丢 -->
      <transition name="soft-err">
        <div v-if="errorState.softMessage" class="soft-error-toast">
          <span class="set-dot" />
          <span>{{ errorState.softMessage }}</span>
        </div>
      </transition>
    </template>
  </template>
</template>
