<script setup>
// 充值中心：数据概览 / 充值订单 / 套餐配置 / 自动化任务
// 接口依据：reports/ops-backend-2026-11-05/接口契约.md 第 2 节
import { ref, reactive, computed, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  fetchRechargeOrders, fetchRechargeStats, fetchRechargePlans, saveRechargePlans,
  fetchAutomation, saveAutomation, runAutomation,
  manualPaidOrder, syncOrder, refundOrder, noteOrder
} from "../../api.js";

const props = defineProps({ perms: { type: Array, default: () => [] } });
const can = (c) => props.perms.includes(c);
const canView = computed(() => can("admin:recharge:view"));
const canManage = computed(() => can("admin:recharge:manage"));

const STATUS = {
  pending: { label: "待支付", cls: "warn" },
  paid: { label: "已支付", cls: "active" },
  cancelled: { label: "已取消", cls: "disabled" },
  expired: { label: "已过期", cls: "disabled" },
  refunded: { label: "已退款", cls: "danger" }
};
const CHANNEL = {
  wechat: "微信支付",
  alipay: "支付宝",
  aggregator: "聚合支付",
  manual: "人工补单",
  sandbox: "沙箱",
  "": "未知渠道"
};

function statusMeta(s) {
  return STATUS[s] || { label: s || "-", cls: "" };
}
function channelLabel(c) {
  return CHANNEL[c] ?? c ?? "-";
}
function toDate(v) {
  if (v == null || v === "") return null;
  const d = new Date(typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtTime(v) {
  const d = toDate(v);
  if (!d) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDate(v) {
  const d = toDate(v);
  if (!d) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtMoney(v) {
  return `¥${Number(v || 0).toFixed(2)}`;
}
function fmtNum(v) {
  return Number(v || 0).toLocaleString("zh-CN");
}

// ---------- 数据概览 ----------
const statsLoading = ref(false);
const statsError = ref("");
const stats = ref(null);
const statDays = ref(30);

const trend = computed(() => stats.value?.trend || []);
const trendMax = computed(() =>
  Math.max(1, ...trend.value.map((t) => Number(t.amount || 0)))
);
const byChannel = computed(() => stats.value?.byChannel || []);
const channelMax = computed(() =>
  Math.max(1, ...byChannel.value.map((c) => Number(c.amount || 0)))
);
const byStatus = computed(() => stats.value?.byStatus || []);
const pendingCount = computed(() => {
  const hit = byStatus.value.find((s) => s.status === "pending");
  return hit ? Number(hit.count || 0) : 0;
});
const statusTotal = computed(() =>
  byStatus.value.reduce((s, x) => s + Number(x.count || 0), 0) || 1
);
const topCustomers = computed(() => stats.value?.topCustomers || []);

function barHeight(amount, max) {
  const v = Number(amount || 0);
  if (v <= 0) return "2%";
  return `${Math.max(3, Math.round((v / max) * 100))}%`;
}
function trendLabel(i) {
  const t = trend.value[i];
  if (!t) return "";
  // 30 天时每 5 天标一次，7 天全标
  const step = trend.value.length > 14 ? 5 : 1;
  if (i % step !== 0 && i !== trend.value.length - 1) return "";
  return fmtDate(t.date);
}

async function loadStats() {
  if (!canView.value) return;
  statsLoading.value = true;
  statsError.value = "";
  try {
    stats.value = await fetchRechargeStats(statDays.value);
  } catch (err) {
    statsError.value = err.message || "充值统计加载失败";
  } finally {
    statsLoading.value = false;
  }
}
function changeDays() {
  loadStats();
}

// ---------- 订单列表 ----------
const loading = ref(false);
const ordersError = ref("");
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const summary = ref(null);

const filters = reactive({ status: "", keyword: "", userId: "", from: "", to: "" });

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

async function loadOrders() {
  if (!canView.value) return;
  loading.value = true;
  ordersError.value = "";
  try {
    const r = await fetchRechargeOrders({
      status: filters.status,
      keyword: filters.keyword.trim(),
      userId: filters.userId.trim(),
      from: filters.from,
      to: filters.to,
      page: page.value,
      pageSize: pageSize.value
    });
    rows.value = r.rows || [];
    total.value = r.total || 0;
    summary.value = r.summary || null;
  } catch (err) {
    rows.value = [];
    total.value = 0;
    summary.value = null;
    ordersError.value = err.message || "充值订单加载失败";
    ElMessage.error(ordersError.value);
  } finally {
    loading.value = false;
  }
}

function applyFilter() {
  page.value = 1;
  loadOrders();
}
function resetFilter() {
  Object.assign(filters, { status: "", keyword: "", userId: "", from: "", to: "" });
  page.value = 1;
  loadOrders();
}
function prevPage() {
  if (page.value > 1) {
    page.value -= 1;
    loadOrders();
  }
}
function nextPage() {
  if (page.value < pageCount.value) {
    page.value += 1;
    loadOrders();
  }
}
function changePageSize() {
  page.value = 1;
  loadOrders();
}
function refreshAll() {
  loadStats();
  loadOrders();
}

// ---------- 订单操作 ----------
const actionOpen = ref(false);
const actionType = ref("manual"); // manual | refund | note
const actionRow = ref(null);
const actionText = ref("");
const actionBusy = ref(false);
const syncBusyId = ref("");

const ACTION_META = {
  manual: {
    title: "人工补单",
    tip: "将订单标记为已支付，并按套餐发放算力（写入余额与流水）。仅用于已确认收款但回调丢失的情况。",
    label: "补单原因",
    placeholder: "例如：财务确认微信收款，回调丢失"
  },
  refund: {
    title: "订单退款",
    tip: "将为该订单发起退款并扣回已发放算力；若余额不足，后端会拒绝。",
    label: "退款原因",
    placeholder: "例如：客户申请退款，已确认"
  },
  note: {
    title: "添加备注",
    tip: "备注会追加到订单备注记录，不影响订单状态与余额。",
    label: "备注内容",
    placeholder: "例如：客户已电话确认到账"
  }
};
const actionMeta = computed(() => ACTION_META[actionType.value]);

function openAction(type, row) {
  if (!canManage.value) return;
  actionType.value = type;
  actionRow.value = row;
  actionText.value = "";
  actionOpen.value = true;
}

async function submitAction() {
  const text = actionText.value.trim();
  if (!text) return ElMessage.warning(`请填写${actionMeta.value.label}`);
  const id = actionRow.value?.id;
  if (!id) return;
  actionBusy.value = true;
  try {
    if (actionType.value === "manual") {
      const r = await manualPaidOrder(id, text);
      ElMessage.success(r?.already ? "该订单已是已支付状态（幂等，无重复发放）" : "补单成功，算力已发放");
    } else if (actionType.value === "refund") {
      const r = await refundOrder(id, text);
      ElMessage.success(r?.deducted != null ? `退款成功，已扣回算力 ${fmtNum(r.deducted)}` : "退款成功");
    } else {
      await noteOrder(id, text);
      ElMessage.success("备注已添加");
    }
    actionOpen.value = false;
    refreshAll();
  } catch (err) {
    ElMessage.error(err.message || "操作失败");
  } finally {
    actionBusy.value = false;
  }
}

async function doSync(row) {
  if (!canManage.value) return;
  syncBusyId.value = row.id;
  try {
    const r = await syncOrder(row.id);
    if (r?.paid) {
      ElMessage.success("同步成功：已确认支付并发放算力");
    } else {
      ElMessage.info(r?.reason ? `未支付：${r.reason}` : "同步完成，订单仍未支付");
    }
    refreshAll();
  } catch (err) {
    ElMessage.error(err.message || "同步失败");
  } finally {
    syncBusyId.value = "";
  }
}

// 订单详情
const detailOpen = ref(false);
const detailRow = ref(null);
function openDetail(row) {
  detailRow.value = row;
  detailOpen.value = true;
}
function orderNotes(row) {
  const n = row?.notes;
  if (!n) return [];
  if (Array.isArray(n)) return n;
  if (typeof n === "string") {
    try {
      const parsed = JSON.parse(n);
      return Array.isArray(parsed) ? parsed : [{ note: n }];
    } catch {
      return [{ note: n }];
    }
  }
  return [];
}

// ---------- 套餐配置 ----------
const plansOpen = ref(false);
const plansLoading = ref(false);
const plansSaving = ref(false);
const plansError = ref("");
const plans = ref([]);

async function openPlans() {
  if (!canManage.value) return;
  plansOpen.value = true;
  plansLoading.value = true;
  plansError.value = "";
  try {
    const r = await fetchRechargePlans();
    plans.value = (r.rows || []).map((p) => ({
      id: p.id,
      label: p.label || p.id,
      credits: Number(p.credits || 0),
      bonus: Number(p.bonus || 0),
      price: Number(p.price || 0),
      hot: !!p.hot,
      perUnit: p.perUnit != null ? p.perUnit : null
    }));
  } catch (err) {
    plansError.value = err.message || "套餐加载失败";
    plans.value = [];
  } finally {
    plansLoading.value = false;
  }
}

function planTotal(p) {
  return Number(p.credits || 0) + Number(p.bonus || 0);
}

async function savePlans() {
  if (!plans.value.length) return ElMessage.warning("没有可保存的套餐");
  for (const p of plans.value) {
    if (!Number.isInteger(Number(p.credits)) || Number(p.credits) <= 0) {
      return ElMessage.warning(`套餐「${p.label}」的算力必须为正整数`);
    }
    if (!Number.isInteger(Number(p.bonus)) || Number(p.bonus) < 0) {
      return ElMessage.warning(`套餐「${p.label}」的赠送算力必须为非负整数`);
    }
    if (!(Number(p.price) > 0)) {
      return ElMessage.warning(`套餐「${p.label}」的价格必须大于 0`);
    }
  }
  plansSaving.value = true;
  try {
    const payload = plans.value.map((p) => ({
      id: p.id,
      label: String(p.label || "").trim() || p.id,
      credits: Number(p.credits),
      bonus: Number(p.bonus),
      price: Number(p.price),
      hot: !!p.hot
    }));
    const r = await saveRechargePlans(payload);
    plans.value = (r.rows || payload).map((p) => ({
      id: p.id,
      label: p.label || p.id,
      credits: Number(p.credits || 0),
      bonus: Number(p.bonus || 0),
      price: Number(p.price || 0),
      hot: !!p.hot,
      perUnit: p.perUnit != null ? p.perUnit : null
    }));
    ElMessage.success("套餐已保存");
    plansOpen.value = false;
  } catch (err) {
    ElMessage.error(err.message || "套餐保存失败");
  } finally {
    plansSaving.value = false;
  }
}

// ---------- 自动化任务 ----------
const autoOpen = ref(false);
const autoLoading = ref(false);
const autoSaving = ref(false);
const autoRunning = ref(false);
const autoError = ref("");
const automation = ref(null);
const autoForm = reactive({ enabled: false, expireMinutes: 30, syncAfterSec: 60, syncBatch: 20 });

async function openAuto() {
  if (!canManage.value) return;
  autoOpen.value = true;
  autoLoading.value = true;
  autoError.value = "";
  try {
    const r = await fetchAutomation();
    automation.value = r;
    applyAutoConfig(r.config || {});
  } catch (err) {
    autoError.value = err.message || "自动化配置加载失败";
    automation.value = null;
  } finally {
    autoLoading.value = false;
  }
}

function applyAutoConfig(c) {
  autoForm.enabled = !!c.enabled;
  if (c.expireMinutes != null) autoForm.expireMinutes = Number(c.expireMinutes);
  if (c.syncAfterSec != null) autoForm.syncAfterSec = Number(c.syncAfterSec);
  if (c.syncBatch != null) autoForm.syncBatch = Number(c.syncBatch);
}

function validateAuto() {
  const e = Number(autoForm.expireMinutes);
  const s = Number(autoForm.syncAfterSec);
  const b = Number(autoForm.syncBatch);
  if (!Number.isInteger(e) || e < 5 || e > 1440) return "过期时长需为 5~1440 分钟的整数";
  if (!Number.isInteger(s) || s < 30 || s > 3600) return "同步间隔需为 30~3600 秒的整数";
  if (!Number.isInteger(b) || b < 1 || b > 100) return "同步批量需为 1~100 的整数";
  return "";
}

async function saveAuto() {
  const msg = validateAuto();
  if (msg) return ElMessage.warning(msg);
  autoSaving.value = true;
  try {
    const r = await saveAutomation({
      enabled: !!autoForm.enabled,
      expireMinutes: Number(autoForm.expireMinutes),
      syncAfterSec: Number(autoForm.syncAfterSec),
      syncBatch: Number(autoForm.syncBatch)
    });
    ElMessage.success("自动化配置已保存");
    if (r?.config) {
      automation.value = { ...(automation.value || {}), config: r.config };
      applyAutoConfig(r.config);
    }
  } catch (err) {
    ElMessage.error(err.message || "配置保存失败");
  } finally {
    autoSaving.value = false;
  }
}

async function runAutoNow() {
  autoRunning.value = true;
  try {
    const r = await runAutomation();
    const rep = r?.report || {};
    automation.value = { ...(automation.value || {}), lastReport: rep };
    ElMessage.success(
      `执行完成：过期 ${rep.expired ?? 0} 单，同步 ${rep.synced ?? 0} 单，补单 ${rep.paid ?? 0} 单，错误 ${rep.errors ?? 0} 条`
    );
    refreshAll();
  } catch (err) {
    ElMessage.error(err.message || "执行失败");
  } finally {
    autoRunning.value = false;
  }
}

async function confirmRunAuto() {
  try {
    await ElMessageBox.confirm(
      "将立即执行一次过期处理与回调同步任务，可能影响部分待支付订单，确定继续？",
      "立即执行一次",
      { type: "warning", confirmButtonText: "执行", cancelButtonText: "取消" }
    );
    runAutoNow();
  } catch {
    /* 取消 */
  }
}

onMounted(() => {
  if (!canView.value) return;
  loadStats();
  loadOrders();
});
</script>

<template>
  <div class="ac-page">
    <div v-if="!canView" class="ad-empty">
      无权限查看充值中心（需要 <code>admin:recharge:view</code>），请联系管理员分配权限。
    </div>

    <template v-else>
      <!-- ================= 数据概览 ================= -->
      <div class="rc-head">
        <h3>充值概览</h3>
        <div class="rc-head-ops">
          <select v-model.number="statDays" class="ac-select" @change="changeDays">
            <option :value="7">近 7 天</option>
            <option :value="30">近 30 天</option>
            <option :value="90">近 90 天</option>
          </select>
          <button class="ac-btn" :disabled="statsLoading" @click="loadStats">
            {{ statsLoading ? "加载中…" : "刷新概览" }}
          </button>
        </div>
      </div>

      <div v-if="statsError" class="rc-error">
        {{ statsError }}
        <button class="ac-act" @click="loadStats">重试</button>
      </div>

      <div v-else-if="statsLoading && !stats" class="ad-empty">概览加载中…</div>

      <template v-else-if="stats">
        <div class="rc-cards">
          <div class="rc-card">
            <span>今日充值</span>
            <strong>{{ fmtMoney(stats.today?.amount) }}</strong>
            <em>{{ stats.today?.count ?? 0 }} 笔</em>
          </div>
          <div class="rc-card">
            <span>昨日充值</span>
            <strong>{{ fmtMoney(stats.yesterday?.amount) }}</strong>
            <em>{{ stats.yesterday?.count ?? 0 }} 笔</em>
          </div>
          <div class="rc-card">
            <span>区间充值（{{ statDays }} 天）</span>
            <strong>{{ fmtMoney(stats.range?.amount) }}</strong>
            <em>{{ stats.range?.count ?? 0 }} 笔 · {{ stats.range?.paidUsers ?? 0 }} 人</em>
          </div>
          <div class="rc-card">
            <span>待支付笔数</span>
            <strong class="rc-warn">{{ pendingCount }}</strong>
            <em>区间退款 {{ fmtMoney(stats.range?.refundAmount) }}</em>
          </div>
        </div>

        <div class="rc-grid">
          <!-- 趋势（纯 CSS 柱状图） -->
          <div class="rc-panel rc-trend">
            <div class="rc-panel-head">
              <h4>充值趋势</h4>
              <span class="ac-dim">按日统计金额（元）</span>
            </div>
            <div v-if="!trend.length" class="ad-empty">暂无趋势数据</div>
            <div v-else class="rc-chart">
              <div class="rc-bars">
                <div
                  v-for="(t, i) in trend"
                  :key="t.date || i"
                  class="rc-bar-col"
                  :title="`${t.date}：${fmtMoney(t.amount)}，${t.count ?? 0} 笔`"
                >
                  <div class="rc-bar" :style="{ height: barHeight(t.amount, trendMax) }" />
                </div>
              </div>
              <div class="rc-axis">
                <span v-for="(t, i) in trend" :key="`a-${t.date || i}`">{{ trendLabel(i) }}</span>
              </div>
            </div>
          </div>

          <!-- 渠道分布 -->
          <div class="rc-panel">
            <div class="rc-panel-head">
              <h4>渠道分布</h4>
              <span class="ac-dim">按金额</span>
            </div>
            <div v-if="!byChannel.length" class="ad-empty">暂无渠道数据</div>
            <ul v-else class="rc-list">
              <li v-for="c in byChannel" :key="c.channel || 'none'">
                <div class="rc-list-top">
                  <span>{{ channelLabel(c.channel) }}</span>
                  <b>{{ fmtMoney(c.amount) }} <i>{{ c.count ?? 0 }} 笔</i></b>
                </div>
                <div class="rc-track">
                  <div class="rc-fill" :style="{ width: `${Math.max(2, (Number(c.amount || 0) / channelMax) * 100)}%` }" />
                </div>
              </li>
            </ul>
          </div>

          <!-- 状态分布 -->
          <div class="rc-panel">
            <div class="rc-panel-head">
              <h4>订单状态</h4>
              <span class="ac-dim">按笔数</span>
            </div>
            <div v-if="!byStatus.length" class="ad-empty">暂无状态数据</div>
            <ul v-else class="rc-list">
              <li v-for="s in byStatus" :key="s.status || 'none'">
                <div class="rc-list-top">
                  <span>
                    <span class="ac-status" :class="statusMeta(s.status).cls">
                      {{ statusMeta(s.status).label }}
                    </span>
                  </span>
                  <b>{{ s.count ?? 0 }} 笔</b>
                </div>
                <div class="rc-track">
                  <div class="rc-fill" :style="{ width: `${Math.max(2, (Number(s.count || 0) / statusTotal) * 100)}%` }" />
                </div>
              </li>
            </ul>
          </div>

          <!-- 充值排行 -->
          <div class="rc-panel">
            <div class="rc-panel-head">
              <h4>充值排行</h4>
              <span class="ac-dim">TOP {{ topCustomers.length }}</span>
            </div>
            <div v-if="!topCustomers.length" class="ad-empty">暂无排行数据</div>
            <table v-else class="ad-table rc-rank">
              <thead>
                <tr>
                  <th>#</th>
                  <th>客户</th>
                  <th class="ta-r">累计充值</th>
                  <th class="ta-r">订单</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in topCustomers" :key="c.userId || i">
                  <td class="ac-dim">{{ i + 1 }}</td>
                  <td class="rc-ellipsis" :title="c.nickname || c.userId">{{ c.nickname || c.userId }}</td>
                  <td class="ta-r ac-mono">{{ fmtMoney(c.totalPaid) }}</td>
                  <td class="ta-r ac-mono">{{ c.orderCount ?? 0 }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <!-- ================= 订单列表 ================= -->
      <div class="rc-head rc-head-orders">
        <h3>充值订单</h3>
        <div class="rc-head-ops">
          <button class="ac-btn" @click="openPlans">套餐配置</button>
          <button class="ac-btn" @click="openAuto">自动化任务</button>
          <button class="ac-btn-primary" :disabled="loading" @click="refreshAll">刷新</button>
        </div>
      </div>

      <div class="ac-bar">
        <select v-model="filters.status" class="ac-select" @change="applyFilter">
          <option value="">全部状态</option>
          <option value="pending">待支付</option>
          <option value="paid">已支付</option>
          <option value="cancelled">已取消</option>
          <option value="expired">已过期</option>
          <option value="refunded">已退款</option>
        </select>
        <input
          v-model="filters.keyword"
          class="ac-input"
          placeholder="搜索订单号 / 昵称 / 账号"
          @keyup.enter="applyFilter"
        />
        <input v-model="filters.userId" class="ac-input rc-input-sm" placeholder="用户 ID" @keyup.enter="applyFilter" />
        <input v-model="filters.from" class="ac-input rc-input-date" type="date" title="开始日期" @change="applyFilter" />
        <span class="ac-dim">至</span>
        <input v-model="filters.to" class="ac-input rc-input-date" type="date" title="结束日期" @change="applyFilter" />
        <button class="ac-btn" @click="applyFilter">查询</button>
        <button class="ac-btn-ghost" @click="resetFilter">重置</button>
      </div>

      <div v-if="summary" class="rc-summary">
        <span>筛选合计：<b>{{ fmtMoney(summary.amount) }}</b></span>
        <span>订单 <b>{{ summary.count ?? 0 }}</b> 笔</span>
        <span>待支付 <b class="rc-warn">{{ summary.pending ?? 0 }}</b></span>
        <span>已支付 <b class="rc-ok">{{ summary.paid ?? 0 }}</b></span>
        <span>已退款 <b class="rc-danger">{{ summary.refunded ?? 0 }}</b></span>
      </div>

      <div v-if="ordersError" class="rc-error">
        {{ ordersError }}
        <button class="ac-act" @click="loadOrders">重试</button>
      </div>

      <div class="ac-table-wrap">
        <table class="ad-table">
          <thead>
            <tr>
              <th>订单号</th>
              <th>客户</th>
              <th>套餐</th>
              <th class="ta-r">算力</th>
              <th class="ta-r">金额</th>
              <th>渠道</th>
              <th>状态</th>
              <th>创建 / 支付时间</th>
              <th class="ta-r">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="9" class="ad-empty">加载中…</td>
            </tr>
            <tr v-else-if="!rows.length">
              <td colspan="9" class="ad-empty">{{ ordersError ? "订单加载失败" : "没有符合条件的充值订单" }}</td>
            </tr>
            <tr v-for="row in rows" v-else :key="row.id">
              <td class="ac-mono rc-ellipsis" :title="row.id">{{ row.id }}</td>
              <td>
                <div class="rc-ellipsis" :title="row.nickname || row.username">
                  {{ row.nickname || row.username || row.userId || "-" }}
                </div>
                <div v-if="row.username && row.nickname" class="ac-dim rc-ellipsis">{{ row.username }}</div>
              </td>
              <td class="ac-mono">{{ row.planId || "-" }}</td>
              <td class="ta-r ac-mono">
                {{ fmtNum(row.total ?? (row.credits || 0) + (row.bonus || 0)) }}
                <span v-if="row.bonus" class="ac-dim">（含赠 {{ fmtNum(row.bonus) }}）</span>
              </td>
              <td class="ta-r ac-mono">{{ fmtMoney(row.price) }}</td>
              <td>{{ channelLabel(row.channel) }}<div v-if="row.payMethod" class="ac-dim">{{ row.payMethod }}</div></td>
              <td>
                <span class="ac-status" :class="statusMeta(row.status).cls">{{ statusMeta(row.status).label }}</span>
              </td>
              <td class="ac-mono ac-dim">
                {{ fmtTime(row.createdAt) }}
                <div v-if="row.paidAt">付 {{ fmtTime(row.paidAt) }}</div>
              </td>
              <td class="ta-r">
                <div class="ac-actions">
                  <button class="ac-act" @click="openDetail(row)">详情</button>
                  <template v-if="canManage">
                    <button
                      v-if="row.status === 'pending' || row.status === 'expired'"
                      class="ac-act"
                      :disabled="syncBusyId === row.id"
                      @click="doSync(row)"
                    >
                      {{ syncBusyId === row.id ? "查单中…" : "查单" }}
                    </button>
                    <button
                      v-if="row.status === 'pending' || row.status === 'expired'"
                      class="ac-act"
                      @click="openAction('manual', row)"
                    >
                      补单
                    </button>
                    <button v-if="row.status === 'paid'" class="ac-act danger" @click="openAction('refund', row)">
                      退款
                    </button>
                    <button class="ac-act" @click="openAction('note', row)">备注</button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="rc-pager">
        <span class="ac-dim">共 {{ total }} 笔</span>
        <span class="ac-dim">第 {{ page }} / {{ pageCount }} 页</span>
        <select v-model.number="pageSize" class="ac-select" @change="changePageSize">
          <option :value="10">10 条/页</option>
          <option :value="20">20 条/页</option>
          <option :value="50">50 条/页</option>
        </select>
        <button class="ac-btn" :disabled="loading || page <= 1" @click="prevPage">上一页</button>
        <button class="ac-btn" :disabled="loading || page >= pageCount" @click="nextPage">下一页</button>
      </div>
    </template>

    <!-- ================= 订单操作弹窗 ================= -->
    <el-dialog v-model="actionOpen" :title="actionMeta.title" width="460px" append-to-body>
      <div class="ac-form">
        <p class="ac-note">{{ actionMeta.tip }}</p>
        <div class="rc-order-brief">
          <div><span>订单号</span><b class="ac-mono">{{ actionRow?.id }}</b></div>
          <div><span>客户</span><b>{{ actionRow?.nickname || actionRow?.username || actionRow?.userId }}</b></div>
          <div><span>金额</span><b class="ac-mono">{{ fmtMoney(actionRow?.price) }}</b></div>
          <div><span>状态</span><b>{{ statusMeta(actionRow?.status).label }}</b></div>
        </div>
        <label class="ac-field">
          <span>{{ actionMeta.label }} <i>*</i></span>
          <input
            v-model="actionText"
            maxlength="200"
            :placeholder="actionMeta.placeholder"
            @keyup.enter="submitAction"
          />
        </label>
      </div>
      <template #footer>
        <button class="ac-btn-ghost" @click="actionOpen = false">取消</button>
        <button class="ac-btn-primary" :disabled="actionBusy" @click="submitAction">
          {{ actionBusy ? "提交中…" : "确认" }}
        </button>
      </template>
    </el-dialog>

    <!-- ================= 订单详情 ================= -->
    <el-dialog v-model="detailOpen" title="订单详情" width="560px" append-to-body>
      <div v-if="detailRow" class="ac-form">
        <div class="rc-order-brief">
          <div><span>订单号</span><b class="ac-mono">{{ detailRow.id }}</b></div>
          <div><span>客户</span><b>{{ detailRow.nickname || detailRow.username || detailRow.userId }}</b></div>
          <div><span>套餐</span><b class="ac-mono">{{ detailRow.planId || "-" }}</b></div>
          <div><span>渠道</span><b>{{ channelLabel(detailRow.channel) }}</b></div>
          <div><span>算力</span><b class="ac-mono">{{ fmtNum(detailRow.credits) }} + 赠 {{ fmtNum(detailRow.bonus) }}</b></div>
          <div><span>金额</span><b class="ac-mono">{{ fmtMoney(detailRow.price) }}</b></div>
          <div><span>状态</span><b>{{ statusMeta(detailRow.status).label }}</b></div>
          <div><span>支付方式</span><b>{{ detailRow.payMethod || "-" }}</b></div>
          <div><span>创建时间</span><b class="ac-mono">{{ fmtTime(detailRow.createdAt) }}</b></div>
          <div><span>支付时间</span><b class="ac-mono">{{ fmtTime(detailRow.paidAt) }}</b></div>
          <div><span>过期时间</span><b class="ac-mono">{{ fmtTime(detailRow.expiredAt) }}</b></div>
          <div><span>退款</span><b>{{ detailRow.refund ? JSON.stringify(detailRow.refund) : "-" }}</b></div>
        </div>
        <div class="rc-notes">
          <h4>备注记录</h4>
          <div v-if="!orderNotes(detailRow).length" class="ad-empty">暂无备注</div>
          <ul v-else>
            <li v-for="(n, i) in orderNotes(detailRow)" :key="i">
              <span class="ac-dim">{{ fmtTime(n.at) }} · {{ n.actor || "-" }}</span>
              <div>{{ n.note }}</div>
            </li>
          </ul>
        </div>
      </div>
      <template #footer>
        <button class="ac-btn" @click="detailOpen = false">关闭</button>
      </template>
    </el-dialog>

    <!-- ================= 套餐配置 ================= -->
    <el-dialog v-model="plansOpen" title="充值套餐配置" width="720px" append-to-body>
      <div v-if="plansLoading" class="ad-empty">套餐加载中…</div>
      <div v-else-if="plansError" class="rc-error">
        {{ plansError }}
        <button class="ac-act" @click="openPlans">重试</button>
      </div>
      <div v-else class="ac-form">
        <p class="ac-note">仅可修改现有套餐的算力、赠送、价格、名称与推荐标记；套餐 ID 由后端固定，不支持新增或删除。</p>
        <table class="ad-table rc-plans">
          <thead>
            <tr>
              <th>套餐 ID</th>
              <th>名称</th>
              <th class="ta-r">算力</th>
              <th class="ta-r">赠送</th>
              <th class="ta-r">合计</th>
              <th class="ta-r">价格（元）</th>
              <th class="ta-r">单价</th>
              <th class="ta-c">推荐</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in plans" :key="p.id">
              <td class="ac-mono">{{ p.id }}</td>
              <td><input v-model="p.label" class="rc-plan-input rc-plan-label" maxlength="20" /></td>
              <td class="ta-r"><input v-model.number="p.credits" type="number" min="1" step="1" class="rc-plan-input" /></td>
              <td class="ta-r"><input v-model.number="p.bonus" type="number" min="0" step="1" class="rc-plan-input" /></td>
              <td class="ta-r ac-mono">{{ fmtNum(planTotal(p)) }}</td>
              <td class="ta-r"><input v-model.number="p.price" type="number" min="0.01" step="0.01" class="rc-plan-input" /></td>
              <td class="ta-r ac-mono">{{ p.perUnit != null ? p.perUnit : "-" }}</td>
              <td class="ta-c"><input v-model="p.hot" type="checkbox" /></td>
            </tr>
          </tbody>
        </table>
        <div v-if="!plans.length" class="ad-empty">暂无套餐</div>
      </div>
      <template #footer>
        <button class="ac-btn-ghost" @click="plansOpen = false">取消</button>
        <button class="ac-btn-primary" :disabled="plansSaving || plansLoading" @click="savePlans">
          {{ plansSaving ? "保存中…" : "保存套餐" }}
        </button>
      </template>
    </el-dialog>

    <!-- ================= 自动化任务 ================= -->
    <el-dialog v-model="autoOpen" title="充值自动化任务" width="560px" append-to-body>
      <div v-if="autoLoading" class="ad-empty">配置加载中…</div>
      <div v-else-if="autoError" class="rc-error">
        {{ autoError }}
        <button class="ac-act" @click="openAuto">重试</button>
      </div>
      <div v-else class="ac-form">
        <p class="ac-note">
          自动化会定期把超时未支付订单标记为过期，并主动向支付渠道同步待支付订单状态；需保证服务端常驻运行。
        </p>
        <div class="ac-field-row">
          <label class="ac-field rc-field-auto">
            <span>启用自动化</span>
            <el-switch v-model="autoForm.enabled" />
          </label>
        </div>
        <div class="ac-field-row">
          <label class="ac-field">
            <span>订单过期时长（分钟，5~1440）</span>
            <input v-model.number="autoForm.expireMinutes" type="number" min="5" max="1440" step="1" />
          </label>
          <label class="ac-field">
            <span>同步间隔（秒，30~3600）</span>
            <input v-model.number="autoForm.syncAfterSec" type="number" min="30" max="3600" step="1" />
          </label>
        </div>
        <div class="ac-field-row">
          <label class="ac-field">
            <span>每轮同步批量（1~100）</span>
            <input v-model.number="autoForm.syncBatch" type="number" min="1" max="100" step="1" />
          </label>
        </div>

        <div v-if="automation?.lastReport" class="rc-last-report">
          <h4>上次执行（{{ fmtTime(automation.lastReport.at) }}）</h4>
          <div class="rc-report-grid">
            <div><span>过期</span><b>{{ automation.lastReport.expired ?? 0 }}</b></div>
            <div><span>同步</span><b>{{ automation.lastReport.synced ?? 0 }}</b></div>
            <div><span>补单</span><b>{{ automation.lastReport.paid ?? 0 }}</b></div>
            <div><span>错误</span><b :class="automation.lastReport.errors ? 'rc-danger' : ''">{{ automation.lastReport.errors ?? 0 }}</b></div>
          </div>
        </div>
        <div v-else class="ac-dim rc-last-report-empty">暂无执行记录</div>
      </div>
      <template #footer>
        <button class="ac-btn rc-btn-run" :disabled="autoRunning || autoLoading" @click="confirmRunAuto">
          {{ autoRunning ? "执行中…" : "立即执行一次" }}
        </button>
        <button class="ac-btn-ghost" @click="autoOpen = false">关闭</button>
        <button class="ac-btn-primary" :disabled="autoSaving || autoLoading" @click="saveAuto">
          {{ autoSaving ? "保存中…" : "保存配置" }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.rc-btn-run {
  color: #b91c1c;
  border-color: #fecaca;
  background: #fef2f2;
}

.rc-btn-run:hover {
  border-color: #fca5a5;
  color: #991b1b;
}

.rc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 0 10px;
}

.rc-head-orders {
  margin-top: 26px;
  padding-top: 18px;
  border-top: 1px solid #e9edf3;
}

.rc-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
}

.rc-head-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rc-error {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 0;
  padding: 10px 14px;
  border: 1px solid #fecaca;
  border-radius: 10px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 12.5px;
}

.rc-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 12px;
}

.rc-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px 14px;
  border: 1px solid #e9edf3;
  border-radius: 10px;
  background: #fafbfd;
}

.rc-card span {
  font-size: 11.5px;
  color: #94a3b8;
}

.rc-card strong {
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}

.rc-card em {
  font-style: normal;
  font-size: 11.5px;
  color: #94a3b8;
}

.rc-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 10px;
  margin-bottom: 6px;
}

.rc-panel {
  padding: 12px 14px 14px;
  border: 1px solid #e9edf3;
  border-radius: 10px;
  background: #fff;
}

.rc-panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
}

.rc-panel-head h4 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: #334155;
}

.rc-chart {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rc-bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 132px;
  padding: 0 2px;
  border-bottom: 1px solid #eef2f7;
}

.rc-bar-col {
  flex: 1;
  display: flex;
  align-items: flex-end;
  height: 100%;
  min-width: 0;
}

.rc-bar {
  width: 100%;
  border-radius: 3px 3px 0 0;
  background: linear-gradient(180deg, #60a5fa, #3b82f6);
  transition: height 0.25s ease;
}

.rc-axis {
  display: flex;
  gap: 3px;
}

.rc-axis span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 9.5px;
  color: #94a3b8;
  text-align: center;
  white-space: nowrap;
}

.rc-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.rc-list-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  font-size: 12px;
  color: #475569;
}

.rc-list-top b {
  font-weight: 600;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}

.rc-list-top b i {
  font-style: normal;
  font-weight: 400;
  font-size: 11px;
  color: #94a3b8;
}

.rc-track {
  height: 5px;
  border-radius: 99px;
  background: #f1f5f9;
  overflow: hidden;
}

.rc-fill {
  height: 100%;
  border-radius: 99px;
  background: #3b82f6;
}

.rc-rank {
  width: 100%;
}

.rc-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 18px;
  margin: 0 0 10px;
  padding: 9px 14px;
  border: 1px solid #e9edf3;
  border-radius: 10px;
  background: #fafbfd;
  font-size: 12px;
  color: #475569;
}

.rc-summary b {
  font-weight: 600;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}

.rc-warn {
  color: #d97706 !important;
}

.rc-ok {
  color: #059669 !important;
}

.rc-danger {
  color: #dc2626 !important;
}

.rc-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.rc-input-sm {
  width: 96px;
}

.rc-input-date {
  width: 138px;
}

.rc-ellipsis {
  max-width: 210px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-order-brief {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 18px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #f8fafc;
  font-size: 12px;
}

.rc-order-brief > div {
  display: flex;
  gap: 8px;
  min-width: 0;
}

.rc-order-brief span {
  flex: none;
  width: 62px;
  color: #94a3b8;
}

.rc-order-brief b {
  font-weight: 500;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-notes {
  margin-top: 12px;
  font-size: 12px;
}

.rc-notes h4 {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: #334155;
}

.rc-notes ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 180px;
  overflow: auto;
}

.rc-notes li {
  padding: 8px 10px;
  border: 1px solid #eef2f7;
  border-radius: 8px;
  background: #fafbfd;
  color: #334155;
}

.rc-plans td {
  padding: 6px 8px;
}

.rc-plan-input {
  width: 100%;
  padding: 5px 7px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  color: #0f172a;
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.rc-plan-input:focus {
  border-color: var(--primary);
}

.rc-plan-label {
  min-width: 92px;
}

.rc-field-auto {
  flex-direction: row !important;
  align-items: center;
  justify-content: space-between;
}

.rc-last-report {
  padding: 10px 12px;
  border: 1px solid #e9edf3;
  border-radius: 10px;
  background: #fafbfd;
}

.rc-last-report h4 {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: #334155;
}

.rc-report-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.rc-report-grid > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11.5px;
  color: #94a3b8;
}

.rc-report-grid b {
  font-size: 15px;
  color: #0f172a;
}

.rc-last-report-empty {
  padding: 8px 2px;
  font-size: 12px;
}

.ta-c {
  text-align: center;
}

:global(body.dark) .rc-head h3,
:global(body.dark) .rc-panel-head h4,
:global(body.dark) .rc-card strong,
:global(body.dark) .rc-list-top b,
:global(body.dark) .rc-order-brief b {
  color: #e6e8ec;
}

:global(body.dark) .rc-card,
:global(body.dark) .rc-panel,
:global(body.dark) .rc-summary,
:global(body.dark) .rc-order-brief,
:global(body.dark) .rc-last-report,
:global(body.dark) .rc-notes li {
  background: #141414;
  border-color: #2e2e2e;
}

:global(body.dark) .rc-panel {
  background: #1a1a1a;
}

:global(body.dark) .rc-head-orders {
  border-color: #2e2e2e;
}

:global(body.dark) .rc-bars {
  border-color: #2e2e2e;
}

:global(body.dark) .rc-plan-input {
  background: #141414;
  border-color: #3a3a3a;
  color: #e6e8ec;
}
</style>
