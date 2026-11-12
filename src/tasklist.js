// 任务列表的纯逻辑（可单测，不 import vue / 不碰 DOM）
//
// 为什么要单独抽出来：任务条的"分组/统计/文案"以前全都写在组件的 computed 里，
// 于是「3 个一模一样的失败要不要折叠」「已退算力怎么显示」这类判断无法被测试覆盖，
// 只能靠人肉点。这里把它们变成纯函数，组件退化成薄薄一层渲染。
//
// 用户反馈驱动的三条规则：
//   1. 失败的任务常常是**同一件事重复失败**（比如密钥失效时连点三次），
//      一条条平铺只会刷屏 —— 按「标签 + 错误」折叠成一组，并给出条数。
//   2. 退费结果必须看得见：失败后算力退回来了没有，是用户最关心的一件事，
//      但以前只显示错误原文，退了多少完全看不到。
//   3. 进行中的任务永远排最前 —— 用户打开面板就是想看"现在跑到哪了"。

/** 任务状态归并：running | done | error | canceled */
export function statusOf(task) {
  const s = task?.status;
  if (s === "running" || s === "done" || s === "error" || s === "canceled") return s;
  return "canceled";
}

/** 任务统计（面板头部的那一行摘要） */
export function taskStats(tasks = []) {
  const out = { running: 0, done: 0, error: 0, canceled: 0, total: 0, refunded: 0, cost: 0, saved: 0 };
  for (const t of tasks) {
    const s = statusOf(t);
    out[s] += 1;
    out.total += 1;
    out.refunded += Number(t?.refunded) || 0;
    out.cost += Number(t?.cost) || 0;
    out.saved += Number(t?.savedCost) || 0;
  }
  return out;
}

/** 摘要文案：进行中优先，其次完成/失败 */
export function summaryOf(stats) {
  if (!stats.total) return "暂无任务";
  if (stats.running) {
    return stats.error || stats.done
      ? `${stats.running} 个进行中 · ${stats.done} 完成${stats.error ? ` · ${stats.error} 失败` : ""}`
      : `${stats.running} 个任务进行中`;
  }
  const parts = [];
  if (stats.done) parts.push(`${stats.done} 个完成`);
  if (stats.error) parts.push(`${stats.error} 个失败`);
  if (stats.canceled) parts.push(`${stats.canceled} 个已取消`);
  return parts.join(" · ") || "暂无任务";
}

/** 相对时间：刚刚 / N 分钟前 / HH:MM */
export function friendlyTime(ts, now = Date.now()) {
  const n = Number(ts) || 0;
  if (!n) return "";
  const diff = Math.max(0, now - n);
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(n);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hhmm : `${d.getMonth() + 1}-${d.getDate()} ${hhmm}`;
}

/**
 * 任务行的副标题：状态 + 退费（退费必须显式写出来）
 *
 * 「已退回 10 算力」这句话很重要：失败本身用户能看见，
 * 但"钱回来了没有"看不见 —— 而后者才是他会不会来追问你的原因。
 */
export function subtitleOf(task) {
  const s = statusOf(task);
  if (s === "running") return task?.text || "处理中…";
  if (s === "done") {
    const n = (task?.images || []).length;
    return n ? `完成 · ${n} 个结果` : "完成";
  }
  if (s === "canceled") return "已取消 · 未扣费";
  const refunded = Number(task?.refunded) || 0;
  const reason = task?.text || "失败";
  return refunded > 0 ? `${reason} · 已退回 ${refunded} 算力` : reason;
}

/** 失败分组键：同一件事重复失败就折叠（标签 + 错误原文） */
export function failureKey(task) {
  return `${task?.label || ""}\u0000${task?.text || ""}`;
}

/**
 * 把任务整理成面板要渲染的「行」：
 *   { kind:"task", task }                    普通一行
 *   { kind:"group", tasks:[...], label, text, count }  折叠的重复失败
 *
 * 顺序：进行中 → 失败（含折叠组）→ 已取消 → 已完成（最多 keepDone 条，其余折叠成一条）
 */
export function taskRows(tasks = [], { keepDone = 5, collapseFailures = true } = {}) {
  const running = [];
  const errors = [];
  const canceled = [];
  const done = [];
  for (const t of tasks) {
    const s = statusOf(t);
    if (s === "running") running.push(t);
    else if (s === "error") errors.push(t);
    else if (s === "canceled") canceled.push(t);
    else done.push(t);
  }

  const rows = [];
  for (const t of running) rows.push({ kind: "task", key: `t:${t.id}`, task: t });

  if (collapseFailures) {
    const groups = new Map();
    for (const t of errors) {
      const k = failureKey(t);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t);
    }
    for (const [, list] of groups) {
      if (list.length === 1) {
        rows.push({ kind: "task", key: `t:${list[0].id}`, task: list[0] });
      } else {
        rows.push({
          kind: "group",
          key: `g:${list[0].id}`,
          tasks: list,
          count: list.length,
          label: list[0].label,
          text: list[0].text
        });
      }
    }
  } else {
    for (const t of errors) rows.push({ kind: "task", key: `t:${t.id}`, task: t });
  }

  for (const t of canceled) rows.push({ kind: "task", key: `t:${t.id}`, task: t });

  const shownDone = done.slice(0, keepDone);
  for (const t of shownDone) rows.push({ kind: "task", key: `t:${t.id}`, task: t });
  const hiddenDone = done.length - shownDone.length;
  if (hiddenDone > 0) {
    rows.push({ kind: "more", key: "more-done", count: hiddenDone });
  }

  return rows;
}

/** 失败且记录了节点 id 的任务 → 可以「全部重做」 */
export function retryableTasks(tasks = []) {
  return tasks.filter((t) => statusOf(t) === "error" && t.nodeId);
}
