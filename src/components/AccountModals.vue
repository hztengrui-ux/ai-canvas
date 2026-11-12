<script setup>
// 账号相关的四个弹窗：充值算力 / 使用记录 / 团队管理 / 微信连接
import { ref, computed, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { store } from "../store.js";
import {
  fetchPlans,
  fetchOrders,
  createOrder,
  payOrder,
  createPayment,
  fetchPayStatus,
  fetchBalance,
  fetchCreditRecords
} from "../api.js";

const props = defineProps({
  recharge: Boolean,
  usage: Boolean,
  team: Boolean,
  wechat: Boolean
});
const emit = defineEmits(["update:recharge", "update:usage", "update:team", "update:wechat"]);

// ---------- 充值（套餐由服务端下发） ----------
const plans = ref([]);
const orders = ref([]);
const selectedPlanId = ref("");
const payChannel = ref("wechat");
const busy = ref(false);
/** 当前待支付订单；生成二维码后才存在 */
const pendingOrder = ref(null);
/** 本次下单拿到的支付凭证：{ gateway, qrCode, payUrl, sandbox } */
const payInfo = ref(null);
/** 服务端支付模式：{ mode, sandbox, configured, aggregator, hint }；决定是否显示「模拟支付」 */
const payStatus = ref(null);

const selectedPlan = computed(() => plans.value.find((p) => p.id === selectedPlanId.value) || null);

async function loadRecharge() {
  try {
    const [p, o, s] = await Promise.all([
      fetchPlans(),
      fetchOrders(),
      // 支付模式读不到不影响充值页主体，降级为 null 即可
      fetchPayStatus().catch(() => null)
    ]);
    plans.value = p.rows || [];
    orders.value = o.rows || [];
    payStatus.value = s || null;
    // 默认选中「热门」档，没有就选第一个
    if (!selectedPlanId.value && plans.value.length) {
      selectedPlanId.value = (plans.value.find((x) => x.hot) || plans.value[0]).id;
    }
  } catch (err) {
    ElMessage.error(err.message);
  }
}

// 生成一个看起来像二维码的占位图案（确定性，不依赖网络）
const qrCells = computed(() => {
  const n = 21;
  const cells = [];
  let seed = (selectedPlanId.value || "").split("").reduce((a, c) => a + c.charCodeAt(0), 13);
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const isFinder = (x, y) =>
    (x < 7 && y < 7) || (x > n - 8 && y < 7) || (x < 7 && y > n - 8);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (isFinder(x, y)) continue;
      if (rnd() > 0.55) cells.push({ x, y });
    }
  }
  return cells;
});

function pickPlan(id) {
  selectedPlanId.value = id;
  pendingOrder.value = null;
  payInfo.value = null;
}

/**
 * 下单 → 申请支付凭证。
 *
 * 顺序不能反：先 createOrder 落「待支付」订单（此时不加算力），
 * 再向后端要收银台链接/二维码。支付结果一律由网关回调驱动，前端无法自行到账。
 */
async function generateQr() {
  if (!selectedPlan.value) return;
  busy.value = true;
  try {
    const r = await createOrder(selectedPlanId.value);
    pendingOrder.value = r.order;
    try {
      const pay = await createPayment(r.order.id, payChannel.value);
      payInfo.value = pay;
      if (pay.payUrl) {
        ElMessage.success("订单已创建，请点击「打开支付页面」完成支付");
      } else if (pay.gateway === "sandbox") {
        ElMessage.success("沙箱模式：订单已创建，可点「模拟支付」走完整到账链路");
      } else {
        ElMessage.success("订单已创建，请扫码支付");
      }
    } catch (err) {
      // 支付凭证拿不到（未配置/上游异常）不吞掉订单：订单仍在，可在后台补单或稍后重试
      payInfo.value = null;
      ElMessage.warning(`支付通道暂不可用：${err.message}`);
    }
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    busy.value = false;
  }
}

/** 聚合支付/支付宝直连返回收银台地址；微信直连返回 code_url（weixin:// 链接，手机可直接打开） */
function openPayUrl() {
  const url = payInfo.value?.payUrl || payInfo.value?.qrCode || "";
  if (!url) return ElMessage.warning("暂无可用的支付链接，请重新生成订单");
  window.open(url, "_blank", "noopener");
}

/**
 * 沙箱模式下的「模拟支付成功」。
 *
 * ⚠️ 它不是前端伪造支付：调用的是服务端 /api/recharge/orders/:id/simulate-paid，
 *    由服务端用沙箱私钥签发回调票据，并走与真实网关**完全相同**的链路：
 *    验签 → 金额校验 → 幂等 → 到账。
 *    一旦配置了真实商户号/AppId（sandbox=false），该接口直接 403，
 *    此时到账只能由支付网关服务器回调触发。
 */
async function finishPay() {
  if (!pendingOrder.value) return ElMessage.warning("请先创建订单");
  busy.value = true;
  try {
    await ElMessageBox.confirm(
      "当前为沙箱演示模式：点击「确认」将模拟一次支付网关回调并到账。\n配置真实商户号后本入口自动关闭。",
      "模拟支付",
      { type: "warning", confirmButtonText: "模拟支付成功", cancelButtonText: "取消" }
    );
    const r = await payOrder(pendingOrder.value.id, payChannel.value);
    await refreshBalance();
    ElMessage.success(`充值成功，当前余额 ${r.balance} 算力`);
    pendingOrder.value = null;
    payInfo.value = null;
    await loadRecharge();
  } catch (err) {
    if (err !== "cancel") ElMessage.error(err.message || "支付失败");
  } finally {
    busy.value = false;
  }
}

async function refreshBalance() {
  try {
    const b = await fetchBalance();
    store.balance = b.balance ?? 0;
  } catch {
    /* 忽略 */
  }
}

// ---------- 使用记录（真实流水） ----------
const usageRange = ref("today");
const usageRows = ref([]);
const usageLoading = ref(false);

async function loadUsage() {
  usageLoading.value = true;
  try {
    const [b, r] = await Promise.all([fetchBalance(), fetchCreditRecords(100)]);
    store.balance = b.balance ?? 0;
    usageRows.value = (r.rows || []).map((x) => ({
      id: x.id,
      name: x.reason || x.type,
      type: x.amount >= 0 ? "获得" : "消耗",
      raw: x.type,
      date: new Date(x.ts).toISOString().slice(0, 10),
      delta: x.amount,
      balanceAfter: x.balanceAfter
    }));
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    usageLoading.value = false;
  }
}

/** 时间段筛选 */
const filteredUsage = computed(() => {
  const now = new Date();
  const days = usageRange.value === "today" ? 1 : usageRange.value === "week" ? 7 : 30;
  const from = now.getTime() - days * 86400000;
  return usageRows.value.filter((r) => new Date(r.date).getTime() >= from - 86400000);
});

const usageStats = computed(() => {
  const rows = filteredUsage.value;
  return {
    balance: store.balance || 0,
    gained: rows.filter((r) => r.delta > 0).reduce((s, r) => s + r.delta, 0),
    spent: rows.filter((r) => r.delta < 0).reduce((s, r) => s + Math.abs(r.delta), 0)
  };
});

function exportUsage() {
  const head = "明细,类型,日期,算力变化\n";
  const body = filteredUsage.value
    .map((r) => `${r.name},${r.type},${r.date},${r.delta}`)
    .join("\n");
  const blob = new Blob([head + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `使用记录-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success("已导出明细");
}

// ---------- 团队管理 ----------
const members = ref([]);
const newMember = ref({ name: "", phone: "" });

function addMember() {
  const phone = newMember.value.phone.trim();
  if (!/^1\d{10}$/.test(phone)) {
    ElMessage.warning("请输入 11 位手机号");
    return;
  }
  if (members.value.some((m) => m.phone === phone)) {
    ElMessage.warning("该手机号已在团队中");
    return;
  }
  members.value.push({
    id: `m-${Date.now()}`,
    name: newMember.value.name.trim() || `成员${members.value.length + 1}`,
    phone,
    today: 0,
    month: 0,
    total: 0
  });
  newMember.value = { name: "", phone: "" };
  ElMessage.success("成员已添加");
}

function removeMember(m) {
  members.value = members.value.filter((x) => x.id !== m.id);
  ElMessage.success("已移除成员");
}

// ---------- 微信连接 ----------
const wechatConnected = ref(false);

function connectWechat() {
  wechatConnected.value = true;
  ElMessage.success("微信已连接");
}

function disconnectWechat() {
  wechatConnected.value = false;
  ElMessage.info("已退出连接");
}

// 打开弹窗时拉取套餐、订单与流水
watch(
  () => props.recharge,
  (v) => {
    if (v) {
      pendingOrder.value = null;
      loadRecharge();
    }
  }
);

watch(
  () => props.usage,
  (v) => {
    if (v) loadUsage();
  }
);
</script>

<template>
  <!-- ============ 充值算力 ============ -->
  <el-dialog
    :model-value="recharge"
    width="860px"
    top="8vh"
    class="ac-dialog"
    :show-close="false"
    @update:model-value="emit('update:recharge', $event)"
  >
    <template #header>
      <div class="ac-head">
        <div>
          <h3 class="ac-title">充值算力 <span class="ac-bolt">⚡</span></h3>
          <p class="ac-sub">当前剩余 {{ store.balance || 0 }} 算力。套餐越大单价越低，额度长期有效。</p>
        </div>
        <div class="ac-head-right">
          <span class="ac-pill">我的算力 <b>⚡ {{ store.balance || 0 }}</b></span>
          <button class="ac-close" @click="emit('update:recharge', false)">✕</button>
        </div>
      </div>
    </template>

    <div class="ac-body">
      <div class="rc-grid">
        <div class="rc-left">
          <div class="rc-divider"><span>算力购买</span></div>
          <div class="rc-packages">
            <button
              v-for="p in plans"
              :key="p.id"
              class="rc-pkg"
              :class="{ on: selectedPlanId === p.id }"
              @click="pickPlan(p.id)"
            >
              <span v-if="p.hot" class="rc-pkg-tag">最划算</span>
              <span class="rc-pkg-amount"><i>⚡</i> {{ p.total.toLocaleString() }}</span>
              <span class="rc-pkg-price">¥ {{ p.price }}</span>
              <span class="rc-pkg-bonus">
                {{ p.credits.toLocaleString() }} 点
                <em v-if="p.bonus">+ 赠 {{ p.bonus.toLocaleString() }}</em>
              </span>
            </button>
          </div>
          <p v-if="selectedPlan" class="rc-tip">
            {{ selectedPlan.label }}：到手 {{ selectedPlan.total.toLocaleString() }} 算力，
            折合 <b>{{ selectedPlan.perUnit }}</b> 元/点
          </p>
        </div>

        <div class="rc-right">
          <div class="rc-qr-card">
            <div class="rc-qr">
              <svg viewBox="0 0 21 21" class="rc-qr-svg">
                <rect x="0" y="0" width="21" height="21" fill="#fff" />
                <g fill="#111827">
                  <rect x="0" y="0" width="7" height="7" />
                  <rect x="1" y="1" width="5" height="5" fill="#fff" />
                  <rect x="2" y="2" width="3" height="3" />
                  <rect x="14" y="0" width="7" height="7" />
                  <rect x="15" y="1" width="5" height="5" fill="#fff" />
                  <rect x="16" y="2" width="3" height="3" />
                  <rect x="0" y="14" width="7" height="7" />
                  <rect x="1" y="15" width="5" height="5" fill="#fff" />
                  <rect x="2" y="16" width="3" height="3" />
                </g>
                <g fill="#111827">
                  <rect v-for="(c, i) in qrCells" :key="i" :x="c.x" :y="c.y" width="1" height="1" />
                </g>
              </svg>
            </div>
            <div class="rc-qr-meta">
              <div class="rc-qr-amount">
                {{ selectedPlan ? selectedPlan.total.toLocaleString() : 0 }} 算力额度
              </div>
              <div class="rc-qr-price">¥ {{ selectedPlan ? selectedPlan.price : 0 }}</div>
            </div>
            <div class="rc-channels">
              <button
                class="rc-channel"
                :class="{ on: payChannel === 'wechat' }"
                @click="payChannel = 'wechat'"
              >
                微信支付
              </button>
              <button
                class="rc-channel"
                :class="{ on: payChannel === 'alipay' }"
                @click="payChannel = 'alipay'"
              >
                支付宝
              </button>
            </div>
            <button class="rc-pay" :disabled="busy || !selectedPlan" @click="generateQr">
              {{ pendingOrder ? "重新生成订单" : "生成支付二维码" }}
            </button>
            <button
              v-if="pendingOrder && (payInfo?.payUrl || payInfo?.qrCode)"
              class="rc-pay rc-pay-alt"
              :disabled="busy"
              @click="openPayUrl"
            >
              打开支付页面
            </button>
            <p class="rc-tip">
              <template v-if="payStatus && !payStatus.sandbox">
                请使用{{ payChannel === "wechat" ? "微信" : "支付宝" }}扫码或打开收银台完成支付
              </template>
              <template v-else>
                当前为沙箱演示模式：真实支付通道未配置，可点下方「模拟支付」走完整到账链路
              </template>
            </p>
            <button
              v-if="pendingOrder && payStatus?.sandbox"
              class="rc-simulate"
              :disabled="busy"
              @click="finishPay"
            >
              模拟支付（沙箱）
            </button>
            <p v-if="payInfo?.gateway" class="rc-tip rc-tip-order">
              支付通道：{{ payInfo.gateway }}
              <template v-if="payInfo.tradeNo"> · 流水号 {{ String(payInfo.tradeNo).slice(0, 24) }}</template>
            </p>
            <p v-if="orders.length" class="rc-tip rc-tip-order">
              最近订单：{{ orders[0].id.slice(0, 14) }}… · ¥{{ orders[0].price }} ·
              {{ orders[0].status === "paid" ? "已支付" : orders[0].status === "pending" ? "待支付" : "已取消" }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>

  <!-- ============ 使用记录 ============ -->
  <el-dialog
    :model-value="usage"
    width="900px"
    top="8vh"
    class="ac-dialog"
    :show-close="false"
    @update:model-value="emit('update:usage', $event)"
  >
    <template #header>
      <div class="ac-head">
        <div>
          <h3 class="ac-title">使用记录</h3>
          <p class="ac-sub">查看算力获取、消耗和过期记录。</p>
        </div>
        <button class="ac-close" @click="emit('update:usage', false)">✕</button>
      </div>
    </template>

    <div class="ac-body">
      <div class="us-stats">
        <div class="us-stat">
          <span class="us-stat-label">当前余额</span>
          <span class="us-stat-value">⚡ {{ usageStats.balance }}</span>
        </div>
        <div class="us-stat">
          <span class="us-stat-label">本月获取</span>
          <span class="us-stat-value">+{{ usageStats.gained }}</span>
        </div>
        <div class="us-stat">
          <span class="us-stat-label">本月消耗</span>
          <span class="us-stat-value">-{{ usageStats.spent }}</span>
        </div>
      </div>

      <div class="us-toolbar">
        <span class="us-toolbar-title">明细</span>
        <div class="us-toolbar-right">
          <button class="us-btn" @click="exportUsage">导出详情</button>
          <select v-model="usageRange" class="us-select">
            <option value="today">本日</option>
            <option value="week">近 7 天</option>
            <option value="month">本月</option>
          </select>
        </div>
      </div>

      <table class="us-table">
        <thead>
          <tr>
            <th>明细</th>
            <th>类型</th>
            <th>日期</th>
            <th class="ta-r">算力变化</th>
            <th class="ta-r">变动后余额</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="usageLoading">
            <td colspan="5" class="us-empty">加载中…</td>
          </tr>
          <tr v-else-if="!filteredUsage.length">
            <td colspan="5" class="us-empty">
              该时间段暂无记录。生成图片或充值后，这里会显示每一笔的来龙去脉。
            </td>
          </tr>
          <tr v-for="r in filteredUsage" v-else :key="r.id">
            <td>{{ r.name }}</td>
            <td>
              <span class="us-badge" :class="r.delta >= 0 ? 'in' : 'out'">{{ r.type }}</span>
            </td>
            <td class="us-date">{{ r.date }}</td>
            <td class="ta-r" :class="r.delta >= 0 ? 'us-plus' : 'us-minus'">
              {{ r.delta > 0 ? "+" : "" }}{{ r.delta }}
            </td>
            <td class="ta-r us-after">{{ r.balanceAfter }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </el-dialog>

  <!-- ============ 团队管理 ============ -->
  <el-dialog
    :model-value="team"
    width="900px"
    top="8vh"
    class="ac-dialog"
    :show-close="false"
    @update:model-value="emit('update:team', $event)"
  >
    <template #header>
      <div class="ac-head">
        <div>
          <h3 class="ac-title">团队管理</h3>
          <p class="ac-sub">通过手机号添加团队成员，统一查看成员算力消耗。</p>
        </div>
        <button class="ac-close" @click="emit('update:team', false)">✕</button>
      </div>
    </template>

    <div class="ac-body">
      <div class="tm-add">
        <div class="tm-add-title">添加团队成员</div>
        <div class="tm-add-row">
          <input v-model="newMember.name" class="tm-input" placeholder="成员名称（选填）" maxlength="20" />
          <div class="tm-phone">
            <span class="tm-prefix">+86</span>
            <input v-model="newMember.phone" class="tm-input tm-input-phone" placeholder="请输入团队成员手机号" />
          </div>
          <button class="tm-submit" @click="addMember">添加成员</button>
        </div>
        <p class="tm-hint">名称最多 20 个字符，添加后仍可修改。</p>
      </div>

      <div class="tm-list-title">团队成员 {{ members.length }}</div>
      <table class="us-table">
        <thead>
          <tr>
            <th>成员</th>
            <th>今日消耗</th>
            <th>本月消耗</th>
            <th>累计消耗</th>
            <th class="ta-r">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!members.length">
            <td colspan="5" class="us-empty">还没有团队成员，输入手机号添加第一位成员</td>
          </tr>
          <tr v-for="m in members" :key="m.id">
            <td>
              <span class="tm-name">{{ m.name }}</span>
              <span class="tm-phone-text">{{ m.phone }}</span>
            </td>
            <td>{{ m.today }}</td>
            <td>{{ m.month }}</td>
            <td>{{ m.total }}</td>
            <td class="ta-r">
              <button class="tm-remove" @click="removeMember(m)">移除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </el-dialog>

  <!-- ============ 微信连接 ============ -->
  <el-dialog
    :model-value="wechat"
    width="620px"
    top="12vh"
    class="ac-dialog"
    :show-close="false"
    @update:model-value="emit('update:wechat', $event)"
  >
    <template #header>
      <div class="ac-head">
        <div class="wc-head">
          <span class="wc-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M9 3C5.1 3 2 5.7 2 9c0 1.9 1 3.5 2.6 4.6L4 16l2.4-1.2c.8.2 1.7.3 2.6.3" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M15 8c3.9 0 7 2.5 7 5.6 0 1.6-.8 3-2.2 4l.4 2.1-2.3-1.1c-.9.2-1.9.4-2.9.4-3.9 0-7-2.5-7-5.4S11.1 8 15 8z" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
          <div>
            <h3 class="ac-title">使用微信连接 AI 创作台</h3>
            <p class="ac-sub">随时随地，继续创作</p>
          </div>
        </div>
        <button class="ac-close" @click="emit('update:wechat', false)">✕</button>
      </div>
    </template>

    <div class="ac-body">
      <div class="wc-card">
        <span class="wc-status-icon" :class="{ on: wechatConnected }">
          <svg v-if="wechatConnected" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 6L9 17l-5-5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <circle cx="12" cy="12" r="9" />
          </svg>
        </span>
        <div class="wc-status-body">
          <div class="wc-status-title">{{ wechatConnected ? "微信已连接" : "微信未连接" }}</div>
          <p class="wc-status-desc">
            {{
              wechatConnected
                ? "直接在微信发送消息或素材，内容会自动进入专属画布。发送「/新对话」可开始新画布。"
                : "连接后可直接在微信里发送素材和需求，内容会自动同步到你的画布。"
            }}
          </p>
          <div class="wc-actions">
            <button v-if="!wechatConnected" class="wc-primary" @click="connectWechat">连接微信</button>
            <template v-else>
              <button class="wc-primary" @click="emit('update:wechat', false); store.route = 'studio'">打开画布</button>
              <button class="wc-ghost" @click="disconnectWechat">退出连接</button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>
