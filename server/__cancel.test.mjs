/**
 * 端到端验证「取消是真的取消」（2026-09-25）
 * --------------------------------------------------------------------------
 * 单测只能证明「钩子被调用了」，证明不了「上游真的收到停止指令」。
 * 这里起一个假 ComfyUI：
 *   · /prompt   返回 prompt_id
 *   · /history  永远返回空（假装还在算）
 *   · /interrupt 计数
 * 然后真的跑一次 comfyui.generate，中途取消，断言：
 *   1. /interrupt 真的被请求了（不是只断开本地连接）
 *   2. generate 抛出的错误是「已取消」而不是超时（说明轮询被立刻打断）
 *
 * 这两条正是「用户点了取消，GPU 还在跑」这个 bug 的反面。
 */
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-test-"));
process.env.AI_CANVAS_HOME = HOME;
process.env.AI_CANVAS_VAULT = "file";

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

// ---------- 假 ComfyUI ----------
let interruptHits = 0;
let promptHits = 0;
let historyHits = 0;

const OBJECT_INFO = {
  ImageScale: {},
  UNETLoader: { input: { required: { unet_name: [["z_image_turbo_bf16.safetensors"]] } } },
  VAELoader: { input: { required: { vae_name: [["z_image_vae.safetensors"]] } } },
  CLIPLoader: { input: { required: { clip_name: [["qwen_3_4b.safetensors"]] } } }
};

const fake = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  res.setHeader("content-type", "application/json");
  if (url === "/interrupt" && req.method === "POST") {
    interruptHits++;
    return res.end("{}");
  }
  if (url === "/object_info") return res.end(JSON.stringify(OBJECT_INFO));
  if (url === "/prompt") {
    promptHits++;
    return res.end(JSON.stringify({ prompt_id: "fake-prompt-1" }));
  }
  if (url.startsWith("/history/")) {
    historyHits++;
    return res.end(JSON.stringify({})); // 永远没算完
  }
  res.end("{}");
});

await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${fake.address().port}`;

// ---------- 把 provider 指向假服务 ----------
const { saveConfig } = await import("./config.js");
saveConfig({ comfyui: { baseUrl, profile: "" } });

const comfyui = await import("./providers/comfyui.js");
const tasks = await import("./tasks.js");

console.log("\n[1] 取消会停上游（ComfyUI /interrupt 真的被请求）");
{
  const id = "cancel-e2e-1";
  const t = tasks.register(id, { provider: "comfyui" });

  const running = comfyui
    .generate({
      prompt: "一件杏色圆领毛衫",
      size: "512x512",
      n: 1,
      signal: t.controller.signal,
      registerCancel: (fn) => tasks.onCancel(id, fn)
    })
    .then(
      () => null,
      (e) => e
    );

  // 轮询间隔 1.5s，要等超过一个间隔才算真的「进到轮询阶段」——
  // 否则取消发生在首次 sleep 里，测的是 sleep 可中断而不是轮询被打断
  await new Promise((r) => setTimeout(r, 1700));
  check("任务已提交（prompt 被请求）", promptHits > 0, `promptHits=${promptHits}`);
  check("任务已进入轮询（history 被查过）", historyHits > 0, `historyHits=${historyHits}`);
  check("取消前没请求过 interrupt", interruptHits === 0);

  const startedAt = Date.now();
  const r = await tasks.cancel(id);
  const err = await running;
  const cost = Date.now() - startedAt;

  check("取消返回成功", r.ok === true);
  check("**/interrupt 真的被请求了**", interruptHits === 1, `hits=${interruptHits}`);
  check("generate 抛的是「已取消」", err?.message === "已取消", err?.message);
  check("取消立刻生效，没有等到超时", cost < 1500, `耗时 ${cost}ms`);

  tasks.unregister(id);
}

console.log("\n[2] 不取消时不会被误中断");
{
  const id = "cancel-e2e-2";
  const t = tasks.register(id, { provider: "comfyui" });
  const before = interruptHits;
  // 只跑很短一段，然后由我们主动 abort（模拟「任务自己结束」而非用户取消）
  const p = comfyui.generate({
    prompt: "x",
    size: "512x512",
    n: 1,
    signal: t.controller.signal
  }).then(() => null, (e) => e);
  await new Promise((r) => setTimeout(r, 300));
  t.controller.abort(); // 直接断信号，不走 tasks.cancel
  await p;
  check("直接 abort 不触发 /interrupt（钩子只由 cancel 触发）", interruptHits === before, `${before} → ${interruptHits}`);
  tasks.unregister(id);
}

fake.close();
try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* Windows 上可能有句柄占用，忽略 */
}

console.log(`\n取消端到端：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
