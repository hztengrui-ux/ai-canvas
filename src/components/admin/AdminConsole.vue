<script setup>
// 运营系统 · 总后台外壳
// 控制面与数据面分离：这里只管控人、管规则、管审计，不碰创作素材
import { ref, computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { fetchMyPerms, fetchAdminOverview } from "../../api.js";
import AdminAccounts from "./AdminAccounts.vue";
import AdminRoles from "./AdminRoles.vue";
import AdminDepts from "./AdminDepts.vue";
import AdminLogs from "./AdminLogs.vue";
import AdminKeys from "./AdminKeys.vue";
import AdminCustomers from "./AdminCustomers.vue";
import AdminRecharge from "./AdminRecharge.vue";
import AdminPayment from "./AdminPayment.vue";

const props = defineProps({ user: { type: Object, default: null } });
const emit = defineEmits(["close"]);

const loading = ref(true);
const perms = ref([]);
const overview = ref(null);
const page = ref("overview");

const NAV = [
  { key: "overview", label: "运营看板", icon: "DataLine", perm: "admin:dashboard:view" },
  { key: "customers", label: "客户中心", icon: "User", perm: "admin:customer:view" },
  { key: "recharge", label: "充值中心", icon: "Money", perm: "admin:recharge:view" },
  { key: "payments", label: "支付通道", icon: "CreditCard", perm: "admin:payment:view" },
  { key: "accounts", label: "账号管理", icon: "UserFilled", perm: "admin:account:view" },
  { key: "roles", label: "角色权限", icon: "Lock", perm: "admin:role:view" },
  { key: "depts", label: "组织架构", icon: "Share", perm: "admin:dept:view" },
  { key: "logs", label: "日志审计", icon: "Document", perm: "admin:log:view" },
  { key: "keys", label: "客户端密钥", icon: "Key", perm: "admin:apikey:view" }
];

// 没有权限的入口直接不渲染（后端仍然会拦）
const navItems = computed(() =>
  NAV.filter((n) => perms.value.includes(n.perm) || perms.value.length === 0)
);

const can = (code) => perms.value.includes(code);

async function loadOverview() {
  try {
    overview.value = await fetchAdminOverview();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

async function boot() {
  loading.value = true;
  try {
    const p = await fetchMyPerms();
    perms.value = p.perms || [];
    if (perms.value.length && !perms.value.includes("admin:dashboard:view")) {
      page.value = navItems.value[0]?.key || "overview";
    }
    await loadOverview();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

onMounted(boot);
</script>

<template>
  <div class="ad">
    <!-- 左侧运营菜单 -->
    <aside class="ad-side">
      <div class="ad-brand">
        <img src="/brand/logo-mark.png" alt="跨多多科技" />
        <div>
          <strong>运营系统</strong>
          <small>总后台管理</small>
        </div>
      </div>

      <nav class="ad-nav">
        <button
          v-for="n in navItems"
          :key="n.key"
          class="ad-nav-item"
          :class="{ on: page === n.key }"
          @click="page = n.key"
        >
          <el-icon><component :is="n.icon" /></el-icon>
          <span>{{ n.label }}</span>
        </button>
      </nav>

      <button class="ad-back" @click="emit('close')">
        <el-icon><Back /></el-icon>
        <span>返回创作台</span>
      </button>
    </aside>

    <!-- 主区 -->
    <div class="ad-main">
      <header class="ad-top">
        <h1 class="ad-title">
          {{ NAV.find((n) => n.key === page)?.label }}
        </h1>
        <div class="ad-top-right">
          <span class="ad-env">云端唯一可信 · 控制面</span>
          <span class="ad-user">{{ props.user?.nickname || props.user?.username || "admin" }}</span>
        </div>
      </header>

      <div class="ad-body">
        <div v-if="loading" class="ad-loading">加载中…</div>

        <!-- 运营看板 -->
        <template v-else-if="page === 'overview'">
          <div class="ad-stats">
            <div class="ad-stat">
              <span class="ad-stat-label">账号总数</span>
              <span class="ad-stat-num">{{ overview?.accounts?.total ?? 0 }}</span>
              <span class="ad-stat-sub">
                启用 {{ overview?.accounts?.active ?? 0 }} · 停用
                {{ overview?.accounts?.disabled ?? 0 }}
              </span>
            </div>
            <div class="ad-stat">
              <span class="ad-stat-label">在线账号</span>
              <span class="ad-stat-num">{{ overview?.accounts?.online ?? 0 }}</span>
              <span class="ad-stat-sub">持有有效会话</span>
            </div>
            <div class="ad-stat">
              <span class="ad-stat-label">角色 / 部门</span>
              <span class="ad-stat-num">{{ overview?.roles ?? 0 }} / {{ overview?.depts ?? 0 }}</span>
              <span class="ad-stat-sub">权限码 {{ perms.length }} 项</span>
            </div>
            <div class="ad-stat">
              <span class="ad-stat-label">近 7 天事件</span>
              <span class="ad-stat-num">{{ overview?.audit?.total ?? 0 }}</span>
              <span class="ad-stat-sub">
                风险 {{ overview?.audit?.byLevel?.danger ?? 0 }} · 注意
                {{ overview?.audit?.byLevel?.warn ?? 0 }}
              </span>
            </div>
          </div>

          <section class="ad-card">
            <div class="ad-card-head">
              <h2>最近动态</h2>
              <button class="ad-link" @click="page = 'logs'">查看全部 →</button>
            </div>
            <div class="ad-feed">
              <div
                v-for="(e, i) in overview?.recent || []"
                :key="i"
                class="ad-feed-row"
                :class="e.level"
              >
                <span class="ad-dot" />
                <span class="ad-feed-label">{{ e.label }}</span>
                <span class="ad-feed-user">{{ e.user }}</span>
                <span class="ad-feed-time">{{ fmtTime(e.ts) }}</span>
              </div>
              <div v-if="!overview?.recent?.length" class="ad-empty">暂无动态</div>
            </div>
          </section>
        </template>

        <AdminCustomers v-else-if="page === 'customers'" :perms="perms" />
        <AdminRecharge v-else-if="page === 'recharge'" :perms="perms" />
        <AdminPayment v-else-if="page === 'payments'" :perms="perms" />
        <AdminAccounts v-else-if="page === 'accounts'" :perms="perms" />
        <AdminRoles v-else-if="page === 'roles'" :perms="perms" />
        <AdminDepts v-else-if="page === 'depts'" :perms="perms" />
        <AdminLogs v-else-if="page === 'logs'" />
        <AdminKeys v-else-if="page === 'keys'" :perms="perms" />
      </div>
    </div>
  </div>
</template>
