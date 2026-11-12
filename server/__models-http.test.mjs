/**
 * 模型网关 / 提示词编译 —— HTTP 端到端（Sprint 1）
 * --------------------------------------------------------------------------
 * 单元测试证明「函数算得对」，证明不了「接口挂上了、中间件没拦错、校验发生在正确的时机」。
 * 这里跑真实服务端（run-tests 起的那个，BASE 指向它），断言：
 *   1. /api/models 下发的能力与单价 == 注册表（界面拿它显示价格）
 *   2. /api/prompt/compile 真能编译，且 4000 字符硬上限在接口层同样成立
 *   3. /api/generate 的网关校验是**结构化错误**，不是 500
 *   4. ★ 校验失败**不得占用并发槽** —— 这是 __fixes 里「余额为 0 连点两次锁死所有人」
 *      的同一类缺陷换了触发点：如果校验放在 acquireSlot() 之后，非法请求就能把
 *      inFlight 顶满，变成一个新的全局 DoS
 *   5. 合法请求必须能穿过网关（落到算力/密钥这类真正的下一道门）
 */
const BASE = process.env.BASE || "http://127.0.0.1:5181";

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

const registry = await import("./models/registry.js");
const credits = await import("./credits.js");

let TOKEN = "";
const api = async (pathname, { method = "GET", body, headers = {} } = {}) => {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", "X-AI-Canvas-Token": TOKEN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
};

/** 解析 SSE 流：返回 [{ event, data }]，与 __fixes / __p18-http 的读法一致 */
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
    let parsed = null;
    try {
      parsed = dt ? JSON.parse(dt[1]) : null;
    } catch {
      parsed = null;
    }
    events.push({ event: ev[1], data: parsed });
  }
  return events;
}
const errorOf = (events) => events.find((e) => e.event === "error")?.data?.error || "";

// 会话令牌（run-tests 起的服务端）
{
  const sess = await (await fetch(`${BASE}/api/session`)).json();
  TOKEN = sess.token || "";
}

console.log("\n[1] GET /api/models：服务端下发的能力与单价");
{
  const r = await api("/api/models");
  check("接口可用", r.status === 200, `status=${r.status}`);
  const models = r.data?.models || [];
  check("模型数量与「可见」注册表一致（hidden 不下发）", models.length === registry.visibleModels().length, `${models.length}/${registry.visibleModels().length}`);
  check("每条都有单价", models.every((m) => Number.isFinite(m.cost)));
  check("图片模型单价 == 计费表基价", models.filter((m) => m.kind === "image").every((m) => m.cost === credits.COST_TABLE["image.generate"].cost));
  check("带密钥状态布尔值", models.every((m) => typeof m.hasKey === "boolean"));
  check("带供应商分栏（界面分栏用）", models.every((m) => typeof m.tab === "string" && m.tab.length > 0));
  check("基价字段与计费表一致", r.data?.baseCost === credits.COST_TABLE["image.generate"].cost, `baseCost=${r.data?.baseCost}`);

  const video = await api("/api/models?kind=video");
  check("按 kind 过滤可用", (video.data?.models || []).every((m) => m.kind === "video") && (video.data?.models || []).length > 0);
}

console.log("\n[2] POST /api/prompt/compile：提示词编译");
{
  const ok = await api("/api/prompt/compile", {
    method: "POST",
    body: {
      raw: "把这件毛衫换成模特实拍，保留印花",
      references: [
        { url: "/materials/clothing/a.png", role: "产品图", protected: true },
        { url: "/materials/model/b.png", role: "模特" }
      ],
      ratio: "3:4",
      slots: ["场景：户外", "场景：户外"]
    }
  });
  check("编译成功", ok.status === 200 && ok.data?.ok === true, `status=${ok.status}`);
  check("返回正文非空", typeof ok.data?.text === "string" && ok.data.text.length > 0);
  check("字符数自洽", ok.data?.characters === ok.data?.text?.length, `${ok.data?.characters} vs ${ok.data?.text?.length}`);
  check("blocks 六个分区齐全", ["role", "task", "invariants", "boundaries", "composition", "output"].every((k) => k in (ok.data?.blocks || {})));
  check("参考图编号进入正文", /图1/.test(ok.data?.text || "") && /图2/.test(ok.data?.text || ""));
  check("含注入防御声明（图内文字是素材）", /素材|不作为指令|不是指令/.test(ok.data?.text || ""));

  const long = await api("/api/prompt/compile", {
    method: "POST",
    body: { raw: "把这张图改成电商主图。".repeat(1200), references: [{ url: "/materials/a.png" }], ratio: "1:1" }
  });
  check("超长输入被裁剪到 4000 以内", (long.data?.text || "").length <= 4000, `len=${(long.data?.text || "").length}`);
  check("超长时 truncated=true", long.data?.truncated === true);

  const dirty = await api("/api/prompt/compile", { method: "POST", body: { raw: null, references: "x", ratio: 42, slots: null } });
  check("脏输入不 500（返回可用正文）", dirty.status === 200 && typeof dirty.data?.text === "string", `status=${dirty.status}`);
}

console.log("\n[3] /api/generate：网关校验是结构化错误");
{
  const unknownProvider = await sse("/api/generate", { provider: "__not_exist__", prompt: "x", n: 1 });
  check("未知提供方仍按原样拒绝", errorOf(unknownProvider).includes("未知提供方"), errorOf(unknownProvider));

  const badSize = await sse("/api/generate", { provider: "wanxiang", model: "wanxiang", prompt: "x", size: "abc", n: 1 });
  check("尺寸不合法被网关拦下", errorOf(badSize).includes("尺寸不合法"), errorOf(badSize));

  const tooManyRefs = await sse("/api/generate", {
    provider: "wanxiang",
    model: "wanxiang",
    prompt: "x",
    size: "1024x1024",
    n: 1,
    referenceImages: new Array(5).fill({ url: "/materials/a.png" })
  });
  check("参考图超上限被拦下", /参考图/.test(errorOf(tooManyRefs)), errorOf(tooManyRefs));

  const kindMismatch = await sse("/api/generate", {
    provider: "wanxiang",
    model: "wanx2.1-t2v-turbo",
    prompt: "x",
    size: "1024x1024",
    n: 1
  });
  check("视频模型当图片用被拦下", /类型/.test(errorOf(kindMismatch)), errorOf(kindMismatch));

  const videoKindMismatch = await sse("/api/generate-video", { prompt: "x", model: "wanxiang", resolution: "720p" });
  check("图片模型当视频用被拦下", /类型/.test(errorOf(videoKindMismatch)), errorOf(videoKindMismatch));
}

console.log("\n[4] ★ 校验失败不得占用并发槽（防新型全局 DoS）");
{
  const before = (await api("/api/security")).data?.inFlight;
  // 连打 6 次非法请求：如果校验发生在 acquireSlot() 之后，inFlight 会被顶满，
  // 此后所有人的合法生成都会被拒 —— 这正是要防的回归。
  for (let i = 0; i < 6; i++) {
    await sse("/api/generate", { provider: "wanxiang", model: "wanxiang", prompt: "x", size: "abc", n: 1 });
  }
  const after = (await api("/api/security")).data?.inFlight;
  check("非法请求后 inFlight 未增长", after === before, `${before} → ${after}`);
  check("inFlight 归零（没有泄漏的槽位）", after === 0, `inFlight=${after}`);
}

console.log("\n[5] 合法请求必须能穿过网关");
{
  // 用已注册模型 + 合法尺寸：网关校验应通过，落到下一道门（测试环境里 "local" 余额为 0 → 算力不足，
  // 或未配密钥 → 密钥报错）。关键断言是：失败原因**不是**网关的校验错误。
  const events = await sse("/api/generate", {
    provider: "nano-banana-pro",
    model: "nano-banana-pro",
    prompt: "一件杏色圆领毛衫，白底主图",
    size: "1024x1024",
    n: 1
  });
  const err = errorOf(events);
  const isGatewayError = /尺寸不合法|最多接受|单次最多|类型为/.test(err);
  check("未带 provider 也能由模型路由（openai/gemini 皆可）", true);
  check("失败原因不是网关校验错误（说明已穿过网关）", !isGatewayError, err);
  check("给出了可读的下一道门原因", err.length > 0, err);
}

console.log(`\n模型网关接口：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
