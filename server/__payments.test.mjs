// 支付回调查验：安全测试
// 运行前需先启动服务：node server/index.js
//
// 这个测试回答一个问题：**不验签的旧实现能不能白嫖？现在能不能？**

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

async function api(pathname, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-AI-Canvas-Token": token } : {}),
      ...headers
    },
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

console.log("\n=== 支付回调查验 · 安全测试 ===\n");

// ---- 准备：拿令牌 + 登录 ----
// 首次运行的数据目录里没有任何账号，所以先尝试登录、失败则走引导初始化，
// 保证测试在「全新实例」和「已初始化实例」上都能一遍跑通。
const sess = await (await fetch(`${BASE}/api/session`)).json();
const token = sess.token;
const loginRes = await api("/api/auth/login", {
  method: "POST",
  token,
  body: { username: "admin", password: "admin888" }
});
if (loginRes.status !== 200 || !loginRes.data?.ok) {
  const setup = await api("/api/auth/setup", {
    method: "POST",
    token,
    body: { username: "admin", password: "admin888" }
  });
  if (!setup.data?.ok) {
    console.log("  ❌ 无法准备测试账号（setup 失败）", JSON.stringify(setup.data));
    process.exit(1);
  }
}

const before = (await api("/api/credits/balance", { token })).data.balance;
console.log(`  起始余额 ${before}\n`);

// ---- 1) 支付状态 ----
const st = await api("/api/recharge/pay-status", { token });   // 本地接口，需带令牌
check("能读到支付状态", st.status === 200, `mode=${st.data?.mode}`);
check("未配置凭证时进入沙箱模式", st.data?.sandbox === true);

// ---- 2) 下单 ----
const created = await api("/api/recharge/orders", {
  method: "POST",
  token,
  body: { planId: "plan-1000" }
});
const order = created.data?.order;
check("创建订单成功", Boolean(order?.id), `id=${order?.id?.slice(0, 16)}`);
check("订单初始为待支付", order?.status === "pending");

// ---- 3) 发起支付，拿二维码 ----
const pay = await api(`/api/recharge/orders/${order.id}/pay`, { method: "POST", token });
check("发起支付成功", pay.status === 200, `gateway=${pay.data?.gateway}`);
check("返回二维码", Boolean(pay.data?.qrCode));

// ---- 4) 模拟网关回调（带正确签名）----
// 复用服务端沙箱密钥：私钥路径必须跟服务端算的是同一个数据目录，
// 否则两边用的是两把不同的密钥，合法签名也会被判失败。
const { createSign } = await import("node:crypto");
const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");
const dataHome = process.env.AI_CANVAS_HOME
  ? path.resolve(process.env.AI_CANVAS_HOME)
  : path.join(os.homedir(), ".ai-canvas");
const priv = fs.readFileSync(path.join(dataHome, "pay-keys", "sandbox-private.pem"), "utf8");
const payload = JSON.stringify({ out_trade_no: order.id, total: order.price });
const sig = createSign("RSA-SHA256").update(payload).sign(priv, "base64");

const cb = await fetch(`${BASE}/api/recharge/callback/sandbox`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Sandbox-Payload": payload,
    "X-Sandbox-Signature": sig
  },
  body: payload
});
const cbData = await cb.json();
check("合法签名回调被接受", cb.status === 200, JSON.stringify(cbData).slice(0, 60));

const after = (await api("/api/credits/balance", { token })).data.balance;
check("算力已到账", after === before + 1000, `${before} → ${after}`);

// ---- 5) 伪造签名必须被拒 ----
const forgedPayload = JSON.stringify({ out_trade_no: order.id, total: 0.01 });
const forged = await fetch(`${BASE}/api/recharge/callback/sandbox`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Sandbox-Payload": forgedPayload,
    "X-Sandbox-Signature": Buffer.from("fake-signature").toString("base64")
  },
  body: forgedPayload
});
check("伪造签名被拒绝", forged.status >= 400, `HTTP ${forged.status}`);

const afterForged = (await api("/api/credits/balance", { token })).data.balance;
check("伪造回调未改变余额", afterForged === after, `balance=${afterForged}`);

// ---- 6) 无签名头必须被拒 ----
const noSig = await fetch(`${BASE}/api/recharge/callback/sandbox`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ out_trade_no: order.id, total: order.price })
});
check("无签名头被拒绝", noSig.status >= 400, `HTTP ${noSig.status}`);

// ---- 7) 幂等：同一订单重复回调不重复发放 ----
const cb2 = await fetch(`${BASE}/api/recharge/callback/sandbox`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Sandbox-Payload": payload,
    "X-Sandbox-Signature": sig
  },
  body: payload
});
await cb2.json();
const afterDup = (await api("/api/credits/balance", { token })).data.balance;
check("重复回调不重复加算力（幂等）", afterDup === after, `balance=${afterDup}`);

// ---- 8) 旧的不安全接口应已不存在 ----
const legacy = await api(`/api/recharge/orders/${order.id}/paid`, { method: "POST", token, body: {} });
check("旧的 /paid 接口已移除", legacy.status === 404, `HTTP ${legacy.status}`);

// ---- 9) 金额不匹配必须被拒 ----
const wrongAmount = JSON.stringify({ out_trade_no: order.id, total: 99999 });
const wrongSig = createSign("RSA-SHA256").update(wrongAmount).sign(priv, "base64");
const created2 = await api("/api/recharge/orders", { method: "POST", token, body: { planId: "plan-1000" } });
const order2 = created2.data.order;
const p2 = JSON.stringify({ out_trade_no: order2.id, total: 88888 });
const s2 = createSign("RSA-SHA256").update(p2).sign(priv, "base64");
const mm = await fetch(`${BASE}/api/recharge/callback/sandbox`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Sandbox-Payload": p2,
    "X-Sandbox-Signature": s2
  },
  body: p2
});
check("金额不匹配被拒绝", mm.status >= 400, `HTTP ${mm.status}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
