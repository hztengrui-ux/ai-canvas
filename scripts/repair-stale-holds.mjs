#!/usr/bin/env node
/**
 * 回收「悬空预扣」——预扣了算力但既没退费也没结算的账。
 *
 * 什么时候需要它：
 *   · 生成失败但没退费（例如 refId 复用把退费吞掉的旧 bug）
 *   · 生成中途进程被杀（关应用 / 崩溃），catch 里的退费根本没机会跑
 * 用户看到的都是同一件事：**失败了，但算力没回来**。
 *
 * 应用启动时会自动回收 30 分钟以上的悬空预扣（server/index.js → credits.recoverStale）。
 * 这个脚本用于**当场修复**：可以指定更短的时限，且默认只预览不改账本。
 *
 * 用法：
 *   node scripts/repair-stale-holds.mjs                 # 预览（默认 10 分钟前，不改任何东西）
 *   node scripts/repair-stale-holds.mjs --apply         # 真的退回
 *   node scripts/repair-stale-holds.mjs --apply --older-than-min=1
 *   node scripts/repair-stale-holds.mjs --apply --user=8ed7336d
 */
import process from "node:process";
import * as credits from "../server/credits.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const olderThanMin = Number((args.find((a) => a.startsWith("--older-than-min=")) || "").split("=")[1] || 10);
const onlyUser = (args.find((a) => a.startsWith("--user=")) || "").split("=")[1] || "";
const olderThanMs = Math.max(1, olderThanMin) * 60 * 1000;

// 先做一次"预览"：给 recoverStale 一个「不包含任何可回收记录」的阈值，
// 这样我们能看清有哪些候选，而账本一个字节都不动。
function scan() {
  const now = Date.now();
  return { now, threshold: olderThanMs };
}

const { now } = scan();

// 直接读账本做候选枚举（与 credits.recoverStale 的判定口径一致：按 refId 配对计数）
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const file = path.join(process.env.AI_CANVAS_HOME || path.join(os.homedir(), ".ai-canvas"), "credits-ledger.json");
const raw = JSON.parse(fs.readFileSync(file, "utf8"));

const candidates = [];
for (const [userId, rows] of Object.entries(raw.records || {})) {
  if (onlyUser && userId !== onlyUser) continue;
  const byRef = new Map();
  for (const r of rows) {
    if (!r.refId) continue;
    if (!byRef.has(r.refId)) byRef.set(r.refId, { reserves: [], closed: 0 });
    const g = byRef.get(r.refId);
    if (r.type === "reserve") g.reserves.push(r);
    else if (r.type === "rollback" || r.type === "consume") g.closed += 1;
  }
  for (const [refId, g] of byRef) {
    let open = g.reserves.length - g.closed;
    for (const rs of g.reserves) {
      if (open <= 0) break;
      const ageMin = (now - Number(rs.ts || 0)) / 60000;
      if (ageMin >= olderThanMin) {
        candidates.push({ userId, refId, txId: rs.id, amount: Math.abs(rs.amount), ageMin: Math.round(ageMin) });
        open -= 1;
      }
    }
  }
}

const total = candidates.reduce((s, c) => s + c.amount, 0);
console.log(`账本：${file}`);
console.log(`悬空预扣候选（${olderThanMin} 分钟前、未被退费/结算收口）：${candidates.length} 笔，合计 ${total} 算力\n`);
for (const c of candidates) {
  console.log(`  ${c.userId}  ${c.refId}  ${c.amount} 算力  （${c.ageMin} 分钟前）  tx=${c.txId}`);
}

if (!candidates.length) {
  console.log("\n没有需要回收的悬空预扣。");
  process.exit(0);
}

if (!apply) {
  console.log("\n以上只是预览。确认无误后加 --apply 真正退回。");
  process.exit(0);
}

console.log("\n开始退回…");
let refunded = 0;
let done = 0;
for (const c of candidates) {
  const r = await credits.rollback(c.userId, c.refId, c.txId);
  if (r.refunded) {
    refunded += r.refunded;
    done += 1;
    console.log(`  ✓ ${c.userId} 退回 ${r.refunded}，余额 → ${r.balance}`);
  } else {
    console.log(`  · ${c.userId} 跳过（${r.skipped ? "已收口" : "未找到预扣"}）`);
  }
}
console.log(`\n完成：${done} 笔，退回 ${refunded} 算力。`);

for (const userId of new Set(candidates.map((c) => c.userId))) {
  console.log(`  ${userId} 当前余额：${credits.balance(userId)}`);
}
