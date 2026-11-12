// 云端四家 provider 的「图生图」入参验收
//
// 要防的回归：**参考图被静默丢弃**。
// 表现是「生成成功了，但图跟上传的毛衫一点关系都没有」——最难排查的一类 bug，
// 因为它不报错。所以这里不看返回，只断言**发出去的请求体里真的带了图片字节**。
//
// 运行：node server/__i2i.test.mjs
//   需 AI_CANVAS_HOME 指向临时目录、AI_CANVAS_VAULT=file（密钥落文件，免得动系统凭据库）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, setProviderKey } from "./config.js";
import * as refimage from "./providers/refimage.js";

// 硬闸门：这个套件会改 config.json（模型名 / outputsDir），
// 忘了给 AI_CANVAS_HOME 就会写脏用户真实配置，且症状要等下次生成才暴露。
// 与其事后清理，不如直接不让跑。
if (!process.env.AI_CANVAS_HOME) {
  console.error("❌ 缺少 AI_CANVAS_HOME：本套件会写配置文件，必须指向临时目录后再跑。");
  process.exit(1);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "i2i-test-"));
const WANXIANG_BEFORE = loadConfig().wanxiang;

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

// ---------- 造一张真实 PNG（1x1，够小，够真） ----------
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const B64 = PNG_1X1.toString("base64");
const DATA_URI = `data:image/png;base64,${B64}`;

const OUT = path.join(TMP, "outputs");
fs.mkdirSync(OUT, { recursive: true });
saveConfig({ outputsDir: OUT });

fs.writeFileSync(path.join(OUT, "sweater.png"), PNG_1X1);
fs.writeFileSync(path.join(OUT, "logo.png"), PNG_1X1);
const REF_ONE = [{ url: "/outputs/sweater.png" }];
const REF_TWO = [{ url: "/outputs/sweater.png" }, { url: "/outputs/logo.png" }];

// ---------- fetch 打桩：只记录，不发真实请求 ----------
let calls = [];
function stubFetch(router) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [pattern, handler] of router) {
      if (u.includes(pattern)) {
        const body = typeof handler === "function" ? handler(u, init) : handler;
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body)
        };
      }
    }
    throw new Error(`未打桩的请求：${u}`);
  };
}
function lastCall(fragment) {
  const hit = calls.filter((c) => c.url.includes(fragment));
  return hit[hit.length - 1];
}
async function jsonBody(call) {
  return JSON.parse(String(call.init.body));
}

// ============================================================
console.log("\n=== 1. refimage：路径校验 / 体积上限 / data URI ===");
{
  check("本地 outputs 文件可读", Boolean(refimage.resolveLocalFile("/outputs/sweater.png")));
  check(
    "路径穿越被拦（../../）",
    refimage.resolveLocalFile("/outputs/../../package.json") === ""
  );
  check("非白名单目录被拦", refimage.resolveLocalFile("/etc/hosts") === "");
  check("不存在的文件返回空", refimage.resolveLocalFile("/outputs/__nope__.png") === "");
  check("mime 推断 png", refimage.mimeOf("a.png") === "image/png");
  check("mime 推断 jpg", refimage.mimeOf("a.JPG") === "image/jpeg");
  check("未知扩展名兜底 png", refimage.mimeOf("a.bin") === "image/png");

  const loaded = await refimage.loadReferences(REF_ONE, {});
  check("读盘产出 1 条", loaded.length === 1, `实际 ${loaded.length}`);
  check("data URI 前缀正确", loaded[0]?.dataUri?.startsWith("data:image/png;base64,"));
  check("data URI 含真实字��", loaded[0]?.dataUri?.includes(B64));
  check("裸 base64 可用（Gemini 要这个）", loaded[0]?.b64 === B64);

  const two = await refimage.loadReferences(REF_TWO, { max: 2 });
  check("多图读盘产出 2 条", two.length === 2);
  const capped = await refimage.loadReferences(REF_TWO, { max: 1 });
  check("max 生效（只取 1 张）", capped.length === 1);

  const big = path.join(OUT, "big.png");
  fs.writeFileSync(big, Buffer.alloc(refimage.MAX_REF_BYTES + 1024, 1));
  const withBig = await refimage.loadReferences([{ url: "/outputs/big.png" }], {});
  check("超 8MB 被跳过", withBig.length === 0);
  fs.unlinkSync(big);

  const notes = [];
  await refimage.loadReferences([{ url: "/outputs/__nope__.png" }], { onProgress: (t) => notes.push(t) });
  check("跳过会回报原因（不静默丢图）", notes.some((t) => t.includes("跳过")));

  const fromUri = await refimage.loadReferences([{ url: DATA_URI }], {});
  check("已是 data URI 直接复用", fromUri.length === 1 && fromUri[0].dataUri === DATA_URI);
}

console.log("\n=== 2. refimage：商品一致性提示词后缀 ===");
{
  const s = refimage.productIntentSuffix({ printArea: "chest", keepTexture: true });
  check("含印花区域", s.includes("胸前"));
  check("含纹理保留", s.includes("针织纹理"));
  const s2 = refimage.productIntentSuffix({ printArea: "full", keepTexture: false });
  check("关闭纹理后不再提保留", !s2.includes("针织纹理"));
  check(
    "无参考图时不拼接后缀",
    refimage.withProductIntent("原提示词", [], {}) === "原提示词"
  );
  const merged = refimage.withProductIntent("原提示词", [{ url: "x" }], { printArea: "back" });
  check("有参考图时拼接后缀", merged.startsWith("原提示词。") && merged.includes("背面"));
}

// ============================================================
console.log("\n=== 3. 万相：带参考图必须走 multimodal-generation ===");
stubFetch([
  ["multimodal-generation", { output: { choices: [{ message: { content: [{ image: "https://dash/ok.png" }] } }] } }],
  ["text2image/image-synthesis", { output: { task_id: "wx-task" } }],
  ["/api/v1/tasks/", { output: { task_status: "SUCCEEDED", results: [{ url: "https://dash/t2i.png" }] } }]
]);
setProviderKey("wanxiang", "sk-test-wx");
saveConfig({ wanxiang: { ...loadConfig().wanxiang, i2iModel: "wan2.6-image" } });
{
  const wx = await import("./providers/wanxiang.js");
  const out = await wx.generate({
    prompt: "杏色毛衫加圣诞印花",
    negativePrompt: "模糊",
    size: "1024x1024",
    n: 1,
    referenceImages: REF_ONE
  });

  const call = lastCall("multimodal-generation");
  check("命中图生图端点", Boolean(call));
  check(
    "没有误走文生图端点",
    !calls.some((c) => c.url.includes("text2image"))
  );
  const body = await jsonBody(call);
  check("模型换成图生图模型", body.model === "wan2.6-image", body.model);
  check("messages 结构正确", Array.isArray(body.input?.messages?.[0]?.content));
  const content = body.input.messages[0].content;
  check("content[0] 是文本", typeof content[0]?.text === "string");
  check("content[1] 是图片", typeof content[1]?.image === "string");
  check("图片是 data URI", String(content[1]?.image).startsWith("data:image/png;base64,"));
  check("图片字节与磁盘一致", String(content[1]?.image).includes(B64));
  check("提示词带上商品约束", content[0].text.includes("针织纹理"));
  check("返回结果带 url", out?.[0]?.url === "https://dash/ok.png");
}

console.log("\n=== 4. 万相：负向词位置（旧版在 input，新版在 parameters） ===");
{
  const wx = await import("./providers/wanxiang.js");
  // 旧版模型（wanx2.1-t2i-turbo）：不传参考图 → 走异步文生图
  // pollTask 首轮会 sleep 2s，这是唯一一个慢用例，容忍
  await wx.generate({ prompt: "一只猫", negativePrompt: "模糊", size: "1024x1024", n: 1, referenceImages: [] });
  const body = await jsonBody(lastCall("text2image"));
  check("旧版模型用 input.prompt", body.input?.prompt === "一只猫");
  check("旧版负向词在 input 下", body.input?.negative_prompt === "模糊");
  check("旧版 parameters 里没有负向词", body.parameters?.negative_prompt === undefined);

  saveConfig({ wanxiang: { ...loadConfig().wanxiang, model: "wan2.6-t2i" } });
  stubFetch([
    ["text2image/image-synthesis", { output: { task_id: "wx-task" } }],
    ["/api/v1/tasks/", { output: { task_status: "SUCCEEDED", results: [{ url: "https://dash/t2i.png" }] } }]
  ]);
  await wx.generate({ prompt: "一只猫", negativePrompt: "模糊", size: "1024x1024", n: 1, referenceImages: [] });
  const body2 = await jsonBody(lastCall("text2image"));
  check("wan2.6 用 messages", Array.isArray(body2.input?.messages));
  check("wan2.6 负向词在 parameters 下", body2.parameters?.negative_prompt === "模糊");
  check("wan2.6 input 里没有负向词", body2.input?.negative_prompt === undefined);
}

// ============================================================
console.log("\n=== 5. 即梦：image 字段（单图字符串 / 多图数组） ===");
stubFetch([["images/generations", { data: [{ url: "https://ark/ok.png" }] }]]);
setProviderKey("jiemeng", "sk-test-jm");
{
  const jm = await import("./providers/jiemeng.js");
  await jm.generate({ prompt: "毛衫", size: "1024x1024", n: 1, referenceImages: REF_ONE });
  let body = await jsonBody(lastCall("images/generations"));
  check("单图 → image 为字符串", typeof body.image === "string");
  check("image 是 data URI", String(body.image).startsWith("data:image/png;base64,"));
  check("image 字节一致", String(body.image).includes(B64));

  await jm.generate({ prompt: "毛衫", size: "1024x1024", n: 1, referenceImages: REF_TWO });
  body = await jsonBody(lastCall("images/generations"));
  check("多图 → image 为数组", Array.isArray(body.image) && body.image.length === 2);
  check("数组元素都是 data URI", body.image.every((s) => s.startsWith("data:image/")));

  await jm.generate({ prompt: "毛衫", size: "1024x1024", n: 1, referenceImages: [] });
  body = await jsonBody(lastCall("images/generations"));
  check("无参考图时不带 image 字段", body.image === undefined);
}

// ============================================================
console.log("\n=== 6. OpenAI：带参考图必须换 /images/edits（multipart） ===");
stubFetch([
  ["images/edits", { data: [{ b64_json: B64 }] }],
  ["images/generations", { data: [{ url: "https://oai/ok.png" }] }]
]);
setProviderKey("openai", "sk-test-oai");
{
  const oai = await import("./providers/openai.js");
  await oai.generate({ prompt: "毛衫加印花", size: "1024x1024", n: 1, referenceImages: REF_ONE, strength: 0.85 });
  const call = lastCall("images/edits");
  check("命中 edits 端点", Boolean(call));
  check("没有误走 generations", !calls.some((c) => c.url.includes("generations")));
  check("body 是 FormData", call.init.body instanceof FormData);
  const files = call.init.body.getAll("image");
  check("表单里有 1 个 image 文件", files.length === 1, `实际 ${files.length}`);
  check("文件带 filename", typeof files[0]?.name === "string" && files[0].name === "sweater.png");
  check("文件是二进制不是字符串", typeof files[0] !== "string");
  const bytes = Buffer.from(await files[0].arrayBuffer());
  check("文件字节与磁盘一致", bytes.equals(PNG_1X1));
  check("高参考强度 → input_fidelity=high", call.init.body.get("input_fidelity") === "high");

  await oai.generate({ prompt: "毛衫", size: "1024x1024", n: 1, referenceImages: REF_TWO, strength: 0.3 });
  const call2 = lastCall("images/edits");
  check("多图 → 多个 image 字段", call2.init.body.getAll("image").length === 2);
  check("低参考强度 → input_fidelity=low", call2.init.body.get("input_fidelity") === "low");

  await oai.generate({ prompt: "一只猫", size: "1024x1024", n: 1, referenceImages: [] });
  check("无参考图时回落 generations", Boolean(lastCall("images/generations")));
}

// ============================================================
console.log("\n=== 7. Gemini：inline_data part ===");
stubFetch([["generateContent", { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: B64 } }] } }] }]]);
setProviderKey("gemini", "sk-test-gem");
{
  const gm = await import("./providers/gemini.js");
  const out = await gm.generate({ prompt: "毛衫", size: "1024x1024", n: 1, referenceImages: REF_ONE });
  const body = await jsonBody(lastCall("generateContent"));
  const parts = body.contents?.[0]?.parts || [];
  check("parts[0] 是文本", typeof parts[0]?.text === "string");
  check("parts[1] 是 inline_data", Boolean(parts[1]?.inline_data));
  check("mime_type 正确", parts[1]?.inline_data?.mime_type === "image/png");
  check("data 是裸 base64（不是 data URI）", parts[1]?.inline_data?.data === B64);
  check("data 不含 data:image 前缀", !String(parts[1]?.inline_data?.data).startsWith("data:"));
  check("返回图片被解析", out?.[0]?.url?.startsWith("data:image/png;base64,"));

  await gm.generate({ prompt: "毛衫", size: "1024x1024", n: 1, referenceImages: REF_TWO });
  const body2 = await jsonBody(lastCall("generateContent"));
  check("两张参考图 → 两个 inline_data", (body2.contents[0].parts || []).filter((p) => p.inline_data).length === 2);

  await gm.generate({ prompt: "一只猫", size: "1024x1024", n: 1, referenceImages: [] });
  const body3 = await jsonBody(lastCall("generateContent"));
  check("无参考图时只有文本 part", body3.contents[0].parts.length === 1);
}

// ============================================================
console.log("\n=== 8. 反向边界：参考图全废时不能拖垮主流程 ===");
stubFetch([["images/generations", { data: [{ url: "https://ark/ok.png" }] }]]);
{
  const jm = await import("./providers/jiemeng.js");
  const out = await jm.generate({
    prompt: "毛衫",
    size: "1024x1024",
    n: 1,
    referenceImages: [{ url: "/outputs/__不存在__.png" }, { url: "/etc/passwd" }]
  });
  check("参考图全废仍能出图（退回文生图）", out?.length === 1);
  const body = await jsonBody(lastCall("images/generations"));
  check("废图不会被塞进请求体", body.image === undefined);
}

// ---------- 收尾 ----------
globalThis.fetch = undefined;
fs.rmSync(TMP, { recursive: true, force: true });
// 测试改过 outputsDir 和万相模型，这里还原，别影响真实运行
saveConfig({ outputsDir: path.join(ROOT, "outputs"), wanxiang: WANXIANG_BEFORE });

console.log(`\n  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
