/**
 * 批量进度：幂等键 / 只重试失败项 / 中断恢复 自测（Sprint 0 ⑤）
 * --------------------------------------------------------------------------
 * 断点续跑的三条语义，任何一条错了用户都会直接受损：
 *   1. 幂等键 —— 连点两次「开始批量」不能变成两份进度、两条扣费链路
 *   2. 只重试失败项 —— 已成功的批次绝不能重跑（浪费算力 + 结果集出现重复图）
 *   3. 中断恢复 —— 进程重启后 running 是「假运行中」，必须标成 interrupted，
 *      否则 UI 永远转圈，用户以为还在生成
 *
 * 纯逻辑测试：只写临时数据目录（AI_CANVAS_HOME），不依赖服务端。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "batch-resume-"));
process.env.AI_CANVAS_HOME = HOME;

const batch = await import("./batch.js");

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

console.log("\n[1] 幂等键：同键重复发起 = 同一份进度");
{
  const first = batch.create({ id: "b1", total: 3, perBatch: 2, label: "毛衫 3 变体", idempotencyKey: "k-order-1" });
  check("首次创建：3 项全 pending", first.items.length === 3 && first.items.every((i) => i.status === "pending"));
  check("幂等键已落盘", first.idempotencyKey === "k-order-1");

  const again = batch.create({ id: "b2", total: 3, perBatch: 2, label: "毛衫 3 变体", idempotencyKey: "k-order-1" });
  check("同键重复 create → 返回既有进度（id 未变）", again.id === "b1", `got ${again.id}`);
  check("同键重复 create → 磁盘上只有一份", !fs.existsSync(path.join(batch.root(), "b2.json")));

  const other = batch.create({ id: "b2", total: 2, perBatch: 2, label: "另一单", idempotencyKey: "k-order-2" });
  check("不同幂等键 → 新建", other.id === "b2" && fs.existsSync(path.join(batch.root(), "b2.json")));

  const noKey = batch.create({ id: "b3", total: 1 });
  check("不传幂等键：行为与原来一致（每次都新建）", noKey.id === "b3" && noKey.idempotencyKey === "");
}

console.log("\n[2] 只重试失败项：成功项是终态");
{
  batch.update("b1", { index: 0, status: "ok", images: ["i0"] });
  batch.update("b1", { index: 1, status: "failed", error: "模型超时" });

  let data = batch.get("b1");
  check("完成 1 / 失败 1", data.done === 1 && data.failed === 1, `done=${data.done} failed=${data.failed}`);

  const pending = batch.pendingIndexes("b1");
  check("未完成下标 = [1,2]（不含已成功的 0）", JSON.stringify(pending) === "[1,2]", JSON.stringify(pending));

  const sum = batch.summary("b1");
  check(
    "汇总口径一致",
    sum.total === 3 && sum.done === 1 && sum.failed === 1 && sum.pending === 1 && sum.status === "running",
    JSON.stringify(sum)
  );

  // 迟到的重复提交不能把成功项改回失败（否则会重扣费 + 结果重复）
  batch.update("b1", { index: 0, status: "failed", error: "迟到的失败回报" });
  data = batch.get("b1");
  check("已成功项不被降级为 failed", data.items[0].status === "ok", data.items[0].status);
  check("已成功项的结果仍在", batch.results("b1").join(",") === "i0", batch.results("b1").join(","));

  const retry = batch.retryFailed("b1");
  check("retryFailed 只返回失败项下标 [1]", JSON.stringify(retry.retried) === "[1]", JSON.stringify(retry.retried));
  data = batch.get("b1");
  check("重试后 failed 归零", data.failed === 0, `failed=${data.failed}`);
  check("重试后仍是 running（等待客户端重跑）", data.status === "running", data.status);
  check("重试后未完成项 = [1,2]", JSON.stringify(batch.pendingIndexes("b1")) === "[1,2]");

  // 补跑完成
  batch.update("b1", { index: 1, status: "ok", images: ["i1"] });
  batch.update("b1", { index: 2, status: "ok", images: ["i2"] });
  data = batch.get("b1");
  check("全部完成 → status=done", data.status === "done", data.status);
  check("结果按 index 顺序拼接", batch.results("b1").join(",") === "i0,i1,i2", batch.results("b1").join(","));
}

console.log("\n[3] 中断恢复：重启后不装「假运行中」");
{
  batch.create({ id: "b4", total: 2, label: "进程重启前没跑完" });
  batch.update("b4", { index: 0, status: "ok", images: ["x0"] });
  check("重启前状态是 running", batch.get("b4").status === "running");

  const marked = batch.recoverStale();
  check("recoverStale 至少标记 1 个（b4）", marked >= 1, `marked=${marked}`);
  check("b4 被标成 interrupted（可续跑，而不是永远转圈）", batch.get("b4").status === "interrupted", batch.get("b4").status);
  check("已完成的 b1 不受影响", batch.get("b1").status === "done", batch.get("b1").status);

  const again = batch.recoverStale();
  check("重复调用幂等（不会反复改状态）", again === 0, `again=${again}`);

  const listed = batch.list().find((r) => r.id === "b4");
  check("中断批次出现在续跑列表里", Boolean(listed) && listed.status === "interrupted");
}

console.log("\n[4] 边界与清理");
{
  let threw = false;
  try {
    batch.create({ id: "////", total: 1 });
  } catch {
    threw = true;
  }
  check("非法 batchId 抛错（不做路径穿越）", threw === true);

  const cleaned = batch.sweep(7);
  check("sweep(7) 不删刚创建的进度", cleaned === 0 && batch.get("b1") !== null, `cleaned=${cleaned}`);
  check("summary 对不存在的 id 返回 null", batch.summary("nope") === null);
  check("pendingIndexes 对不存在的 id 返回空数组", batch.pendingIndexes("nope").length === 0);
  check("retryFailed 对不存在的 id 返回 ok:false", batch.retryFailed("nope").ok === false);
}

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* Windows 上可能有句柄占用，忽略 */
}

console.log(`\n批量续跑：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
