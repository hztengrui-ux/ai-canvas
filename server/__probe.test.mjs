/**
 * 第三方模型 API 连通性自检（provider probe）自测
 * ---------------------------------------------------------------------------
 * 用本地假上游模拟 OpenAI / Gemini / Chat Completions，验证「同一个失败」能
 * 被区分成不同的 code（用户点「测试连接」时看到的就是这些 code 对应的中文提示）：
 *   - Key 错       → AUTH / FORBIDDEN
 *   - 地址错       → PATH
 *   - 模型名错     → MODEL（列出模型时不匹配只给提示，不判失败）
 *   - 连不上       → NETWORK
 *   - 未配置 Key   → NO_KEY
 *
 * 同时也钉死两件事，避免以后回归：
 *   1. 自检绝不能生成图片、不能扣算力（只允许 /models 与 1-token /chat/completions）
 *   2. 前端传的覆盖值只用于本次探测，不能改到已保存的配置
 *
 * 纯本地：假上游 + 真实服务端，不打外网，不需要任何真实 Key。
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "probe-test-"));
process.env.AI_CANVAS_HOME = HOME;
process.env.AI_CANVAS_VAULT = "file";

const BASE = String(process.env.BASE || "").replace(/\/+$/, "");

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

if (!BASE) {
  console.error("缺少 BASE 环境变量：请通过 scripts/run-tests.mjs 运行");
  process.exit(1);
}

// ---------- 假上游 ----------
const calls = [];
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    calls.push({ url: req.url, method: req.method, body });
    res.setHeader("content-type", "application/json");

    const auth = String(req.headers.authorization || "");
    const gkey = String(req.headers["x-goog-api-key"] || "");

    if (req.url === "/v1/models" && req.method === "GET") {
      if (auth !== "Bearer good") {
        res.writeHead(401).end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ data: [{ id: "gpt-image-2" }, { id: "gpt-image-2.5" }] }));
      return;
    }

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      if (auth !== "Bearer good") {
        res.writeHead(401).end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      if (body?.model === "bad-model") {
        res.writeHead(404).end(JSON.stringify({ error: { message: "model not found: bad-model" } }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ choices: [{ message: { content: "p" } }] }));
      return;
    }

    if (req.url === "/google/v1beta/models" && req.method === "GET") {
      if (gkey !== "gkey") {
        res.writeHead(403).end(JSON.stringify({ error: { message: "permission denied" } }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ models: [{ name: "models/nano-banana-pro" }, { name: "models/gemini-2.5-flash-image" }] }));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: { message: `not found: ${req.url}` } }));
  });
});

await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${fake.address().port}`;

// guard 要求本机会话令牌：先按桌面端同样的方式拿一枚（/api/session 只发给本机）
const sessionResp = await fetch(`${BASE}/api/session`);
const sessionJson = await sessionResp.json().catch(() => ({}));
const TOKEN = String(sessionJson?.token || "");
if (!TOKEN) {
  console.error("拿不到本机会话令牌，无法测自检接口：", JSON.stringify(sessionJson));
  process.exit(1);
}

async function probe(payload) {
  const res = await fetch(`${BASE}/api/providers/probe`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ai-canvas-token": TOKEN },
    body: JSON.stringify(payload)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

console.log("\n[1] 未配置 Key / 不支持的 provider");
{
  const r = await probe({ provider: "openai", baseUrl: `${origin}/v1`, apiKey: null, model: "gpt-image-2" });
  check("没填 Key → NO_KEY", r.json?.code === "NO_KEY", JSON.stringify(r.json));
  check("NO_KEY 有可执行提示", Array.isArray(r.json?.hints) && r.json.hints.length > 0);
  check("回包不回显 Key", !("apiKey" in (r.json || {})), JSON.stringify(r.json));

  const u = await probe({ provider: "wanxiang" });
  check("不支持的 provider → UNSUPPORTED", u.json?.code === "UNSUPPORTED", JSON.stringify(u.json));
}

console.log("\n[2] openai：列模型");
{
  const ok = await probe({ provider: "openai", baseUrl: `${origin}/v1/`, apiKey: "good", model: "gpt-image-2" });
  check("地址尾部斜杠会被规范化并连通", ok.json?.ok === true, JSON.stringify(ok.json));
  check("列出了模型且匹配到目标模型", ok.json?.models?.matched === true, JSON.stringify(ok.json?.models));
  check("返回耗时", typeof ok.json?.latencyMs === "number");

  const wrongKey = await probe({ provider: "openai", baseUrl: `${origin}/v1`, apiKey: "bad", model: "gpt-image-2" });
  check("Key 错 → AUTH", wrongKey.json?.code === "AUTH", JSON.stringify(wrongKey.json));

  const wrongPath = await probe({ provider: "openai", baseUrl: `${origin}/nope`, apiKey: "good", model: "gpt-image-2" });
  check("地址错 → PATH", wrongPath.json?.code === "PATH", JSON.stringify(wrongPath.json));

  const unknownModel = await probe({ provider: "openai", baseUrl: `${origin}/v1`, apiKey: "good", model: "gpt-image-9" });
  check("模型不在列表：仍算连通，但给提示", unknownModel.json?.ok === true && unknownModel.json?.models?.matched === false);
  check("模型未匹配时有提示", (unknownModel.json?.hints || []).length > 0);
}

console.log("\n[3] gemini：x-goog-api-key 头");
{
  const ok = await probe({ provider: "gemini", baseUrl: `${origin}/google/v1beta`, apiKey: "gkey", model: "nano-banana-pro" });
  check("Gemini 连通并匹配模型", ok.json?.ok === true && ok.json?.models?.matched === true, JSON.stringify(ok.json));
  const forbidden = await probe({ provider: "gemini", baseUrl: `${origin}/google/v1beta`, apiKey: "nope", model: "nano-banana-pro" });
  check("Key 无权限 → FORBIDDEN", forbidden.json?.code === "FORBIDDEN", JSON.stringify(forbidden.json));
}

console.log("\n[4] llm：1-token 对话验证");
{
  calls.length = 0;
  const ok = await probe({ provider: "llm", baseUrl: `${origin}/v1`, apiKey: "good", model: "doubao-seed-2-1-pro" });
  check("LLM 连通", ok.json?.ok === true, JSON.stringify(ok.json));
  const chatCall = calls.find((c) => c.url === "/v1/chat/completions");
  check("自检发的是 max_tokens=1 的极短请求", chatCall?.body?.max_tokens === 1, JSON.stringify(chatCall?.body));
  check("没有发起图片生成请求", !calls.some((c) => /images\//.test(c.url)), JSON.stringify(calls.map((c) => c.url)));

  const badModel = await probe({ provider: "llm", baseUrl: `${origin}/v1`, apiKey: "good", model: "bad-model" });
  check("模型名错 → MODEL", badModel.json?.code === "MODEL", JSON.stringify(badModel.json));

  const badPath = await probe({ provider: "llm", baseUrl: `${origin}/x`, apiKey: "good", model: "doubao-seed-2-1-pro" });
  check("地址错 → PATH", badPath.json?.code === "PATH", JSON.stringify(badPath.json));
}

console.log("\n[5] comfyui：地址不可达");
{
  const r = await probe({ provider: "comfyui", baseUrl: "http://127.0.0.1:1" });
  check("连不上 → NETWORK", r.json?.code === "NETWORK", JSON.stringify(r.json));
  check("给了启动 ComfyUI 的提示", (r.json?.hints || []).length > 0);
}

console.log("\n[6] 纯函数：地址规范化");
{
  const mod = await import("./providers/probe.js");
  let threw = false;
  try {
    mod.normalizeBaseUrl("ftp://example.com/v1");
  } catch {
    threw = true;
  }
  check("拒绝非 http(s) 协议", threw);

  let creds = false;
  try {
    mod.normalizeBaseUrl("https://user:pass@example.com/v1");
  } catch {
    creds = true;
  }
  check("拒绝把账号密码写进地址", creds);
  check("去掉尾部斜杠", mod.normalizeBaseUrl("https://api.openai.com/v1///") === "https://api.openai.com/v1");

  const c = mod.classifyHttpStatus(429);
  check("429 → RATE", c.code === "RATE" && /限流/.test(c.message));
}

fake.close();
await new Promise((resolve) => setTimeout(resolve, 50));

console.log(`\n自检接口测试：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
