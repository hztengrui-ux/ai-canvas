/**
 * 语义处理（LLM：豆包 2.1 / 中转站）+ 上游模型名解析 —— 单元自测
 * --------------------------------------------------------------------------
 * 这层不联网：global.fetch 被替换成桩，断言的是**我们发出的请求长什么样**、
 * 以及**返回内容怎么解析**。真接口对不对，只能在配了 Key 的机器上验，
 * 但"请求形状错了"这类错，桩测试就能拦住。
 *
 * 重点覆盖三个极易回归的点：
 *   1. apiIdOf 的三级优先（用户覆盖 > 官方默认 > 原样），这是接中转站的关键；
 *   2. 未配置 Key 时必须报"未配置…"（接口据此返回 503，前端才能提示去设置里填）；
 *   3. content 可能是字符串也可能是数组（各家实现不一），两种都要取到文本。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 数据根隔离：必须在 import config 之前设置，否则会写到真实用户目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-test-"));
process.env.AI_CANVAS_HOME = TMP;
process.env.AI_CANVAS_OUTPUTS = path.join(TMP, "outputs");
process.env.AI_CANVAS_MATERIALS = path.join(TMP, "materials");
process.env.AI_CANVAS_VAULT = "file";
fs.mkdirSync(process.env.AI_CANVAS_OUTPUTS, { recursive: true });
fs.mkdirSync(process.env.AI_CANVAS_MATERIALS, { recursive: true });

const { apiIdOf, getModel, MODELS } = await import("../server/models/registry.js");
const textai = await import("../server/textai.js");
const { setProviderKey, saveConfig } = await import("../server/config.js");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? "  → " + extra : ""}`);
  }
}

function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const record = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(record);
    return handler(record, calls.length);
  };
  return calls;
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj
  };
}

// ---------- 1. 上游模型名解析 ----------
console.log("\n[1] apiIdOf：界面 id → 上游真实模型名");
check("注册表里有 seedream-5-pro", Boolean(getModel("seedream-5-pro")));
check(
  "官方默认：nano-banana-pro → gemini-3-pro-image-preview",
  apiIdOf("nano-banana-pro") === "gemini-3-pro-image-preview",
  apiIdOf("nano-banana-pro")
);
check(
  "官方默认：nano-banana-2 → gemini-2.5-flash-image",
  apiIdOf("nano-banana-2") === "gemini-2.5-flash-image",
  apiIdOf("nano-banana-2")
);
check(
  "官方默认：seedream-5-pro → doubao-seedream-5-0-pro",
  apiIdOf("seedream-5-pro") === "doubao-seedream-5-0-pro",
  apiIdOf("seedream-5-pro")
);
check(
  "用户覆盖优先于官方默认",
  apiIdOf("nano-banana-pro", { "nano-banana-pro": "google/gemini-3-pro-image" }) === "google/gemini-3-pro-image"
);
check(
  "覆盖值为空白 → 回落到官方默认",
  apiIdOf("nano-banana-pro", { "nano-banana-pro": "   " }) === "gemini-3-pro-image-preview"
);
check("未注册模型 → 原样返回（保持老的宽松行为）", apiIdOf("wanx2.1-t2i-turbo") === "wanx2.1-t2i-turbo");
check("空 id → 空串（不抛错）", apiIdOf("") === "");
check("overrides 传非对象也不炸", apiIdOf("jiemeng", null) === "doubao-seedream-4-0");
check(
  "每个 image 模型都带 apiId 字段（没漏）",
  MODELS.filter((m) => m.kind === "image").every((m) => typeof m.apiId === "string")
);

// ---------- 2. 任务表 ----------
console.log("\n[2] 任务表");
check("有 optimize-prompt", textai.hasTask("optimize-prompt"));
check("有 selling-points", textai.hasTask("selling-points"));
check("不存在的任务返回 false", textai.hasTask("hack-the-planet") === false);
check("空任务返回 false", textai.hasTask("") === false);
check("上限是 4000 字", textai.MAX_INPUT_CHARS === 4000);

// ---------- 3. 未配置 Key ----------
console.log("\n[3] 未配置 Key：必须报「未配置」，接口据此回 503");
setProviderKey("llm", ""); // 清空
let missingKeyMsg = "";
try {
  await textai.run("optimize-prompt", "一件米色针织开衫");
} catch (err) {
  missingKeyMsg = String(err?.message || err);
}
check("抛错且提示未配置", /未配置/.test(missingKeyMsg), missingKeyMsg);
check("提示里指明了去哪儿配", /设置/.test(missingKeyMsg), missingKeyMsg);

// ---------- 4. 参数校验（在校验之前不发出网络请求）----------
console.log("\n[4] 入参校验");
const callsBefore = stubFetch(() => jsonResponse({}, 500));
let emptyMsg = "";
try {
  await textai.run("optimize-prompt", "   ");
} catch (err) {
  emptyMsg = String(err?.message || err);
}
check("空内容被拒", /不能为空/.test(emptyMsg), emptyMsg);
let longMsg = "";
try {
  await textai.run("optimize-prompt", "字".repeat(4001));
} catch (err) {
  longMsg = String(err?.message || err);
}
check("超长内容被拒", /过长/.test(longMsg), longMsg);
check("校验失败时没有发出请求", callsBefore.length === 0, `实际 ${callsBefore.length} 次`);
let badTaskMsg = "";
try {
  await textai.run("nope", "x");
} catch (err) {
  badTaskMsg = String(err?.message || err);
}
check("未知任务被拒", /不支持的任务/.test(badTaskMsg), badTaskMsg);

// ---------- 5. 正常调用：请求形状 + 解析 ----------
console.log("\n[5] 正常调用");
setProviderKey("llm", "sk-test-123456");
saveConfig({ llm: { baseUrl: "https://api.example-proxy.com/v1", model: "doubao-seed-2-1-pro" } });

let calls = stubFetch(() =>
  jsonResponse({
    model: "doubao-seed-2-1-pro",
    choices: [{ message: { content: "一件米色羊毛针织开衫，细腻平针纹理…" } }],
    usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 }
  })
);
const ok = await textai.run("optimize-prompt", "把图中的衣服换个欧美模特", { context: { model: "nano-banana-pro" } });
check("返回文本", /米色羊毛/.test(ok.text), ok.text);
check("返回模型名", ok.model === "doubao-seed-2-1-pro", ok.model);
check("返回 token 用量", ok.usage?.totalTokens === 180, JSON.stringify(ok.usage));
check("只发了 1 次请求", calls.length === 1, String(calls.length));
check("打到 {baseUrl}/chat/completions", calls[0].url === "https://api.example-proxy.com/v1/chat/completions", calls[0].url);
check("用 Bearer 鉴权", calls[0].init.headers?.Authorization === "Bearer sk-test-123456", calls[0].init.headers?.Authorization);
check("请求体带 model", calls[0].body?.model === "doubao-seed-2-1-pro");
check("请求体带 messages（system+user）", Array.isArray(calls[0].body?.messages) && calls[0].body.messages.length === 2);
check(
  "模板把上下文里的目标模型带进 prompt",
  JSON.stringify(calls[0].body.messages).includes("nano-banana-pro")
);
check("用户原文出现在 user 消息里", JSON.stringify(calls[0].body.messages).includes("换个欧美模特"));

// content 是数组（部分中转站这么返回）
calls = stubFetch(() =>
  jsonResponse({ choices: [{ message: { content: [{ type: "text", text: "第一段" }, { text: "第二段" }] } }] })
);
const arr = await textai.run("selling-points", "羊绒加厚，不起球");
check("content 为数组时能拼成文本", arr.text === "第一段第二段", arr.text);

// ---------- 6. 上游报错 ----------
console.log("\n[6] 上游报错要原样透出");
calls = stubFetch(() => jsonResponse({ error: { message: "model not found: doubao-seed-2-1-pro" } }, 404));
let upstreamMsg = "";
try {
  await textai.run("optimize-prompt", "随便写点");
} catch (err) {
  upstreamMsg = String(err?.message || err);
}
check("把上游错误消息透出来（便于用户改模型名）", /model not found/.test(upstreamMsg), upstreamMsg);

calls = stubFetch(() => jsonResponse({ choices: [{ message: { content: "   " } }] }));
let emptyReplyMsg = "";
try {
  await textai.run("optimize-prompt", "随便写点");
} catch (err) {
  emptyReplyMsg = String(err?.message || err);
}
check("上游返回空内容时报错而不是静默成功", /没有返回内容/.test(emptyReplyMsg), emptyReplyMsg);

// ---------- 7. 清理 ----------
setProviderKey("llm", "");
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}

console.log(`\n语义处理：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
