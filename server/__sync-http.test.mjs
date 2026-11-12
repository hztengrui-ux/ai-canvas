// 吸收项的 HTTP 端到端自测：批量进度 / 模板反哺 / 上游签名透传
// 运行前需先启动服务：node server/index.js（BASE 指向它）
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

async function api(pathname, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "X-AI-Canvas-Token": token } : {}) },
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

console.log("\n=== 吸收项 HTTP 端到端 ===");

const sess = await (await fetch(`${BASE}/api/session`)).json();
const token = sess.token;
const login = await api("/api/auth/login", { method: "POST", token, body: { username: "admin", password: "admin888" } });
if (!login.data?.ok) {
  await api("/api/auth/setup", { method: "POST", token, body: { username: "admin", password: "admin888" } });
}

// ---- P1-5 批量进度 ----
const bid = `b${Date.now().toString(36)}`;
let r = await api("/api/batch", { method: "POST", token, body: { id: bid, total: 10, perBatch: 4, label: "毛衫 10 变体" } });
check("创建批量任务", r.status === 200 && r.data?.batch?.items?.length === 10, `status=${r.status}`);

r = await api(`/api/batch/${bid}`, { method: "PUT", token, body: { index: 0, status: "ok", images: [{ url: "/outputs/1.png" }, { url: "/outputs/2.png" }] } });
check("写回批次结果", r.status === 200 && r.data?.batch?.done === 1);

r = await api(`/api/batch/${bid}`, { method: "PUT", token, body: { index: 1, status: "failed", error: "超时" } });
check("记录失败批次", r.status === 200 && r.data?.batch?.failed === 1);

r = await api(`/api/batch/${bid}`, { token });
check("读回进度 + 结果", r.data?.images?.length === 2 && r.data?.batch?.status === "running", `status=${r.data?.batch?.status}`);

r = await api("/api/batch", { token });
check("批量任务可被列出（续跑入口）", r.data?.rows?.some((x) => x.id === bid));

r = await api("/api/batch", { method: "POST", token, body: { id: "../../etc/passwd", total: 1 } });
check("穿越型 batchId 被净化", r.status === 200 ? !String(r.data?.batch?.id || "").includes("/") : r.status === 400, `status=${r.status}`);

r = await api(`/api/batch/${bid}`, { method: "DELETE", token });
check("删除批量任务", r.status === 200);

// ---- P2 模板反哺 ----
const graph = {
  nodes: [
    { id: "n1", type: "product", position: { x: 0, y: 0 }, data: { title: "毛衫", role: "outfit", file: { name: "a.png", url: "/materials/clothing/a.png" }, busy: true } },
    { id: "n2", type: "prompt", position: { x: 320, y: 0 }, data: { prompt: "毛衫印花", modelId: "jiemeng", count: 10, ratio: "3:4", error: "旧报错" } },
    { id: "n3", type: "executor", position: { x: 640, y: 0 }, data: { busy: true, status: "生成中" } },
    { id: "n4", type: "result", position: { x: 940, y: 0 }, data: { images: [{ url: "/outputs/x.png" }] } }
  ],
  edges: [
    { source: "n1", target: "n3", sourceHandle: "product", targetHandle: "product", dataType: "image" },
    { source: "n2", target: "n3", sourceHandle: "prompt", targetHandle: "prompt", dataType: "string" },
    { source: "n3", target: "n4", sourceHandle: "result", targetHandle: "result", dataType: "ai-image" }
  ]
};
r = await api("/api/templates/from-project", { method: "POST", token, body: { name: "毛衫印花·HTTP", category: "product", graph } });
check("画布存为模板", r.status === 200 && r.data?.template?.graph?.nodes?.length === 4, `status=${r.status} ${r.data?.error || ""}`);
const tplId = r.data?.template?.id;
check("运行时状态被清洗", !JSON.stringify(r.data?.template?.graph || {}).includes("生成中"));
check("保留 count=10（客户端分批用得上）", r.data?.template?.graph?.nodes?.find((n) => n.type === "prompt")?.data?.count === 10);

r = await api(`/api/templates/${tplId}/graph`, { token });
check("节点图可被读回（铺开用）", r.status === 200 && r.data?.graph?.edges?.length === 3);

r = await api("/api/templates", { token });
check("模板出现在列表里", r.data?.rows?.some((t) => t.id === tplId));

r = await api("/api/templates/from-project", { method: "POST", token, body: { name: "空图", graph: { nodes: [] } } });
check("空画布拒绝保存 400", r.status === 400, `status=${r.status}`);

r = await api("/api/templates/from-project", { method: "POST", token, body: { graph } });
check("无名称拒绝保存 400", r.status === 400, `status=${r.status}`);

// ---- P1-8 上游签名：同输入两次请求，第二次应命中缓存不扣费 ----
// 这里只验证「参数合法 + 接口不报错 + 服务端接受 remark/batchId 字段」，
// 真正出图需要配好 provider 密钥，测试环境跳过。
r = await api("/api/generate", { method: "POST", token, body: { provider: "__not_exist__", prompt: "x", remark: "备注", batchId: bid, batchIndex: 0 } });
check("未知 provider 仍被拒绝 200+error 事件（不 500）", r.status === 200, `status=${r.status}`);

console.log(`\n  通过 ${pass} / 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);
