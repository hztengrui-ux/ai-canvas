/**
 * 第 10 个测试套件：健壮性补齐（2026-09-25）
 * --------------------------------------------------------------------------
 * 覆盖三块新代码，都是「错了很难被发现」的类型：
 *   1. 错误边界分级 —— 该掀桌的掀桌，不该掀桌的别掀桌
 *   2. 服务端任务取消 —— 取消要真取消，钩子要被跑到
 *   3. 素材路径校验 —— 前端传来的 url 不可信，穿越必须拦住
 *
 * 断言原则：不看返回值好不好看，看**副作用对不对**。
 * 比如取消的断言是「hook 真的被调用了 + signal 真的 aborted」，
 * 光看返回值 ok:true 说明不了 GPU 有没有停。
 */
import assert from "node:assert/strict";
import {
  errorState, formatError, isIgnorable, reportError, reportFatal,
  clearFatal, errorReportText
} from "./errorboundary.js";
import * as tasks from "../server/tasks.js";
import * as mats from "../server/materials.js";

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

// ---------------------------------------------------------------
console.log("\n[1] 错误分级：什么该掀桌，什么不该");
// ---------------------------------------------------------------
{
  const e = formatError(new Error("渲染失败"), "组件树");
  check("Error 能取到 message", e.message === "渲染失败", e.message);
  check("Error 带 source", e.source === "组件树");
  check("Error 带堆栈", e.stack.length > 0);

  check("字符串错误也能归一化", formatError("boom").message === "boom");
  check("undefined 不炸，给兜底文案", formatError(undefined).message === "发生了未知错误");
  check("对象错误取 message 字段", formatError({ message: "接口 500" }).message === "接口 500");

  // 这几条是浏览器噪音，掀桌毫无意义
  check("ResizeObserver 噪音被忽略", isIgnorable(new Error("ResizeObserver loop completed")));
  check("跨域 Script error 被忽略", isIgnorable(new Error("Script error.")));
  check("chunk 加载失败被忽略", isIgnorable(new Error("Loading chunk 3 failed")));
  check("真错误不被忽略", !isIgnorable(new Error("Key 无效")));

  // soft：记日志但不掀桌
  clearFatal();
  const before = errorState.softCount;
  reportError(new Error("接口超时"), "素材列表");
  check("soft 错误计数增加", errorState.softCount === before + 1);
  check("soft 错误不掀桌（fatal 仍为空）", errorState.fatal === null);
  check("soft 错误进了日志", errorState.log[0]?.level === "soft");

  // fatal：掀桌
  reportFatal(new Error("组件渲染失败"), "render");
  check("fatal 错误会掀桌", errorState.fatal !== null);
  check("fatal 错误也进日志", errorState.log[0]?.level === "fatal");
  const text = errorReportText();
  check("错误报告含消息", text.includes("组件渲染失败"));
  check("错误报告含位置", text.includes("render"));
  check("错误报告含堆栈", text.includes("堆栈"));

  clearFatal();
  check("clearFatal 能复位", errorState.fatal === null);

  // 日志上限：不能无限膨胀
  for (let i = 0; i < 40; i++) reportError(new Error(`第 ${i} 条`));
  check("日志有上限（不无限膨胀）", errorState.log.length <= 30, `实际 ${errorState.log.length}`);
}

// ---------------------------------------------------------------
console.log("\n[2] 服务端任务取消：取消要真取消");
// ---------------------------------------------------------------
{
  const id = "task-test-1";
  const t = tasks.register(id, { userId: "u1", kind: "image", provider: "comfyui" });
  check("注册返回任务对象", Boolean(t?.controller?.signal));
  check("signal 未取消时 aborted 为 false", t.controller.signal.aborted === false);
  check("可以通过 id 取回", tasks.get(id) === t);

  let hookRan = 0;
  tasks.onCancel(id, async () => {
    hookRan++;
    return { ok: true };
  });

  const r = await tasks.cancel(id);
  check("取消成功", r.ok === true);
  check("取消钩子真的跑了（ComfyUI /interrupt 靠它）", hookRan === 1, `跑了 ${hookRan} 次`);
  check("signal 真的 aborted 了", t.controller.signal.aborted === true);
  check("isCanceled 为真", tasks.isCanceled(id));

  const again = await tasks.cancel(id);
  check("重复取消返回 already 而不是报错", again.ok === true && again.already === true);

  tasks.unregister(id);
  check("unregister 后取不到", tasks.get(id) === null);
  check("取消不存在的任务返回 ok:false", (await tasks.cancel("nope")).ok === false);
}

// sleep 可中断：取消后不该再睡满整个间隔
{
  const id = "task-sleep";
  const t = tasks.register(id);
  const started = Date.now();
  const p = tasks.sleep(5000, t.controller.signal).then(
    () => "resolved",
    (e) => e.message
  );
  setTimeout(() => tasks.cancel(id), 20);
  const out = await p;
  const cost = Date.now() - started;
  check("取消后 sleep 立刻 reject", out === "已取消", out);
  check("不用睡满 5 秒才醒", cost < 1000, `实际 ${cost}ms`);
  tasks.unregister(id);
}

// sweepStale：兜底清理
{
  const id = "task-stale";
  const t = tasks.register(id);
  t.startedAt = Date.now() - 31 * 60 * 1000; // 手动推到 31 分钟前
  const n = tasks.sweepStale();
  check("超时任务被清掉", n === 1 && tasks.get(id) === null, `清了 ${n} 个`);
}

// ---------------------------------------------------------------
console.log("\n[3] 素材路径校验：前端 url 不可信");
// ---------------------------------------------------------------
{
  const ok = mats.parseMaterialUrl("/materials/clothing/a.png");
  check("合法 url 能解析", ok?.cat === "clothing" && ok?.file === "a.png", JSON.stringify(ok));

  check("中文名能解码", mats.parseMaterialUrl("/materials/clothing/" + encodeURIComponent("毛衫.png"))?.file === "毛衫.png");

  check("目录穿越被拦", mats.parseMaterialUrl("/materials/clothing/../../etc/passwd") === null);
  check("编码穿越被拦", mats.parseMaterialUrl("/materials/clothing/" + encodeURIComponent("../x.png")) === null);
  check("非白名单分类被拦", mats.parseMaterialUrl("/materials/secret/a.png") === null);
  check("不含 materials 前缀被拦", mats.parseMaterialUrl("/outputs/a.png") === null);
  check("隐藏文件被拦", mats.parseMaterialUrl("/materials/clothing/.env") === null);
  check("路径段数不对被拦", mats.parseMaterialUrl("/materials/clothing") === null);
  check("空值被拦", mats.parseMaterialUrl("") === null);
  check("null 被拦", mats.parseMaterialUrl(null) === null);
}

// 标签口径
{
  const keys = mats.TAG_GROUPS.map((g) => g.key);
  check("标签口径是四组", keys.length === 4, keys.join(","));
  check("含颜色", keys.includes("color"));
  check("含品类", keys.includes("category"));
  check("含季节", keys.includes("season"));
  check("含 SKU", keys.includes("sku"));
  check(
    "前三项是下拉（防打错字）",
    mats.TAG_GROUPS.filter((g) => g.key !== "sku").every((g) => g.input === "select" && g.options?.length)
  );
  check("SKU 是自由文本（各家规则不同）", mats.TAG_GROUPS.find((g) => g.key === "sku")?.input === "text");
}

// ---------------------------------------------------------------
console.log("\n[4] 排序纯函数");
// ---------------------------------------------------------------
{
  const { sortProjects, PROJECT_SORTS } = await import("./project.js");
  const list = [
    { id: "b", name: "香蕉", updatedAt: "1" },
    { id: "a", name: "苹果", updatedAt: "2" },
    { id: "c", name: "橙子", updatedAt: "3" }
  ];
  const byName = sortProjects(list, "name");
  // localeCompare('zh-CN') 按拼音排：橙(cheng) < 苹(ping) < 香(xiang)
  // （当初按笔画预期过一次，结果是对的、断言错了 —— 这里写死拼音序防回退）
  check(
    "按名称排序（拼音序）",
    byName.map((p) => p.name).join(",") === "橙子,苹果,香蕉",
    byName.map((p) => p.name).join(",")
  );
  check("排序不改原数组", list[0].name === "香蕉");
  check("默认按更新时间（原序）", sortProjects(list, "updated")[0].name === "香蕉");
  check("排序选项有三档", PROJECT_SORTS.length === 3);
}

// ---------------------------------------------------------------
console.log(`\n健壮性补齐：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
