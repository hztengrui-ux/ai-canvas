/**
 * 画布剪贴板自测（Sprint 2 · 纯逻辑侧）
 * --------------------------------------------------------------------------
 * 为什么值得单独钉死：
 *   - 深拷贝漏了 → 「复制一份改改参数」把原节点也改了，用户丢的是作品数据；
 *   - 悬空边 → 粘贴后 Vue Flow 拿到 source/target 不存在的边，画面错乱且难回滚；
 *   - parentNode 没重映射 → 副本挂进「别人的组」，拖原组时副本跟着乱动；
 *   - 限流缺失 → 一次误操作粘贴上千节点，画布直接卡死。
 *   这些都是「跑一次就再也复现不了」的数据损坏，所以全部用断言锁住。
 *
 * 纯逻辑测试，不依赖 DOM / 剪贴板 / 服务端：node src/__clipboard.test.mjs
 */
import {
  CLIPBOARD_VERSION,
  CLIPBOARD_MIME,
  PASTE_OFFSET,
  copySubgraph,
  serializeSubgraph,
  deserializeSubgraph,
  pasteSubgraph,
  duplicateNodes,
  hitTest,
  boundsOf
} from "./canvas-clipboard.js";

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

/** 「绝不抛异常」用：返回 true 表示调用过程没有抛。 */
function noThrow(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/** 造节点的小工具，字段跟 Vue Flow 对齐。 */
function node(id, x, y, extra = {}) {
  const { data, ...rest } = extra;
  return { id, type: "prompt", position: { x, y }, data: { label: id, ...(data || {}) }, ...rest };
}

// ===========================================================================
console.log("\n[0] 常量契约");
{
  check("CLIPBOARD_VERSION = 1", CLIPBOARD_VERSION === 1, String(CLIPBOARD_VERSION));
  check("CLIPBOARD_MIME 是自定义类型", CLIPBOARD_MIME === "application/x-ai-canvas-nodes", CLIPBOARD_MIME);
  check("PASTE_OFFSET = 32", PASTE_OFFSET === 32, String(PASTE_OFFSET));
}

// ===========================================================================
console.log("\n[1] 抽取选中子图：只留内部连线，跨选区连线丢弃");
const nA = node("a", 0, 0, { data: { label: "参考图", tags: ["t1"] } });
const nB = node("b", 300, 0);
const nC = node("c", 600, 0);
const nD = node("d", 900, 0); // 选区外
const eAB = { id: "e1", source: "a", target: "b", sourceHandle: "result", targetHandle: "prompt" };
const eBC = { id: "e2", source: "b", target: "c" };
const eCD = { id: "e3", source: "c", target: "d" }; // 一端在外
const canvasNodes = [nA, nB, nC, nD];
const canvasEdges = [eAB, eBC, eCD];

const sub = copySubgraph(canvasNodes, canvasEdges, ["a", "b", "c"]);
{
  check("ok = true", sub.ok === true, JSON.stringify(sub));
  check("nodes.length = 3", sub.nodes.length === 3, String(sub.nodes.length));
  check("edges.length = 2（只剩内部连线）", sub.edges.length === 2, String(sub.edges.length));
  check("droppedEdges = 1（跨选区那条）", sub.droppedEdges === 1, String(sub.droppedEdges));
  check("保持原顺序 a/b/c", sub.nodes.map((n) => n.id).join(",") === "a,b,c", sub.nodes.map((n) => n.id).join(","));
  check("内部连线的 handle 被保留", sub.edges[0].sourceHandle === "result" && sub.edges[0].targetHandle === "prompt");
  check("groups 为空数组（没有组节点）", Array.isArray(sub.groups) && sub.groups.length === 0);
  check("Set 形式的选中集合同样可用", copySubgraph(canvasNodes, canvasEdges, new Set(["a", "b"])).nodes.length === 2);
}

// ===========================================================================
console.log("\n[2] 空选区 / 脏输入：结构化失败码，不抛异常");
{
  const empty = copySubgraph(canvasNodes, canvasEdges, []);
  check("空选区 → EMPTY_SELECTION", empty.ok === false && empty.code === "EMPTY_SELECTION", JSON.stringify(empty));
  check("失败结果也带 nodes/edges/droppedEdges/groups 形状", Array.isArray(empty.nodes) && Array.isArray(empty.edges) && empty.droppedEdges === 0 && Array.isArray(empty.groups));

  const missing = copySubgraph(canvasNodes, canvasEdges, ["zzz", "yyy"]);
  check("id 全不存在 → NO_MATCHING_NODES", missing.ok === false && missing.code === "NO_MATCHING_NODES", JSON.stringify(missing));

  const partial = copySubgraph(canvasNodes, canvasEdges, ["a", "zzz"]);
  check("部分 id 不存在 → 存在的照抄，不报错", partial.ok === true && partial.nodes.length === 1, JSON.stringify(partial.nodes?.map((n) => n.id)));

  check("nodes 非数组 → BAD_INPUT", copySubgraph(null, [], ["a"]).code === "BAD_INPUT");
  check("edges 非数组 → BAD_INPUT", copySubgraph(canvasNodes, undefined, ["a"]).code === "BAD_INPUT");
  check("selectedIds 为 undefined → EMPTY_SELECTION", copySubgraph(canvasNodes, canvasEdges, undefined).code === "EMPTY_SELECTION");
  check(
    "以上全部不抛异常",
    noThrow(() => {
      copySubgraph(null, null, null);
      copySubgraph([{ id: null }], [], ["a"]);
      copySubgraph([{}], [{}], ["a"]);
      copySubgraph(canvasNodes, canvasEdges, "a");
    })
  );
}

// ===========================================================================
console.log("\n[3] 深拷贝：改副本不能污染原节点");
{
  const cp = copySubgraph(canvasNodes, canvasEdges, ["a", "b", "c"]);
  check("不是同一个对象引用", cp.nodes[0] !== nA && cp.edges[0] !== eAB);
  check("嵌套对象也是新引用", cp.nodes[0].data !== nA.data && cp.nodes[0].data.tags !== nA.data.tags);

  cp.nodes[0].data.label = "被改过";
  cp.nodes[0].data.tags.push("污染");
  cp.nodes[0].position.x = 9999;
  cp.edges[0].source = "???";

  check("改副本 data.label 不影响原节点", nA.data.label === "参考图", nA.data.label);
  check("改副本 data.tags 不影响原节点", nA.data.tags.length === 1, JSON.stringify(nA.data.tags));
  check("改副本 position 不影响原节点", nA.position.x === 0, String(nA.position.x));
  check("改副本 edge 不影响原连线", eAB.source === "a", eAB.source);
}

// ===========================================================================
console.log("\n[4] 序列化 → 反序列化：往返一致");
const text = serializeSubgraph(copySubgraph(canvasNodes, canvasEdges, ["a", "b", "c"]));
{
  const env = JSON.parse(text);
  check("信封含 version", env.version === 1, String(env.version));
  check("信封含 kind", env.kind === "ai-canvas-nodes", String(env.kind));
  check("信封含 createdAt", typeof env.createdAt === "string" && env.createdAt.length > 0, String(env.createdAt));

  const back = deserializeSubgraph(text);
  check("往返 ok = true", back.ok === true, JSON.stringify(back.code || ""));
  check("节点数一致", back.payload.nodes.length === 3, String(back.payload.nodes?.length));
  check("id 一致", back.payload.nodes.map((n) => n.id).join(",") === "a,b,c", back.payload.nodes.map((n) => n.id).join(","));
  check(
    "position 一致",
    JSON.stringify(back.payload.nodes.map((n) => n.position)) === JSON.stringify([nA, nB, nC].map((n) => n.position)),
    JSON.stringify(back.payload.nodes.map((n) => n.position))
  );
  check("连线一致", JSON.stringify(back.payload.edges) === JSON.stringify([eAB, eBC]));
  check("序列化是非空字符串", typeof text === "string" && text.length > 0);
}

// ===========================================================================
console.log("\n[5] 反序列化健壮性：用户从别处复制的东西不能把 Ctrl+V 搞崩");
{
  const cases = [
    ["空字符串", "", "EMPTY"],
    ["纯空白", "   \n\t ", "EMPTY"],
    ["非字符串（null）", null, "EMPTY"],
    ["非字符串（undefined）", undefined, "EMPTY"],
    ["不是 JSON", "not json", "BAD_JSON"],
    ["半个 JSON", '{"version":1,"nodes":[', "BAD_JSON"],
    ["JSON 但不是本格式", '{"a":1}', "BAD_SHAPE"],
    ["JSON 数组", "[1,2,3]", "BAD_SHAPE"],
    ["版本过新", '{"version":99,"nodes":[]}', "VERSION_UNSUPPORTED"],
    ["缺少 nodes 数组", '{"version":1}', "BAD_SHAPE"],
    ["nodes 不是数组", '{"version":1,"nodes":{}}', "BAD_SHAPE"],
    ["version 不是数字", '{"version":"x","nodes":[]}', "BAD_SHAPE"]
  ];
  for (const [label, input, code] of cases) {
    const r = deserializeSubgraph(input);
    check(`${label} → ${code}`, r.ok === false && r.code === code, `got ${JSON.stringify(r.code)}`);
    check(`${label} → payload 为 null`, r.payload === null);
  }
  check(
    "解析全程不抛异常",
    noThrow(() => {
      for (const [, input] of cases) deserializeSubgraph(input);
      deserializeSubgraph('{"version":1,"nodes":[]}');
      deserializeSubgraph(12345);
      deserializeSubgraph({ version: 1 });
    })
  );
}

// ===========================================================================
console.log("\n[6] 粘贴：新 id、偏移、连线两端重映射");
const p1 = pasteSubgraph(sub);
{
  const oldIds = ["a", "b", "c"];
  const newIds = p1.nodes.map((n) => n.id);
  check("ok = true", p1.ok === true, JSON.stringify(p1));
  check("新 id 与旧 id 全不同", newIds.every((id) => !oldIds.includes(id)), newIds.join(","));
  check("同一次粘贴内 id 互不重复", new Set(newIds).size === newIds.length, newIds.join(","));
  check("idMap 覆盖全部旧 id", oldIds.every((id) => typeof p1.idMap[id] === "string" && p1.idMap[id]), JSON.stringify(p1.idMap));
  check("idMap 的值就是节点的新 id", p1.nodes.every((n) => Object.values(p1.idMap).includes(n.id)));
  check(
    "position 按默认 32px 偏移",
    p1.nodes[0].position.x === 0 + PASTE_OFFSET && p1.nodes[0].position.y === 0 + PASTE_OFFSET,
    JSON.stringify(p1.nodes[0].position)
  );
  check(
    "第二条连线端点也整体平移同样的偏移",
    p1.nodes.map((n) => n.position.x).join(",") === "32,332,632",
    p1.nodes.map((n) => n.position.x).join(",")
  );
  check(
    "边的 source/target 指向新 id",
    p1.edges[0].source === p1.idMap.a && p1.edges[0].target === p1.idMap.b,
    JSON.stringify(p1.edges[0])
  );
  check("边也换了新 id", p1.edges.every((e) => e.id !== "e1" && e.id !== "e2"), p1.edges.map((e) => e.id).join(","));
  check("边 id 互不重复", new Set(p1.edges.map((e) => e.id)).size === 2);
  check("没有悬空边（端点都能在结果节点里找到）", p1.edges.every((e) => newIds.includes(e.source) && newIds.includes(e.target)));
  check("默认不截断", p1.truncated === false);

  const p2 = pasteSubgraph(sub, { offsetX: 10, offsetY: -5 });
  check("自定义 offset 生效", p2.nodes[0].position.x === 10 && p2.nodes[0].position.y === -5, JSON.stringify(p2.nodes[0].position));
  check("offset 0 不会被默认值顶掉", pasteSubgraph(sub, { offsetX: 0, offsetY: 0 }).nodes[0].position.x === 0);
  check("粘贴不改动 payload 里的原坐标", sub.nodes[0].position.x === 0 && sub.nodes[0].position.y === 0);
  check("payload 不是对象 → BAD_PAYLOAD", pasteSubgraph(null).code === "BAD_PAYLOAD");
  check("payload.nodes 不是数组 → BAD_PAYLOAD", pasteSubgraph({ nodes: "x" }).code === "BAD_PAYLOAD");
}

// ===========================================================================
console.log("\n[7] 悬空边防护：端点缺失的边必须丢弃并计数");
{
  const tiny = {
    version: 1,
    nodes: [node("a", 0, 0), node("b", 100, 0)],
    edges: [
      { id: "x1", source: "a", target: "ghost" }, // 目标节点根本不存在
      { id: "x2", source: "ghost", target: "b" }, // 源节点根本不存在
      { id: "x3", source: "a", target: "b" }, // 合法
      { source: "a" } // 连 source/target 都没有
    ]
  };
  const r = pasteSubgraph(tiny);
  check("只保留合法的那条边", r.edges.length === 1, String(r.edges.length));
  check("droppedEdges = 3", r.droppedEdges === 3, String(r.droppedEdges));
  check("输出里没有指向 ghost 的边", !JSON.stringify(r.edges).includes("ghost"), JSON.stringify(r.edges));
  check("合法边已重映射到新 id", r.edges[0].source === r.idMap.a && r.edges[0].target === r.idMap.b);

  // 截断导致的端点缺失也走同一条防护路径
  const five = { version: 1, nodes: [node("a", 0, 0), node("b", 1, 0), node("c", 2, 0)], edges: [{ id: "e", source: "a", target: "c" }] };
  const cut = pasteSubgraph(five, { limit: 1 });
  check("被截断端点的边不会留下悬空边", cut.edges.length === 0 && cut.droppedEdges === 1, `edges=${cut.edges.length} dropped=${cut.droppedEdges}`);
}

// ===========================================================================
console.log("\n[8] 连按两次粘贴：两批 id 互不相同");
{
  const a1 = pasteSubgraph(sub);
  const a2 = pasteSubgraph(sub);
  const ids1 = a1.nodes.map((n) => n.id);
  const ids2 = a2.nodes.map((n) => n.id);
  check("内置默认工厂单调递增 → 两批 id 无交集", ids1.every((id) => !ids2.includes(id)), `${ids1.join(",")} | ${ids2.join(",")}`);

  let seq = 0;
  const factory = (oldId) => `${oldId}~${++seq}`; // 调用方自己的计数器（契约要求的用法）
  const b1 = pasteSubgraph(sub, { idFactory: factory });
  const b2 = pasteSubgraph(sub, { idFactory: factory });
  const j1 = b1.nodes.map((n) => n.id);
  const j2 = b2.nodes.map((n) => n.id);
  check("调用方工厂 + 自身计数 → 两批 id 无交集", j1.every((id) => !j2.includes(id)), `${j1.join(",")} | ${j2.join(",")}`);
  check("调用方工厂的结果被真实采用", j1.join(",") === "a~1,b~2,c~3", j1.join(","));

  const bad = pasteSubgraph(sub, { idFactory: () => "same" });
  check("工厂返回重复 id 时不会产出重复节点", new Set(bad.nodes.map((n) => n.id)).size === bad.nodes.length, bad.nodes.map((n) => n.id).join(","));
  const echo = pasteSubgraph(sub, { idFactory: (oldId) => oldId });
  check("工厂返回原 id 时也被强制改名（不与已有画布冲突）", echo.nodes.every((n) => !["a", "b", "c"].includes(n.id)), echo.nodes.map((n) => n.id).join(","));
  check("工厂抛异常时兜底不中断", noThrow(() => pasteSubgraph(sub, { idFactory: () => { throw new Error("boom"); } })));
}

// ===========================================================================
console.log("\n[9] 分组：parentNode 重映射 / 越界父节点清空");
{
  const g1 = { id: "g1", type: "group", position: { x: 100, y: 100 }, style: { width: "400px", height: "300px" }, data: { label: "作品组" } };
  const gOut = { id: "g-outside", type: "group", position: { x: 900, y: 900 }, style: { width: "400px", height: "300px" }, data: {} };
  const c1 = node("c1", 10, 10, { data: { parentNode: "g1" }, extent: "parent" });
  const c2 = node("c2", 500, 500, { data: { parentNode: "g-outside" }, extent: "parent" });
  const gNodes = [g1, gOut, c1, c2];

  const sub2 = copySubgraph(gNodes, [], ["g1", "c1", "c2"]);
  check("groups 里带出选区内的 group id", sub2.groups.join(",") === "g1", JSON.stringify(sub2.groups));

  const r = pasteSubgraph(sub2);
  const byId = Object.fromEntries(r.nodes.map((n) => [n.id, n]));
  const newG = byId[r.idMap.g1];
  const newC1 = byId[r.idMap.c1];
  const newC2 = byId[r.idMap.c2];

  check("新组 id 与旧组 id 不同", r.idMap.g1 !== "g1", r.idMap.g1);
  check("组内子节点指向**新**组 id", newC1.data.parentNode === r.idMap.g1, String(newC1.data.parentNode));
  check("子节点的 extent 保留", newC1.extent === "parent", String(newC1.extent));
  check("越界父节点的子节点 parentNode 被清空", !newC2.data.parentNode, JSON.stringify(newC2.data));
  check("越界父节点的子节点 extent 被一并清掉", !newC2.extent, String(newC2.extent));
  check("原节点 c2 仍是挂在 g-outside 上（没被改）", c2.data.parentNode === "g-outside", String(c2.data.parentNode));

  check("组整体偏移 32px", newG.position.x === 132 && newG.position.y === 132, JSON.stringify(newG.position));
  check(
    "组内子节点不重复偏移（否则会在组内漂移 32px）",
    newC1.position.x === 10 && newC1.position.y === 10,
    JSON.stringify(newC1.position)
  );
  check(
    "越界子节点变成顶层，因此自己吃偏移",
    newC2.position.x === 532 && newC2.position.y === 532,
    JSON.stringify(newC2.position)
  );
  const forced = pasteSubgraph(sub2, { offsetChildren: true });
  const forcedChild = forced.nodes.find((n) => n.id === forced.idMap.c1);
  check("offsetChildren:true 时可强制所有节点一起偏移", forcedChild.position.x === 42, JSON.stringify(forcedChild.position));

  // 只复制组内子节点（父在选区外）→ 落地就必须脱离父节点，否则会挂到原组里
  const onlyChild = pasteSubgraph(copySubgraph(gNodes, [], ["c1"]));
  check("只复制子节点时 parentNode 被清空", !onlyChild.nodes[0].data.parentNode, JSON.stringify(onlyChild.nodes[0].data));
  check("只复制子节点时自己吃偏移", onlyChild.nodes[0].position.x === 42, JSON.stringify(onlyChild.nodes[0].position));
}

// ===========================================================================
console.log("\n[10] 限流：超出 limit 截断，truncated = true");
{
  const many = { version: 1, nodes: [node("n1", 0, 0), node("n2", 10, 0), node("n3", 20, 0), node("n4", 30, 0), node("n5", 40, 0)], edges: [] };
  const r = pasteSubgraph(many, { limit: 2 });
  check("ok 仍为 true（截断不是失败）", r.ok === true, JSON.stringify(r.code || ""));
  check("nodes.length = 2", r.nodes.length === 2, String(r.nodes.length));
  check("truncated = true", r.truncated === true);
  check("保留的是靠前的节点", r.nodes.map((n) => n.id).join(",") === r.idMap.n1 + "," + r.idMap.n2, r.nodes.map((n) => n.id).join(","));
  check("被截断节点不在 idMap 里", r.idMap.n5 === undefined);

  const ok = pasteSubgraph(many);
  check("默认 limit(200) 下 5 个节点不截断", ok.nodes.length === 5 && ok.truncated === false, `${ok.nodes.length}/${ok.truncated}`);

  check("limit 0 → LIMIT_EXCEEDED", pasteSubgraph(many, { limit: 0 }).code === "LIMIT_EXCEEDED");
  check("limit 负数 → LIMIT_EXCEEDED", pasteSubgraph(many, { limit: -3 }).code === "LIMIT_EXCEEDED");
  check("limit 非整数 → LIMIT_EXCEEDED", pasteSubgraph(many, { limit: 1.5 }).code === "LIMIT_EXCEEDED");
  check("limit 为字符串数字 → 按数字处理", pasteSubgraph(many, { limit: "2" }).nodes.length === 2);
}

// ===========================================================================
console.log("\n[11] boundsOf：包围盒");
{
  const bn = [
    { id: "p1", position: { x: 0, y: 0 }, dimensions: { width: 100, height: 50 } },
    { id: "p2", position: { x: 200, y: 120 }, style: { width: "80px", height: "40px" } }
  ];
  const box = boundsOf(bn, ["p1", "p2"]);
  check("x = 0", box && box.x === 0, JSON.stringify(box));
  check("y = 0", box && box.y === 0);
  check("width = 280（用上了 dimensions 与 style 两种尺寸来源）", box && box.width === 280, JSON.stringify(box));
  check("height = 160", box && box.height === 160, JSON.stringify(box));

  const only = boundsOf(bn, ["p2"]);
  check("单节点包围盒等于它自己", only.x === 200 && only.y === 120 && only.width === 80 && only.height === 40, JSON.stringify(only));
  check("省略 ids = 全画布", JSON.stringify(boundsOf(bn)) === JSON.stringify(box));
  check("空选区 → null", boundsOf(bn, []) === null);
  check("空 Set → null", boundsOf(bn, new Set()) === null);
  check("id 全部不存在 → null", boundsOf(bn, ["zzz"]) === null);
  check("nodes 非数组 → null", boundsOf(null, ["p1"]) === null);
  check("无尺寸信息时用默认 220x160 兜底", JSON.stringify(boundsOf([{ id: "d", position: { x: 5, y: 5 } }])) === JSON.stringify({ x: 5, y: 5, width: 220, height: 160 }));

  const parent = { id: "gp", type: "group", position: { x: 100, y: 100 }, style: { width: "400px", height: "300px" }, data: {} };
  const child = { id: "gc", position: { x: 10, y: 10 }, dimensions: { width: 20, height: 20 }, data: { parentNode: "gp" } };
  const cbox = boundsOf([parent, child], ["gc"]);
  check("子节点按绝对坐标计算（父 100,100 + 子 10,10）", cbox.x === 110 && cbox.y === 110, JSON.stringify(cbox));
  check("隐藏节点不参与包围盒", boundsOf([{ id: "h", hidden: true, position: { x: 999, y: 999 } }, bn[0]], ["h", "p1"]).x === 0);
}

// ===========================================================================
console.log("\n[12] hitTest：点击命中与 z 序");
{
  const hn = [
    { id: "h1", position: { x: 0, y: 0 }, dimensions: { width: 100, height: 100 } },
    { id: "h2", position: { x: 50, y: 50 }, dimensions: { width: 100, height: 100 } },
    { id: "h3", position: { x: 400, y: 400 }, dimensions: { width: 50, height: 50 }, hidden: true }
  ];
  check("点中只覆盖 h1 的位置 → h1", hitTest(hn, { x: 10, y: 10 }) === "h1", String(hitTest(hn, { x: 10, y: 10 })));
  check("重叠时返回数组里靠后的（z 序在上）", hitTest(hn, { x: 60, y: 60 }) === "h2", String(hitTest(hn, { x: 60, y: 60 })));
  check("未命中 → null", hitTest(hn, { x: 999, y: 999 }) === null);
  check("隐藏节点不参与命中", hitTest(hn, { x: 410, y: 410 }) === null);
  check("边界点算命中（含右/下边）", hitTest(hn, { x: 100, y: 100 }) === "h2", String(hitTest(hn, { x: 100, y: 100 })));
  check(
    "右下角闭区间：单节点时 (100,100) 仍命中",
    hitTest([{ id: "only", position: { x: 0, y: 0 }, dimensions: { width: 100, height: 100 } }], { x: 100, y: 100 }) === "only"
  );
  check("nodes 非数组 → null", hitTest(null, { x: 0, y: 0 }) === null);
  check("point 非对象 → null", hitTest(hn, null) === null);
  check("point 坐标非数字 → null", hitTest(hn, { x: NaN, y: 0 }) === null);
  check("没有尺寸信息时用默认 220x160 命中", hitTest([{ id: "z", position: { x: 0, y: 0 } }], { x: 200, y: 150 }) === "z");
  check(
    "组内子节点按绝对坐标命中",
    hitTest([{ id: "gp2", position: { x: 100, y: 100 }, dimensions: { width: 10, height: 10 } }, { id: "gc2", position: { x: 5, y: 5 }, dimensions: { width: 20, height: 20 }, data: { parentNode: "gp2" } }], { x: 110, y: 110 }) === "gc2"
  );
}

// ===========================================================================
console.log("\n[13] duplicateNodes：Ctrl+D 原地复制");
{
  const r = duplicateNodes(canvasNodes, canvasEdges, ["a", "b", "c"]);
  check("ok = true", r.ok === true, JSON.stringify(r.code || ""));
  check("复制出 3 个节点", r.nodes.length === 3, String(r.nodes.length));
  check("新 id 不与原 id 相同", r.nodes.every((n) => !["a", "b", "c"].includes(n.id)), r.nodes.map((n) => n.id).join(","));
  check("位置偏移 32px", r.nodes[0].position.x === 32 && r.nodes[0].position.y === 32, JSON.stringify(r.nodes[0].position));
  check("内部两条连线都复制并重映射", r.edges.length === 2 && r.edges[0].source === r.idMap.a && r.edges[1].target === r.idMap.c, JSON.stringify(r.edges));
  check("跨选区那条边计入 droppedEdges", r.droppedEdges === 1, String(r.droppedEdges));
  check("不影响原画布", canvasNodes.length === 4 && nA.position.x === 0 && canvasEdges.length === 3);

  const e = duplicateNodes(canvasNodes, canvasEdges, []);
  check("空选区 → EMPTY_SELECTION 且形状一致", e.ok === false && e.code === "EMPTY_SELECTION" && Array.isArray(e.nodes) && typeof e.idMap === "object");
  const custom = duplicateNodes(canvasNodes, canvasEdges, ["a"], { offsetX: 5, offsetY: 6 });
  check("自定义偏移生效", custom.nodes[0].position.x === 5 && custom.nodes[0].position.y === 6, JSON.stringify(custom.nodes[0].position));
}

console.log(`\n画布剪贴板：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
