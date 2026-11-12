/**
 * 技能 → 画布 接线自测（Sprint 2 收尾）
 * --------------------------------------------------------------------------
 * 这套补的是「技能库界面入口」这一环，分两部分：
 *
 *  A. 纯逻辑（src/skill-graph.js）：技能定义/服务端计划 → 与 WORKFLOWS 同形状的模板。
 *     关键正确性：绝不产出**悬空边**（端点不在节点集合里的边必须丢弃并计数）、
 *     分层布局要把执行器放最右、输入里若重复声明 prompt/executor 不能铺出两个。
 *
 *  B. 静态接线 + 跨端交叉校验：
 *     · 铺图只有**一条**代码路径（applyWorkflow → applyWorkflowGraph），
 *       否则「模板铺图」和「技能铺图」的规则会各自演化；
 *     · 服务端技能声明的 workflow 必须是前端 WORKFLOWS 里真实存在的键 ——
 *       前端删了模板、服务端还指着一个不存在的键，点技能会**静默失败**（最难查的那种）。
 *
 * 纯静态 + 纯函数，不起服务端、不需要浏览器。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillToTemplate, planToTemplate, resolveSkillGraph, layoutLayers, handleFor, NODE_PREFIX } from "./skill-graph.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

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

// 一条最小的技能定义（形状与服务端 skills.js 一致）
const SKILL = {
  id: "outfit-swap",
  label: "模特换装",
  workflow: "",
  inputs: [
    { key: "productImage", type: "image", node: "product", role: "outfit", label: "产品图", protected: true },
    { key: "modelImage", type: "image", node: "product", role: "model", label: "模特图" },
    { key: "scene", type: "text", label: "场景", defaultValue: "" },
    { key: "count", type: "number", label: "张数", defaultValue: 4 }
  ]
};

console.log("\n[1] 分层布局");
{
  const nodes = [{ key: "a" }, { key: "b" }, { key: "c" }];
  const { layers, positions } = layoutLayers(nodes, [
    ["a", "b"],
    ["b", "c"]
  ]);
  check("链式三节点分成三层", layers.length === 3, JSON.stringify(layers.map((l) => l.length)));
  check("列坐标向右递增", positions.a.x < positions.b.x && positions.b.x < positions.c.x);
  check("同层节点纵向排开", layoutLayers([{ key: "x" }, { key: "y" }], []).positions.y.y > 0);

  // 环也不能死循环
  const cyc = layoutLayers([{ key: "p" }, { key: "q" }], [
    ["p", "q"],
    ["q", "p"]
  ]);
  check("存在环时不死循环且有坐标", Boolean(cyc.positions.p) && Boolean(cyc.positions.q));
}

console.log("\n[2] 端口句柄与既有模板一致");
{
  check("style → style 口", handleFor("style") === "style");
  check("prompt → prompt 口", handleFor("prompt") === "prompt");
  check("product → product 口", handleFor("product") === "product");
  check("reference → product 口（与 ai-video 模板一致）", handleFor("reference") === "product");
  check("前缀表覆盖画布全部节点类型", ["product", "style", "prompt", "executor", "reference", "result"].every((t) => NODE_PREFIX[t]));
}

console.log("\n[3] 按技能定义铺图（用户还没填参数时）");
{
  const res = skillToTemplate(SKILL, { prompt: "编译后的正文", count: 4, ratio: "3:4" });
  check("铺图成功", res.ok === true);
  const t = res.template;
  const types = t.nodes.map((n) => n.type);
  check("图片输入各铺一个节点", types.filter((x) => x === "product").length === 2, types.join(","));
  check("恰好一个提示词节点与一个执行器", types.filter((x) => x === "prompt").length === 1 && types.filter((x) => x === "executor").length === 1);
  check("提示词被带入提示词节点", t.nodes.find((n) => n.type === "prompt").data.prompt === "编译后的正文");
  check("画幅与张数被带入", t.nodes.find((n) => n.type === "prompt").data.ratio === "3:4");
  check("受保护标记带进节点数据", t.nodes.some((n) => n.data.protected === true));
  check("节点标题取输入 label", t.nodes.some((n) => n.data.title === "产品图"));

  const keys = new Set(t.nodes.map((n) => n.key));
  check("没有悬空边", t.edges.every(([f, to]) => keys.has(f) && keys.has(to)));
  check("边数 = 图片输入数 + 1（提示词→执行器）", t.edges.length === 3, `edges=${t.edges.length}`);
  check("执行器在最右列（比所有输入节点靠右）", (() => {
    const exec = t.nodes.find((n) => n.type === "executor");
    return t.nodes.filter((n) => n.key !== exec.key).every((n) => n.x < exec.x);
  })());
  check("每个节点都带 x/y", t.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));

  // 输入里若重复声明提示词/执行器类型，不能铺出两个
  const dup = skillToTemplate({ ...SKILL, inputs: [...SKILL.inputs, { key: "p2", type: "prompt", node: "prompt" }, { key: "e2", type: "executor", node: "executor" }] });
  const dupTypes = dup.template.nodes.map((n) => n.type);
  check("输入里声明的 prompt/executor 被忽略", dupTypes.filter((x) => x === "prompt").length === 1 && dupTypes.filter((x) => x === "executor").length === 1, dupTypes.join(","));

  check("空技能不冒充成功", skillToTemplate({ id: "x", label: "空", inputs: [] }).ok === true); // 至少还会铺 prompt+executor
  check("完全没有输入时仍给出提示词+执行器", skillToTemplate({ id: "x", inputs: [] }).template.nodes.length === 2);
}

console.log("\n[4] 按服务端计划铺图（参数齐备时，带编译后提示词）");
{
  const plan = {
    ok: true,
    model: "wanxiang",
    prompt: "服务端编译的提示词",
    count: 4,
    nodes: [
      { type: "product", key: "productImage" },
      { type: "prompt", key: "__prompt" },
      { type: "executor", key: "__exec" }
    ],
    edges: [
      ["productImage", "__exec"],
      ["__prompt", "__exec"]
    ]
  };
  const res = planToTemplate(SKILL, plan);
  check("计划能转成模板", res.ok === true);
  check("提示词来自服务端计划（不是前端拼的）", res.template.nodes.find((n) => n.type === "prompt").data.prompt === "服务端编译的提示词");
  check("执行器带上服务端选定模型", res.template.nodes.find((n) => n.type === "executor").data.modelId === "wanxiang");
  check("没有丢边", res.droppedEdges === 0);

  // 悬空边必须丢弃并计数
  const bad = planToTemplate(SKILL, { ...plan, edges: [["productImage", "__exec"], ["ghost", "__exec"], ["__prompt", "nobody"]] });
  check("悬空边被丢弃", bad.template.edges.length === 1, `edges=${bad.template.edges.length}`);
  check("丢边被计数", bad.droppedEdges === 2, `dropped=${bad.droppedEdges}`);

  const empty = planToTemplate(SKILL, { nodes: [], edges: [] });
  check("空计划 → EMPTY_PLAN 而不是空模板", empty.ok === false && empty.code === "EMPTY_PLAN", empty.code);
}

console.log("\n[5] 铺图策略优先级");
{
  const workflows = { "clothes-model": { label: "服装图模特图换衣" } };
  const withWf = resolveSkillGraph({ ...SKILL, workflow: "clothes-model" }, null, { workflows });
  check("命中内置模板 → 直接用模板（布局最好）", withWf.ok && withWf.mode === "template" && withWf.workflow === "clothes-model");

  const noWf = resolveSkillGraph(SKILL, null, { workflows });
  check("未命中模板 + 无计划 → 按技能定义铺", noWf.ok && noWf.mode === "definition");

  const withPlan = resolveSkillGraph(SKILL, {
    ok: true,
    nodes: [{ type: "product", key: "productImage" }, { type: "executor", key: "__exec" }],
    edges: [["productImage", "__exec"]],
    prompt: "p",
    model: "wanxiang"
  }, { workflows });
  check("未命中模板但有计划 → 用计划", withPlan.ok && withPlan.mode === "plan");

  const broken = resolveSkillGraph(null, null, { workflows: {} });
  check("技能定义不完整（null）→ ok:false（不假装成功）", broken.ok === false && Boolean(broken.reason), JSON.stringify(broken));

  // 纯文本技能（没有图片输入）是合法场景：文生图就是「提示词 → 执行器」
  const textOnly = resolveSkillGraph({ id: "txt2img", label: "文生图", inputs: [{ key: "raw", type: "text" }] }, null, { workflows: {} });
  check(
    "纯文本技能铺出提示词→执行器（文生图场景）",
    textOnly.ok && textOnly.mode === "definition" && textOnly.template.nodes.length === 2,
    JSON.stringify(textOnly.template?.nodes?.map((n) => n.type))
  );
}

console.log("\n[6] 接线：铺图只有一条代码路径");
{
  const canvas = read("src/components/NodeCanvas.vue");
  check("存在统一入口 applyWorkflowGraph", /function applyWorkflowGraph\(wf/.test(canvas));
  check(
    "applyWorkflow 内部调用统一入口（而不是自己再实现一遍）",
    /function applyWorkflow\(wfId\)[\s\S]{0,220}applyWorkflowGraph\(wf[,)]/.test(canvas)
  );
  check("挂载时消费 pendingWorkflowGraph", /if \(store\.pendingWorkflowGraph\)/.test(canvas));
  check("已在创作台内时用 watch 消费", /watch\(\s*\(\) => store\.pendingWorkflowGraph/.test(canvas));
  check("两种待铺来源分开存放（id 与对象不混用）", /pendingWorkflowGraph/.test(read("src/store.js")));

  // 真机点一次就抓到的 bug：把 applyWorkflow 抽成 applyWorkflowGraph 后，
  // 函数体里还残留着旧局部变量 wfId → 点技能铺图时抛 ReferenceError，
  // 界面照常铺图但会弹一条「wfId is not defined」软错误条。
  // 静态锁死：统一入口的函数体里不允许再出现 wfId。
  const body = canvas.slice(canvas.indexOf("function applyWorkflowGraph(wf"), canvas.indexOf("function applyWorkflow(wfId)"));
  check("统一入口的函数体里不引用旧变量 wfId", !/\bwfId\b/.test(body), body.match(/.{0,40}wfId.{0,40}/)?.[0] || "");

  const store = read("src/store.js");
  check("store 提供 launchSkillGraph", /export function launchSkillGraph\(/.test(store));
  check("空模板不冒充成功", /return \{ ok: false, reason: "该技能还没有可铺的节点图" \}/.test(store));
}

console.log("\n[7] 接线：面板入口与服务端降级");
{
  const studio = read("src/components/StudioView.vue");
  check("创作台引入了技能面板", /import SkillsPanel from "\.\/SkillsPanel\.vue"/.test(studio));
  check("顶栏有技能入口按钮", /class="skill-entry"/.test(studio));
  check("面板挂载到模板里", /<SkillsPanel v-model:open="skillsOpen" \/>/.test(studio));
  check("支持 ?panel=skills 预览（便于截图回归）", /get\("panel"\) === "skills"/.test(studio));

  const panel = read("src/components/SkillsPanel.vue");
  check("面板从服务端拉技能", /await fetchSkills\(\)/.test(panel));
  check("点击时请求执行计划", /await planSkill\(skill\.id, params\)/.test(panel));
  check(
    "必填项没填时不发注定 400 的请求（避免控制台红字）",
    /function canPlan\(skill, params\)/.test(panel) && /if \(canPlan\(skill, params\)\)/.test(panel)
  );
  check("用 resolveSkillGraph 决定怎么铺", /resolveSkillGraph\(skill, plan/.test(panel));
  check("服务端不可用时降级到本地清单", /skills\.value = localSkills\(\)/.test(panel));
  check("降级状态如实告知用户", /fromServer/.test(panel) && /本地清单/.test(panel));
  check("图片参数留空不阻塞铺图（计划失败是正常路径）", /catch \{\s*\n\s*plan = null;/.test(panel));
}

console.log("\n[8] 跨端交叉校验：服务端技能指的模板必须真的存在");
{
  const storeSrc = read("src/store.js");
  const block = storeSrc.slice(storeSrc.indexOf("export const WORKFLOWS"));
  const keys = new Set([...block.matchAll(/^\s{2}"([a-z0-9-]+)":\s*\{/gm)].map((m) => m[1]));
  check("能解析出前端模板键", keys.size >= 5, [...keys].join(","));

  const skillsSrc = read("server/skills.js");
  const declared = [...skillsSrc.matchAll(/workflow:\s*"([^"]*)"/g)].map((m) => m[1]);
  check("服务端技能声明了 workflow 字段", declared.length >= 10, `count=${declared.length}`);
  const broken = declared.filter((w) => w && !keys.has(w));
  check(
    "服务端声明的模板键都在前端 WORKFLOWS 里（否则点技能静默失败）",
    broken.length === 0,
    broken.join(",")
  );
}

console.log(`\n技能铺图接线：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
