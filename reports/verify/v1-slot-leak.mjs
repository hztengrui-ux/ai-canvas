// 对抗性复验 V1：/api/generate 与 /api/generate-video 的「算力不足」早退是否泄漏并发槽
//
// 设计原则：不读源码做结论，只用真实 HTTP 行为说话。
//   1. 起一个干净数据目录的真实服务端
//   2. 建一个余额为 0 的普通账号（第 2 个账号 → 默认「运营」角色）
//   3. 连发 N 次「算力不足」的生成请求，每次读 /api/security 的 inFlight
//   4. 观察是否出现「有余额的账号也被拒」的全局锁死
//
// 运行：
//   & "...\node.exe" E:\DSH项目\ai-canvas\reports\verify\v1-slot-leak.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const NODE = process.execPath;

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

function pickPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootServer(tag) {
  const dir = path.join(ROOT, ".verifydata", tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const port = await pickPort();
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    AI_CANVAS_HOME: dir,
    AI_CANVAS_OUTPUTS: path.join(dir, "outputs"),
    AI_CANVAS_VAULT: "file",
    PORT: String(port)
  };
  // stdio: "inherit" —— 沙箱禁止管道 stdio（spawn EPERM）
  const child = spawn(NODE, ["server/index.js"], { cwd: ROOT, stdio: "inherit", env });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/session`);
      if (r.ok) return { child, base, dir, port };
    } catch { /* 未起来 */ }
    await sleep(200);
  }
  child.kill();
  throw new Error(`服务端启动失败：${base}`);
}

function makeClient(base) {
  let TOKEN = "";
  const api = async (pathname, { method = "GET", body } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", "X-AI-Canvas-Token": TOKEN },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  };
  const sse = async (pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
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
      try { data = JSON.parse(dt[1]); } catch { data = null; }
      events.push({ type: ev[1], ...(data || {}) });
    }
    return { status: res.status, events, last: events[events.length - 1] || null };
  };
  return {
    api,
    sse,
    setToken: (t) => { TOKEN = t; },
    getToken: () => TOKEN
  };
}

function ledgerBalance(dir, userId) {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(dir, "credits-ledger.json"), "utf8"));
    return (l.records[userId] || []).reduce((s, r) => s + r.amount, 0);
  } catch {
    return 0;
  }
}

/** 一个隔离环境的公共准备：超管 boss 建好，op1 是「运营」且余额为 0 */
async function prepare(tag) {
  const srv = await bootServer(tag);
  const c = makeClient(srv.base);
  const s = await c.api("/api/session");
  c.setToken(s.data.token);
  const setup = await c.api("/api/auth/setup", { method: "POST", body: { username: "boss", password: "boss8888" } });
  const bossId = setup.data?.user?.id;
  const created = await c.api("/api/admin/accounts", {
    method: "POST",
    body: { username: "op1", password: "op123456", nickname: "运营一号" }
  });
  const opId = created.data?.user?.id;
  const opRoles = created.data?.user?.roleIds;
  await c.api("/api/auth/login", { method: "POST", body: { username: "op1", password: "op123456" } });
  return { srv, c, bossId, opId, opRoles };
}

const img = (prompt) => ({ provider: "wanxiang", prompt, size: "1024x1024", n: 1 });

// ============================================================
// Part A：图片路由
// ============================================================
console.log("\n=== V1-A：/api/generate 「算力不足」早退是否泄漏并发槽 ===");
const A = await prepare("v1a");
const sec0 = await A.c.api("/api/security");
console.log(`  隔离数据目录：${A.srv.dir}`);
console.log(`  第 2 个账号 op1 的默认角色 roleIds=${JSON.stringify(A.opRoles)}（第 1 个是超管，其余默认运营）`);
check("op1 余额为 0（未访问过赠送接口）", ledgerBalance(A.srv.dir, A.opId) === 0, `balance=${ledgerBalance(A.srv.dir, A.opId)}`);
check("初始 inFlight=0，maxConcurrent=2", sec0.data.inFlight === 0 && sec0.data.maxConcurrent === 2,
  `inFlight=${sec0.data.inFlight} maxConcurrent=${sec0.data.maxConcurrent}`);

const leaks = [];
for (let i = 1; i <= 3; i++) {
  const r = await A.c.sse("/api/generate", img(`余额不足探针 #${i} ${Date.now()}`));
  const sec = await A.c.api("/api/security");
  console.log(`  请求#${i}: event=${r.last?.type} msg="${r.last?.error}" → inFlight=${sec.data.inFlight}`);
  leaks.push({ i, msg: r.last?.error, inFlight: sec.data.inFlight });
}
check("第 1 次余额不足：被正确拒绝且 inFlight 泄漏为 1",
  leaks[0].msg?.includes("算力不足") && leaks[0].inFlight === 1, JSON.stringify(leaks[0]));
check("第 2 次余额不足：仍报余额不足，inFlight 已达上限 2",
  leaks[1].msg?.includes("算力不足") && leaks[1].inFlight === 2, JSON.stringify(leaks[1]));
check("【缺陷】第 3 次请求被拒理由变成「并发过多」而非「算力不足」",
  leaks[2].msg?.includes("同时进行的生成任务过多"), JSON.stringify(leaks[2]));

await sleep(2500);
const secLate = await A.c.api("/api/security");
const rLate = await A.c.sse("/api/generate", img(`等待 2.5 秒后的复测 ${Date.now()}`));
check("【缺陷】等待 2.5 秒后仍锁死（无超时自愈）",
  rLate.last?.error?.includes("同时进行的生成任务过多") && secLate.data.inFlight === 2,
  `inFlight=${secLate.data.inFlight} msg="${rLate.last?.error}"`);

// 换成有余额的超管，验证是「全局锁死」而不是「只锁 op1」
await A.c.api("/api/auth/login", { method: "POST", body: { username: "boss", password: "boss8888" } });
const bal = await A.c.api("/api/credits/balance"); // 触发 500 点新用户赠送
const rBoss = await A.c.sse("/api/generate", img(`超管有余额也来试一次 ${Date.now()}`));
check("【缺陷】超管（余额充足）同样被拒：全局锁死，非单账号",
  bal.data?.balance >= 10 && rBoss.last?.error?.includes("同时进行的生成任务过多"),
  `boss balance=${bal.data?.balance} msg="${rBoss.last?.error}"`);
A.srv.child.kill();

// ============================================================
// Part B：视频路由
// ============================================================
console.log("\n=== V1-B：/api/generate-video 「算力不足」早退是否同样泄漏 ===");
const B = await prepare("v1b");
const vidLeaks = [];
for (let i = 1; i <= 3; i++) {
  const r = await B.c.sse("/api/generate-video", { prompt: `视频余额不足探针 #${i} ${Date.now()}` });
  const sec = await B.c.api("/api/security");
  console.log(`  请求#${i}: event=${r.last?.type} msg="${r.last?.error}" → inFlight=${sec.data.inFlight}`);
  vidLeaks.push({ i, msg: r.last?.error, inFlight: sec.data.inFlight });
}
check("视频第 1 次余额不足：inFlight 泄漏为 1", vidLeaks[0].msg?.includes("算力不足") && vidLeaks[0].inFlight === 1, JSON.stringify(vidLeaks[0]));
check("视频第 2 次余额不足：inFlight 泄漏为 2", vidLeaks[1].msg?.includes("算力不足") && vidLeaks[1].inFlight === 2, JSON.stringify(vidLeaks[1]));
check("【缺陷】视频第 3 次被拒理由变成「并发过多」", vidLeaks[2].msg?.includes("同时进行的生成任务过多"), JSON.stringify(vidLeaks[2]));
B.srv.child.kill();

console.log(`\n  V1 汇总：断言通过 ${pass} / 不符 ${fail}`);
console.log(fail === 0
  ? "  → 全部断言成立 ⇒ 报告的 V1「算力不足早退泄漏并发槽」被实测坐实\n"
  : "  → 有断言不符 ⇒ 该条结论至少部分不成立，见上方 ❌\n");
process.exit(0);
