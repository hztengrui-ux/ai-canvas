<script setup>
import { computed, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { store, SKILLS, launchSkill } from "../store.js";
import { taskStats } from "../tasklist.js";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import AppRail from "./AppRail.vue";
import WindowControls from "./WindowControls.vue";

// ---------- 桌面端（Electron）窗口控制 ----------
// 按钮本身抽成了 WindowControls（创作台顶栏也要用），
// 这里只保留「双击顶栏最大化」的桌面端判断。
const desktop = window.desktop;
const isDesktop = Boolean(desktop?.isDesktop);

/**
 * 双击顶栏空白处切换最大化 —— Windows 标题栏的通用习惯，
 * 比精准点中 32px 的按钮省事得多。
 * 点在按钮 / 输入框 / 链接上时跳过，避免误触。
 */
function onTopbarDblClick(e) {
  if (!isDesktop) return;
  if (e.target.closest("button, input, textarea, select, a, .el-input, .el-popover")) return;
  desktop.toggleMaximize?.();
}

const props = defineProps({
  settingsOpen: Boolean,
  user: { type: Object, default: null },
  perms: { type: Array, default: () => [] }
});
const emit = defineEmits([
  "update:settingsOpen",
  "logout",
  "open-tour",
  "open-recharge",
  "open-wechat",
  "open-usage",
  "open-team",
  "open-admin"
]);

// 顶栏「进行中」用的统计：口径和任务面板一致（running / done / error / total）
const liveStats = computed(() => taskStats(store.tasks || []));
// 通知红点：有任务在跑、或有失败没处理，才提示
const hasNotice = computed(() => liveStats.value.running > 0 || liveStats.value.error > 0);
const notices = computed(() => {
  const rows = (store.tasks || []).slice(-6).reverse();
  if (!rows.length) return [];
  return rows.map((x) => ({
    id: x.id,
    title: x.title || x.prompt || x.kind || "生成任务",
    status: x.status || "running"
  }));
});
// 任务面板在 StudioView 的 TaskBar 里，点「进行中」直接回工作台
function openTasks() {
  store.route = "studio";
}

// 左侧图标栏底部的「帮助」：和账号菜单里的「新手指引」是同一个入口，不另开一套
function openHelp() {
  emit("open-tour");
}

// 有后台权限才露出「运营系统」
const canAdmin = computed(() => props.perms.some((p) => p.startsWith("admin:")));

// 顶栏搜索：V1003.06 起输入框已从顶栏移除（用户要求去掉搜索栏），
// 搜索改由「模板库」页面承接。searchKeyword 的写入逻辑保留备用。
const searchText = ref("");
function runSearch() {
  const kw = searchText.value.trim();
  store.searchKeyword = kw;
  store.route = "templates";
}

const runningCount = computed(() => store.history.filter((h) => h.status === "running").length);
const doneCount = computed(() => store.history.filter((h) => h.status === "done").length);
const errorCount = computed(() => store.history.filter((h) => h.status === "error").length);

const userName = computed(() => props.user?.username || "操作员");
const userInitial = computed(() => (userName.value[0] || "U").toUpperCase());
const userRole = computed(() => (props.user?.role === "admin" ? "管理员" : "成员"));

const mainMenu = [
  { key: "home", label: "工作台", icon: "Menu", route: "home" },
  { key: "projects", label: "我的项目", icon: "Folder", route: "projects" }
  // V1003.06：移除「AI 创作台」菜单项 —— 它和「工作台」是同一个入口
  //（工作台点「新建创作」即进 studio），两个并列只会让人犹豫。
  // 创作台本身没动，进节点画布的路径也没变。
];

const assetMenu = [
  { key: "templates", label: "模板库", icon: "Grid", route: "templates" },
  // 之前「作品库」指向 projects —— 那里只是个项目名过滤器，不是作品库（D4）
  { key: "works", label: "作品库", icon: "FolderOpened", route: "review" }
];

/**
 * 顶栏主导航（2026-10-16 改版）。
 *
 * 之前导航在**左侧一条深色侧栏**里，页面被挤到右边、深色块压在浅色内容旁边，
 * 用户反馈"顶部与首页布局超级难看"。参考稿的做法是把导航做成顶栏的**分段胶囊**：
 * 页面拿到整幅宽度，导航一眼扫完，也不再有"两套视觉体系打架"。
 * 只把最常用的四项留在顶栏，技能（15 个）与系统项收进下拉，避免顶栏被撑爆。
 */
const navItems = [
  { key: "home", label: "工作台", icon: "Menu", route: "home" },
  { key: "templates", label: "模板库", icon: "Grid", route: "templates" },
  // 全自动批量：一个文件夹 → 每张图跑同一条流水线。
  // 放在「模板库」之后、「我的项目」之前：它是"拿模板批量产出"的下一步动作，
  // 不是又一个项目管理入口。
  { key: "batch", label: "全自动批量", icon: "Files", route: "batch" },
  { key: "projects", label: "我的项目", icon: "Folder", route: "projects" },
  { key: "works", label: "作品库", icon: "FolderOpened", route: "review" }
];

const systemMenu = [
  { key: "audit", label: "安全记录", icon: "Lock", route: "audit" },
  { key: "settings", label: "设置", icon: "Setting" },
  { key: "help", label: "帮助", icon: "QuestionFilled" }
];

function go(item) {
  if (item.key === "settings") {
    emit("update:settingsOpen", true);
    return;
  }
  if (item.key === "help") {
    store.route = "home";
    return;
  }
  if (item.route) {
    store.route = item.route;
  }
}

/**
 * 技能入口点击：能对上工作流的会真铺出节点图；
 * 尚未接入的技能**必须给出反馈**（原因 + 现在能走的替代做法）。
 *
 * ⚠️ 2026-10-18 修「点了没反应」：
 *   根因是下拉项上加了 :disabled —— 禁用状态下浏览器根本不派发 click，
 *   于是 onSkillClick 永远不执行，用户只看到一个灰标签"待接入"，
 *   既不知道原因，也不知道下一步能干什么。
 *   现在不再禁用，改成可点击 + 明确弹窗（原因 + 替代做法）。
 */
function onSkillClick(skill) {
  const r = launchSkill(skill.id);
  if (r.ok) return;

  if (r.unavailable) {
    const lines = [r.reason || "该技能尚未接入"];
    if (r.alternative) lines.push(`现在可以这样做：${r.alternative}`);
    ElMessageBox.alert(lines.join("\n\n"), `${skill.label} · 即将上线`, {
      confirmButtonText: "知道了",
      type: "info",
      customClass: "skill-coming-dialog"
    }).catch(() => {
      /* 用户点遮罩关掉，不需要处理 */
    });
    return;
  }

  ElMessage.info(`${skill.label}：${r.reason || "暂时不可用"}`);
}

function createNew() {
  onSkillClick(SKILLS.find((s) => s.id === "txt2img") || SKILLS[0]);
}
</script>

<template>
  <div class="app-shell">
    <!-- 左侧图标导航（2026-10-31 布局改版：导航从顶栏搬到这里，顶栏只留工具与账号） -->
    <AppRail @open-help="openHelp" />

    <header
      v-if="store.route !== 'studio'"
      class="topbar"
      @dblclick="onTopbarDblClick"
    >
      <div class="topbar-left">
        <!-- 2026-10-31 布局改版：品牌 logo 已移到左侧图标栏顶部，
             顶栏左边只留「技能 / 更多」这类工具入口，不再重复放一个 logo。 -->
      </div>

      <!-- 主导航：分段胶囊（参考稿的导航语言）。当前项用反色药丸，明暗主题自动跟随 -->
      <nav class="topnav" aria-label="主导航">
        <button
          v-for="item in navItems"
          :key="item.key"
          class="topnav-item"
          :class="{ on: store.route === item.route }"
          @click="go(item)"
        >
          {{ item.label }}
        </button>

        <!-- 技能 15 个，放不下 → 下拉；能对上工作流的点了会真铺画布 -->
        <el-dropdown trigger="click" placement="bottom-start" popper-class="topnav-pop">
          <button class="topnav-item topnav-more">
            技能
            <el-icon><ArrowDown /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="skill in SKILLS"
                :key="skill.id"
                :class="['skill-entry', skill.available === false ? 'is-coming' : '']"
                :title="skill.available === false ? (skill.reason || '即将上线') : skill.desc"
                @click="onSkillClick(skill)"
              >
                {{ skill.label }}
                <span v-if="skill.available === false" class="topnav-hint">即将上线</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <el-dropdown trigger="click" placement="bottom-start" popper-class="topnav-pop">
          <button class="topnav-item topnav-more">
            更多
            <el-icon><ArrowDown /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="item in systemMenu" :key="item.key" @click="go(item)">
                {{ item.label }}
              </el-dropdown-item>
              <el-dropdown-item v-if="canAdmin" divided @click="emit('open-admin')">运营系统</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </nav>

      <div class="topbar-right">
        <!-- ① 进行中：跑着的任务数（口径与任务面板一致），点它回工作台看进度 -->
        <button class="run-pill" :class="{ busy: liveStats.running > 0 }" title="进行中的生成任务" @click="openTasks">
          <i class="run-dot" />
          <span class="run-label">进行中</span>
          <b class="run-count">{{ liveStats.running }}/{{ liveStats.total }}</b>
        </button>

        <!-- ② 算力：标签 + 数字，充值单独一个按钮（原来挤在同一个胶囊里） -->
        <button class="credit-inline" title="算力余额，点开充值" @click="emit('open-recharge')">
          <span class="credit-label">算力</span>
          <b class="credit-num">{{ store.balance ?? 0 }}</b>
        </button>

        <!-- ③ 限时折扣：营销位，点开充值面板 -->
        <button class="promo-pill" title="限时折扣 · 充值有优惠" @click="emit('open-recharge')">
          <el-icon><Discount /></el-icon>
          <span>限时折扣</span>
        </button>

        <!-- ④ 通知：有在跑 / 有失败才亮红点 -->
        <el-popover placement="bottom-end" :width="264" trigger="click" popper-class="notice-popover">
          <template #reference>
            <button class="btn-icon-light bell-btn" :class="{ dot: hasNotice }" title="通知">
              <el-icon><Bell /></el-icon>
            </button>
          </template>
          <div class="notice-card">
            <div class="notice-head">
              <b>通知</b>
              <span>{{ notices.length ? notices.length + " 条" : "暂无新消息" }}</span>
            </div>
            <div v-if="!notices.length" class="notice-empty">生图任务跑起来后，进度会显示在这里</div>
            <button v-for="n in notices" :key="n.id" class="notice-row" @click="openTasks">
              <i class="notice-dot" :class="n.status" />
              <span class="notice-title">{{ n.title }}</span>
              <span class="notice-status">
                {{ n.status === "running" ? "进行中" : n.status === "error" ? "失败" : "已完成" }}
              </span>
            </button>
          </div>
        </el-popover>

        <!-- 主题切换器：三套视觉方案 + 明暗（原来这里只有一个夜间模式按钮） -->
        <ThemeSwitcher />
        <!-- 已拆分到上面的「算力 + 限时折扣」，旧胶囊不再渲染 -->
        <button class="btn-icon-light" title="设置" @click="emit('update:settingsOpen', true)">
          <el-icon><Setting /></el-icon>
        </button>
        <button class="btn-primary" @click="createNew">
          <el-icon><Plus /></el-icon>
          <span>新建创作</span>
        </button>

        <el-popover placement="bottom-end" :width="252" trigger="click" popper-class="account-popover">
          <template #reference>
            <button class="account-trigger" :title="userName">
              <el-icon><UserFilled /></el-icon>
            </button>
          </template>

          <div class="account-menu">
            <div class="account-head">
              <div class="account-head-label">已登录账号</div>
              <div class="account-head-name">{{ userName }}</div>
              <div class="account-head-role">{{ userRole }}</div>
            </div>

            <div class="account-row account-balance">
              <span>算力余额</span>
              <div class="account-balance-right">
                <span class="account-balance-num">
                  <el-icon><Lightning /></el-icon>
                  {{ store.balance ?? 0 }}
                </span>
                <button class="account-recharge" @click="emit('open-recharge')">充值</button>
              </div>
            </div>

            <div class="account-list">
              <button
                v-if="canAdmin"
                class="account-item accent"
                @click="emit('open-admin')"
              >
                <span>运营系统</span>
                <el-icon><Setting /></el-icon>
              </button>
              <button class="account-item" @click="emit('open-wechat')">
                <span>连接微信</span>
                <el-icon><ArrowRight /></el-icon>
              </button>
              <button class="account-item" @click="emit('open-usage')">
                <span>使用详情</span>
                <el-icon><ArrowRight /></el-icon>
              </button>
              <button class="account-item" @click="emit('open-team')">
                <span>团队管理</span>
                <el-icon><ArrowRight /></el-icon>
              </button>
              <button class="account-item" @click="emit('open-tour')">
                <span>新手指引</span>
                <el-icon><ArrowRight /></el-icon>
              </button>
              <button class="account-item" @click="go({ key: 'audit', route: 'audit' })">
                <span>安全记录</span>
                <el-icon><ArrowRight /></el-icon>
              </button>
              <button class="account-item" @click="store.route = 'projects'">
                <span>我的项目</span>
                <el-icon><ArrowRight /></el-icon>
              </button>
              <button class="account-item danger" @click="emit('logout')">
                <span>退出登录</span>
                <el-icon><SwitchButton /></el-icon>
              </button>
            </div>
          </div>
        </el-popover>

        <WindowControls />
      </div>
    </header>

    <div v-if="store.route !== 'studio'" class="app-body">
      <!-- 2026-10-16 改版：深色侧栏整块移除。
           导航已全部搬到顶栏（分段胶囊 + 技能/更多下拉），
           页面因此拿到整幅宽度 —— 参考稿就是这么做的，也解决了
           "深色侧栏压在浅色内容旁边、两套视觉体系打架"的问题。
           侧栏原来的每一项都在顶栏有对应入口，没有功能被删掉。 -->
      <main class="app-main">
        <slot />
      </main>
    </div>
    <main v-else class="app-main fullscreen">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.pill-light {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-3);
  font-size: 12px;
}
.pill-light b {
  color: var(--text);
  font-weight: 700;
}
</style>
