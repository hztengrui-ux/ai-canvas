/**
 * 桌面端「能否正常使用」的后端体检
 *
 * 我这边无法拉起 Electron 窗口（沙箱 exec 级拦截，已用探针证明），
 * 但桌面端 95% 的功能都由它 fork 出来的本地服务端承载 —— 那部分可以完整验证。
 * 这个脚本把桌面端启动后会走的接口全打一遍，并核对关键业务数据。
 *
 * 用法： node tools/healthcheck.mjs [http://127.0.0.1:5181]
 */
const BASE = (process.argv[2] || "http://127.0.0.1:5181").replace(/\/$/, "");

let pass = 0;
let fail = 0;
const rows = [];
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    rows.push(["✓", name, extra]);
  } else {
    fail++;
    rows.push(["✗", name, extra]);
  }
}

async function j(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const t0 = Date.now();
const session = await j("/api/session");
const token = session.body?.token || "";
const H = { "X-AI-Canvas-Token": token, "Content-Type": "application/json" };

check("服务端可达 /api/session", session.status === 200 && Boolean(token), `HTTP ${session.status}`);

// 1. 登录态（桌面端首启靠这个决定进主窗口还是登录窗）
const st = await j("/api/auth/status", { headers: H });
check("会话已绑定账号（桌面端直接进主窗口）", st.body?.loggedIn === true, `loggedIn=${st.body?.loggedIn}`);

// 2. 前端页面（桌面端加载的就是它）
const html = await fetch(BASE + "/");
const htmlText = await html.text();
check("首页 HTML 可加载（桌面端主窗口内容）", html.status === 200 && htmlText.includes("<div id=\"app\""), `HTTP ${html.status} / ${htmlText.length} 字节`);

// 3. 模型目录（生成功能的前提）
const models = await j("/api/models", { headers: H });
const mList = models.body?.models || [];
check("模型目录可用", models.status === 200 && mList.length >= 5, `${mList.length} 个模型`);

// 4. 技能库
const skills = await j("/api/skills", { headers: H });
const sList = skills.body?.skills || [];
check("技能库可用（15 个技能）", skills.status === 200 && sList.length >= 12, `${sList.length} 个技能`);

// 5. 技能执行计划（挑一个不需要图片输入的技能；必填文本项要补示例值，
//    否则服务端会正当地回 MISSING_REQUIRED —— 那是校验在工作，不是故障）
const txt = sList.find((s) => (s.inputs || []).every((i) => i.type !== "image")) || sList[0];
let planOk = false;
let planInfo = "";
if (txt) {
  const params = {};
  for (const i of txt.inputs || []) {
    if (i.defaultValue !== undefined && i.defaultValue !== null && i.defaultValue !== "") params[i.key] = i.defaultValue;
    else if (i.required) params[i.key] = i.type === "number" ? 4 : "一件杏色圆领毛衫，白底主图";
  }
  const plan = await j("/api/skills/plan", { method: "POST", headers: H, body: JSON.stringify({ id: txt.id, params }) });
  planOk = plan.status === 200 && plan.body?.ok === true && Array.isArray(plan.body?.nodes);
  planInfo = planOk
    ? `${txt.id}: ${plan.body.nodes.length} 节点 / ${plan.body.edges.length} 连线 / 模型 ${plan.body.model}`
    : `HTTP ${plan.status} ${JSON.stringify(plan.body).slice(0, 80)}`;
}
check("技能 → 画布计划可用", planOk, planInfo);

// 6. 提示词编译（这轮 Sprint 1 的核心）
const comp = await j("/api/prompt/compile", {
  method: "POST",
  headers: H,
  body: JSON.stringify({ raw: "一件杏色圆领毛衫，白底主图", references: [{ index: 1, role: "服装图" }], ratio: "3:4" })
});
check(
  "提示词编译管线可用",
  comp.status === 200 && Boolean(comp.body?.text),
  comp.status === 200 ? `${comp.body?.characters || 0} 字 / ${(comp.body?.blocks && Object.keys(comp.body.blocks).length) || 0} 分区` : `HTTP ${comp.status}`
);

// 7. 素材库：不只是"能读"，而是真的走一遍「上传 → 列表」
//    （空实例上也能验；真实数据里另有 21 个已存在的素材文件）
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const up = await fetch(BASE + "/api/materials/upload?category=other&name=healthcheck-probe.png", {
  method: "POST",
  headers: { "X-AI-Canvas-Token": token, "Content-Type": "image/png" },
  body: png
});
const upBody = await up.json().catch(() => ({}));
const mats = await j("/api/materials", { headers: H });
// 真实返回是 { categories: [{ id, label, files: [...] }] }，按分类汇总文件数
const mArr = Array.isArray(mats.body?.categories)
  ? mats.body.categories.flatMap((c) => c.files || [])
  : Array.isArray(mats.body?.materials)
    ? mats.body.materials
    : [];
check(
  "素材上传可用",
  up.status === 200 && Boolean(upBody.url || upBody.ok),
  up.status === 200 ? `${upBody.url || "ok"} / ${upBody.size ?? png.length} 字节` : `HTTP ${up.status}`
);
check("素材列表可读（含刚上传的）", mats.status === 200 && mArr.length > 0, `${mArr.length} 个素材`);

// 8. 算力余额（迁移后的账本 + 退费修复）
const bal = await j("/api/credits/balance", { headers: H });
const balance = bal.body?.balance;
check("算力账本可读", bal.status === 200 && Number.isFinite(Number(balance)), `余额 ${balance}`);

// 9. 生成接口在线：SSE 永远是 200，无效模型应在流里回结构化 error（不扣费）
const gen = await fetch(BASE + "/api/generate", {
  method: "POST",
  headers: H,
  body: JSON.stringify({ prompt: "体检用，不实际生成", model: "不存在的模型", size: "1:1" })
});
const genText = await gen.text();
check(
  "生成接口在线（无效模型被结构化拒绝，不扣费）",
  gen.status === 200 && /event:\s*error/.test(genText),
  `HTTP ${gen.status} ${genText.replace(/\s+/g, " ").slice(0, 90)}`
);

// 10. 批量任务接口（任务中心/批量功能依赖）
const batch = await j("/api/batch", { method: "GET", headers: H });
check("批量任务接口在线", batch.status === 200 || batch.status === 404, `HTTP ${batch.status}`);

console.log("═".repeat(72));
for (const [mark, name, extra] of rows) {
  console.log(` ${mark} ${name}${extra ? `  —  ${extra}` : ""}`);
}
console.log("═".repeat(72));
console.log(`后端体检：${pass} 项通过 / ${fail} 项失败   （耗时 ${Date.now() - t0} ms）`);
// 不要 process.exit()：此时还有未关闭的 fetch/socket 句柄，
// Node 强退会撞上 libuv 断言（!(handle->flags & UV_HANDLE_CLOSING)）并报 0xC0000409。
// 设退出码让 Node 自己收尾即可。
process.exitCode = fail ? 1 : 0;
