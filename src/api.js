// 统一调用后端；生成走 SSE 流式接收进度
// 所有 /api 请求都带上本地会话令牌（服务端 Host/Origin 校验之外的二次防线）
import { normalizeMaterialCategory } from "./materials.js";

let sessionToken = "";
let sessionPromise = null;

async function ensureSession() {
  if (sessionToken) return sessionToken;
  if (!sessionPromise) {
    sessionPromise = fetch("/api/session", { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error("无法建立本地会话，请刷新页面重试");
        const body = await res.json();
        sessionToken = body.token || "";
        return sessionToken;
      })
      .catch((error) => {
        sessionPromise = null;
        throw error;
      });
  }
  return sessionPromise;
}

// 本地变更令牌：由 Electron 主进程经白名单 IPC 下发，写操作必须携带。
// 浏览器直连 / 开发态拿不到（服务端那时也不启用该门），所以这里「拿不到就跳过」，
// 而不是报错 —— 保持 `npm run dev` 与纯浏览器调试可用。
let mutationToken = "";
let mutationPromise = null;

async function ensureMutationToken() {
  if (mutationToken) return mutationToken;
  const bridge = typeof window !== "undefined" ? window.desktop : null;
  if (!bridge || typeof bridge.getMutationToken !== "function") return "";
  if (!mutationPromise) {
    mutationPromise = Promise.resolve()
      .then(() => bridge.getMutationToken())
      .then((value) => {
        mutationToken = typeof value === "string" ? value : "";
        return mutationToken;
      })
      .catch(() => {
        mutationPromise = null;
        return "";
      });
  }
  return mutationPromise;
}

export async function apiFetch(url, options = {}) {
  const token = await ensureSession();
  const mutation = await ensureMutationToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers["X-AI-Canvas-Token"] = token;
  if (mutation) headers["X-AI-Canvas-Mutation-Token"] = mutation;
  let res = await fetch(url, { credentials: "same-origin", ...options, headers });

  // 变更令牌失效（主进程重启过一轮）→ 只重取一次令牌并重试，
  // 免得用户看到「刷新页面」这种莫名其妙的提示。
  if (res.status === 403 && mutation) {
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    if (body?.code === "MUTATION_TOKEN_REQUIRED") {
      mutationToken = "";
      mutationPromise = null;
      const next = await ensureMutationToken();
      if (next && next !== mutation) {
        res = await fetch(url, {
          credentials: "same-origin",
          ...options,
          headers: { ...headers, "X-AI-Canvas-Mutation-Token": next }
        });
      }
    }
  }

  if (res.status === 401) {
    // 读服务端给出的具体原因，区分「会话失效」与「需要登录」
    let code = "SESSION_EXPIRED";
    let message = "会话已失效，请刷新页面后重试";
    try {
      const body = await res.clone().json();
      if (body?.code) code = body.code;
      if (body?.error) message = body.error;
    } catch {
      /* ignore */
    }
    const err = new Error(message);
    err.code = code;
    if (code === "LOGIN_REQUIRED") {
      sessionToken = "";
      sessionPromise = null;
    }
    throw err;
  }
  return res;
}

/**
 * 通知服务端取消任务。
 * 只 abort 本地 fetch 是不够的：服务端那条请求会继续跑完，
 * GPU 继续算、预扣的算力照扣 —— 用户看到的就是「取消了还扣钱」。
 * 返回 false 表示服务端已经没有这条任务（可能本来就跑完了），不算失败。
 */
export async function cancelServerTask(taskId) {
  if (!taskId) return false;
  try {
    const res = await apiFetch("/api/tasks/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId })
    });
    const body = await res.json().catch(() => ({}));
    return Boolean(body?.ok);
  } catch {
    return false;
  }
}

// ---------- 账号与登录 ----------
export async function fetchAuthStatus() {
  const res = await apiFetch("/api/auth/status");
  return res.json();
}

export async function setupAdmin(username, password) {
  const res = await apiFetch("/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  return res.json();
}

export async function loginAccount(username, password, remember = true) {
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // remember=true → 服务端发 30 天会话；这是"下次打开软件不用再登录"的关键
    body: JSON.stringify({ username, password, remember: Boolean(remember) })
  });
  return res.json();
}

export async function logoutAccount() {
  const res = await apiFetch("/api/auth/logout", { method: "POST" });
  return res.json();
}

export async function changePassword(oldPassword, newPassword) {
  const res = await apiFetch("/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oldPassword, newPassword })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || "修改失败");
  return body;
}

// ---------- 安全记录 ----------
export async function fetchAudit(params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== "" && v != null)
  ).toString();
  const res = await apiFetch(`/api/audit${qs ? `?${qs}` : ""}`);
  return res.json();
}

export async function fetchAuditStats(days = 7) {
  const res = await apiFetch(`/api/audit/stats?days=${days}`);
  return res.json();
}

export async function fetchSettings() {
  const res = await apiFetch("/api/settings");
  return res.json();
}

export async function fetchVersion() {
  const res = await apiFetch("/api/version");
  return res.json();
}

/**
 * 手机端联调信息：是否已开启局域网监听、本机私有网段地址、端口。
 * 设置页用它显示「手机填这个地址」，省得用户自己去 ipconfig 里翻（还会翻到虚拟网卡）。
 */
export async function fetchMobileInfo() {
  const res = await apiFetch("/api/m/info");
  return res.json();
}

export async function saveSettings(patch) {
  const res = await apiFetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  return res.json();
}

/**
 * 模型 API 连通性自检。
 *
 * 传 baseUrl / model / apiKey 时用「表单里当前的值」去探测，不落盘 —— 用户可以
 * 填完先测、通了再点保存。返回结构见 server/providers/probe.js：
 * { ok, code, message, hints[], latencyMs, models? }。
 */
export async function probeProvider(payload) {
  const res = await apiFetch("/api/providers/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, code: "HTTP", message: body?.message || `自检接口返回 ${res.status}`, hints: [] };
  }
  return body;
}

// ---------- 素材标签（颜色 / 品类 / 季节 / SKU） ----------

/** 写入素材标签。口径由服务端的 TAG_GROUPS 定义，前端只负责收集。 */
export async function setMaterialTags(url, tags) {
  const res = await apiFetch("/api/materials/tags", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, tags })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || "标签保存失败");
  return body;
}

/**
 * 删除素材。文件与标签一起清 —— 只清一半会留下「删了又回来」的垃圾。
 * 前端调用前须自行二次确认。
 */
export async function deleteMaterial(url) {
  const res = await apiFetch(`/api/materials?url=${encodeURIComponent(url)}`, { method: "DELETE" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || "删除失败");
  return body;
}

/**
 * 查一张产出图的「来源」（E6 资产血缘）。
 * 传入的是图片 url（/outputs/xxx.png）或裸文件名。
 * 查不到是**正常情况**（这张图可能是别人拷进来的），返回 null 而不是抛错。
 */
export async function fetchOutputMeta(urlOrFile) {
  const raw = String(urlOrFile || "");
  if (!raw) return null;
  const file = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  if (!file) return null;
  try {
    const res = await apiFetch(`/api/outputs/meta?file=${encodeURIComponent(file)}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.entry) return null;
    return body.entry;
  } catch {
    return null; // 没来源就不显示来源区，别让这张图的属性页整个挂掉
  }
}

export async function comfyStatus() {
  const res = await apiFetch("/api/comfyui/status");
  return res.json();
}

export async function securityStatus() {
  const res = await apiFetch("/api/security");
  return res.json();
}

// ---------- 模型网关（Sprint 1）----------
// 模型目录由服务端下发：能力 / 单价 / 限额 / 密钥是否已配置。
// 界面显示单价必须用这里的 cost，而不是再在前端写一份常量 ——
// 两处各写一个数就一定会漂移，最后变成「界面写 10、实际扣 20」。
export async function fetchModels({ kind = "" } = {}) {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  const res = await apiFetch(`/api/models${qs}`);
  return res.json();
}

/**
 * 编译提示词：把「参考图序列 + 用户原话 + 画幅 + 槽位标签」变成可直接执行的指令。
 * 纯计算接口（不扣费），适合在生成前反复预览。
 */
export async function compilePrompt(payload) {
  const res = await apiFetch("/api/prompt/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || "提示词编译失败");
  return body;
}

// ---------- 技能库（Sprint 2）----------
// 技能定义由服务端下发（参数定义 / 推荐模型 / 提示词链 / 建议节点图），
// 前端据 skillPlan 的 nodes/edges 一键铺画布，加技能不用改前端。
export async function fetchSkills({ category = "", kind = "" } = {}) {
  const qs = new URLSearchParams();
  if (category) qs.set("category", category);
  if (kind) qs.set("kind", kind);
  const suffix = qs.toString() ? `?${qs}` : "";
  const res = await apiFetch(`/api/skills${suffix}`);
  return res.json();
}

/** 生成技能执行计划（纯计算接口，可在生成前反复预览） */
export async function planSkill(id, params) {
  const res = await apiFetch("/api/skills/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, params: params || {} })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    const err = new Error(body.error || "技能规划失败");
    err.code = body.code || "SKILL_PLAN_FAILED";
    throw err;
  }
  return body;
}

export async function uploadImage(file) {
  const res = await apiFetch("/api/upload", {
    method: "POST",
    headers: { "Content-Type": file.type || "image/png" },
    body: file
  });
  if (!res.ok) throw new Error("上传失败");
  return res.json();
}

// ---------- 素材库 ----------
export async function fetchMaterials() {
  const res = await apiFetch("/api/materials");
  return res.json();
}

/**
 * 上传素材。
 *
 * ⚠️ 2026-10-14 修复：分类在这里**统一归一化**。
 * 之前调用方各写各的，甚至传过 "uploads"（不在服务端白名单里）→
 * 服务端 parseMaterialUrl 解析不出路径 → 画布上那张图是坏的。
 * 现在无论谁来调，非法分类一律回退到 other，从入口杜绝这类坏 URL。
 */
export async function uploadMaterial(file, category) {
  const cat = normalizeMaterialCategory(category);
  const res = await apiFetch(`/api/materials/upload?category=${encodeURIComponent(cat)}&name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "素材上传失败");
  }
  return res.json();
}

// ---------- SSE 解析 ----------
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      try {
        const parsed = { type: event, ...JSON.parse(data) };
        onEvent(parsed);
        // 生成结束给主进程一个信号：窗口在后台时弹系统通知。
        // 这里只上报**事实**（成功/失败、数量、文案），"该不该打扰"由主进程的
        // electron/tray.cjs 决定（前台不打扰、失败静音等策略都在那边，且被单测覆盖）。
        if (
          (parsed.type === "done" || parsed.type === "error") &&
          typeof window !== "undefined" &&
          window.desktop?.notifyTask
        ) {
          const list = Array.isArray(parsed.images)
            ? parsed.images
            : Array.isArray(parsed.videos)
              ? parsed.videos
              : [];
          const ok = parsed.type === "done";
          window.desktop.notifyTask({
            kind: ok ? "done" : "failed",
            count: list.length,
            title: ok ? "生成完成" : "生成失败",
            body: ok ? (list.length ? `本次完成 ${list.length} 项` : "任务已完成") : String(parsed.error || "任务未完成")
          });
        }
      } catch { /* ignore */ }
    }
  }
}

// ---------- 视频生成（SSE） ----------
export function generateVideoStream(payload, onEvent, opts = {}) {
  return apiFetch("/api/generate-video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: opts.signal
  }).then((res) => readSse(res, onEvent));
}

// onEvent: ({ type: 'progress'|'done'|'error', ... })
// opts.signal：传入 AbortSignal 即可中途取消（底部任务条的「取消」按钮）
export function generateStream(payload, onEvent, opts = {}) {
  return apiFetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: opts.signal
  }).then((res) => readSse(res, onEvent));
}

// ---------- 批量任务（P1-5：客户端编排 + 磁盘进度） ----------
export const batchCreate = (data) =>
  apiFetch("/api/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }).then((r) => r.json());

export const batchUpdate = (id, data) =>
  apiFetch(`/api/batch/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }).then((r) => r.json());

export const batchGet = (id) => apiFetch(`/api/batch/${encodeURIComponent(id)}`).then((r) => r.json());

export const batchList = () => apiFetch("/api/batch").then((r) => r.json());

export const batchRemove = (id) =>
  apiFetch(`/api/batch/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.json());

// ---------- 模板反哺（P2：画布 → 模板） ----------
export function saveTemplateFromProject(data) {
  return apiFetch("/api/templates/from-project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || "保存失败");
    return body;
  });
}

export function fetchTemplateGraph(id) {
  return apiFetch(`/api/templates/${encodeURIComponent(id)}/graph`).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || "模板没有节点图");
    return body;
  });
}

// ---------- 运营系统 ----------
async function adminReq(url, options = {}) {
  const res = await apiFetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error || "操作失败");
    err.code = body?.code;
    err.need = body?.need;
    throw err;
  }
  return body;
}

export const fetchMyPerms = () => adminReq("/api/auth/perms");
export const fetchAdminOverview = () => adminReq("/api/admin/overview");

function qs(params) {
  return new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== "" && v != null)
  ).toString();
}

export const fetchAccounts = (params = {}) => {
  const q = qs(params);
  return adminReq(`/api/admin/accounts${q ? `?${q}` : ""}`);
};
export const createAccount = (data) =>
  adminReq("/api/admin/accounts", { method: "POST", body: JSON.stringify(data) });
export const updateAccount = (id, data) =>
  adminReq(`/api/admin/accounts/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const removeAccount = (id) =>
  adminReq(`/api/admin/accounts/${id}`, { method: "DELETE" });
export const setAccountStatus = (id, status) =>
  adminReq(`/api/admin/accounts/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
export const resetAccountPassword = (id, password) =>
  adminReq(`/api/admin/accounts/${id}/reset`, {
    method: "POST",
    body: JSON.stringify({ password })
  });
export const kickAccount = (id) => adminReq(`/api/admin/accounts/${id}/kick`, { method: "POST" });

export const fetchRoles = () => adminReq("/api/admin/roles");
export const saveRole = (data) =>
  adminReq("/api/admin/roles", { method: "POST", body: JSON.stringify(data) });
export const removeRole = (id) => adminReq(`/api/admin/roles/${id}`, { method: "DELETE" });

export const fetchDepts = () => adminReq("/api/admin/depts");
export const saveDept = (data) =>
  adminReq("/api/admin/depts", { method: "POST", body: JSON.stringify(data) });
export const removeDept = (id) => adminReq(`/api/admin/depts/${id}`, { method: "DELETE" });

export const fetchAdminLogs = (params = {}) => {
  const q = qs(params);
  return adminReq(`/api/admin/logs${q ? `?${q}` : ""}`);
};

export const fetchApiKeys = () => adminReq("/api/admin/apikeys");

// ---------- 运营系统 · 客户中心（契约 2026-11-05 §1） ----------
export const fetchCustomers = (params = {}) => {
  const q = qs(params);
  return adminReq(`/api/admin/customers${q ? `?${q}` : ""}`);
};
export const fetchCustomer = (id) => adminReq(`/api/admin/customers/${encodeURIComponent(id)}`);
export const fetchCustomerMeta = () => adminReq("/api/admin/customers/meta");
export const updateCustomer = (id, data) =>
  adminReq(`/api/admin/customers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data)
  });
export const adjustCustomer = (id, { amount, reason }) =>
  adminReq(`/api/admin/customers/${encodeURIComponent(id)}/adjust`, {
    method: "POST",
    body: JSON.stringify({ amount, reason })
  });

// ---------- 运营系统 · 充值中心（契约 §2） ----------
export const fetchRechargeOrders = (params = {}) => {
  const q = qs(params);
  return adminReq(`/api/admin/recharge/orders${q ? `?${q}` : ""}`);
};
export const fetchRechargeStats = (days = 30) =>
  adminReq(`/api/admin/recharge/stats?days=${encodeURIComponent(days)}`);
export const fetchRechargePlans = () => adminReq("/api/admin/recharge/plans");
export const saveRechargePlans = (rows) =>
  adminReq("/api/admin/recharge/plans", { method: "PUT", body: JSON.stringify({ rows }) });

export const fetchAutomation = () => adminReq("/api/admin/recharge/automation");
export const saveAutomation = (config) =>
  adminReq("/api/admin/recharge/automation", { method: "PUT", body: JSON.stringify(config) });
export const runAutomation = () =>
  adminReq("/api/admin/recharge/automation/run", { method: "POST" });

export const manualPaidOrder = (id, reason) =>
  adminReq(`/api/admin/recharge/orders/${encodeURIComponent(id)}/manual-paid`, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
export const syncOrder = (id) =>
  adminReq(`/api/admin/recharge/orders/${encodeURIComponent(id)}/sync`, { method: "POST" });
export const refundOrder = (id, reason) =>
  adminReq(`/api/admin/recharge/orders/${encodeURIComponent(id)}/refund`, {
    method: "POST",
    body: JSON.stringify({ reason })
  });
export const noteOrder = (id, note) =>
  adminReq(`/api/admin/recharge/orders/${encodeURIComponent(id)}/note`, {
    method: "POST",
    body: JSON.stringify({ note })
  });

// ---------- 运营系统 · 聚合支付通道（契约 §3） ----------
export const fetchPaymentChannels = () => adminReq("/api/admin/payment/channels");
export const savePaymentChannels = (payload) =>
  adminReq("/api/admin/payment/channels", { method: "PUT", body: JSON.stringify(payload) });
export const testPaymentChannel = (provider) =>
  adminReq("/api/admin/payment/channels/test", {
    method: "POST",
    body: JSON.stringify({ provider })
  });

// ---------- 品牌（白标） ----------
export const fetchBrand = () => adminReq("/api/brand");

// ---------- 模板（服务端下发） ----------
export const fetchTemplates = (category = "") => {
  const q = category && category !== "all" ? `?category=${encodeURIComponent(category)}` : "";
  return adminReq(`/api/templates${q}`);
};

// ---------- 算力 ----------
export const fetchBalance = () => adminReq("/api/credits/balance");
export const fetchCreditRecords = (limit = 50) => adminReq(`/api/credits/records?limit=${limit}`);
export const fetchCostTable = () => adminReq("/api/credits/costs");

// ---------- 充值 ----------
export const fetchPlans = () => adminReq("/api/recharge/plans");
export const fetchOrders = () => adminReq("/api/recharge/orders");
export const createOrder = (planId) =>
  adminReq("/api/recharge/orders", { method: "POST", body: JSON.stringify({ planId }) });
export const cancelOrder = (id) =>
  adminReq(`/api/recharge/orders/${id}/cancel`, { method: "POST" });
// 沙箱模式下模拟一次「支付网关回调」。
// ⚠️ 它不是一个「前端标记已付」的后门：服务端会用沙箱私钥签发回调票据，
//    并走与真实支付完全相同的 验签 → 金额校验 → 幂等 链路；配置了真实凭证后该接口 403。
export const payOrder = (id, payMethod = "wechat") =>
  adminReq(`/api/recharge/orders/${id}/simulate-paid`, {
    method: "POST",
    body: JSON.stringify({ payMethod })
  });
// 真实支付：向服务端申请支付凭证/收银台链接。
// 返回 { ok, gateway, qrCode, payUrl, sandbox }：
//   - gateway="sandbox" 时模拟支付入口才会启用
//   - 聚合支付/支付宝直连返回 payUrl（跳转收银台）
//   - 微信直连返回 qrCode（二维码内容，前端负责渲染）
export const createPayment = (id, channel = "wechat") =>
  adminReq(`/api/recharge/orders/${id}/pay`, {
    method: "POST",
    body: JSON.stringify({ channel })
  });
// 当前支付模式（公开接口）：{ mode, sandbox, configured:{wechat,alipay,aggregator}, aggregator, hint }
export const fetchPayStatus = () => adminReq("/api/recharge/pay-status");
export const rotateApiKey = (id) =>
  adminReq(`/api/admin/apikeys/${id}/rotate`, { method: "POST" });

// ---------- 语义处理（豆包 2.1 / 任意 OpenAI 兼容 LLM） ----------
// task: optimize-prompt | selling-points | translate-prompt
// 返回 { ok, task, result, model, usage }；未配置 Key 时服务端返回 503 + code=LLM_NOT_CONFIGURED
export async function semanticTask({ task, text, context = {} }) {
  const res = await apiFetch("/api/ai/semantic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task, text, context })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `语义处理失败（${res.status}）`);
    err.code = data?.code || "LLM_FAILED";
    err.status = res.status;
    throw err;
  }
  return data;
}