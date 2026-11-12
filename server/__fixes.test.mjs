/**
 * 修复验收测试（2026-10-14）—— 针对本轮修掉的 4 处严重缺陷 + 1 处测试基线
 *
 * 配套改动：
 *   R1 server/index.js   /api/generate 与 /api/generate-video 的并发槽泄漏
 *   R2 server/accounts.js + server/admin.js  运营角色越权提权/重置超管
 *   R3 server/index.js + src/api.js + AccountModals.vue  充值演示链路 404 / 伪支付
 *   R4 server/credits.js  reserve 幂等 + 流水裁剪不再吞余额
 *   R5 src/__theme.test.mjs  默认主题断言过期（npm test 恒红）
 *
 * 运行：node server/__fixes.test.mjs
 * 特点：完全离线。A 组直接测模块（不需要服务端），B 组起隔离实例测真实 HTTP。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ============================================================
// A 组：账本模块直测（R4）
// ============================================================
const DIR_A = fs.mkdtempSync(path.join(os.tmpdir(), "ai-canvas-fix-a-"));
process.env.AI_CANVAS_HOME = DIR_A;
process.env.AI_CANVAS_OUTPUTS = path.join(DIR_A, "outputs");
const credits = await import("./credits.js");

console.log("\n[A] R4 账本：reserve 幂等（同一 refId 不重复扣费）");
{
  const U = "fix-reserve-" + Date.now();
  await credits.grant(U, 100, "测试");

  const r1 = await credits.reserve(U, "image.generate", "ref-same");
  const after1 = credits.balance(U);
  check("首次预扣成功", r1.ok === true && r1.reserved === true, `cost=${r1.cost}`);
  check("首次预扣扣了 10", after1 === 90, `balance=${after1}`);

  // 同一 refId 再预扣（模拟「同一任务失败后重跑」）—— 旧实现会再扣一笔
  const r2 = await credits.reserve(U, "image.generate", "ref-same");
  const after2 = credits.balance(U);
  check("重复预扣被识别为已存在", r2.ok === true && r2.duplicate === true, `duplicate=${r2.duplicate}`);
  check("重复预扣不再扣费（余额仍是 90）", after2 === 90, `balance=${after2}`);
  check("重复预扣返回同一笔 txId", r2.txId === r1.txId, `tx=${r2.txId} vs ${r1.txId}`);

  // 失败回滚：这一笔只退一次
  const rb1 = await credits.rollback(U, "ref-same", r1.txId);
  check("回滚退回 10", rb1.refunded === 10, `refunded=${rb1.refunded}`);
  check("回滚后余额回到 100（旧实现会少一笔）", credits.balance(U) === 100, `balance=${credits.balance(U)}`);

  // 防刷：同一笔不能被退两次
  const rb2 = await credits.rollback(U, "ref-same", r1.txId);
  check("同一笔不会被退两次", rb2.skipped === true, `skipped=${rb2.skipped}`);
  check("余额未被刷高", credits.balance(U) === 100, `balance=${credits.balance(U)}`);

  // 第二个独立任务（新 refId）走完整 预扣→回滚，账目必须干净
  const r3 = await credits.reserve(U, "image.generate", "ref-other");
  check("第二个任务预扣成功（新 refId）", r3.ok === true && credits.balance(U) === 90, `balance=${credits.balance(U)}`);
  const rb3 = await credits.rollback(U, "ref-other", r3.txId);
  check("第二个任务回滚成功", rb3.refunded === 10, `refunded=${rb3.refunded}`);
  check("两轮后余额仍是 100（无资损）", credits.balance(U) === 100, `balance=${credits.balance(U)}`);

  // 同一 refId 复用两轮（失败→回滚→再失败→再回滚）：
  // 这是被有意设计为「同一逻辑任务只结算一次」，因此第二轮回滚应被去重挡掉，
  // 关键是**不能多扣**（旧实现的资损来自 reserve 重复扣，而不是 rollback 去重）。
  const r4 = await credits.reserve(U, "image.generate", "ref-reuse");
  const r5 = await credits.reserve(U, "image.generate", "ref-reuse");
  check("复用 refId 只扣一次", credits.balance(U) === 90, `balance=${credits.balance(U)}`);
  await credits.rollback(U, "ref-reuse", r4.txId);
  check("复用 refId 只退一次，余额复原", credits.balance(U) === 100, `balance=${credits.balance(U)}`);
  void r5;
}

console.log("\n[A] R4 账本：流水裁剪不吞余额（余额==流水求和 不变式）");
{
  const U = "fix-trim-" + Date.now();
  const AMOUNT = 1;
  const N = 2100; // 超过 2000 条上限，必然触发裁剪

  // 逐笔充值，每笔 1 点，共 2100 点
  for (let i = 0; i < N; i++) await credits.grant(U, AMOUNT, `批量 ${i}`);

  const bal = credits.balance(U);
  check(`充值 ${N} 点后余额仍为 ${N}（旧实现蒸发 100）`, bal === N, `balance=${bal}`);

  // 对账：余额必须等于记录的余额
  const rec = credits.reconcile ? credits.reconcile(U) : null;
  if (rec) {
    check("对账一致（余额 == 流水求和）", rec.ok === true, JSON.stringify(rec));
  }

  // 流水条数仍有界（结转记录会额外占 1 行，这是有意的）
  const rows = credits.records(U, { limit: 5000 });
  check("流水条数仍然有界（≤2001）", rows.length <= 2001, `rows=${rows.length}`);
  check(
    "存在结转记录（旧流水被压成一个数而不是丢弃）",
    rows.some((r) => r.type === "carry"),
    `carry=${rows.filter((r) => r.type === "carry").length}`
  );

  // 裁剪后仍然能正确继续扣费
  const r = await credits.reserve(U, "image.generate", "trim-ref");
  check("裁剪后仍可正常预扣", r.ok === true, `balance=${credits.balance(U)}`);
  check("裁剪后扣费金额正确（2100 - 10 = 2090）", credits.balance(U) === N - 10, `balance=${credits.balance(U)}`);
}

// ============================================================
// B 组：真实服务端 HTTP 验收（R1 / R2 / R3）
// ============================================================
const DIR_B = fs.mkdtempSync(path.join(os.tmpdir(), "ai-canvas-fix-b-"));
const PORT = await pickPort();
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(NODE, ["server/index.js"], {
  cwd: ROOT,
  stdio: "inherit", // 沙箱禁止管道 stdio
  env: {
    ...process.env,
    AI_CANVAS_HOME: DIR_B,
    AI_CANVAS_OUTPUTS: path.join(DIR_B, "outputs"),
    AI_CANVAS_VAULT: "file",
    PORT: String(PORT)
  }
});

let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try {
    const r = await fetch(`${BASE}/api/session`);
    up = r.ok;
  } catch {
    /* 还没起来 */
  }
  if (!up) await sleep(200);
}
if (!up) {
  console.error("服务端启动失败");
  server.kill("SIGKILL");
  process.exit(1);
}

let TOKEN = "";
const api = async (pathname, { method = "GET", body, headers = {} } = {}) => {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AI-Canvas-Token": TOKEN, ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
};
const sse = async (pathname, body) => {
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
    let d = null;
    try {
      d = JSON.parse(dt[1]);
    } catch {
      d = null;
    }
    events.push({ type: ev[1], ...(d || {}) });
  }
  return { status: res.status, events, last: events[events.length - 1] || null };
};

// 建超管
let BOSS_ID = "";
{
  const s = await api("/api/session");
  TOKEN = s.data.token;
  const setup = await api("/api/auth/setup", {
    method: "POST",
    body: { username: "boss", password: "boss8888" }
  });
  BOSS_ID = setup.data?.user?.id || "";
  check("超管初始化成功", setup.data?.ok === true && Boolean(BOSS_ID), `bossId=${BOSS_ID}`);
}

console.log("\n[B] R1 并发槽：算力不足早退不再泄漏（未授权全局 DoS）");
{
  // 用一个余额为 0 的新账号连发 2 次生成（maxConcurrent=2）
  const created = await api("/api/admin/accounts", {
    method: "POST",
    body: { username: "poor1", password: "poor123456" }
  });
  check("创建余额为 0 的普通账号", created.status === 200, `status=${created.status}`);

  // 用超管身份读取 inFlight（/api/security 需要登录即可）
  const secBefore = await api("/api/security");
  const inflightBefore = secBefore.data?.inFlight ?? 0;

  const r1 = await sse("/api/generate", { provider: "wanxiang", prompt: "修复验收 A", n: 1 });
  const r2 = await sse("/api/generate", { provider: "wanxiang", prompt: "修复验收 B", n: 1 });

  check(
    "两次请求都被「算力不足」拒绝（而不是并发过多）",
    String(r1.last?.error || "").includes("算力不足") && String(r2.last?.error || "").includes("算力不足"),
    `1st=${r1.last?.error} / 2nd=${r2.last?.error}`
  );

  const secAfter = await api("/api/security");
  const inflightAfter = secAfter.data?.inFlight ?? 0;
  check(
    "两次失败后 inFlight 回到 0（槽位已归还）",
    inflightAfter === 0,
    `before=${inflightBefore} after=${inflightAfter}`
  );

  // 关键回归：第 3 次请求不能因为槽位耗尽而被拒
  const s3 = await sse("/api/generate", { provider: "wanxiang", prompt: "修复验收 D", n: 1 });
  const msg3 = String(s3.last?.error || "");
  check(
    "第 3 次仍返回业务错误而非「同时进行的生成任务过多」",
    !msg3.includes("同时进行的生成任务过多"),
    `msg=${msg3}`
  );

  // 视频路由同病同修
  const s4 = await sse("/api/generate-video", { prompt: "修复验收视频", duration: 5 });
  check(
    "视频路由也未泄漏槽位",
    !String(s4.last?.error || "").includes("同时进行的生成任务过多"),
    `msg=${s4.last?.error}`
  );
  const secFinal = await api("/api/security");
  check("视频失败后 inFlight 仍为 0", (secFinal.data?.inFlight ?? 0) === 0, `inFlight=${secFinal.data?.inFlight}`);
}

console.log("\n[B] R2 越权：运营角色不得自我提权 / 重置超管 / 直造超管");
{
  const sec = await api("/api/security"); // 保持超管会话
  const bossId = BOSS_ID;
  check("拿到超管 id（后续越权测试的目标）", Boolean(bossId), `bossId=${bossId}`);

  // 建运营账号（默认角色应含 admin:account:edit/reset）
  const created = await api("/api/admin/accounts", {
    method: "POST",
    body: { username: "op9", password: "op123456", nickname: "运营九号" }
  });
  check("创建运营账号", created.status === 200, `status=${created.status}`);
  const opId = created.data?.user?.id;
  const createPerms = created.data?.user?.perms || [];
  check(
    "运营账号创建成功且带 id",
    created.status === 200 && Boolean(opId),
    `id=${opId}`
  );

  // 切到运营身份
  const bossToken = TOKEN;
  const login = await api("/api/auth/login", { method: "POST", body: { username: "op9", password: "op123456" } });
  TOKEN = login.data?.token || TOKEN;
  const opPermsAfter = (await api("/api/auth/perms")).data?.perms || [];
  check("运营角色确实带 account:edit/reset（复现前提）", opPermsAfter.includes("admin:account:reset"), `perms=${opPermsAfter.length}`);
  // 2026-11-05 新增运营后台后，运营角色额外拿到 customer/recharge/payment 的只读+管理码（13 个）。
  // 这里只断言「明显少于超管、且不含超管专属码」，避免每次加权限码都要改这个数字。
  check(
    "运营登录后权限数远少于超管（非超管）",
    opPermsAfter.length > 0 && opPermsAfter.length < 20 && !opPermsAfter.includes("admin:payment:config"),
    `perms=${opPermsAfter.length}`
  );
  void createPerms;

  // ① 自我提权
  const esc = await api(`/api/admin/accounts/${opId}`, {
    method: "PUT",
    body: { roleIds: ["r-super"] }
  });
  check("运营给自己写 r-super 被拒", esc.status >= 400, `status=${esc.status} msg=${esc.data?.error}`);

  // ② 直造超管
  const makeSuper = await api("/api/admin/accounts", {
    method: "POST",
    body: { username: "evil1", password: "evil123456", roleIds: ["r-super"] }
  });
  check("运营直接创建超管账号被拒", makeSuper.status >= 400, `status=${makeSuper.status} msg=${makeSuper.data?.error}`);

  // ③ 重置超管密码（接管系统）
  const reset = await api(`/api/admin/accounts/${bossId}/reset`, {
    method: "POST",
    body: { password: "hacked666" }
  });
  check("运营重置超管密码被拒", reset.status >= 400, `status=${reset.status} msg=${reset.data?.error}`);

  // 反向确认：被拒后超管原密码仍然可登录（没被改掉）
  const bossLogin = await api("/api/auth/login", {
    method: "POST",
    body: { username: "boss", password: "boss8888" }
  });
  check("超管原密码仍然有效（确实没被改）", bossLogin.data?.ok === true, `status=${bossLogin.status}`);

  // 运营改自己的非权限字段应当仍然允许（不能矫枉过正）
  TOKEN = login.data?.token || TOKEN;
  const okEdit = await api(`/api/admin/accounts/${opId}`, { method: "PUT", body: { nickname: "运营九号改" } });
  check("运营改自己昵称仍被允许（未误伤正常功能）", okEdit.status === 200, `status=${okEdit.status}`);

  TOKEN = bossToken;
}

console.log("\n[B] R3 支付：沙箱演示走真实回调链路，且三道闸生效");
{
  const plans = await api("/api/recharge/plans");
  const plan = (plans.data?.rows || [])[0];
  check("能读到充值套餐", Boolean(plan?.id), `plan=${plan?.id}`);

  const balBefore = (await api("/api/credits/balance")).data?.balance ?? 0;

  const order = await api("/api/recharge/orders", { method: "POST", body: { planId: plan.id } });
  check("能创建订单", Boolean(order.data?.order?.id), `status=${order.status}`);
  const orderId = order.data?.order?.id;

  // 旧的伪支付路由必须仍然是 404（不能把后门加回来）
  const legacy = await api(`/api/recharge/orders/${orderId}/paid`, { method: "POST", body: {} });
  check("旧的 /paid 伪支付路由仍为 404（无后门）", legacy.status === 404, `status=${legacy.status}`);

  // 新的沙箱模拟支付：走真实验签链路
  const paid = await api(`/api/recharge/orders/${orderId}/simulate-paid`, { method: "POST", body: {} });
  check("沙箱模拟支付成功（真实回调链路）", paid.status === 200, `status=${paid.status} body=${JSON.stringify(paid.data)}`);

  const balAfter = (await api("/api/credits/balance")).data?.balance ?? 0;
  check("算力已到账", balAfter === balBefore + plan.total, `${balBefore} → ${balAfter}（应 +${plan.total}）`);

  // 幂等：重复回调不重复加算力
  const again = await api(`/api/recharge/orders/${orderId}/simulate-paid`, { method: "POST", body: {} });
  const balAgain = (await api("/api/credits/balance")).data?.balance ?? 0;
  check("重复模拟支付不重复到账（幂等）", balAgain === balAfter, `${balAfter} → ${balAgain}`);
}

server.kill("SIGKILL");
await sleep(300);
for (const d of [DIR_A, DIR_B]) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* 沙箱可能拦删除，无所谓 */
  }
}

console.log("\n════════ 汇总 ════════");
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log("");
process.exit(fail === 0 ? 0 : 1);
