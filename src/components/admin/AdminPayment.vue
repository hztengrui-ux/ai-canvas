<script setup>
// 支付通道：当前模式 / 通道状态 / 聚合支付配置 / 连通性测试
// 接口依据：reports/ops-backend-2026-11-05/接口契约.md 第 3 节
import { ref, reactive, computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { fetchPaymentChannels, savePaymentChannels, testPaymentChannel } from "../../api.js";

const props = defineProps({ perms: { type: Array, default: () => [] } });
const can = (c) => props.perms.includes(c);
const canView = computed(() => can("admin:payment:view"));
const canConfig = computed(() => can("admin:payment:config"));

const loading = ref(false);
const saving = ref(false);
const loadError = ref("");
const data = ref(null); // {mode, sandbox, channels, hint}

const MODE_LABEL = {
  aggregator: "聚合支付",
  wechat: "微信支付直连",
  alipay: "支付宝直连",
  sandbox: "沙箱模式"
};
const PROVIDER_LABEL = { epay: "易支付（epay）", xunhupay: "虎皮椒（xunhupay）", custom: "自定义网关" };

const TESTING = { wechat: false, alipay: false, aggregator: false };
const testBusy = reactive({ ...TESTING });
const testResult = reactive({ wechat: null, alipay: null, aggregator: null });

const mode = ref("");
const agg = reactive({
  provider: "epay",
  gateway: "",
  pid: "",
  key: "",
  appid: "",
  appsecret: "",
  notifyBaseUrl: "",
  returnBaseUrl: "",
  // 聚合商的「支付方式」用后端协议里的类型名：wxpay / alipay（与 payment-aggregator.js 的 DEFAULT_METHODS 一致）
  methods: ["wxpay", "alipay"]
});
const clearKey = ref(false);
const clearAppsecret = ref(false);

const channels = computed(() => data.value?.channels || {});
const aggChannel = computed(() => channels.value.aggregator || {});
const wechat = computed(() => channels.value.wechat || {});
const alipay = computed(() => channels.value.alipay || {});

function pickChannelStatus(ch) {
  if (!ch || !Object.keys(ch).length) return { configured: false, detail: "" };
  const configured = !!ch.configured;
  const bits = [];
  if (ch.mchId) bits.push(`商户号 ${ch.mchId}`);
  else if (ch.mchIdSet) bits.push("商户号已配置");
  if (ch.appid) bits.push(`AppID ${ch.appid}`);
  else if (ch.appidSet) bits.push("AppID 已配置");
  if (ch.provider) bits.push(`服务商 ${PROVIDER_LABEL[ch.provider] || ch.provider}`);
  if (ch.gateway) bits.push(`网关 ${ch.gateway}`);
  return { configured, detail: bits.join(" · ") };
}

function failureText(ch) {
  // 后端可能返回配置缺失原因（契约未完全约定，存在则展示）
  return ch?.reason || ch?.message || "";
}

function applyChannel(r) {
  data.value = r || null;
  mode.value = r?.mode || "aggregator";
  const a = r?.channels?.aggregator || {};
  agg.provider = a.provider || "epay";
  agg.gateway = a.gateway || "";
  agg.pid = a.pid || "";
  agg.key = "";
  agg.appid = a.appid || "";
  agg.appsecret = "";
  agg.notifyBaseUrl = a.notifyBaseUrl || "";
  agg.returnBaseUrl = a.returnBaseUrl || "";
  agg.methods = Array.isArray(a.methods) && a.methods.length ? [...a.methods] : ["wxpay", "alipay"];
  clearKey.value = false;
  clearAppsecret.value = false;
  Object.assign(testResult, { wechat: null, alipay: null, aggregator: null });
}

async function load() {
  if (!canView.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    applyChannel(await fetchPaymentChannels());
  } catch (err) {
    loadError.value = err.message || "支付通道配置加载失败";
    ElMessage.error(loadError.value);
  } finally {
    loading.value = false;
  }
}

function toggleMethod(m) {
  const i = agg.methods.indexOf(m);
  if (i >= 0) agg.methods.splice(i, 1);
  else agg.methods.push(m);
}

async function save() {
  if (!canConfig.value) return;
  const gateway = agg.gateway.trim();
  if (gateway && !/^https?:\/\//i.test(gateway)) {
    return ElMessage.warning("网关地址需以 http:// 或 https:// 开头");
  }
  saving.value = true;
  try {
    const payload = {
      provider: mode.value,
      aggregator: {
        provider: agg.provider,
        gateway,
        pid: agg.pid.trim(),
        // 后端约定："" 表示不修改，__CLEAR__ 表示清除
        key: clearKey.value ? "__CLEAR__" : agg.key,
        appid: agg.appid.trim(),
        appsecret: clearAppsecret.value ? "__CLEAR__" : agg.appsecret,
        notifyBaseUrl: agg.notifyBaseUrl.trim(),
        returnBaseUrl: agg.returnBaseUrl.trim(),
        methods: [...agg.methods]
      }
    };
    const r = await savePaymentChannels(payload);
    ElMessage.success("支付配置已保存");
    if (r?.channels) {
      // 保存后以后端返回为准，但保留 mode 选择
      const keepMode = mode.value;
      applyChannel({ ...(data.value || {}), channels: r.channels, mode: keepMode });
    } else {
      agg.key = "";
      agg.appsecret = "";
      clearKey.value = false;
      clearAppsecret.value = false;
      load();
    }
  } catch (err) {
    ElMessage.error(err.message || "保存失败");
  } finally {
    saving.value = false;
  }
}

async function testChannel(provider) {
  if (!canConfig.value) return;
  testBusy[provider] = true;
  testResult[provider] = null;
  try {
    const r = await testPaymentChannel(provider);
    testResult[provider] = {
      ok: !!r?.ok,
      text: `${r?.ok ? "连通正常" : "连通失败"}${r?.latencyMs != null ? ` · ${r.latencyMs}ms` : ""}${r?.message ? ` · ${r.message}` : ""}`
    };
    if (r?.ok) ElMessage.success(`${MODE_LABEL[provider] || provider} 测试通过`);
    else ElMessage.warning(`${MODE_LABEL[provider] || provider} 测试未通过`);
  } catch (err) {
    testResult[provider] = { ok: false, text: err.message || "测试失败" };
    ElMessage.error(err.message || "测试失败");
  } finally {
    testBusy[provider] = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="ac-page">
    <div v-if="!canView" class="ad-empty">
      无权限查看支付通道（需要 <code>admin:payment:view</code>），请联系管理员分配权限。
    </div>

    <template v-else>
      <div class="pm-head">
        <h3>支付通道</h3>
        <div class="pm-head-ops">
          <button class="ac-btn" :disabled="loading" @click="load">{{ loading ? "加载中…" : "刷新" }}</button>
        </div>
      </div>

      <div v-if="loadError" class="pm-error">
        {{ loadError }}
        <button class="ac-act" @click="load">重试</button>
      </div>

      <div v-if="loading && !data" class="ad-empty">支付通道配置加载中…</div>

      <template v-else-if="data">
        <!-- 当前模式 -->
        <div class="pm-banner">
          <div class="pm-banner-main">
            <span class="pm-banner-label">当前生效模式</span>
            <b class="pm-mode">{{ MODE_LABEL[data.mode] || data.mode || "未配置" }}</b>
            <span v-if="data.sandbox" class="ac-tag pm-sandbox">沙箱环境</span>
          </div>
          <p v-if="data.hint" class="pm-hint">{{ data.hint }}</p>
        </div>

        <!-- 通道状态 -->
        <div class="pm-channels">
          <div v-for="c in [
            { key: 'wechat', label: '微信支付', ch: wechat },
            { key: 'alipay', label: '支付宝', ch: alipay },
            { key: 'aggregator', label: '聚合支付', ch: aggChannel }
          ]" :key="c.key" class="pm-channel">
            <div class="pm-channel-head">
              <b>{{ c.label }}</b>
              <span class="ac-status" :class="pickChannelStatus(c.ch).configured ? 'active' : 'disabled'">
                {{ pickChannelStatus(c.ch).configured ? "已配置" : "未配置" }}
              </span>
            </div>
            <div class="pm-channel-detail">
              {{ pickChannelStatus(c.ch).detail || "暂无配置信息" }}
            </div>
            <div v-if="failureText(c.ch)" class="pm-channel-fail">{{ failureText(c.ch) }}</div>
            <div class="pm-channel-foot">
              <button class="ac-btn" :disabled="!canConfig || testBusy[c.key]" @click="testChannel(c.key)">
                {{ testBusy[c.key] ? "测试中…" : "连通性测试" }}
              </button>
              <span
                v-if="testResult[c.key]"
                class="pm-test-result"
                :class="testResult[c.key].ok ? 'ok' : 'fail'"
              >{{ testResult[c.key].text }}</span>
            </div>
          </div>
        </div>

        <!-- 模式选择 -->
        <div class="pm-panel">
          <div class="pm-panel-head">
            <h4>支付模式</h4>
            <span class="ac-dim">保存后立即切换实际收款通道</span>
          </div>
          <div class="pm-modes">
            <label
              v-for="m in ['aggregator', 'wechat', 'alipay', 'sandbox']"
              :key="m"
              class="pm-mode-opt"
              :class="{ active: mode === m, disabled: !canConfig }"
            >
              <input v-model="mode" type="radio" :value="m" :disabled="!canConfig" />
              <span>
                <b>{{ MODE_LABEL[m] }}</b>
                <em>{{
                  m === "aggregator"
                    ? "通过易支付 / 虎皮椒 / 自定义网关统一收款"
                    : m === "wechat"
                      ? "微信商户号直连"
                      : m === "alipay"
                        ? "支付宝直连"
                        : "仅本地联调，不产生真实支付"
                }}</em>
              </span>
            </label>
          </div>
        </div>

        <!-- 聚合支付配置 -->
        <div class="pm-panel">
          <div class="pm-panel-head">
            <h4>聚合支付配置</h4>
            <span v-if="!canConfig" class="ac-dim">无配置权限</span>
          </div>
          <p class="ac-note">
            密钥只写不读：输入框留空表示保持原值，勾选「清除」才会删除已保存的密钥。微信 / 支付宝直连参数在服务端配置。
          </p>
          <div class="ac-form">
            <div class="ac-field-row">
              <label class="ac-field">
                <span>服务商</span>
                <select v-model="agg.provider" :disabled="!canConfig">
                  <option value="epay">易支付（epay）</option>
                  <option value="xunhupay">虎皮椒（xunhupay）</option>
                  <option value="custom">自定义网关</option>
                </select>
              </label>
              <label class="ac-field">
                <span>网关地址</span>
                <input
                  v-model="agg.gateway"
                  :disabled="!canConfig"
                  placeholder="https://pay.example.com/"
                  maxlength="200"
                />
              </label>
            </div>
            <div class="ac-field-row">
              <label class="ac-field">
                <span>商户 PID</span>
                <input v-model="agg.pid" :disabled="!canConfig" placeholder="聚合平台分配的商户号" maxlength="60" />
              </label>
              <label class="ac-field">
                <span>商户密钥 Key</span>
                <div class="pm-secret">
                  <input
                    v-model="agg.key"
                    :disabled="!canConfig || clearKey"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="aggChannel.keySet ? '已配置则留空表示不修改' : '请输入商户密钥（已配置则留空表示不修改）'"
                    maxlength="200"
                  />
                  <label v-if="aggChannel.keySet" class="pm-clear" :class="{ disabled: !canConfig }">
                    <input v-model="clearKey" type="checkbox" :disabled="!canConfig" />
                    清除
                  </label>
                </div>
              </label>
            </div>
            <div class="ac-field-row">
              <label class="ac-field">
                <span>应用 AppID</span>
                <input v-model="agg.appid" :disabled="!canConfig" placeholder="选填，部分网关需要" maxlength="80" />
              </label>
              <label class="ac-field">
                <span>应用密钥 AppSecret</span>
                <div class="pm-secret">
                  <input
                    v-model="agg.appsecret"
                    :disabled="!canConfig || clearAppsecret"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="aggChannel.appsecretSet ? '已配置则留空表示不修改' : '选填；已配置则留空表示不修改'"
                    maxlength="200"
                  />
                  <label v-if="aggChannel.appsecretSet" class="pm-clear" :class="{ disabled: !canConfig }">
                    <input v-model="clearAppsecret" type="checkbox" :disabled="!canConfig" />
                    清除
                  </label>
                </div>
              </label>
            </div>
            <div class="ac-field-row">
              <label class="ac-field">
                <span>异步通知地址（notify）</span>
                <input
                  v-model="agg.notifyBaseUrl"
                  :disabled="!canConfig"
                  placeholder="https://your.domain/api/pay/notify"
                  maxlength="200"
                />
              </label>
              <label class="ac-field">
                <span>同步返回地址（return）</span>
                <input
                  v-model="agg.returnBaseUrl"
                  :disabled="!canConfig"
                  placeholder="https://your.domain/pay/result"
                  maxlength="200"
                />
              </label>
            </div>
            <div class="ac-field">
              <span>启用的支付方式</span>
              <div class="pm-methods">
                <label v-for="m in [
                  { key: 'wxpay', label: '微信' },
                  { key: 'alipay', label: '支付宝' }
                ]" :key="m.key" class="pm-method" :class="{ disabled: !canConfig }">
                  <input
                    type="checkbox"
                    :checked="agg.methods.includes(m.key)"
                    :disabled="!canConfig"
                    @change="toggleMethod(m.key)"
                  />
                  {{ m.label }}
                </label>
                <span class="ac-dim">留空表示由网关默认支持</span>
              </div>
            </div>
            <div v-if="canConfig" class="pm-actions">
              <button class="ac-btn-primary" :disabled="saving" @click="save">
                {{ saving ? "保存中…" : "保存支付配置" }}
              </button>
              <span class="ac-dim">保存会同时切换上方选择的支付模式</span>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.pm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 0 12px;
}

.pm-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
}

.pm-head-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pm-error {
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

.pm-banner {
  margin-bottom: 12px;
  padding: 14px 16px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: #f5f9ff;
}

.pm-banner-main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pm-banner-label {
  font-size: 12px;
  color: #64748b;
}

.pm-mode {
  font-size: 15px;
  font-weight: 700;
  color: #1d4ed8;
}

.pm-sandbox {
  border-color: #fde68a !important;
  background: #fffbeb !important;
  color: #b45309 !important;
}

.pm-hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #475569;
}

.pm-channels {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 16px;
}

.pm-channel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid #e9edf3;
  border-radius: 10px;
  background: #fff;
}

.pm-channel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.pm-channel-head b {
  font-size: 13px;
  color: #0f172a;
}

.pm-channel-detail {
  flex: 1;
  font-size: 11.5px;
  line-height: 1.6;
  color: #64748b;
  word-break: break-all;
}

.pm-channel-fail {
  font-size: 11.5px;
  color: #b45309;
}

.pm-channel-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.pm-test-result {
  font-size: 11.5px;
}

.pm-test-result.ok {
  color: #059669;
}

.pm-test-result.fail {
  color: #dc2626;
}

.pm-panel {
  margin-bottom: 14px;
  padding: 14px 16px 16px;
  border: 1px solid #e9edf3;
  border-radius: 12px;
  background: #fff;
}

.pm-panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
}

.pm-panel-head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.pm-modes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.pm-mode-opt {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
  cursor: pointer;
  transition: all 0.14s ease;
}

.pm-mode-opt.active {
  border-color: var(--primary);
  background: #f5f9ff;
}

.pm-mode-opt.disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.pm-mode-opt input {
  margin-top: 2px;
}

.pm-mode-opt span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.pm-mode-opt b {
  font-size: 12.5px;
  font-weight: 600;
  color: #0f172a;
}

.pm-mode-opt em {
  font-style: normal;
  font-size: 11px;
  line-height: 1.5;
  color: #94a3b8;
}

.pm-secret {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pm-secret input {
  flex: 1;
  min-width: 0;
}

.pm-clear {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: #dc2626;
  cursor: pointer;
  white-space: nowrap;
}

.pm-clear.disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.pm-methods {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}

.pm-method {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: #334155;
  cursor: pointer;
}

.pm-method.disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.pm-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 4px;
}

:global(body.dark) .pm-head h3,
:global(body.dark) .pm-channel-head b,
:global(body.dark) .pm-panel-head h4,
:global(body.dark) .pm-mode-opt b {
  color: #e6e8ec;
}

:global(body.dark) .pm-channel,
:global(body.dark) .pm-panel,
:global(body.dark) .pm-mode-opt {
  background: #1a1a1a;
  border-color: #2e2e2e;
}

:global(body.dark) .pm-mode-opt.active {
  background: #16233a;
  border-color: var(--primary);
}

:global(body.dark) .pm-banner {
  background: #141c2b;
  border-color: #1e3a5f;
}

:global(body.dark) .pm-mode {
  color: #93c5fd;
}
</style>
