// 手机端「出图」作业注册表
//
// 为什么不让小程序自己调 /api/generate 解 SSE：
//   1. 小程序要自己拼 SSE 分帧、还得处理 UTF-8 分片截断（中文进度文案会被从中间切开）；
//   2. 页面一被切到后台，wx.request 的长连接就断了，任务等于白跑；
//   3. 断线重连后拿不回进度。
//
// 所以做法是：小程序只发「提交 + 轮询」两个简单请求，**服务端替它跑 SSE**：
//   POST /api/m/jobs  →  服务端内部用**该用户自己的 mobile token** 调 /api/generate
//                        （计费/幂等/退款/取消 全部沿用原逻辑，一行不用改）
//                    →  进度写进 Map，小程序每 1.5s 轮询 /api/m/jobs/:id
//
// 关键点：内部这一跳带的是**手机用户的令牌**，不是机器令牌。
// 否则扣费会记到「本机 local 账号」头上，多账号场景直接把账算错人。
import crypto from "node:crypto";
import * as gateway from "./gateway.js";
import { mutationToken } from "./security.js";

/** 最多保留多少个作业（手机端看进度用，不需要长期存储） */
const MAX_JOBS = 60;
/** 作业保留时长：30 分钟。超过就清掉，内存不涨。 */
const JOB_TTL = 30 * 60 * 1000;
/** 进度只留最后 40 条：小程序只渲染 3 条，留太多纯属浪费内存 */
const MAX_PROGRESS = 40;

const jobs = new Map();

function pushProgress(job, text) {
  const t = String(text || "").trim();
  if (!t) return;
  job.progress.push({ text: t.slice(0, 300), at: Date.now() });
  if (job.progress.length > MAX_PROGRESS) job.progress.splice(0, job.progress.length - MAX_PROGRESS);
  job.updatedAt = Date.now();
}

/** 清理过期 / 超额作业 */
export function sweep(now = Date.now()) {
  let removed = 0;
  for (const [id, job] of jobs) {
    const finished = job.state === "done" || job.state === "error" || job.state === "canceled";
    if (finished && now - job.updatedAt > JOB_TTL) {
      jobs.delete(id);
      removed += 1;
    }
  }
  if (jobs.size > MAX_JOBS) {
    // 先删最老的已结束作业
    const finished = [...jobs.entries()]
      .filter(([, j]) => j.state !== "queued" && j.state !== "running")
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id] of finished) {
      if (jobs.size <= MAX_JOBS) break;
      jobs.delete(id);
      removed += 1;
    }
  }
  return removed;
}

export function activeCountOf(userId) {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.userId === userId && (job.state === "queued" || job.state === "running")) n += 1;
  }
  return n;
}

/** 对外投影：不要把 controller / token 这类的内部字段漏出去 */
function project(job) {
  if (!job) return null;
  return {
    id: job.id,
    state: job.state,
    progress: job.progress.slice(-3),
    images: job.images,
    cost: job.cost,
    balance: job.balance,
    error: job.error,
    createdAt: job.createdAt,
    endedAt: job.endedAt
  };
}

export function get(id, userId, isSuper = false) {
  const job = jobs.get(String(id || ""));
  if (!job) return null;
  // 别人的作业不给看 —— 同一台机器多账号时这是硬边界
  if (job.userId !== userId && !isSuper) return null;
  return project(job);
}

export function create({ userId, token, payload, selfBase, balance = 0, isSuper = false }) {
  const prompt = String(payload?.prompt || "").trim();
  if (!prompt) return { ok: false, code: "BAD_PROMPT", error: "提示词不能为空" };
  if (!token) return { ok: false, code: "NO_TOKEN", error: "会话无效，请重新登录" };

  const n = Math.min(Math.max(Math.round(Number(payload?.n) || 1), 1), 4);
  const id = `j_${crypto.randomBytes(8).toString("hex")}`;
  const job = {
    id,
    userId,
    token,
    state: "queued",
    progress: [],
    images: [],
    cost: 0,
    // 先把提交时的余额带上：失败时也能告诉用户"你现在还有多少"，
    // 否则前端拿到 balance:0 会以为账被清了。
    balance: Number(balance) || 0,
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: 0,
    controller: new AbortController()
  };
  jobs.set(id, job);
  pushProgress(job, "已提交，排队中…");

  // 不 await：立刻把 jobId 还给小程序，剩下的在后台跑
  runJob(job, { prompt, payload, n, selfBase }).catch((err) => {
    if (job.state === "canceled") return;
    job.state = "error";
    job.error = err?.message || String(err);
    job.endedAt = Date.now();
    job.updatedAt = Date.now();
    pushProgress(job, `失败：${job.error}`);
  });

  return { ok: true, job: { id, state: job.state, cost: 0 } };
}

/** 内部：真正去调 /api/generate 并把 SSE 转成作业状态 */
async function runJob(job, { prompt, payload, n, selfBase }) {
  // 没指定模型时给一个默认值。
  // 不补这一步的话，/api/generate 会因为「provider 为空 + model 为空」直接报
  // 「未知提供方」—— 用户明明看到有模型可选，却因为没点就被拒，是纯粹的体验倒退。
  // 优先挑「已配置密钥」的模型，挑不到就挑第一个，让失败信息落在"没配密钥"上而不是"未知提供方"。
  let provider = String(payload?.provider || "");
  let model = String(payload?.model || "");
  if (!model) {
    try {
      const list = (gateway.catalog({ kind: "image" }).models || []).filter((m) => m.kind === "image");
      // 优先「已配置密钥」的模型 → 其次非 ComfyUI（ComfyUI 是可选的本机 GPU 服务，
      // 没装它的人看到"ComfyUI 不可达"会一头雾水）→ 最后才是第一个。
      const withKey = list.filter((m) => m.hasKey);
      const preferred = withKey[0] || list.find((m) => m.provider !== "comfyui") || list[0];
      if (preferred) {
        model = preferred.id;
        if (!provider) provider = preferred.provider;
      }
    } catch {
      /* 目录取不到就维持空值，让 /api/generate 自己报错 */
    }
  }

  const body = {
    provider,
    model,
    prompt,
    n,
    size: String(payload?.size || "1024x1024"),
    referenceImages: Array.isArray(payload?.referenceUrls) ? payload.referenceUrls.filter(Boolean).slice(0, 3) : [],
    remark: String(payload?.remark || "").slice(0, 200),
    // 让服务端把这次生成登记进 tasks 注册表：取消时才能真正停掉上游并退回预扣
    taskId: job.id
  };

  job.state = "running";
  job.updatedAt = Date.now();
  pushProgress(job, model ? `开始生成（${model}）…` : "开始生成…");

  const res = await fetch(`${selfBase}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // ⚠️ 用手机用户自己的令牌，不能用机器令牌：否则扣费记到本机 local 账号上
      "X-AI-Canvas-Token": job.token,
      // ⚠️ 变更令牌：桌面版（Electron）会注入它并开启变更门，/api/generate 是受保护写接口。
      // 手机请求本身不带这枚令牌（它只在主进程内存里），但这一跳是**服务端自己发起的内部调用**，
      // 属于可信来源，所以由服务端补上。少了这一行，桌面版里手机端就是
      // "能登录、能看图，一点出图就 403" —— 而且日志里只会看到一条 MUTATION_TOKEN_REQUIRED，
      // 极难联想到是手机端的问题。
      ...(mutationToken() ? { "X-AI-Canvas-Mutation-Token": mutationToken() } : {}),
      // Host 校验：自调走回环，这里给的是 127.0.0.1:PORT，本身就在允许端口里
      Accept: "text/event-stream"
    },
    body: JSON.stringify(body),
    signal: job.controller.signal
  });

  if (!res.ok) {
    let msg = `生成接口返回 ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* 不是 JSON 就用状态码 */
    }
    throw new Error(msg);
  }
  if (!res.body) throw new Error("服务端没有返回事件流");

  // ---- SSE 解析 ----
  // Node 的 fetch body 是「按字节的异步可迭代」，一个 chunk 可能把一行中文切成两半，
  // 所以必须用 TextDecoder({stream:true}) 累积解码，不能每个 chunk 各自 toString。
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleEventBlock(job, block);
      if (job.state === "done" || job.state === "error") return;
      idx = buffer.indexOf("\n\n");
    }
  }
  // 流结束了还没收到 done/error —— 说明连接被掐断，别假装成功
  if (job.state === "running") {
    throw new Error("生成连接中断，请重试（若已扣费会自动退回）");
  }
}

function handleEventBlock(job, block) {
  const evMatch = /^event:\s*(\S+)/m.exec(block);
  const dataMatch = /^data:\s*(.+)$/m.exec(block);
  if (!evMatch) return;
  const type = evMatch[1];
  let data = null;
  if (dataMatch) {
    try {
      data = JSON.parse(dataMatch[1]);
    } catch {
      data = null;
    }
  }
  if (type === "progress") {
    pushProgress(job, data?.text || "");
    return;
  }
  if (type === "error") {
    job.state = "error";
    job.error = String(data?.message || data?.error || "生成失败");
    job.endedAt = Date.now();
    job.updatedAt = Date.now();
    pushProgress(job, `失败：${job.error}`);
    return;
  }
  if (type === "done") {
    job.state = "done";
    job.images = Array.isArray(data?.images) ? data.images.filter((i) => i?.url) : [];
    job.cost = Number(data?.cost) || 0;
    job.balance = Number(data?.balance) || 0;
    job.endedAt = Date.now();
    job.updatedAt = Date.now();
    if (data?.cached) pushProgress(job, "命中历史结果，本次未扣算力");
    pushProgress(job, `完成，共 ${job.images.length} 张`);
  }
}

/**
 * 取消作业。
 * 两步都要做：
 *   ① 请求服务端 /api/tasks/cancel —— 才会真的停上游并回滚预扣；
 *   ② abort 自己这条内部连接，释放 socket。
 * 只做 ② 的话，上游照跑、点数照扣，用户看到的就是「取消了还扣钱」。
 */
export async function cancel(id, userId, { selfBase, isSuper = false } = {}) {
  const job = jobs.get(String(id || ""));
  if (!job) return { ok: false, code: "NOT_FOUND", error: "作业不存在或已过期" };
  if (job.userId !== userId && !isSuper) return { ok: false, code: "FORBIDDEN", error: "无权取消该作业" };
  if (job.state !== "queued" && job.state !== "running") {
    return { ok: false, code: "ALREADY_ENDED", error: "任务已结束" };
  }

  try {
    await fetch(`${selfBase}/api/tasks/cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AI-Canvas-Token": job.token,
        // 同样是受保护写接口，服务端内部调用要补变更令牌（原因见 runJob 里那段注释）
        ...(mutationToken() ? { "X-AI-Canvas-Mutation-Token": mutationToken() } : {})
      },
      body: JSON.stringify({ taskId: job.id })
    });
  } catch {
    /* 取消失败也要继续释放本地连接，至少别让小程序卡在 running */
  }

  job.state = "canceled";
  job.endedAt = Date.now();
  job.updatedAt = Date.now();
  pushProgress(job, "已取消");
  try {
    job.controller.abort();
  } catch {
    /* 已结束 */
  }
  return { ok: true };
}
