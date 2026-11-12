<script setup>
import { ref, computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { fetchAuthStatus, setupAdmin, loginAccount } from "../api.js";

const emit = defineEmits(["authed"]);

// 独立登录窗（Electron）：无边框，需要自备关闭按钮与拖拽区
const isStandaloneWindow = window.desktop?.windowMode === "login";
const closeWindow = () => window.desktop?.close?.();

const loading = ref(true);
const busy = ref(false);
const hasAccounts = ref(true);
const error = ref("");

const form = ref({ username: "", password: "", confirm: "" });
// 默认记住：桌面端每次开机都要求登录，体验上就是"这软件老要我登录"
const remember = ref(true);
const showPwd = ref(false);

// V1003.07：记住上次登录的账号名（只存用户名，绝不存密码）。
// 起因：server/accounts.js 的 sessions 是纯内存 Map，应用一重启登录态就丢，
// 每次开应用都要把账号密码重打一遍。这里把用户名补回来，密码仍由用户输入。
const LAST_USER_KEY = "ai-canvas.last-user";
try {
  const last = localStorage.getItem(LAST_USER_KEY);
  if (last) form.value.username = last;
} catch {
  /* 隐私模式 / 存储不可用时忽略即可 */
}

const isSetup = computed(() => !hasAccounts.value);

const canSubmit = computed(() => {
  const f = form.value;
  if (!f.username.trim() || !f.password) return false;
  if (isSetup.value && f.password !== f.confirm) return false;
  return true;
});

async function check() {
  loading.value = true;
  try {
    const s = await fetchAuthStatus();
    hasAccounts.value = s.hasAccounts;
    if (s.loggedIn) emit("authed", s.user);
  } catch {
    // 后端没起来时按「需要登录」展示，避免白屏
    hasAccounts.value = true;
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!canSubmit.value || busy.value) return;
  error.value = "";

  const username = form.value.username.trim();
  const password = form.value.password;

  if (isSetup.value && password !== form.value.confirm) {
    error.value = "两次输入的密码不一致";
    return;
  }

  busy.value = true;
  try {
    const res = isSetup.value
      ? await setupAdmin(username, password)
      : await loginAccount(username, password, remember.value);

    if (!res.ok) {
      error.value = res.error || "登录失败";
      return;
    }
    try {
      localStorage.setItem(LAST_USER_KEY, username);
    } catch {
      /* 存不下就算了 */
    }
    ElMessage.success(isSetup.value ? "管理员已创建" : "登录成功");
    emit("authed", res.user);
  } catch (e) {
    error.value = e.message || "请求失败，请检查服务是否已启动";
  } finally {
    busy.value = false;
  }
}

onMounted(check);
</script>

<!--
  登录 / 初始化页（2026-10-23 重做）

  用户原话：「现在登录页面不好看，不适合统一我们的色彩，不大气；
  可以参考图 1 图 2 的布局与色彩风格，主要是色彩与按钮风格」。
  参考稿的共同点：一侧大面积深色/留白 + 另一侧表单；按钮是大圆角；强调色只出现一两次。

  所以改成左右分屏：
    左（深墨黑舞台）— 品牌、口号、三条卖点、浮动卡片示意（呼应画布/批量）
    右（浅灰白面板）— 表单：标题大、留白足、胶囊输入框、荧光绿主按钮
  颜色全部走既定系统：墨黑 #15171E / 荧光绿 #D8FA34 / 中性灰底，不再出现蓝色渐变。

  窄窗（独立登录窗 440×620）自动塌成单列：深色舞台压成顶部品牌条，表单在下方，
  保证小窗里也不滚动、不拥挤。
-->
<template>
  <div class="lg-page" :class="{ 'lg-page--standalone': isStandaloneWindow }">
    <!-- 独立登录窗无边框：自备关闭按钮 -->
    <button v-if="isStandaloneWindow" class="lg-close" title="关闭" aria-label="关闭" @click="closeWindow">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" /></svg>
    </button>

    <!-- ================= 左：品牌舞台 ================= -->
    <aside class="lg-stage">
      <div class="lg-stage-glow" aria-hidden="true" />
      <div class="lg-stage-grid" aria-hidden="true" />

      <header class="lg-brand">
        <span class="lg-logo"><img src="/brand/logo-mark.png" alt="跨多多科技" /></span>
        <span class="lg-brand-text">
          <strong>跨多多科技</strong>
          <small>KUADUO TECH</small>
        </span>
      </header>

      <div class="lg-hero">
        <p class="lg-eyebrow">AI VISUAL STUDIO</p>
        <h1 class="lg-headline">
          让每一张商品图<br />
          都<span class="lg-mark">值得上架</span>
        </h1>
        <p class="lg-lede">换装、生图、详情页 —— 一个文件夹丢进来，整批跑完。</p>

        <ul class="lg-points">
          <li><i />文件夹批量出图，原图与结果左右对比</li>
          <li><i />本地部署，密钥与成图都不离开这台机器</li>
          <li><i />画布、批量、手机端共用同一套结果</li>
        </ul>
      </div>

      <!-- 浮动卡片：画布 / 批量的意象，纯 CSS，不加载图片 -->
      <!-- 结果预览卡：让左半屏有"产品在跑"的具体感，而不是三张小贴纸 -->
      <div class="lg-preview" aria-hidden="true">
        <div class="lg-preview-hd">
          <span class="lg-preview-title">批量结果</span>
          <span class="lg-preview-badge">已完成 12 / 48</span>
        </div>
        <div class="lg-preview-body">
          <div class="lg-preview-thumb"><span class="lg-preview-tag">原图</span></div>
          <span class="lg-preview-arrow">→</span>
          <div class="lg-preview-thumb lg-preview-thumb--result"><span class="lg-preview-tag lg-preview-tag--lime">结果</span></div>
        </div>
        <div class="lg-preview-ft">
          <span class="lg-preview-file">A组_毛衣_001.png</span>
          <span class="lg-preview-time">12.4s</span>
        </div>
        <div class="lg-preview-bar"><i /></div>
      </div>

      <footer class="lg-stage-foot">
        <span class="lg-chip">本地部署</span>
        <span class="lg-chip">密钥不出本机</span>
      </footer>
    </aside>

    <!-- ================= 右：表单面板 ================= -->
    <main class="lg-panel">
      <p class="lg-panel-tag">跨多多 AI 创作台</p>
      <div class="lg-form-wrap">
        <p class="lg-form-eyebrow">{{ isSetup ? "SETUP" : "SIGN IN" }}</p>
        <h2 class="lg-title">{{ isSetup ? "初始化管理员" : "欢迎回来" }}</h2>
        <p class="lg-sub">
          {{ isSetup ? "首次使用，设置一个管理员账号即可开始" : "输入账号密码继续" }}
        </p>

        <div v-if="loading" class="lg-loading">
          <span class="lg-spin" />
          <span>正在连接本地服务…</span>
        </div>

        <form v-else class="lg-form" @submit.prevent="submit">
          <label class="lg-field">
            <span class="lg-label">账号</span>
            <input
              v-model="form.username"
              type="text"
              autocomplete="username"
              placeholder="输入账号"
              :disabled="busy"
            />
          </label>

          <label class="lg-field">
            <span class="lg-label">密码</span>
            <span class="lg-pwd">
              <input
                v-model="form.password"
                :type="showPwd ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="输入密码"
                :disabled="busy"
              />
              <button type="button" class="lg-eye" @click="showPwd = !showPwd">
                {{ showPwd ? "隐藏" : "显示" }}
              </button>
            </span>
          </label>

          <label v-if="isSetup" class="lg-field">
            <span class="lg-label">确认密码</span>
            <input
              v-model="form.confirm"
              type="password"
              autocomplete="new-password"
              placeholder="再输入一次"
              :disabled="busy"
            />
          </label>

          <p v-if="error" class="lg-error">{{ error }}</p>

          <label v-if="!isSetup" class="lg-remember">
            <input v-model="remember" type="checkbox" />
            <span>记住这台设备（30 天免登录）</span>
          </label>

          <button class="lg-submit" type="submit" :disabled="!canSubmit || busy">
            <span v-if="busy" class="lg-spin lg-spin--dark" />
            <span>{{ busy ? "处理中…" : isSetup ? "创建并进入" : "登录" }}</span>
            <svg v-if="!busy" class="lg-arrow" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 10h11m0 0l-4.2-4.2M15 10l-4.2 4.2" />
            </svg>
          </button>
        </form>

        <p class="lg-hint">
          {{ isSetup ? "密码至少 6 位，以加盐哈希保存在本机" : "登录行为会记入安全日志" }}
        </p>
      </div>

      <p class="lg-foot">跨多多 AI 创作台 · 本地部署，数据只在这台电脑</p>
    </main>
  </div>
</template>

<style scoped>
/* ============================ 布局 ============================ */
.lg-page {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(0, 1.06fr) minmax(420px, 0.94fr);
  background: #f4f6f8;
  color: #15171e;
  overflow: hidden;
}

/* ============================ 左：舞台 ============================ */
.lg-stage {
  position: relative;
  padding: 44px 56px 40px;
  display: flex;
  flex-direction: column;
  background: linear-gradient(105deg, #1b1e26 0%, #15171e 46%, #101216 100%);
  color: #f2f4f7;
  overflow: hidden;
  isolation: isolate;
}

/* 两层光：左上荧光绿薄雾 + 右下冷灰，制造纵深但不抢字 */
.lg-stage-glow {
  position: absolute;
  inset: -20% -10% auto -20%;
  height: 90%;
  background:
    radial-gradient(660px 380px at 12% 4%, rgba(216, 250, 52, 0.32), rgba(216, 250, 52, 0) 66%),
    radial-gradient(520px 420px at 98% 92%, rgba(216, 250, 52, 0.14), rgba(216, 250, 52, 0) 62%),
    radial-gradient(760px 460px at 92% 78%, rgba(120, 132, 150, 0.3), rgba(120, 132, 150, 0) 68%);
  z-index: -1;
}

/* 极淡网格：让深色块有"画布"的质感 */
.lg-stage-grid {
  position: absolute;
  inset: 0;
  z-index: -1;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.045) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(76% 62% at 32% 28%, #000 30%, transparent 78%);
  -webkit-mask-image: radial-gradient(76% 62% at 32% 28%, #000 30%, transparent 78%);
}

.lg-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
}
.lg-logo {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: #ffffff;
  display: grid;
  place-items: center;
  box-shadow: 0 10px 26px -16px rgba(0, 0, 0, 0.9);
}
.lg-logo img {
  width: 24px;
  height: 24px;
  display: block;
}
.lg-brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.lg-brand-text strong {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.lg-brand-text small {
  font-size: 10.5px;
  letter-spacing: 2.4px;
  color: rgba(242, 244, 247, 0.5);
  margin-top: 3px;
}

.lg-hero {
  margin-top: clamp(28px, 9vh, 86px);
  max-width: 560px;
}
.lg-eyebrow {
  margin: 0 0 18px;
  font-size: 10.5px;
  letter-spacing: 3px;
  color: rgba(216, 250, 52, 0.9);
  font-weight: 600;
}
.lg-headline {
  margin: 0;
  font-size: clamp(30px, 3.1vw, 50px);
  line-height: 1.14;
  font-weight: 800;
  letter-spacing: -1.2px;
}
.lg-mark {
  position: relative;
  color: #d8fa34;
  white-space: nowrap;
}
.lg-mark::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 4px;
  height: 8px;
  background: rgba(216, 250, 52, 0.18);
  border-radius: 4px;
  z-index: -1;
}
.lg-lede {
  margin: 18px 0 0;
  font-size: 14px;
  line-height: 1.8;
  color: rgba(226, 231, 238, 0.66);
  max-width: 420px;
}

.lg-points {
  margin: 26px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.lg-points li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: rgba(226, 231, 238, 0.78);
}
.lg-points i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d8fa34;
  flex: 0 0 auto;
  box-shadow: 0 0 0 4px rgba(216, 250, 52, 0.12);
}

/* 结果预览卡：左下角一张"正在跑批"的示意卡，撑住左半屏的分量 */
.lg-preview {
  position: absolute;
  right: 40px;
  bottom: 64px;
  width: 336px;
  padding: 14px 16px 16px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.035));
  backdrop-filter: blur(10px);
  box-shadow: 0 30px 70px -34px rgba(0, 0, 0, 0.9);
  transform: rotate(-1.6deg);
  pointer-events: none;
}
.lg-preview-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.lg-preview-title {
  font-size: 12px;
  font-weight: 700;
  color: rgba(242, 244, 247, 0.92);
}
.lg-preview-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 7px;
  background: rgba(216, 250, 52, 0.92);
  color: #15171e;
}
.lg-preview-body {
  display: flex;
  align-items: center;
  gap: 10px;
}
.lg-preview-thumb {
  position: relative;
  flex: 1;
  height: 92px;
  border-radius: 12px;
  background: linear-gradient(140deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.05));
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.lg-preview-thumb--result {
  background:
    linear-gradient(140deg, rgba(216, 250, 52, 0.5) 0%, rgba(188, 230, 0, 0.16) 46%, rgba(21, 23, 30, 0.5) 100%),
    rgba(21, 23, 30, 0.35);
  border-color: rgba(216, 250, 52, 0.45);
  box-shadow: 0 14px 34px -22px rgba(188, 230, 0, 0.7);
}
.lg-preview-tag {
  position: absolute;
  left: 8px;
  top: 8px;
  font-size: 9px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(21, 23, 30, 0.55);
  color: #fff;
}
.lg-preview-tag--lime {
  background: #15171e;
  color: #d8fa34;
}
.lg-preview-arrow {
  font-size: 12px;
  color: rgba(242, 244, 247, 0.4);
}
.lg-preview-ft {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  font-size: 10.5px;
  color: rgba(226, 231, 238, 0.66);
}
.lg-preview-file {
  font-family: ui-monospace, Consolas, monospace;
}
.lg-preview-bar {
  margin-top: 10px;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}
.lg-preview-bar i {
  display: block;
  width: 25%;
  height: 100%;
  border-radius: 2px;
  background: #d8fa34;
}

.lg-stage-foot {
  margin-top: auto;
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}
.lg-chip {
  font-size: 10.5px;
  letter-spacing: 0.4px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: rgba(226, 231, 238, 0.7);
}

/* ============================ 右：表单 ============================ */
.lg-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  padding: clamp(72px, 13vh, 132px) clamp(32px, 5vw, 76px) 64px;
  background:
    radial-gradient(420px 260px at 100% 0%, #ffffff, rgba(255, 255, 255, 0) 60%),
    #f4f6f8;
}
.lg-panel-tag {
  position: absolute;
  left: clamp(32px, 5vw, 76px);
  top: 34px;
  margin: 0;
  font-size: 10.5px;
  letter-spacing: 2.2px;
  font-weight: 700;
  color: #a6adbd;
}
.lg-form-wrap {
  width: 100%;
  max-width: 372px;
  margin: 0 auto;
}
.lg-form-eyebrow {
  margin: 0 0 10px;
  font-size: 10.5px;
  letter-spacing: 2.6px;
  font-weight: 700;
  color: #838ca0;
}
.lg-title {
  margin: 0;
  font-size: 30px;
  line-height: 1.2;
  font-weight: 800;
  letter-spacing: -0.6px;
  color: #15171e;
}
.lg-sub {
  margin: 10px 0 28px;
  font-size: 13.5px;
  line-height: 1.7;
  color: #7b8496;
}

.lg-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.lg-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lg-label {
  font-size: 12.5px;
  font-weight: 650;
  color: #5a6274;
}
.lg-field input {
  height: 48px;
  padding: 0 16px;
  border-radius: 13px;
  border: 1px solid #e2e6eb;
  background: #ffffff;
  font-size: 14px;
  color: #15171e;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
  font-family: inherit;
}
.lg-field input::placeholder {
  color: #aab1bf;
}
.lg-field input:hover:not(:disabled) {
  border-color: #cfd5dd;
}
.lg-field input:focus {
  border-color: #bce600;
  box-shadow: 0 0 0 4px rgba(216, 250, 52, 0.28);
}
.lg-field input:disabled {
  background: #f5f7f9;
  color: #97a0af;
}

.lg-pwd {
  position: relative;
  display: block;
}
.lg-pwd input {
  width: 100%;
  padding-right: 58px;
}
.lg-eye {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  height: 32px;
  padding: 0 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: #838ca0;
  font-size: 12px;
  cursor: pointer;
}
.lg-eye:hover {
  background: #f2f4f7;
  color: #15171e;
}

.lg-remember {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: #5a6274;
  cursor: pointer;
  user-select: none;
  margin-top: -2px;
}
.lg-remember input {
  width: 15px;
  height: 15px;
  accent-color: #bce600;
  cursor: pointer;
}

.lg-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(224, 85, 63, 0.08);
  border: 1px solid rgba(224, 85, 63, 0.22);
  color: #c0392b;
  font-size: 12.5px;
  line-height: 1.6;
}

.lg-submit {
  margin-top: 6px;
  height: 50px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: none;
  border-radius: 13px;
  background: #d8fa34;
  color: #15171e;
  font-size: 14.5px;
  font-weight: 750;
  letter-spacing: 0.3px;
  cursor: pointer;
  box-shadow: 0 14px 30px -18px rgba(188, 230, 0, 0.95);
  transition: transform 0.12s ease, background 0.15s ease, box-shadow 0.15s ease;
  font-family: inherit;
}
.lg-submit:hover:not(:disabled) {
  background: #bce600;
  transform: translateY(-1px);
  box-shadow: 0 18px 34px -18px rgba(188, 230, 0, 0.95);
}
.lg-submit:active:not(:disabled) {
  transform: translateY(0);
}
.lg-submit:disabled {
  background: #e6e9ee;
  color: #9aa3b2;
  cursor: not-allowed;
  box-shadow: none;
}
.lg-arrow {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.lg-hint {
  margin: 16px 0 0;
  font-size: 11.5px;
  color: #97a0af;
  line-height: 1.6;
}

.lg-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: #5a6274;
  padding: 18px 0;
}

.lg-foot {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 18px;
  text-align: center;
  font-size: 11px;
  color: #a6adbd;
}

.lg-spin {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(21, 23, 30, 0.18);
  border-top-color: #15171e;
  animation: lg-spin 0.8s linear infinite;
}
.lg-spin--dark {
  border-color: rgba(21, 23, 30, 0.25);
  border-top-color: #15171e;
}
@keyframes lg-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 独立登录窗：无边框，自备关闭按钮 */
.lg-close {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  border: 1px solid #e2e6eb;
  background: #ffffff;
  color: #5a6274;
  display: grid;
  place-items: center;
  cursor: pointer;
}
.lg-close:hover {
  background: #f2f4f7;
  color: #15171e;
}
.lg-close svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
}

/* ============================ 窄窗塌成单列 ============================ */
@media (max-width: 980px) {
  .lg-page {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    overflow: auto;
  }
  .lg-stage {
    padding: 20px 22px 26px;
    gap: 0;
  }
  .lg-brand {
    width: 100%;
    align-items: center;
  }
  .lg-brand-text small {
    margin-top: 2px;
    font-size: 9.5px;
    letter-spacing: 2px;
  }
  .lg-logo {
    width: 34px;
    height: 34px;
    border-radius: 10px;
  }
  .lg-logo img {
    width: 20px;
    height: 20px;
  }
  /* 小窗只留品牌条：标题交给右侧表单，深色条保持"一条墨黑带"最干净 */
  .lg-hero,
  .lg-preview,
  .lg-stage-foot,
  .lg-panel-tag {
    display: none;
  }
  .lg-stage {
    /* 实测这里会塌成"只有 padding"的高度（grid auto 行按内容算时没算进 flex 子项），
       品牌文字于是被 overflow:hidden 裁掉下半截。给一个下限最省事也最稳。 */
    min-height: 82px;
    padding-bottom: 22px;
  }
  .lg-brand-text strong {
    font-size: 14px;
  }
  /* 小窗里深色条只保留墨黑，绿光会把顶部染成橄榄色，显得脏 */
  .lg-stage-glow {
    display: none;
  }
  .lg-panel {
    padding: 26px 22px 34px;
    justify-content: flex-start;
  }
  .lg-foot {
    position: static;
    margin-top: 22px;
  }
  .lg-title {
    font-size: 24px;
  }
  .lg-sub {
    margin-bottom: 20px;
  }
  .lg-field input {
    height: 44px;
  }
  .lg-submit {
    height: 46px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lg-submit,
  .lg-field input {
    transition: none;
  }
}
</style>
