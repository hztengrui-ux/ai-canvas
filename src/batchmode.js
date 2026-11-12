/**
 * 批量节点模式的纯逻辑（2026-09-25）
 *
 * 单独抽出来不依赖 DOM / Vue，方便单测。
 * 组件（BatchDock / NodeCanvas）只负责把这里的结果画出来。
 */

/** 批量一次最多铺多少行 —— 再多画布就成马赛克了，且容易一次扣穿算力 */
export const BATCH_LIMITS = {
  maxRows: 60,
  minRows: 1,
  maxPerNode: 10,
  minPerNode: 1,
  defaultCols: 3
};

/**
 * 把粘贴进来的一大段文字拆成提示词数组。
 *
 * 真实场景里用户会从 Excel / 文档里复制，带来一堆噪声：
 *   "1. 雪尼尔毛衫，圆领，胸前小面积刺绣"
 *   "- 同上，改成V领"
 *   "（空行）"
 * 所以这里要洗：去序号、去项目符号、去空行、压掉重复。
 *
 * @param {string} text
 * @param {{max?:number, dedupe?:boolean}} [opts]
 * @returns {string[]}
 */
export function splitPrompts(text, opts = {}) {
  const max = Math.max(1, Math.round(Number(opts.max) || BATCH_LIMITS.maxRows));
  const dedupe = opts.dedupe !== false;

  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => String(s || "").trim())
    // 去掉行首的序号（1. / 1、/ 01) ）与项目符号（- / * / • / —）
    .map((s) => s.replace(/^\s*(?:[-*•—–]\s+|\d+\s*[.、)）:：]\s*)/, "").trim())
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const l of lines) {
    if (dedupe) {
      const key = l.replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 网格排布：把 n 个格子按行优先铺开。
 * 批量铺节点时用，避免所有节点叠在原点（Vue Flow 不会自动避让）。
 *
 * @param {number} count
 * @param {{cols?:number, cellW?:number, cellH?:number, x?:number, y?:number}} [opts]
 * @returns {{x:number,y:number}[]}
 */
export function planGrid(count, opts = {}) {
  const n = Math.max(0, Math.round(Number(count) || 0));
  const cols = Math.max(1, Math.round(Number(opts.cols) || BATCH_LIMITS.defaultCols));
  const cellW = Math.max(1, Number(opts.cellW) || 420);
  const cellH = Math.max(1, Number(opts.cellH) || 520);
  const x0 = Number(opts.x) || 0;
  const y0 = Number(opts.y) || 0;

  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      x: x0 + (i % cols) * cellW,
      y: y0 + Math.floor(i / cols) * cellH
    });
  }
  return out;
}

/** 行的状态中文标签，任务条与批量面板共用一套说法 */
export function batchRowStateLabel(state) {
  return (
    {
      idle: "待运行",
      queued: "排队中",
      running: "运行中",
      done: "完成",
      error: "失败",
      canceled: "已取消",
      skipped: "已跳过"
    }[state] || "待运行"
  );
}

/**
 * 估算一次批量的算力开销，用于批量运行前的确认弹窗。
 * 真实扣费由服务端账本决定，这里只是给用户一个量级提示。
 *
 * @param {{rows:number, perNode:number, unitCost:number}} o
 */
export function estimateBatchCost({ rows = 0, perNode = 1, unitCost = 0 }) {
  const r = Math.max(0, Math.round(Number(rows) || 0));
  const p = Math.max(0, Math.round(Number(perNode) || 0));
  const u = Math.max(0, Number(unitCost) || 0);
  return Math.round(r * p * u * 100) / 100;
}
