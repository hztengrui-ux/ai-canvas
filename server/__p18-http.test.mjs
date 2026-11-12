// P1-8 HTTP 端到端验收：真实服务端 + 真实 SSE，覆盖「改备注重跑不重复扣费」
//
// 为什么还要端到端（单元测试已经 55 项全绿）：
//   单元测试验证的是 upstream.js 的规则；这里验证的是 /api/generate、
//   /api/generate-video 这两条路由**真的按规则走了** —— 路由里漏接签名、
//   漏传 userId、把 remark 混进签名，单元测试都发现不了。
//
// 运行：先起服务端（AI_CANVAS_HOME 指向临时目录），再 BASE=... node 本文件
import * as upstream from "./upstream.js";
import * as credits from "./credits.js";
import { outputsDir } from "./config.js";
import { dataFile } from "./paths.js";
import fs from "node:fs";
import path from "node:path";

const CACHE_PATH = dataFile("gen-cache.json");

const BASE = process.env.BASE || "http://127.0.0.1:5181";

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

// 本地会话令牌（安全层要求），不带会被拦在 401
const session = await (await fetch(`${BASE}/api/session`)).json();
let TOKEN = session.token || "";
check("拿到本地会话令牌", Boolean(TOKEN));

// 必须先登录，并**用真实账号 id 播种缓存**。
// 踩过的坑：/api/session 的本地令牌是复用的，若前面的测试用它登录过，
// 本次请求的 chargeUser 就是那个账号 id 而不是 "local" —— 缓存按用户隔离，
// 播种到 "local" 名下就永远命中不了（这不是 bug，正是隔离在生效）。
await api("/api/auth/setup", { method: "POST", body: { username: "admin", password: "admin888" } });
const lg = await api("/api/auth/login", { method: "POST", body: { username: "admin", password: "admin888" } });
if (lg.data?.token) TOKEN = lg.data.token;
const USER = lg.data?.user?.id || "local";
check("已登录并拿到计费账号", Boolean(lg.data?.ok), `user=${USER}`);

/** 读一条 SSE 流，收集所有事件 */
async function sse(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AI-Canvas-Token": TOKEN },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const events = [];
  for (const block of text.split("\n\n")) {
    const ev = /^event:\s*(\S+)/m.exec(block);
    const dt = /^data:\s*(.+)$/m.exec(block);
    if (!ev) continue;
    let data = null;
    try {
      data = JSON.parse(dt[1]);
    } catch {
      data = null;
    }
    events.push({ type: ev[1], ...(data || {}) });
  }
  return { status: res.status, events, last: events[events.length - 1] || null };
}

async function api(pathname, { method = "GET", body, token } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AI-Canvas-Token": token || TOKEN },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** 在 outputs 里放一个真实文件（缓存命中要求产物还在） */
function seedFile(name = `__p18_http_${Date.now().toString(36)}.png`) {
  const p = path.join(outputsDir(), name);
  fs.writeFileSync(p, "seed-png");
  return `/outputs/${name}`;
}

console.log("\n=== P1-8 HTTP 端到端：图片生成幂等 ===");

upstream.cacheClear();
// 全新数据目录余额为 0，先充上，否则「预扣 → 失败退回」这条路径验证不到
await credits.grant(USER, 1000, "P1-8 测试充值");
check("测试账号余额已就绪", credits.balance(USER) >= 1000, `balance=${credits.balance(USER)}`);

const imgBody = {
  provider: "wanxiang",
  model: "wanx2.1-t2i-turbo",
  prompt: "红色毛衣，模特实拍，纯色背景",
  size: "1024x1024",
  n: 2
};
const imgSig = upstream.upstreamSignature({ kind: "image", ...imgBody });
const imgUrl = seedFile();
upstream.cachePut(imgSig, {
  items: [{ url: imgUrl, remoteUrl: "" }],
  cost: 10,
  provider: "wanxiang",
  model: imgBody.model,
  userId: USER,
  kind: "image"
});
// 诊断：种子是否真的可被读回（排除「缓存写进去但读不到」这类低级问题）
const seedHit = upstream.cacheGet(imgSig, USER);
check("种子缓存在测试进程侧可读回", Boolean(seedHit), `sig=${imgSig} user=${USER} url=${imgUrl}`);
if (!seedHit) {
  console.log(`     ↳ 诊断：outputsDir=${outputsDir()}  cache=${JSON.stringify(upstream.cacheStats())}`);
  console.log(`     ↳ 诊断：种子文件存在=${fs.existsSync(path.join(outputsDir(), path.basename(imgUrl)))}`);
}

// ① 同输入重跑 → 命中缓存，零扣费
let r = await sse("/api/generate", imgBody);
check("首次重跑返回 done", r.last?.type === "done", JSON.stringify(r.last).slice(0, 120));
check("命中缓存 → 不扣费", r.last?.cost === 0 && r.last?.cached === true, JSON.stringify(r.last).slice(0, 120));
check("返回上次的结果图", r.last?.images?.[0]?.url === imgUrl);
check("告知用户省了多少点", r.last?.savedCost === 10, `savedCost=${r.last?.savedCost}`);
check("进度里说明免扣原因", r.events.some((e) => String(e.text || "").includes("不扣算力")));

// ② 只改备注 → 仍然免扣（这就是 P1 验收新增项）
r = await sse("/api/generate", { ...imgBody, remark: "客户A 的第 3 版备注" });
check("改备注重跑 → 仍然零扣费", r.last?.cached === true && r.last?.cost === 0, JSON.stringify(r.last).slice(0, 120));

// ③ 改任务名 + 批量上下文 → 仍然免扣
r = await sse("/api/generate", { ...imgBody, title: "毛衫印花", batchId: "b1", batchIndex: 0 });
check("改任务名/批量上下文 → 仍然零扣费", r.last?.cached === true && r.last?.cost === 0);

// ④ 真的改了提示词 → 必须重新计费（预扣了才会退款，说明走了计费路径）
//    本环境没配 provider 密钥，生成必然失败；失败会退回预扣，正好证明「预扣发生过」。
r = await sse("/api/generate", { ...imgBody, prompt: "蓝色羽绒服，街拍" });
check("改提示词 → 不再命中缓存", r.last?.type === "error" || r.last?.cached === false, JSON.stringify(r.last).slice(0, 120));
check(
  "改提示词 → 确实发生了预扣（失败后原额退回）",
  r.events.some((e) => e.type === "error" && Number(e.refunded) === 10),
  JSON.stringify(r.events.filter((e) => e.type === "error")).slice(0, 160)
);

// ⑤ 换张数也算新任务
r = await sse("/api/generate", { ...imgBody, n: 4 });
check("改张数 → 重新计费", r.events.some((e) => e.type === "error" && Number(e.refunded) === 10));

// ⑥ 跨用户隔离：把这条缓存改判给别人，本人重跑必须重新计费
//    （否则等于 B 能白嫖 A 付费生成的图，还能看到 A 的素材）
const rawCache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
if (rawCache.entries?.[imgSig]) {
  rawCache.entries[imgSig].userId = "someone-else";
  fs.writeFileSync(CACHE_PATH, JSON.stringify(rawCache, null, 2));
  r = await sse("/api/generate", imgBody);
  check(
    "缓存归属他人 → 不命中，重新计费（防跨账号白嫖）",
    r.events.some((e) => e.type === "error" && Number(e.refunded) === 10),
    JSON.stringify(r.last).slice(0, 120)
  );
} else {
  check("缓存归属他人 → 不命中，重新计费（防跨账号白嫖）", false, "缓存条目丢失，无法验证");
}

console.log("\n=== P1-8 HTTP 端到端：视频生成幂等（本轮补齐的扣费缺口）===");

const vidBody = { prompt: "模特转身展示毛衣", resolution: "720p", duration: 5 };
const vidSig = upstream.upstreamSignature({ kind: "video", provider: "wanxiang", model: "", ...vidBody });
const vidUrl = seedFile("__p18_http_v.mp4");
upstream.cachePut(vidSig, {
  items: [{ url: vidUrl, remoteUrl: "" }],
  cost: 120, // video.generate 的单价
  provider: "wanxiang",
  model: "",
  userId: USER,
  kind: "video"
});

r = await sse("/api/generate-video", vidBody);
check("视频重跑命中缓存", r.last?.cached === true && r.last?.cost === 0, JSON.stringify(r.last).slice(0, 140));
check("视频返回上次结果", r.last?.videos?.[0]?.url === vidUrl);
check("视频免扣额度正确（120 点）", r.last?.savedCost === 120, `savedCost=${r.last?.savedCost}`);

// 视频确实会扣费（本轮新增）：未命中 → 预扣 120 → 无密钥失败 → 退回 120
r = await sse("/api/generate-video", { ...vidBody, prompt: "另一个镜头" });
check(
  "视频未命中时按 120 点预扣（失败原额退回）",
  r.events.some((e) => e.type === "error" && Number(e.refunded) === 120),
  JSON.stringify(r.events.filter((e) => e.type === "error")).slice(0, 160)
);

// 视频改时长 → 新任务（120 点）
r = await sse("/api/generate-video", { ...vidBody, duration: 10 });
check("改视频时长 → 重新计费", r.events.some((e) => e.type === "error" && Number(e.refunded) === 120));

console.log("\n=== 缓存运维接口（需管理员）===");
const st = await api("/api/cache/status");
check("缓存状态接口可读", st.status === 200, `status=${st.status} ${JSON.stringify(st.data).slice(0, 120)}`);
if (st.status === 200) {
  check("状态里含签名版本", String(st.data?.version || "").startsWith("v"), JSON.stringify(st.data));
}
const clr = await api("/api/cache", { method: "DELETE" });
check("管理员可清空缓存", clr.status === 200 && upstream.cacheStats().total === 0, `status=${clr.status}`);

console.log(`\n  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
