<script setup>
// 客户中心：列表 / 档案 / 充值订单 / 算力流水 / 人工调账
// 接口依据：reports/ops-backend-2026-11-05/接口契约.md 第 1 节
import { ref, reactive, computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import {
  fetchCustomers, fetchCustomer, fetchCustomerMeta, updateCustomer, adjustCustomer
} from "../../api.js";

const props = defineProps({ perms: { type: Array, default: () => [] } });
const can = (c) => props.perms.includes(c);
const canView = computed(() => can("admin:customer:view"));
const canEdit = computed(() => can("admin:customer:edit"));

const loading = ref(false);
const loadError = ref("");
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const meta = reactive({ levels: [], sources: [] });

const filters = reactive({ keyword: "", status: "", level: "" });

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

// 后端未下发 meta 时的兜底文案（契约：normal/vip/svip/agent）
const LEVEL_FALLBACK = { normal: "普通客户", vip: "VIP", svip: "SVIP", agent: "代理商" };
const STATUS_LABEL = { active: "正常", disabled: "停用" };
const ORDER_STATUS = {
  pending: { label: "待支付", cls: "warn" },
  paid: { label: "已支付", cls: "active" },
  cancelled: { label: "已取消", cls: "disabled" },
  expired: { label: "已过期", cls: "disabled" },
  refunded: { label: "已退款", cls: "danger" }
};
const CREDIT_TYPE = {
  recharge: "充值",
  consume: "消费",
  reserve: "预扣",
  rollback: "退回预扣",
  refund: "退款",
  grant: "赠送/调账",
  carry: "流水结转"
};

function levelLabel(v) {
  return meta.levels.find((l) => l.value === v)?.label || LEVEL_FALLBACK[v] || v || "-";
}
function statusLabel(s) {
  return STATUS_LABEL[s] || s || "-";
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
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtMoney(v) {
  return `¥${Number(v || 0).toFixed(2)}`;
}
function fmtNum(v) {
  return Number(v || 0).toLocaleString("zh-CN");
}
function signedNum(v) {
  const n = Number(v || 0);
  return n > 0 ? `+${fmtNum(n)}` : fmtNum(n);
}

async function load() {
  if (!canView.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    const [list, m] = await Promise.all([
      fetchCustomers({
        keyword: filters.keyword.trim(),
        status: filters.status,
        level: filters.level,
        page: page.value,
        pageSize: pageSize.value
      }),
      // meta 失败不影响列表；等级文案有兜底
      fetchCustomerMeta().catch(() => null)
    ]);
    rows.value = list.rows || [];
    total.value = list.total || 0;
    if (m) {
      meta.levels = m.levels || [];
      meta.sources = m.sources || [];
    }
  } catch (err) {
    rows.value = [];
    total.value = 0;
    loadError.value = err.message || "客户列表加载失败";
    ElMessage.error(err.message || "客户列表加载失败");
  } finally {
    loading.value = false;
  }
}

function applyFilter() {
  page.value = 1;
  load();
}
function reset() {
  Object.assign(filters, { keyword: "", status: "", level: "" });
  page.value = 1;
  load();
}
function prevPage() {
  if (page.value > 1) {
    page.value -= 1;
    load();
  }
}
function nextPage() {
  if (page.value < pageCount.value) {
    page.value += 1;
    load();
  }
}
function changePageSize() {
  page.value = 1;
  load();
}

// ---------- 详情抽屉 ----------
const drawerOpen = ref(false);
const detailLoading = ref(false);
const detailError = ref("");
const detail = ref(null);
const activeRow = ref(null); // 详情加载失败时用于重试
const profileSaving = ref(false);
const profile = reactive({
  realName: "",
  company: "",
  wechat: "",
  level: "normal",
  tags: [],
  source: "",
  remark: "",
  region: ""
});

const sourceOptions = computed(() =>
  (meta.sources || []).map((s) => (typeof s === "string" ? { value: s, label: s } : s))
);

function detailCustomer() {
  return detail.value?.customer || {};
}
function detailStats() {
  return detail.value?.customer?.stats || {};
}

async function openDetail(row) {
  drawerOpen.value = true;
  activeRow.value = row;
  detailLoading.value = true;
  detailError.value = "";
  detail.value = null;
  try {
    const d = await fetchCustomer(row.id);
    detail.value = d;
    fillProfile(d);
  } catch (err) {
    detailError.value = err.message || "客户详情加载失败";
    ElMessage.error(detailError.value);
  } finally {
    detailLoading.value = false;
  }
}

function fillProfile(d) {
  const c = d?.customer || {};
  const p = d?.profile || {};
  const pick = (k) => {
    if (c[k] != null && c[k] !== "") return c[k];
    if (p[k] != null) return p[k];
    return "";
  };
  Object.assign(profile, {
    realName: pick("realName") || "",
    company: pick("company") || "",
    wechat: pick("wechat") || "",
    level: pick("level") || "normal",
    tags: Array.isArray(c.tags) && c.tags.length ? [...c.tags] : Array.isArray(p.tags) ? [...p.tags] : [],
    source: pick("source") || "",
    remark: pick("remark") || "",
    region: pick("region") || ""
  });
}

async function saveProfile() {
  const c = detailCustomer();
  if (!c.id) return;
  profileSaving.value = true;
  try {
    const r = await updateCustomer(c.id, {
      realName: profile.realName.trim(),
      company: profile.company.trim(),
      wechat: profile.wechat.trim(),
      level: profile.level,
      tags: (profile.tags || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 20),
      source: profile.source,
      remark: profile.remark.trim(),
      region: profile.region.trim()
    });
    ElMessage.success("客户档案已保存");
    if (r?.customer) detail.value.customer = { ...c, ...r.customer };
    fillProfile(detail.value);
    load();
  } catch (err) {
    ElMessage.error(err.message || "保存失败");
  } finally {
    profileSaving.value = false;
  }
}

// ---------- 人工调账 ----------
const adjustOpen = ref(false);
const adjustSaving = ref(false);
const adjustForm = reactive({ amount: null, reason: "" });

function openAdjust() {
  adjustForm.amount = null;
  adjustForm.reason = "";
  adjustOpen.value = true;
}

async function submitAdjust() {
  const amount = Number(adjustForm.amount);
  if (!Number.isInteger(amount) || amount === 0) {
    return ElMessage.warning("调账算力必须是非零整数（正数增加，负数扣减）");
  }
  if (!adjustForm.reason.trim()) return ElMessage.warning("请填写调账原因");
  adjustSaving.value = true;
  try {
    const r = await adjustCustomer(detailCustomer().id, { amount, reason: adjustForm.reason.trim() });
    ElMessage.success(`调账成功，当前余额 ${fmtNum(r.balance)}`);
    adjustOpen.value = false;
    // 重新拉详情：余额 / 流水 / 统计都已变化
    const d = await fetchCustomer(detailCustomer().id);
    detail.value = d;
    fillProfile(d);
    load();
  } catch (err) {
    ElMessage.error(err.message || "调账失败");
  } finally {
    adjustSaving.value = false;
  }
}

function orderStatusMeta(s) {
  return ORDER_STATUS[s] || { label: s || "-", cls: "" };
}

onMounted(load);
</script>

<template>
  <div class="ac-page">
    <div v-if="!canView" class="ad-empty">
      无权限查看客户中心（需要 <code>admin:customer:view</code>），请联系管理员分配权限。
    </div>

    <template v-else>
      <!-- 筛选 -->
      <div class="ac-bar">
        <input
          v-model="filters.keyword"
          class="ac-input"
          placeholder="搜索昵称 / 账号 / 手机 / 公司 / 真实姓名"
          @keyup.enter="applyFilter"
        />
        <select v-model="filters.status" class="ac-select" @change="applyFilter">
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="disabled">停用</option>
        </select>
        <select v-model="filters.level" class="ac-select" @change="applyFilter">
          <option value="">全部等级</option>
          <option v-for="l in meta.levels" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>
        <button class="ac-btn" @click="applyFilter">查询</button>
        <button class="ac-btn-ghost" @click="reset">重置</button>
        <span class="ac-spacer" />
        <span class="ac-total">共 {{ total }} 位客户</span>
        <button class="ac-btn" :disabled="loading" @click="load">刷新</button>
      </div>

      <div v-if="loadError" class="cd-error">{{ loadError }}（可点击「刷新」重试）</div>

      <!-- 表格 -->
      <div class="ac-table-wrap">
        <table class="ad-table">
          <thead>
            <tr>
              <th>客户</th>
              <th>手机</th>
              <th>等级</th>
              <th class="ta-r">余额</th>
              <th class="ta-r">累计充值</th>
              <th class="ta-r">订单数</th>
              <th>注册时间</th>
              <th>最近充值</th>
              <th class="ta-r">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="9" class="ad-empty">加载中…</td>
            </tr>
            <tr v-else-if="!rows.length">
              <td colspan="9" class="ad-empty">
                {{ loadError ? "客户列表加载失败" : "没有符合条件的客户" }}
              </td>
            </tr>
            <tr v-for="row in rows" v-else :key="row.id">
              <td>
                <div class="ac-user">
                  <span class="ac-avatar">{{ (row.nickname || row.username || "?")[0]?.toUpperCase() }}</span>
                  <div>
                    <div class="ac-user-name">{{ row.nickname || row.username || "未命名客户" }}</div>
                    <div class="ac-user-sub">
                      {{ row.username || row.id
                      }}<template v-if="row.company"> · {{ row.company }}</template>
                    </div>
                  </div>
                </div>
              </td>
              <td class="ac-mono">{{ row.phone || "-" }}</td>
              <td><span class="ac-tag">{{ levelLabel(row.level) }}</span></td>
              <td class="ta-r ac-mono">{{ fmtNum(row.balance) }}</td>
              <td class="ta-r ac-mono">{{ fmtMoney(row.totalPaid) }}</td>
              <td class="ta-r ac-mono">
                {{ row.orderCount ?? 0
                }}<span v-if="row.paidOrderCount != null" class="ac-dim">（实付 {{ row.paidOrderCount }}）</span>
              </td>
              <td class="ac-mono ac-dim">{{ fmtDate(row.createdAt) }}</td>
              <td class="ac-mono ac-dim">{{ fmtTime(row.lastPaidAt) }}</td>
              <td class="ta-r">
                <div class="ac-actions">
                  <button class="ac-act" @click="openDetail(row)">详情</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 -->
      <div class="cd-pager">
        <span class="ac-total">第 {{ page }} / {{ pageCount }} 页</span>
        <select v-model.number="pageSize" class="ac-select" @change="changePageSize">
          <option :value="10">10 条/页</option>
          <option :value="20">20 条/页</option>
          <option :value="50">50 条/页</option>
        </select>
        <button class="ac-btn" :disabled="loading || page <= 1" @click="prevPage">上一页</button>
        <button class="ac-btn" :disabled="loading || page >= pageCount" @click="nextPage">下一页</button>
      </div>

      <!-- 客户详情抽屉 -->
      <el-drawer
        v-model="drawerOpen"
        title="客户详情"
        size="760px"
        append-to-body
        class="cd-drawer"
        :destroy-on-close="false"
      >
        <div v-if="detailLoading" class="ad-empty">加载中…</div>
        <div v-else-if="detailError" class="cd-error">
          {{ detailError }}
          <button class="ac-act" @click="activeRow && openDetail(activeRow)">重试</button>
        </div>
        <div v-else-if="detail" class="cd-detail">
          <!-- 客户概览 -->
          <div class="cd-head">
            <span class="ac-avatar cd-avatar">
              {{ (detailCustomer().nickname || detailCustomer().username || "?")[0]?.toUpperCase() }}
            </span>
            <div class="cd-head-main">
              <div class="cd-name">{{ detailCustomer().nickname || detailCustomer().username || "未命名客户" }}</div>
              <div class="ac-user-sub">
                {{ detailCustomer().username || detailCustomer().id }}
                <template v-if="detailCustomer().phone"> · {{ detailCustomer().phone }}</template>
                · 注册于 {{ fmtDate(detailCustomer().createdAt) }}
              </div>
            </div>
            <span class="ac-status" :class="detailCustomer().status === 'active' ? 'active' : 'disabled'">
              {{ statusLabel(detailCustomer().status) }}
            </span>
          </div>

          <div class="cd-stats">
            <div class="cd-stat">
              <span>当前余额</span>
              <strong>{{ fmtNum(detailCustomer().balance ?? detailStats().balance) }}</strong>
            </div>
            <div class="cd-stat">
              <span>累计实付</span>
              <strong>{{ fmtMoney(detailCustomer().totalPaid ?? detailStats().totalPaid) }}</strong>
            </div>
            <div class="cd-stat">
              <span>累计消耗</span>
              <strong>{{ fmtNum(detailCustomer().totalSpent ?? detailStats().totalSpent) }}</strong>
            </div>
            <div class="cd-stat">
              <span>累计退款 / 订单</span>
              <strong>
                {{ fmtMoney(detailCustomer().refundAmount ?? detailStats().refundAmount) }}
                <em>/ {{ detailCustomer().orderCount ?? detailStats().orderCount ?? 0 }}</em>
              </strong>
            </div>
          </div>

          <!-- 档案编辑 -->
          <section class="cd-sec">
            <div class="cd-sec-head">
              <h3>客户档案</h3>
              <button
                v-if="canEdit"
                class="ac-btn-primary sm"
                :disabled="profileSaving"
                @click="saveProfile"
              >
                {{ profileSaving ? "保存中…" : "保存档案" }}
              </button>
              <span v-else class="ac-dim">无编辑权限</span>
            </div>
            <div class="ac-form">
              <div class="ac-field-row">
                <label class="ac-field">
                  <span>真实姓名</span>
                  <input v-model="profile.realName" :disabled="!canEdit" placeholder="选填" maxlength="30" />
                </label>
                <label class="ac-field">
                  <span>公司</span>
                  <input v-model="profile.company" :disabled="!canEdit" placeholder="选填" maxlength="60" />
                </label>
              </div>
              <div class="ac-field-row">
                <label class="ac-field">
                  <span>微信</span>
                  <input v-model="profile.wechat" :disabled="!canEdit" placeholder="选填" maxlength="40" />
                </label>
                <label class="ac-field">
                  <span>地区</span>
                  <input v-model="profile.region" :disabled="!canEdit" placeholder="选填，如 广东深圳" maxlength="40" />
                </label>
              </div>
              <div class="ac-field-row">
                <label class="ac-field">
                  <span>客户等级</span>
                  <select v-model="profile.level" :disabled="!canEdit">
                    <option v-for="l in meta.levels" :key="l.value" :value="l.value">{{ l.label }}</option>
                    <!-- meta 未加载时至少保住当前值 -->
                    <option v-if="!meta.levels.length" :value="profile.level">{{ levelLabel(profile.level) }}</option>
                  </select>
                </label>
                <label class="ac-field">
                  <span>客户来源</span>
                  <select v-model="profile.source" :disabled="!canEdit">
                    <option value="">未标记</option>
                    <option v-for="s in sourceOptions" :key="s.value" :value="s.value">{{ s.label }}</option>
                  </select>
                </label>
              </div>
              <div class="ac-field">
                <span>标签（回车添加，最多 20 个）</span>
                <el-select
                  v-model="profile.tags"
                  :disabled="!canEdit"
                  multiple
                  filterable
                  allow-create
                  default-first-option
                  :reserve-keyword="false"
                  :multiple-limit="20"
                  placeholder="如：高意向 / 批发 / 需回访"
                  class="cd-tags"
                >
                  <el-option v-for="t in profile.tags" :key="t" :label="t" :value="t" />
                </el-select>
              </div>
              <label class="ac-field">
                <span>备注</span>
                <textarea
                  v-model="profile.remark"
                  :disabled="!canEdit"
                  rows="3"
                  maxlength="300"
                  placeholder="内部可见的沟通记录 / 注意事项"
                  class="cd-textarea"
                />
              </label>
            </div>
          </section>

          <!-- 算力流水 -->
          <section class="cd-sec">
            <div class="cd-sec-head">
              <h3>算力流水（最近 50 条）</h3>
              <button v-if="canEdit" class="ac-btn" @click="openAdjust">人工调账</button>
            </div>
            <div class="cd-table-wrap">
              <table class="ad-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>类型</th>
                    <th class="ta-r">变动</th>
                    <th class="ta-r">变动后余额</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!(detailCustomer().records || []).length">
                    <td colspan="5" class="ad-empty">暂无算力流水</td>
                  </tr>
                  <tr v-for="r in detailCustomer().records || []" :key="r.id">
                    <td class="ac-mono ac-dim">{{ fmtTime(r.ts) }}</td>
                    <td>{{ CREDIT_TYPE[r.type] || r.type }}</td>
                    <td class="ta-r ac-mono" :class="Number(r.amount) >= 0 ? 'cd-plus' : 'cd-minus'">
                      {{ signedNum(r.amount) }}
                    </td>
                    <td class="ta-r ac-mono">{{ r.balanceAfter == null ? "-" : fmtNum(r.balanceAfter) }}</td>
                    <td class="cd-ellipsis" :title="r.reason || ''">{{ r.reason || "-" }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- 充值订单 -->
          <section class="cd-sec">
            <div class="cd-sec-head">
              <h3>充值订单（{{ (detailCustomer().orders || []).length }}）</h3>
            </div>
            <div class="cd-table-wrap">
              <table class="ad-table">
                <thead>
                  <tr>
                    <th>订单号</th>
                    <th>套餐</th>
                    <th class="ta-r">算力</th>
                    <th class="ta-r">金额</th>
                    <th>状态</th>
                    <th>创建 / 支付时间</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-if="!(detailCustomer().orders || []).length">
                    <td colspan="6" class="ad-empty">暂无充值订单</td>
                  </tr>
                  <tr v-for="o in detailCustomer().orders || []" :key="o.id">
                    <td class="ac-mono cd-ellipsis" :title="o.id">{{ o.id }}</td>
                    <td>{{ o.planId || "-" }}</td>
                    <td class="ta-r ac-mono">{{ fmtNum(o.total ?? (o.credits || 0) + (o.bonus || 0)) }}</td>
                    <td class="ta-r ac-mono">{{ fmtMoney(o.price) }}</td>
                    <td>
                      <span class="ac-status" :class="orderStatusMeta(o.status).cls">
                        {{ orderStatusMeta(o.status).label }}
                      </span>
                    </td>
                    <td class="ac-mono ac-dim">
                      {{ fmtTime(o.createdAt) }}<template v-if="o.paidAt"> / {{ fmtTime(o.paidAt) }}</template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </el-drawer>

      <!-- 人工调账 -->
      <el-dialog v-model="adjustOpen" title="人工调账" width="440px" append-to-body>
        <div class="ac-form">
          <p class="ac-note">
            正数为增加算力，负数为扣减；扣减后余额不能为负。操作会写入算力流水与审计日志。
          </p>
          <label class="ac-field">
            <span>变动算力 <i>*</i></span>
            <input
              v-model.number="adjustForm.amount"
              type="number"
              step="1"
              placeholder="整数，例如 100 或 -50"
              @keyup.enter="submitAdjust"
            />
          </label>
          <label class="ac-field">
            <span>原因 <i>*</i></span>
            <input v-model="adjustForm.reason" maxlength="100" placeholder="例如：活动补偿 / 客服补发" />
          </label>
        </div>
        <template #footer>
          <button class="ac-btn-ghost" @click="adjustOpen = false">取消</button>
          <button class="ac-btn-primary" :disabled="adjustSaving" @click="submitAdjust">
            {{ adjustSaving ? "提交中…" : "确认调账" }}
          </button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<style scoped>
.cd-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.cd-error {
  padding: 12px 16px;
  border: 1px solid #fecaca;
  border-radius: 10px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 12.5px;
}

.cd-detail {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.cd-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.cd-avatar {
  width: 44px;
  height: 44px;
  font-size: 16px;
}

.cd-head-main {
  flex: 1;
  min-width: 0;
}

.cd-name {
  font-size: 15px;
  font-weight: 600;
  color: #0f172a;
}

.cd-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.cd-stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid #e9edf3;
  border-radius: 10px;
  background: #fafbfd;
}

.cd-stat span {
  font-size: 11.5px;
  color: #94a3b8;
}

.cd-stat strong {
  font-size: 17px;
  font-weight: 700;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
}

.cd-stat strong em {
  font-style: normal;
  font-size: 12px;
  color: #94a3b8;
}

.cd-sec {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cd-sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid #f1f4f8;
}

.cd-sec-head h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: #0f172a;
}

.cd-table-wrap {
  max-height: 300px;
  overflow: auto;
  border: 1px solid #e9edf3;
  border-radius: 10px;
}

.cd-table-wrap .ad-table {
  min-width: 560px;
}

.cd-ellipsis {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cd-plus {
  color: #059669;
}

.cd-minus {
  color: #dc2626;
}

.cd-textarea {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 9px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.6;
  outline: none;
  resize: vertical;
}

.cd-textarea:focus {
  border-color: var(--primary);
}

.cd-textarea:disabled {
  background: #f8fafc;
  color: #94a3b8;
}

.cd-tags {
  width: 100%;
}

:deep(.el-drawer__body) {
  padding: 18px 22px 28px;
}

:global(body.dark) .cd-stat {
  background: #141414;
  border-color: #2e2e2e;
}

:global(body.dark) .cd-name,
:global(body.dark) .cd-sec-head h3,
:global(body.dark) .cd-stat strong {
  color: #e6e8ec;
}

:global(body.dark) .cd-table-wrap {
  border-color: #2e2e2e;
}

:global(body.dark) .cd-textarea {
  background: #141414;
  border-color: #3a3a3a;
  color: #e6e8ec;
}
</style>
