// 对抗性复验 V3：账本幂等键（refId）与 2000 条裁剪
// 直接以模块身份调用 credits.js（与 index.js 路由同一份代码），隔离到 .verifydata/v3
//
// 运行：& "...\node.exe" E:\DSH项目\ai-canvas\reports\verify\v3-ledger.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(ROOT, ".verifydata", "v3");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
// 必须在 import credits.js 之前设置（paths.js 在模块求值时读取）
process.env.AI_CANVAS_HOME = DIR;
process.env.AI_CANVAS_OUTPUTS = path.join(DIR, "outputs");
process.env.AI_CANVAS_VAULT = "file";

const credits = await import(pathToFileURL(path.join(ROOT, "server", "credits.js")).href);

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`); }
}
const rowsOf = (u) => credits.records(u, { limit: 500 }).reverse();
const dump = (u) => rowsOf(u).map((r) => `${r.type}(${r.amount >= 0 ? "+" : ""}${r.amount})`).join(" → ");

console.log("\n=== V3-A：同一 refId「失败两次」是否第二次永不退款 ===");
console.log(`  隔离目录：${DIR}`);
const U = "userA";
const REF = "usig_v2_" + "a".repeat(32);
await credits.grant(U, 100, "复验种子充值");
const b0 = credits.balance(U);

// 复刻 index.js:581-590 的判定顺序
const attempt = async (label) => {
  const replay = credits.findConsumed(U, REF);            // index.js:581
  const reserved = replay
    ? { ok: true, cost: 0, reserved: false, replay: true }
    : await credits.reserve(U, "image.generate", REF);    // index.js:587
  const afterReserve = credits.balance(U);
  const rb = reserved.reserved ? await credits.rollback(U, REF) : { refunded: 0 }; // index.js:676
  const afterRollback = credits.balance(U);
  console.log(`  ${label}: replay=${Boolean(replay)} 预扣=${reserved.ok ? reserved.cost : "拒绝"} ` +
    `reserve后余额=${afterReserve} rollback.refunded=${rb.refunded} (skipped=${Boolean(rb.skipped)}) 回滚后余额=${afterRollback}`);
  return { replay, reserved, rb, afterReserve, afterRollback };
};

const first = await attempt("第 1 次失败");
const second = await attempt("第 2 次失败");
const third = await attempt("第 3 次失败");
console.log(`  流水：${dump(U)}`);

check("起始余额 100", b0 === 100, `balance=${b0}`);
check("第 1 次预扣正常（-10）", first.afterReserve === 90);
check("第 1 次失败全额退回（100）", first.rb.refunded === 10 && first.afterRollback === 100,
  `refunded=${first.rb.refunded} balance=${first.afterRollback}`);
check("【缺陷】第 2 次确实重新预扣了 10 点（findConsumed 为 null，非 replay）",
  second.replay === null && second.reserved.reserved === true && second.afterReserve === 90,
  `replay=${second.replay} reserved=${second.reserved.reserved}`);
check("【缺陷】第 2 次失败的回滚被 skipped → refunded 为 undefined，前端收到 refunded:0",
  second.rb.skipped === true && second.rb.refunded === undefined,
  `rollback → ${JSON.stringify(second.rb)}`);
check("【缺陷】第 2 次失败后余额永久停在 90（用户白丢 10 点）",
  second.afterRollback === 90, `balance=${second.afterRollback}`);
check("【缺陷】第 3 次同样再扣一次且再次不退款（每失败一次丢 10 点）",
  third.afterReserve === 80 && third.afterRollback === 80, `balance=${third.afterRollback}`);

// 对照：换一个 refId 就正常退回 —— 证明问题确实出在「幂等键 = refId」
const REF2 = "usig_v2_" + "b".repeat(32);
const r2 = await credits.reserve(U, "image.generate", REF2);
const rb2 = await credits.rollback(U, REF2);
check("对照：不同 refId 的失败能正常退回（证明缺陷根因是 refId 幂等键）",
  r2.reserved === true && rb2.refunded === 10, `refunded=${rb2.refunded} balance=${credits.balance(U)}`);

console.log("\n=== V3-B：单用户流水超 2000 条裁剪后的账本一致性 ===");
const V = "userB";
const N = 2100;
for (let i = 0; i < N; i++) await credits.grant(V, 1, `批量充值 ${i}`);
// 直接读原始账本文件，避免 records() 的 limit 截断干扰统计
const raw = JSON.parse(fs.readFileSync(path.join(DIR, "credits-ledger.json"), "utf8"));
const rawRows = raw.records[V] || [];
const kept = rawRows.length;
const sum = rawRows.reduce((s, r) => s + r.amount, 0);
const lastAfter = rawRows[rawRows.length - 1]?.balanceAfter;
const bal = credits.balance(V);
const rec = credits.reconcile();
const mine = rec.mismatched.find((m) => m.userId === V);
console.log(`  累计 grant ${N} 笔 × 1 点 → 用户应持有 ${N} 点`);
console.log(`  裁剪后保留条数=${kept}  剩余流水求和=${sum}  balance()=${bal}  最后一条.balanceAfter=${lastAfter}`);
check("裁剪确实发生（原始文件只保留 2000 条）", kept === 2000, `kept=${kept}`);
check("【缺陷】用户实际余额比累计充值少 100 点（2100 → 2000，被裁记录凭空消失）", bal === 2000, `balance=${bal}`);
check("【缺陷】reconcile() 报不一致：最后一条 balanceAfter(2001) ≠ 流水求和(2000)",
  rec.ok === false && Boolean(mine) && mine.recorded === 2001 && mine.sum === 2000,
  JSON.stringify(rec.mismatched.slice(0, 3)));
check("关键区分：balance() 仍恒等于『剩余流水求和』（该式按剩余窗口自洽，坏掉的是账目本身）",
  sum === bal && lastAfter !== sum, `sum=${sum} balance=${bal} lastAfter=${lastAfter}`);

console.log(`\n  V3 汇总：断言通过 ${pass} / 不符 ${fail}`);
console.log(fail === 0
  ? "  → 全部断言成立 ⇒ 报告的 V3(R3 + R4) 被实测坐实\n"
  : "  → 有断言不符 ⇒ 该条结论至少部分不成立，见上方 ❌\n");
process.exit(0);
