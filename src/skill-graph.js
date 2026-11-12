// 技能 → 画布节点图（纯逻辑，可单测）
//
// 背景：服务端的技能库（server/skills.js）给出 `skillPlan`：
//   nodes: [{ type, key }]      建议铺哪些节点
//   edges: [[fromKey, toKey]]   建议怎么连
// 但画布真正认的是 **WORKFLOWS 模板形状**（src/store.js）：
//   { label, tool, nodes: [{ key, type, x, y, data }], edges: [[from,to,sourceHandle,targetHandle]] }
//
// 所以这里做的事只有一件：**把技能计划翻译成模板形状**，然后交给既有的
// applyWorkflow 去铺图（定位、id 生成、结果节点补齐、连线校验全都复用同一份代码）。
//
// 为什么不另写一条铺图路径：那意味着「模板铺图」和「技能铺图」会各自演化 ——
// 端口校验、结果节点、id 唯一性这些规则很快就不一致，出问题极难查。
//
// 本模块零依赖、不 import vue、不碰 DOM。

/** 节点类型 → id 前缀（与 NodeCanvas 的 PREFIX 保持一致，前缀只为可读性，唯一性靠计数器） */
export const NODE_PREFIX = {
  product: "pd",
  style: "s",
  prompt: "p",
  executor: "e",
  reference: "ref",
  result: "r",
  group: "g"
};

/** 源节点 → 输出句柄。规则取自 src/store.js 里现成的 WORKFLOWS 模板 */
export function handleFor(type) {
  if (type === "style") return "style";
  if (type === "prompt") return "prompt";
  return "product"; // product / reference / 其余一律走 product 口
}

/** 目标节点（执行器）的入端口与源同义 */
export function targetHandleFor(sourceType) {
  return handleFor(sourceType);
}

/**
 * 分层布局：按拓扑深度分列。
 * @returns {{ positions: Record<string,{x:number,y:number}>, layers: string[][], maxLayer: number }}
 */
export function layoutLayers(nodes, edges, { colGap = 300, rowGap = 190 } = {}) {
  const keys = nodes.map((n) => n.key);
  const known = new Set(keys);
  const indegree = new Map(keys.map((k) => [k, 0]));
  const outs = new Map(keys.map((k) => [k, []]));
  for (const [from, to] of edges) {
    if (!known.has(from) || !known.has(to)) continue;
    indegree.set(to, indegree.get(to) + 1);
    outs.get(from).push(to);
  }

  // Kahn 拓扑分层；环上的节点兜底放到最后一层（宁可位置不完美，也不能死循环）
  const layer = new Map(keys.map((k) => [k, 0]));
  const queue = keys.filter((k) => indegree.get(k) === 0);
  const seen = new Set(queue);
  while (queue.length) {
    const cur = queue.shift();
    for (const next of outs.get(cur)) {
      layer.set(next, Math.max(layer.get(next), layer.get(cur) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) <= 0 && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  for (const k of keys) if (!seen.has(k)) layer.set(k, Math.max(1, ...layer.values()));

  const layers = [];
  for (const k of keys) {
    const i = layer.get(k);
    (layers[i] ||= []).push(k);
  }

  const positions = {};
  layers.forEach((row, col) => {
    row.forEach((k, idx) => {
      positions[k] = { x: col * colGap, y: idx * rowGap };
    });
  });
  return { positions, layers, maxLayer: Math.max(0, layers.length - 1) };
}

/**
 * 技能计划 → WORKFLOWS 同形状模板。
 *
 * @param {object} skill 服务端技能定义（含 inputs，用于给节点填 title/role）
 * @param {object} plan  skillPlan 的结果（nodes / edges / prompt / model / kind）
 * @param {{ count?: number, ratio?: string, modelId?: string }} [opts]
 * @returns {{ ok: boolean, code?: string, message?: string, template?: object, droppedEdges?: number }}
 */
export function planToTemplate(skill, plan, opts = {}) {
  const planNodes = Array.isArray(plan?.nodes) ? plan.nodes : [];
  const planEdges = Array.isArray(plan?.edges) ? plan.edges : [];
  if (!planNodes.length) {
    return { ok: false, code: "EMPTY_PLAN", message: "技能计划里没有节点" };
  }

  const inputs = Array.isArray(skill?.inputs) ? skill.inputs : [];
  const inputOf = (key) => inputs.find((i) => i.key === key) || null;

  // 节点数据：图片类输入 → 上传节点的标题/角色/受保护标记
  const nodes = planNodes.map((n) => {
    const def = inputOf(n.key);
    const data = {};
    if (def) {
      if (def.label) data.title = def.label;
      if (def.role) data.role = def.role;
      // 「受保护」= 参考图内容不得改写（服务端编译器的同一条语义）
      if (def.protected) data.protected = true;
    }
    return { key: n.key, type: n.type, data };
  });

  // 提示词节点带上编译后的正文；执行器带上模型与张数（用户进来就能直接点生成）
  const promptText = String(plan?.prompt || "");
  const count = Number(opts.count ?? plan?.count ?? 0);
  for (const n of nodes) {
    if (n.type === "prompt") {
      n.data = { ...n.data, prompt: promptText };
      if (count > 0) n.data.count = count;
      if (opts.ratio) n.data.ratio = opts.ratio;
    }
    if (n.type === "executor") {
      n.data = { ...n.data };
      if (plan?.model) n.data.modelId = plan.model;
      if (count > 0) n.data.count = count;
    }
  }

  const typeOf = (k) => nodes.find((n) => n.key === k)?.type || "";
  const edges = planEdges.map((e) => {
    const from = Array.isArray(e) ? e[0] : e?.from;
    const to = Array.isArray(e) ? e[1] : e?.to;
    return [from, to, handleFor(typeOf(from)), targetHandleFor(typeOf(from))];
  });
  // 收尾（布局 + 丢悬空边）与 skillToTemplate 共用同一份实现
  return finalize(skill, nodes, edges);
}

/**
 * 只按技能定义铺图（**不需要用户先填参数**）。
 *
 * 为什么需要这条路：技能计划 `skillPlan` 会校验必填参数 —— 而用户点技能时
 * 还没来得及传产品图，计划必然失败。但「铺出节点让用户把图拖进来」本身不需要参数，
 * 只需要「有哪些输入、各自是什么角色」这些定义信息（服务端的 node/role/protected
 * 扩展字段就是为此存在的，与服务端计划同源，所以两边铺出来的结构一致）。
 *
 * @param {object} skill 技能定义
 * @param {{ prompt?: string, model?: string, count?: number, ratio?: string }} [opts]
 */
export function skillToTemplate(skill, opts = {}) {
  // 没有 id 就说明这压根不是一条技能定义（null / 脏数据）。
  // 此时**不能**退化成「铺一条通用提示词→执行器」—— 那等于假装成功，
  // 用户会得到一张不知道自己在干什么的画布。
  if (!skill || !skill.id) {
    return { ok: false, code: "BAD_SKILL", message: "技能定义不完整" };
  }
  const inputs = Array.isArray(skill?.inputs) ? skill.inputs : [];
  const nodes = [];

  for (const input of inputs) {
    const type = input?.node;
    // 提示词与执行器由本函数统一补，输入里声明的一律忽略，避免铺出两个提示词节点
    if (!type || type === "prompt" || type === "executor" || type === "result") continue;
    nodes.push({
      key: input.key,
      type,
      data: {
        title: input.label || "",
        ...(input.role ? { role: input.role } : {}),
        ...(input.protected ? { protected: true } : {})
      }
    });
  }

  const count = Number(opts.count) || 0;
  nodes.push({
    key: "__prompt",
    type: "prompt",
    data: {
      prompt: String(opts.prompt || ""),
      ...(count > 0 ? { count } : {}),
      ...(opts.ratio ? { ratio: opts.ratio } : {})
    }
  });
  nodes.push({
    key: "__exec",
    type: "executor",
    data: {
      ...(opts.model ? { modelId: opts.model } : {}),
      ...(count > 0 ? { count } : {})
    }
  });

  const edges = [];
  for (const n of nodes) {
    if (n.key === "__prompt" || n.key === "__exec") continue;
    edges.push([n.key, "__exec", handleFor(n.type), targetHandleFor(n.type)]);
  }
  edges.push(["__prompt", "__exec", "prompt", "prompt"]);

  return finalize(skill, nodes, edges);
}

/** 收尾：分层布局 + 丢弃悬空边（两条铺图路径共用，保证规则只存在一份） */
function finalize(skill, nodes, edges) {
  if (!nodes.length) return { ok: false, code: "EMPTY_GRAPH", message: "该技能没有可铺的节点" };
  const { positions } = layoutLayers(nodes, edges);
  for (const n of nodes) {
    const pos = positions[n.key] || { x: 0, y: 0 };
    n.x = pos.x;
    n.y = pos.y;
  }
  const known = new Set(nodes.map((n) => n.key));
  let droppedEdges = 0;
  const kept = [];
  for (const [from, to, sh, th] of edges) {
    if (!known.has(from) || !known.has(to)) {
      droppedEdges += 1;
      continue;
    }
    kept.push([from, to, sh, th]);
  }
  return {
    ok: true,
    droppedEdges,
    template: {
      label: skill?.label || "技能",
      tool: "",
      skillId: skill?.id || "",
      nodes,
      edges: kept
    }
  };
}

/**
 * 决定这个技能该怎么铺：
 *   mode=template → 前端已有同名工作流模板（布局最好，直接复用）
 *   mode=plan     → 用服务端技能计划的节点图
 *   mode=definition → 用户还没填参数，按技能定义先铺出结构
 *   ok=false      → 如实返回原因（不假装成功）
 *
 * @param {object} skill 技能
 * @param {object} plan  skillPlan 结果（可为 null：拉不到计划时也要能降级铺图）
 * @param {{ workflows?: object, opts?: object }} [ctx]
 */
export function resolveSkillGraph(skill, plan, ctx = {}) {
  const workflows = ctx.workflows || {};
  if (skill?.workflow && workflows[skill.workflow]) {
    return {
      ok: true,
      mode: "template",
      workflow: skill.workflow,
      label: workflows[skill.workflow].label || skill.label
    };
  }
  const built = planToTemplate(skill, plan, ctx.opts || {});
  if (built.ok) {
    return { ok: true, mode: "plan", template: built.template, droppedEdges: built.droppedEdges, label: built.template.label };
  }
  const fromDef = skillToTemplate(skill, ctx.opts || {});
  if (fromDef.ok) {
    return {
      ok: true,
      mode: "definition",
      template: fromDef.template,
      droppedEdges: fromDef.droppedEdges,
      label: fromDef.template.label
    };
  }
  return { ok: false, code: built.code || "NO_GRAPH", reason: built.message || "该技能还没有可铺的节点图" };
}
