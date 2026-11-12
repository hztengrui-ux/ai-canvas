/**
 * 任务中心：底部不再占位 + 任务列表优化 + 退费可见
 * --------------------------------------------------------------------------
 * 两轮用户反馈推动了这次重做：
 *   1. "底部这个不要" —— 常驻底部横条（没任务也占一条、有任务自动展开）被否掉。
 *      现在底部一个像素都不占，入口挪到顶栏，没任务时入口也不出现。
 *   2. "任务全部优化好" —— 重复失败折叠、失败显示已退算力、批量重做、单条移除。
 *
 * 分组/统计/文案都抽到了 src/tasklist.js（纯函数），所以可以被真正测到 ——
 * 以前这些判断写死在组件 computed 里，只能靠人肉点界面。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taskRows, taskStats, summaryOf, subtitleOf, statusOf, friendlyTime, retryableTasks } from "./tasklist.js";

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

const T = (over = {}) => ({ id: over.id || `t${Math.random().toString(36).slice(2, 7)}`, status: "running", ts: Date.now(), ...over });

console.log("\n[1] 统计与摘要");
{
  const tasks = [
    T({ id: "a", status: "running" }),
    T({ id: "b", status: "error", refunded: 10 }),
    T({ id: "c", status: "error", refunded: 10 }),
    T({ id: "d", status: "done", cost: 10 })
  ];
  const s = taskStats(tasks);
  check("四态计数正确", s.running === 1 && s.error === 2 && s.done === 1 && s.total === 4, JSON.stringify(s));
  check("汇总已退算力", s.refunded === 20, String(s.refunded));
  check("有进行中时摘要以进行中开头", summaryOf(s).startsWith("1 个进行中"), summaryOf(s));
  check("无任务时摘要为「暂无任务」", summaryOf(taskStats([])) === "暂无任务");
  check("全结束时摘要列出完成与失败", summaryOf(taskStats([T({ status: "done" }), T({ status: "error" })])).includes("失败"));
  check("未知状态不崩，归到已取消", statusOf({ status: "???" }) === "canceled");
}

console.log("\n[2] 退费必须看得见（用户最关心的一件事）");
{
  check(
    "失败且已退费 → 文案含「已退回 N 算力」",
    subtitleOf(T({ status: "error", text: "Invalid API-key provided.", refunded: 10 })) ===
      "Invalid API-key provided. · 已退回 10 算力",
    subtitleOf(T({ status: "error", text: "Invalid API-key provided.", refunded: 10 }))
  );
  check("失败但没退费 → 不谎称已退", subtitleOf(T({ status: "error", text: "超时" })) === "超时");
  check("已取消 → 说明未扣费", subtitleOf(T({ status: "canceled" })) === "已取消 · 未扣费");
  check("完成 → 带上结果数", subtitleOf(T({ status: "done", images: [1, 2] })) === "完成 · 2 个结果");
  check("进行中 → 显示进度文案", subtitleOf(T({ status: "running", text: "生成中…" })) === "生成中…");
}

console.log("\n[3] 相对时间");
{
  const now = Date.now();
  check("刚刚", friendlyTime(now - 5_000, now) === "刚刚");
  check("分钟级", friendlyTime(now - 5 * 60_000, now) === "5 分钟前");
  check("跨天显示日期", /\d+-\d+/.test(friendlyTime(now - 3 * 24 * 3600_000, now)));
  check("没有时间戳就不显示", friendlyTime(0, now) === "");
}

console.log("\n[4] 列表分组：顺序 / 折叠 / 收敛");
{
  const same = { label: "通义万相 2.1 Turbo × 1 张", text: "Invalid API-key provided." };
  const tasks = [
    T({ id: "d1", status: "done", ...same }),
    T({ id: "e1", status: "error", ...same }),
    T({ id: "e2", status: "error", ...same }),
    T({ id: "e3", status: "error", ...same }),
    T({ id: "r1", status: "running" })
  ];
  const rows = taskRows(tasks);
  check("进行中排最前", rows[0].kind === "task" && rows[0].task.id === "r1");
  const group = rows.find((r) => r.kind === "group");
  check("3 条相同失败折叠成一组（原来会刷 3 行）", Boolean(group) && group.count === 3, JSON.stringify(rows.map((r) => r.kind)));
  check("折叠组只占一行", rows.filter((r) => r.kind === "group").length === 1);
  check("不同错误不折叠", taskRows([T({ status: "error", label: "A", text: "x" }), T({ status: "error", label: "B", text: "y" })]).every((r) => r.kind === "task"));

  // 已完成过多时收敛
  const many = Array.from({ length: 9 }, (_, i) => T({ id: `ok${i}`, status: "done" }));
  const rows2 = taskRows(many, { keepDone: 5 });
  check("已完成只显示最近 5 条", rows2.filter((r) => r.kind === "task").length === 5);
  check("其余折叠成「还有 N 条」", rows2.some((r) => r.kind === "more" && r.count === 4), JSON.stringify(rows2.at(-1)));

  check("可重做 = 失败且有节点 id", retryableTasks([T({ status: "error", nodeId: "n1" }), T({ status: "error" })]).length === 1);
}

console.log("\n[5] 任务中心接线：底部不再占位");
{
  const studio = read("src/components/StudioView.vue");
  const bar = read("src/components/TaskBar.vue");

  check("顶栏挂了任务入口", /<TaskBar \/>/.test(studio));
  // 旧的底部挂载点必须消失：它在 </header> 之后、帮助弹窗之前
  const headerEnd = studio.indexOf("</header>");
  const afterHeader = studio.slice(headerEnd, headerEnd + 2000);
  check("底部不再有常驻任务条", !/^\s*<TaskBar \/>\s*$/m.test(afterHeader), "TaskBar 仍在底部区域");
  check("底部移除处留了说明（避免以后被顺手加回来）", /底部任务条已移除/.test(studio));

  check("没有任务时入口不渲染（不制造「暂无任务」噪音）", /v-if="stats\.total"/.test(bar));
  check("入口是顶栏按钮 + 徽标", /class="task-entry"/.test(bar) && /task-entry-badge|task-entry-count/.test(bar));
  check("面板用浮层而不是第二根横条", /el-popover/.test(bar));
  check("任务逻辑走纯函数模块", /from "\.\.\/tasklist\.js"/.test(bar));
  check("有「全部重做」", /全部重做/.test(bar) && /retryAll/.test(bar));
  check("有「清除失败」", /清除失败/.test(bar) && /clearFailedTasks/.test(bar));
  check("清除已完成文案如实带上失败数", /清除已完成 \+ \$\{stats\.value\.error\} 失败/.test(bar));
  check("失败折叠组可展开", /toggleGroup/.test(bar) && /expanded/.test(bar));
  check("单条移除仍在，且进行中不可移除", /tp-dismiss/.test(bar) && /statusOf\(row\.task\) !== 'running'/.test(bar));
  check("进行中可取消、失败可重做", /cancel\(row\.task\)/.test(bar) && /retry\(row\.task\)/.test(bar));
  check("面板顶部显示已退算力", /tp-refund/.test(bar) && /stats\.refunded/.test(bar));
}

console.log("\n[6] 不再自动弹面板（用户被顶开的体验问题）");
{
  const store = read("src/store.js");
  check("pushTask 不再自动展开面板", !/store\.tasks\.unshift\(t\);[\s\S]{0,200}store\.taskBarOpen = true/.test(store));
  check("finishTask 不再自动收起面板", !/setTimeout\([\s\S]{0,200}taskBarOpen = false/.test(store));
  check("面板默认关闭", /taskBarOpen: false/.test(store));
  check("演示任务入口只服务于预览/截图", /seedDemoTasks/.test(store) && /仅供界面预览/.test(store));
}

console.log("\n[7] 全局样式层不再残留底部任务条规则");
{
  const css = read("src/redesign.css");
  // 只看「选择器 + {」这种真正的规则，注释里提到类名不算
  check("旧的 .taskbar-clear.is-error 覆盖规则已移除", !/\.taskbar-clear\.is-error\s*\{/.test(css));
  check("旧的 .tb-dismiss 覆盖规则已移除（新样式是组件 scoped）", !/\.tb-dismiss\s*\{/.test(css));
}

console.log(`\n任务中心：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
