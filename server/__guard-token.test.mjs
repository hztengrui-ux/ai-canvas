/**
 * 变更令牌门 + 端口归属自测（Sprint 0 ① ② ③）
 * --------------------------------------------------------------------------
 * 这套测试回答两个问题：
 *   A. 变更令牌门「默认拒绝未授权写」是否真的成立 —— 缺令牌 / 错令牌必须 403，
 *      正确令牌必须放行；同时不能误伤读接口、支付回调、静态资源。
 *   B. 端口归属是否可信 —— 服务端每个响应回显本次运行标识，主进程据此确认
 *      「这个端口上的服务是我 fork 的」，端口被占用时不会误判就绪。
 *
 * 分两段：
 *   第 1 段：直接驱动中间件（纯逻辑，毫秒级，能精确断言 next/403）
 *   第 2 段：起一个真实服务端（带注入令牌），走 HTTP 验真链路 ——
 *           只测中间件会漏掉「挂载顺序/路径匹配」这类真实问题。
 *
 * 注意：令牌必须在 import security.js **之前**注入 —— 模块级常量只在首次求值时读环境。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 准备：环境 + 令牌 ----------
const UNIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "guard-unit-"));
const HTTP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "guard-http-"));
const RUNTIME_TOKEN = crypto.randomBytes(32).toString("hex");
const MUTATION_TOKEN = crypto.randomBytes(32).toString("hex");
const WRONG_TOKEN = crypto.randomBytes(32).toString("hex");

process.env.AI_CANVAS_HOME = UNIT_HOME;
process.env.AI_CANVAS_VAULT = "file";
process.env.AI_CANVAS_RUNTIME_TOKEN = RUNTIME_TOKEN;
process.env.AI_CANVAS_MUTATION_TOKEN = MUTATION_TOKEN;

const sec = await import("./security.js");

// ============================================================
// 第 1 段：中间件级
// ============================================================
console.log("\n[1] 令牌生效开关与响应回显");
{
  check("注入了令牌 → 变更门启用", sec.MUTATION_ENFORCED === true);
  check("运行时令牌为 64 位 hex", /^[0-9a-f]{64}$/.test(sec.runtimeToken()), sec.runtimeToken().slice(0, 8));
  check("变更令牌为 64 位十六进制", /^[0-9a-f]{64}$/.test(sec.mutationToken()));

  const headers = {};
  const res = { setHeader: (k, v) => (headers[String(k).toLowerCase()] = v) };
  sec.securityHeaders({ headers: {} }, res, () => {});
  check(
    "securityHeaders 回显 X-AI-Canvas-Runtime-Token",
    headers["x-ai-canvas-runtime-token"] === sec.runtimeToken(),
    String(headers["x-ai-canvas-runtime-token"]).slice(0, 8)
  );
}

console.log("\n[2] 变更门：读放行、写默认拒绝");
{
  const makeRes = () => {
    const captured = { statusCode: 0, body: null };
    return {
      captured,
      setHeader() {},
      status(code) {
        captured.statusCode = code;
        return this;
      },
      json(payload) {
        captured.body = payload;
        return this;
      }
    };
  };

  const run = (method, p, headers = {}) => {
    const res = makeRes();
    let nexted = false;
    sec.mutationGuard({ method, path: p, headers }, res, () => {
      nexted = true;
    });
    return { nexted, ...res.captured };
  };

  const read = run("GET", "/api/templates");
  check("GET 读接口直接放行", read.nexted === true);

  const noToken = run("POST", "/api/generate");
  check("POST 无令牌 → 403", noToken.statusCode === 403, `status=${noToken.statusCode}`);
  check("错误码为 MUTATION_TOKEN_REQUIRED", noToken.body?.code === "MUTATION_TOKEN_REQUIRED", JSON.stringify(noToken.body));

  const wrong = run("POST", "/api/generate", { "x-ai-canvas-mutation-token": WRONG_TOKEN });
  check("POST 错令牌 → 403", wrong.statusCode === 403);

  const right = run("POST", "/api/generate", { "x-ai-canvas-mutation-token": MUTATION_TOKEN });
  check("POST 正确令牌 → 放行", right.nexted === true);

  const patch = run("PATCH", "/api/settings", { "x-ai-canvas-mutation-token": MUTATION_TOKEN });
  check("PATCH 同样受管", patch.nexted === true);

  const del = run("DELETE", "/api/materials", {});
  check("DELETE 无令牌 → 403", del.statusCode === 403);

  const callback = run("POST", "/api/recharge/callback/wechat", {});
  check("支付回调豁免（凭回调验签，不依赖本地令牌）", callback.nexted === true);

  // 2026-10-18 手机端：/api/m/* 必须豁免变更令牌门。
  // 微信小程序拿不到主进程内存里的变更令牌（那是 Electron 内部的），
  // 它的凭据是登录拿到的 m_ 会话令牌，且只走 header、不带 cookie —— 没有 CSRF 面。
  // 漏了这条豁免，桌面版一开手机模式，小程序就会「能登录、能看图，一写出图就 403」。
  const mobileWrite = run("POST", "/api/m/jobs", {});
  check("手机端写接口豁免变更令牌门", mobileWrite.nexted === true, `status=${mobileWrite.statusCode}`);
  const mobileUpload = run("POST", "/api/m/upload", {});
  check("手机端上传同样豁免", mobileUpload.nexted === true);
  // 反向断言：普通写接口不能因为开了手机模式就一起被豁免
  const stillGuarded = run("POST", "/api/generate", {});
  check("普通写接口仍受变更令牌门约束（豁免没开成一片）", stillGuarded.statusCode === 403);

  // 2026-10-18 手机端出图代理：服务端**自调** /api/generate，这一跳必须由服务端补上变更令牌。
  // 手机请求本身拿不到主进程内存里的令牌，但不补的话桌面版里 /api/generate 直接 403 ——
  // 现象是"手机能登录、能看图，一点出图就失败"，日志里只有一条 MUTATION_TOKEN_REQUIRED。
  const jobsMod = await import("./mobile-jobs.js");
  const captured = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    captured.push({ url: String(url), headers: (opts && opts.headers) || {} });
    return { ok: false, status: 500, json: async () => ({ error: "stub" }) };
  };
  try {
    jobsMod.create({
      userId: "u-guard",
      token: "m_" + "b".repeat(64),
      payload: { prompt: "杏色毛衫" },
      selfBase: "http://127.0.0.1:1"
    });
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    globalThis.fetch = savedFetch;
  }
  check(
    "出图自调携带变更令牌（否则桌面版手机出图必 403）",
    captured[0]?.headers?.["X-AI-Canvas-Mutation-Token"] === MUTATION_TOKEN,
    JSON.stringify(captured[0]?.headers || {}).slice(0, 140)
  );
  check("出图自调带的是手机用户令牌，不是机器令牌", captured[0]?.headers?.["X-AI-Canvas-Token"]?.startsWith("m_") === true);

  const nonApi = run("POST", "/upload", {});
  check("非 /api 路径不受变更门管（静态/其它路由）", nonApi.nexted === true);
}

// ============================================================
// 第 2 段：真实服务端 HTTP
// ============================================================
function pickPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const PORT = await pickPort();
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  stdio: "inherit", // 沙箱禁止管道 stdio
  env: {
    ...process.env,
    AI_CANVAS_HOME: HTTP_HOME,
    AI_CANVAS_OUTPUTS: path.join(HTTP_HOME, "outputs"),
    AI_CANVAS_VAULT: "file",
    AI_CANVAS_RUNTIME_TOKEN: RUNTIME_TOKEN,
    AI_CANVAS_MUTATION_TOKEN: MUTATION_TOKEN,
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

const call = async (pathname, { method = "GET", headers = {}, body } = {}) => {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data, headers: res.headers };
};

/** 绕开 fetch 的头部限制，用来伪造 Host / Origin */
const rawCall = (pathname, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: pathname, method: "GET", headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* 非 JSON 响应 */
        }
        resolve({ status: res.statusCode, data: json, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });

console.log("\n[3] 真实服务端：端口归属与写操作门");
{
  const s = await call("/api/session");
  check(
    "每个响应都回显本次运行标识（主进程据此确认端口归属）",
    s.headers.get("x-ai-canvas-runtime-token") === RUNTIME_TOKEN
  );
  check("就绪探针接口本身可读（不带令牌）", s.status === 200, `status=${s.status}`);

  const readBrand = await call("/api/brand");
  check("公开读接口不受变更门影响", readBrand.status === 200, `status=${readBrand.status}`);

  const noToken = await call("/api/__guard-probe", { method: "POST", body: {} });
  check("POST 无令牌 → 403", noToken.status === 403, `status=${noToken.status}`);
  check("响应体带 MUTATION_TOKEN_REQUIRED", noToken.data?.code === "MUTATION_TOKEN_REQUIRED", JSON.stringify(noToken.data));

  const wrongToken = await call("/api/__guard-probe", {
    method: "POST",
    headers: { "X-AI-Canvas-Mutation-Token": WRONG_TOKEN },
    body: {}
  });
  check("POST 错令牌 → 403", wrongToken.status === 403, `status=${wrongToken.status}`);

  const okToken = await call("/api/__guard-probe", {
    method: "POST",
    headers: { "X-AI-Canvas-Mutation-Token": MUTATION_TOKEN },
    body: {}
  });
  check(
    "POST 正确令牌 → 通过变更门（随后被会话门拦下 = 两层串联，防御纵深）",
    okToken.status === 401 && okToken.data?.code === "SESSION_REQUIRED",
    `status=${okToken.status} ${JSON.stringify(okToken.data)}`
  );

  const sessionToken = (await call("/api/session")).data?.token || "";
  check("能取到本地会话令牌", /^[0-9a-f]{64}$/.test(sessionToken));

  const bothTokens = await call("/api/__guard-probe", {
    method: "POST",
    headers: { "X-AI-Canvas-Mutation-Token": MUTATION_TOKEN, "X-AI-Canvas-Token": sessionToken },
    body: {}
  });
  check(
    "两层令牌齐备 → 真正进到路由层（404 = 门都过了）",
    bothTokens.status === 404,
    `status=${bothTokens.status}`
  );

  const callback = await call("/api/recharge/callback/sandbox", { method: "POST", body: {} });
  check("支付回调不被变更门拦（403 之外的校验结果交给验签）", callback.status !== 403, `status=${callback.status}`);
}

console.log("\n[4] 原有防线未被破坏：Host / Origin");
{
  const badHost = await rawCall("/api/brand", { Host: "evil.example.com" });
  check("伪造 Host → 403 BAD_HOST", badHost.status === 403 && badHost.data?.code === "BAD_HOST", `status=${badHost.status} ${JSON.stringify(badHost.data)}`);

  const badOrigin = await rawCall("/api/brand", { Origin: "http://evil.example.com" });
  check(
    "跨站 Origin → 403 BAD_ORIGIN",
    badOrigin.status === 403 && badOrigin.data?.code === "BAD_ORIGIN",
    `status=${badOrigin.status} ${JSON.stringify(badOrigin.data)}`
  );
}

// ---------- 收尾 ----------
server.kill("SIGKILL");
await sleep(300);
for (const dir of [UNIT_HOME, HTTP_HOME]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上可能有句柄占用，忽略 */
  }
}

console.log(`\n变更令牌门与端口归属：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
