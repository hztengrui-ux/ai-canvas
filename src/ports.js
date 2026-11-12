// 端口类型系统（P0-9 · 强类型端口）
//
// 对标 SynMew：每条连线都带 dataType（image / string / ai-image / video），
// 类型不匹配的连线在「拖拽阶段」就被拒绝，而不是等到运行才报错。
//
// 现状问题（改造前）：
//   ProductNode 的 source handle 叫 "product"，ExecutorNode 的 target handle
//   有 prompt / product / style 三个，但 Vue Flow 默认只校验 handle 存在、
//   不校验语义 —— 把产品图拖到「prompt」口上照样能连上，
//   点执行时才提示「请先连接画面描述节点」，用户根本不知道错在哪。
//
// 改造后：
//   1) 每个 handle 声明类型，连线时校验（isValidConnection）
//   2) 连线带上 dataType，边按类型着色，一眼看出数据流向
//   3) 序列化时保留 dataType，存成模板 / 撤销重做都不丢

// ---------- 数据类型 ----------
export const DATA_TYPES = {
  image: { label: "图片", color: "#2563EB" },
  string: { label: "文本", color: "#0EA5E9" },
  "ai-image": { label: "AI 图片", color: "#7C3AED" },
  video: { label: "视频", color: "#DB2777" },
  audio: { label: "音频", color: "#F59E0B" }
};

export function typeLabel(t) {
  return DATA_TYPES[t]?.label || t || "未知";
}

export function typeColor(t) {
  return DATA_TYPES[t]?.color || "#94A3B8";
}

// ---------- 节点端口表 ----------
// handle id 与现有节点组件里的 <Handle id="..."> 一一对应，不要随手改。
export const NODE_PORTS = {
  product: {
    outputs: [{ id: "product", type: "image", label: "产品/服装图" }]
  },
  style: {
    outputs: [{ id: "style", type: "image", label: "风格参考" }]
  },
  prompt: {
    outputs: [{ id: "prompt", type: "string", label: "画面描述" }]
  },
  reference: {
    outputs: [{ id: "result", type: "video", label: "视频结果" }]
  },
  executor: {
    inputs: [
      { id: "prompt", type: "string", label: "画面描述" },
      { id: "product", type: "image", label: "产品图" },
      { id: "style", type: "image", label: "风格参考" }
    ],
    outputs: [{ id: "result", type: "ai-image", label: "生成结果" }]
  },
  result: {
    inputs: [
      { id: "result", type: "ai-image", label: "生成结果" },
      { id: "result", type: "video", label: "视频结果" }
    ]
  }
};

function findPort(nodeType, handleId, dir) {
  const def = NODE_PORTS[nodeType];
  if (!def) return null;
  const list = dir === "in" ? def.inputs || [] : def.outputs || [];
  // result 节点两个输入口共用 id "result"，这里按「任一匹配即可」放行
  return list.find((p) => p.id === handleId) || null;
}

/** 取某节点某方向某 handle 的数据类型；查不到返回 null（视为未声明） */
export function portType(nodeType, handleId, dir) {
  if (dir === "in") {
    const def = NODE_PORTS[nodeType];
    const list = def?.inputs || [];
    const hits = list.filter((p) => p.id === handleId).map((p) => p.type);
    return hits.length ? hits : null;
  }
  return findPort(nodeType, handleId, "out")?.type || null;
}

/**
 * 校验一条连线。
 * @returns {{ok: boolean, reason?: string, dataType?: string}}
 *   dataType 仅在 ok 时返回，用于给边着色和序列化。
 */
export function validateConnection({ sourceType, sourceHandle, targetType, targetHandle }) {
  const out = portType(sourceType, sourceHandle, "out");
  const ins = portType(targetType, targetHandle, "in");

  // 端口未声明：不拦（模板里可能存在自定义节点），但也不着色
  if (!out || !ins) return { ok: true, dataType: out || "" };

  // 输入口声明了多种可接受类型（如 result 同时吃图片和视频）
  if (ins.includes(out)) return { ok: true, dataType: out };

  const srcLabel = findPort(sourceType, sourceHandle, "out")?.label || sourceHandle;
  const dstLabel = (NODE_PORTS[targetType]?.inputs || []).find((p) => p.id === targetHandle)?.label || targetHandle;
  return {
    ok: false,
    reason: `类型不匹配：「${srcLabel}」输出的是 ${typeLabel(out)}，而「${dstLabel}」只接受 ${ins
      .map(typeLabel)
      .join(" / ")}`
  };
}

/** 边的描边样式：虚线 + 按类型着色（蚂蚁线动画靠 CSS，颜色在这里定） */
export function edgeStyleFor(dataType) {
  return { strokeWidth: 1.6, strokeDasharray: "6 5", stroke: typeColor(dataType) };
}

/** 给一批边补上 dataType 与样式（反序列化 / 铺模板时统一调用） */
export function decorateEdge(edge, nodeTypeOf = () => "") {
  const dataType =
    edge.dataType ||
    validateConnection({
      sourceType: nodeTypeOf(edge.source),
      sourceHandle: edge.sourceHandle,
      targetType: nodeTypeOf(edge.target),
      targetHandle: edge.targetHandle
    }).dataType ||
    "";
  return { ...edge, dataType, style: { ...(edge.style || {}), ...edgeStyleFor(dataType) } };
}
