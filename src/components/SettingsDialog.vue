<script setup>
import { reactive, ref, watch, computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { store, bridge } from "../store.js";
import { saveSettings, fetchVersion, fetchMobileInfo, probeProvider } from "../api.js";

const props = defineProps({ modelValue: Boolean });
const emit = defineEmits(["update:modelValue"]);

const vaultHint = computed(() => {
  const label = store.settings?.vault?.label || "本地加密存储";
  return `API Key 由「${label}」保管`;
});

// ---------- 版本与更新 ----------
const version = reactive({
  current: "—",
  latest: "",
  hasUpdate: false,
  notes: "",
  releasedAt: "",
  size: 0
});

async function loadVersion() {
  try {
    Object.assign(version, await fetchVersion());
  } catch { /* ignore */ }
}

function checkUpdate() {
  loadVersion();
  bridge.checkUpdate?.();
}

function fmtSize(n) {
  if (!n) return "";
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

onMounted(loadVersion);

// ---------- 手机端联调 ----------
// 手机（微信小程序）要连的是「这台电脑的局域网地址」，不是 127.0.0.1。
// 让用户自己去 ipconfig 里翻很容易填到虚拟网卡上（VMware/Docker/VPN 一堆），
// 所以服务端算好地址、这里直接显示，并给个复制按钮。
const mobileInfo = reactive({ loading: true, enabled: false, urls: [], hint: "", bind: "", port: 0 });

async function loadMobileInfo() {
  mobileInfo.loading = true;
  try {
    const j = await fetchMobileInfo();
    Object.assign(mobileInfo, {
      loading: false,
      enabled: Boolean(j.enabled),
      urls: Array.isArray(j.urls) ? j.urls : [],
      hint: j.hint || "",
      bind: j.bind || "",
      port: Number(j.port) || 0
    });
  } catch {
    mobileInfo.loading = false;
  }
}
onMounted(loadMobileInfo);

async function copyMobileUrl() {
  const url = mobileInfo.urls[0] || "";
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    ElMessage.success("地址已复制，粘到小程序「我的 - 服务端地址」里");
  } catch {
    ElMessage.info(`请手动复制：${url}`);
  }
}

const form = reactive({
  jiemengKey: "",
  jiemengModel: "doubao-seedream-4-0",
  openaiKey: "",
  openaiModel: "gpt-image-2",
  openaiBaseUrl: "https://api.openai.com/v1",
  geminiKey: "",
  geminiModel: "nano-banana-pro",
  geminiBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  // 语义处理（LLM）：豆包 2.1 或任意 OpenAI 兼容中转站
  // ⚠️ 豆包 2.1 是**语言模型**，只做语义处理（优化提示词 / 提炼卖点），不能出图；
  //    豆包出图是另一条线（Seedream，见上方「闭源 · 国内」）。
  llmKey: "",
  llmBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  llmModel: "doubao-seed-2-1-pro",
  // 上游模型名覆盖：中转站的名字与官方不同（如 google/gemini-3-pro-image），留空则用官方默认
  modelGooglePro: "",
  modelGoogle2: "",
  // Nano Banana 2.1：Google 没有公开这个型号名，默认先按 2.5-flash-image 走，
  // 走中转站就把它的叫法填进来（如 google/nano-banana-2.1）
  modelGoogle21: "",
  modelSeedream5: "",
});

watch(
  () => props.modelValue,
  (open) => {
    if (open && store.settings) {
      form.jiemengKey = store.settings.jiemeng?.apiKey || "";
      form.jiemengModel = store.settings.jiemeng?.model || "doubao-seedream-4-0";
      form.openaiKey = store.settings.openai?.apiKey || "";
      form.openaiModel = store.settings.openai?.model || "gpt-image-2";
      form.openaiBaseUrl = store.settings.openai?.baseUrl || "https://api.openai.com/v1";
      form.geminiKey = store.settings.gemini?.apiKey || "";
      form.geminiModel = store.settings.gemini?.model || "nano-banana-pro";
      form.geminiBaseUrl = store.settings.gemini?.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
      form.llmKey = store.settings.llm?.apiKey || "";
      form.llmBaseUrl = store.settings.llm?.baseUrl || "https://ark.cn-beijing.volces.com/api/v3";
      form.llmModel = store.settings.llm?.model || "doubao-seed-2-1-pro";
      const mo = store.settings.models || {};
      form.modelGooglePro = mo["nano-banana-pro"] || "";
      form.modelGoogle2 = mo["nano-banana-2"] || "";
    form.modelGoogle21 = mo["nano-banana-2.1"] || "";
      form.modelSeedream5 = mo["seedream-5-pro"] || "";
    }
  }
);

async function save() {
  store.settings = await saveSettings({
    jiemeng: { apiKey: form.jiemengKey, model: form.jiemengModel },
    openai: { apiKey: form.openaiKey, model: form.openaiModel, baseUrl: form.openaiBaseUrl },
    gemini: { apiKey: form.geminiKey, model: form.geminiModel, baseUrl: form.geminiBaseUrl },
    llm: { apiKey: form.llmKey, baseUrl: form.llmBaseUrl, model: form.llmModel },
    models: {
      "nano-banana-pro": form.modelGooglePro,
      "nano-banana-2": form.modelGoogle2,
      "nano-banana-2.1": form.modelGoogle21,
      "seedream-5-pro": form.modelSeedream5
    },
  });
  ElMessage.success("已保存到 ~/.ai-canvas/config.json");
  emit("update:modelValue", false);
}

// ---------- 接口自检 ----------
// 填完 Key / 地址 / 模型名，先测通再保存：自检不生成图片、不扣算力，
// 失败时会说明是 Key 错、地址错、模型没开通还是网络不通。
const probeState = reactive({
  openai: { loading: false, result: null },
  gemini: { loading: false, result: null },
  jiemeng: { loading: false, result: null },
  llm: { loading: false, result: null },
  comfyui: { loading: false, result: null }
});
const probeAllLoading = ref(false);
const probeAllSummary = ref("");

// 已保存的 Key 在界面上是掩码（sk-****），拿它去测必然 401：
// 掩码 → 不传（undefined），让服务端用保险箱里的真 Key；
// 空的输入框 → 传 null，表示"这次就是没有 Key"，服务端会明确报 NO_KEY，
// 而不是偷偷用旧 Key 返回"连通正常"（那种假成功最坑人）。
function keyOrUndefined(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  if (v.includes("****")) return undefined;
  return v;
}

function probePayload(name) {
  if (name === "openai") {
    return { provider: name, apiKey: keyOrUndefined(form.openaiKey), baseUrl: form.openaiBaseUrl, model: form.openaiModel };
  }
  if (name === "gemini") {
    return { provider: name, apiKey: keyOrUndefined(form.geminiKey), baseUrl: form.geminiBaseUrl, model: form.geminiModel };
  }
  if (name === "jiemeng") {
    return { provider: name, apiKey: keyOrUndefined(form.jiemengKey), model: form.jiemengModel };
  }
  if (name === "llm") {
    return { provider: name, apiKey: keyOrUndefined(form.llmKey), baseUrl: form.llmBaseUrl, model: form.llmModel };
  }
  return { provider: name };
}

const PROBE_NAMES = ["openai", "gemini", "jiemeng", "llm"];

async function testProvider(name) {
  const state = probeState[name];
  if (!state) return null;
  state.loading = true;
  try {
    state.result = await probeProvider(probePayload(name));
  } catch (error) {
    state.result = { ok: false, code: "NETWORK", message: `自检失败：${error?.message || error}`, hints: [] };
  } finally {
    state.loading = false;
  }
  return state.result;
}

async function testAll() {
  probeAllLoading.value = true;
  probeAllSummary.value = "";
  try {
    for (const name of PROBE_NAMES) {
      await testProvider(name);
    }
    const results = PROBE_NAMES.map((name) => ({ name, r: probeState[name].result }));
    const passed = results.filter((x) => x.r?.ok).length;
    const failed = results.filter((x) => x.r && !x.r.ok).map((x) => labelOf(x.name));
    probeAllSummary.value = failed.length
      ? `${passed}/${results.length} 项通过，待修：${failed.join("、")}`
      : `${passed}/${results.length} 项全部通过`;
  } finally {
    probeAllLoading.value = false;
  }
}

function labelOf(name) {
  return { openai: "OpenAI", gemini: "Gemini", jiemeng: "即梦", llm: "LLM", comfyui: "ComfyUI" }[name] || name;
}

</script>

<template>
  <el-drawer
    :model-value="modelValue"
    title="设置"
    size="420px"
    append-to-body
    class="settings-drawer"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-position="top" size="default" class="settings-form">
      <div class="probe-all">
        <el-button size="small" type="primary" plain :loading="probeAllLoading" @click="testAll">
          一键自检全部接口
        </el-button>
        <span class="probe-msg" :class="probeAllSummary.includes('待修') ? 'err' : 'ok'">
          {{ probeAllSummary }}
        </span>
      </div>
      <div class="version-note" style="margin-bottom: 14px">
        自检只做一次免费探测（列模型 / 1 个 token 的对话），<b>不生成图片、不扣算力</b>；
        用的是当前表单里的值，测通了再点保存。
      </div>

      <el-divider content-position="left">付费 · 国际</el-divider>
      <el-form-item label="OpenAI API Key（GPT Image 系列）">
        <el-input v-model="form.openaiKey" placeholder="sk-...（留空则不修改）" clearable />
      </el-form-item>
      <el-form-item label="GPT Image 模型">
        <el-select v-model="form.openaiModel" style="width: 100%">
          <el-option label="gpt-image-2" value="gpt-image-2" />
          <el-option label="gpt-image-2.5" value="gpt-image-2.5" />
          <el-option label="gpt-image-1" value="gpt-image-1" />
        </el-select>
      </el-form-item>
      <div class="probe-row">
        <el-button size="small" :loading="probeState.openai.loading" @click="testProvider('openai')">测试连接</el-button>
        <span class="probe-msg" :class="probeState.openai.result?.ok ? 'ok' : 'err'">
          {{ probeState.openai.result?.message || "" }}
        </span>
      </div>
      <ul v-if="probeState.openai.result?.hints?.length" class="probe-hints">
        <li v-for="(hint, i) in probeState.openai.result.hints" :key="i">{{ hint }}</li>
      </ul>
      <el-form-item label="Gemini API Key（Nano Banana 系列）">
        <el-input v-model="form.geminiKey" placeholder="AIza...（留空则不修改）" clearable />
      </el-form-item>
      <el-form-item label="Nano Banana 模型">
        <el-select v-model="form.geminiModel" style="width: 100%">
          <el-option label="nano-banana-pro" value="nano-banana-pro" />
          <el-option label="nano-banana-2" value="nano-banana-2" />
        </el-select>
      </el-form-item>
      <div class="probe-row">
        <el-button size="small" :loading="probeState.gemini.loading" @click="testProvider('gemini')">测试连接</el-button>
        <span class="probe-msg" :class="probeState.gemini.result?.ok ? 'ok' : 'err'">
          {{ probeState.gemini.result?.message || "" }}
        </span>
      </div>
      <ul v-if="probeState.gemini.result?.hints?.length" class="probe-hints">
        <li v-for="(hint, i) in probeState.gemini.result.hints" :key="i">{{ hint }}</li>
      </ul>

      <el-divider content-position="left">付费 · 国内</el-divider>
      <!-- 2026-10-23：用户要求去掉「通义万相」，设置项一并撤掉；
           服务端 provider 与注册表条目保留（hidden），老项目/老接口不受影响。 --><el-form-item label="Ark API Key（即梦 Seedream · 火山方舟）">
        <el-input v-model="form.jiemengKey" placeholder="火山方舟控制台获取，Bearer 鉴权" clearable />
      </el-form-item>
      <el-form-item label="即梦模型">
        <el-select v-model="form.jiemengModel" style="width: 100%">
          <el-option label="doubao-seedream-5-0-lite" value="doubao-seedream-5-0-lite" />
          <el-option label="doubao-seedream-4-5" value="doubao-seedream-4-5" />
          <el-option label="doubao-seedream-4-0" value="doubao-seedream-4-0" />
          <el-option label="doubao-seedream-3-0-t2i-250415（仅文生图）" value="doubao-seedream-3-0-t2i-250415" />
        </el-select>
      </el-form-item>
      <div class="probe-row">
        <el-button size="small" :loading="probeState.jiemeng.loading" @click="testProvider('jiemeng')">测试连接</el-button>
        <span class="probe-msg" :class="probeState.jiemeng.result?.ok ? 'ok' : 'err'">
          {{ probeState.jiemeng.result?.message || "" }}
        </span>
      </div>
      <ul v-if="probeState.jiemeng.result?.hints?.length" class="probe-hints">
        <li v-for="(hint, i) in probeState.jiemeng.result.hints" :key="i">{{ hint }}</li>
      </ul>

      <el-divider content-position="left">语义处理（豆包 2.1 / LLM）</el-divider>
      <div class="version-note" style="margin-bottom: 10px">
        豆包 2.1（Doubao-Seed-2.1 Pro/Turbo）是<b>语言模型</b>：用来把口语需求扩写成专业提示词、
        提炼卖点文案，<b>不能出图</b>。出图请用上面的 Seedream 或 Nano Banana。
        这里的接口是 OpenAI 兼容的 <code>/chat/completions</code>，官方方舟和中转站都能填。
      </div>
      <el-form-item label="API 地址">
        <el-input v-model="form.llmBaseUrl" placeholder="https://ark.cn-beijing.volces.com/api/v3" clearable />
      </el-form-item>
      <el-form-item label="模型名">
        <el-input v-model="form.llmModel" placeholder="doubao-seed-2-1-pro" clearable />
        <div style="margin-top: 6px; font-size: 12px; line-height: 1.6; opacity: 0.65">
          中转站请照抄它们文档里的名字，例如 <code>doubao-seed-2-1-pro</code> / <code>doubao-seed-2-1-turbo</code>
        </div>
      </el-form-item>
      <el-form-item label="API Key">
        <el-input v-model="form.llmKey" placeholder="方舟或中转站的 Key" clearable show-password />
      </el-form-item>
      <div class="probe-row">
        <el-button size="small" :loading="probeState.llm.loading" @click="testProvider('llm')">测试连接</el-button>
        <span class="probe-msg" :class="probeState.llm.result?.ok ? 'ok' : 'err'">
          {{ probeState.llm.result?.message || "" }}
        </span>
      </div>
      <ul v-if="probeState.llm.result?.hints?.length" class="probe-hints">
        <li v-for="(hint, i) in probeState.llm.result.hints" :key="i">{{ hint }}</li>
      </ul>

      <el-divider content-position="left">模型 ID 覆盖（接中转站必填）</el-divider>
      <div class="version-note" style="margin-bottom: 10px">
        界面上的模型名和上游真实模型名是两回事：官方叫 <code>gemini-3-pro-image-preview</code>，
        中转站可能叫 <code>google/gemini-3-pro-image</code>。<b>留空 = 用官方默认</b>，走中转站就照抄它的名字。
      </div>
      <el-form-item label="Nano Banana Pro">
        <el-input v-model="form.modelGooglePro" placeholder="gemini-3-pro-image-preview（留空用此默认）" clearable />
      </el-form-item>
      <el-form-item label="Nano Banana 2">
        <el-input v-model="form.modelGoogle2" placeholder="gemini-2.5-flash-image（留空用此默认）" clearable />
      </el-form-item>
      <el-form-item label="Nano Banana 2.1">
        <el-input
          v-model="form.modelGoogle21"
          placeholder="gemini-2.5-flash-image（留空用此默认；中转站叫法请照抄）"
          clearable
        />
      </el-form-item>
      <el-form-item label="豆包 Seedream 5.0 Pro">
        <el-input v-model="form.modelSeedream5" placeholder="doubao-seedream-5-0-pro（留空用此默认）" clearable />
      </el-form-item>

      <!-- 2026-10-23：本地 ComfyUI 模型已从界面下线（用户要求去掉 FLUX-2-Klein），
           设置项一并收起来，免得留一组"配了也用不上"的输入框。
           服务端 provider 与注册表条目仍保留（hidden）。 -->

      <el-divider content-position="left">手机端联调（微信小程序）</el-divider>
      <el-form-item label="状态">
        <div class="version-row">
          <span v-if="mobileInfo.loading">读取中…</span>
          <template v-else-if="mobileInfo.enabled">
            <span class="version-current">已开启</span>
            <span class="version-note-meta">监听 {{ mobileInfo.bind }}:{{ mobileInfo.port }}</span>
          </template>
          <span v-else class="version-note-meta">未开启（只监听本机，手机连不上）</span>
        </div>
      </el-form-item>
      <el-form-item v-if="mobileInfo.urls.length" label="手机填这个">
        <div class="version-row" style="flex-wrap: wrap; gap: 8px">
          <span class="version-current">{{ mobileInfo.urls[0] }}</span>
          <el-button size="small" @click="copyMobileUrl">复制</el-button>
        </div>
      </el-form-item>
      <el-form-item v-if="mobileInfo.hint" label="提示">
        <div class="version-note-body">{{ mobileInfo.hint }}</div>
      </el-form-item>
      <el-form-item v-else-if="mobileInfo.urls.length > 1" label="其它地址">
        <div class="version-note-body">
          {{ mobileInfo.urls.slice(1).join("　") }}
          <br />（多网卡时会列出多个，逐个试一下能通的那个）
        </div>
      </el-form-item>

      <!-- 2026-10-23：用户要求"没有更新版本号就不要出现这个"。
           版本号只有真正发版时才可信，平时挂着 v0.2.0 反而误导；
           这里不再显示当前版本，只留「检查更新」动作。
           有更新时仍然照常展示新版本号 / 体积 / 更新说明。 -->
      <el-divider content-position="left">版本与更新</el-divider>
      <el-form-item label="更新">
        <el-button size="small" @click="checkUpdate">检查更新</el-button>
      </el-form-item>
      <el-form-item v-if="version.hasUpdate" label="可用更新">
        <div class="version-note">
          <div class="version-note-title">
            v{{ version.latest }}
            <span v-if="version.size" class="version-note-meta">· {{ fmtSize(version.size) }}</span>
            <span v-if="version.releasedAt" class="version-note-meta">· {{ version.releasedAt }}</span>
          </div>
          <div v-if="version.notes" class="version-note-body">{{ version.notes }}</div>
        </div>
      </el-form-item>

      <el-button type="primary" style="width: 100%; margin-top: 8px" @click="save">保存设置</el-button>
      <el-text size="small" type="info" style="display: block; margin-top: 12px">
        {{ vaultHint }}：API Key 仅存于本机，后端代理直连各厂商，不经任何第三方服务器。
      </el-text>
    </el-form>
  </el-drawer>
</template>

<style scoped>
:deep(.el-drawer__header) {
  margin-bottom: 0;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
:deep(.el-drawer__title) {
  color: var(--text);
  font-weight: 700;
}
:deep(.el-drawer__body) {
  padding: 16px 20px 24px;
}

.version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
}

.version-current {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.version-note {
  width: 100%;
  padding: 10px 12px;
  border-radius: 10px;
  background: #fff7ed;
  border: 1px solid #fde3c8;
}

.version-note-title {
  font-size: 12.5px;
  font-weight: 700;
  color: #c2410c;
}

.version-note-meta {
  font-weight: 500;
  color: #ea580c;
  opacity: 0.85;
}

.version-note-body {
  margin-top: 4px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #9a3412;
}

/* ---------- 接口自检 ---------- */
.probe-all {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.probe-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: -6px 0 14px;
}

.probe-msg {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.probe-msg.ok {
  color: #15803d;
}

.probe-msg.err {
  color: #b91c1c;
}

.probe-hints {
  margin: -8px 0 14px;
  padding-left: 18px;
  font-size: 11.5px;
  line-height: 1.6;
  color: #6b7280;
}

.probe-hints li {
  margin-bottom: 2px;
}
</style>
