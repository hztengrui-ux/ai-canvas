// 算力账本自测：验证预扣、回滚、去重、并发安全
// 运行：node server/__credits.test.mjs
import * as credits from "./credits.js";

const U = "test-user-" + Date.now();
let pass = 0;
let fail = 0;

function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

console.log("\n=== 算力账本自测 ===\n");

// 1) 初始为 0
check("初始余额为 0", credits.balance(U) === 0, `balance=${credits.balance(U)}`);

// 2) 赠送
await credits.grant(U, 1000, "测试充值");
check("充值 1000 后余额 1000", credits.balance(U) === 1000, `balance=${credits.balance(U)}`);

// 3) 预扣
const r1 = await credits.reserve(U, "image.generate", "task-1");
check("预扣成功", r1.ok === true, `cost=${r1.cost}`);
check("预扣后余额 990", credits.balance(U) === 990, `balance=${credits.balance(U)}`);

// 4) 提交（成功出图）
await credits.commit(U, "image.generate", "task-1");
check("提交后余额不变 990", credits.balance(U) === 990, `balance=${credits.balance(U)}`);

// 5) 回滚（失败退款）
const r2 = await credits.reserve(U, "video.generate", "task-2");
check("视频预扣 120", r2.ok === true && credits.balance(U) === 870, `balance=${credits.balance(U)}`);
const rb = await credits.rollback(U, "task-2");
check("回滚成功", rb.ok === true, `refunded=${rb.refunded}`);
check("回滚后余额回到 990", credits.balance(U) === 990, `balance=${credits.balance(U)}`);

// 6) 重复回滚必须被拒（防刷）
const rb2 = await credits.rollback(U, "task-2");
check("重复回滚被去重", rb2.skipped === true, `skipped=${rb2.skipped}`);
check("余额未被二次退回", credits.balance(U) === 990, `balance=${credits.balance(U)}`);

// 7) 余额不足应拒绝
const r3 = await credits.reserve(U, "video.generate", "task-3");
for (let i = 0; i < 8; i++) await credits.reserve(U, "video.generate", `drain-${i}`);
const poor = await credits.reserve(U, "video.generate", "task-poor");
check("余额不足被拒绝", poor.ok === false && poor.code === "INSUFFICIENT_CREDITS",
  `balance=${poor.balance} need=${poor.need}`);

// 8) 并发安全：同时发起 20 次预扣，不能超扣
const U2 = "concurrent-" + Date.now();
await credits.grant(U2, 100, "并发测试");
const tasks = Array.from({ length: 20 }, (_, i) => credits.reserve(U2, "image.generate", `c-${i}`));
const results = await Promise.all(tasks);
const okCount = results.filter((r) => r.ok).length;
check("并发 20 次、余额 100、单价 10 → 只成功 10 次",
  okCount === 10, `成功 ${okCount} 次, 余额 ${credits.balance(U2)}`);
check("并发后余额正好为 0", credits.balance(U2) === 0, `balance=${credits.balance(U2)}`);

// 9) 对账
const rec = credits.reconcile();
check("对账一致（余额 == 流水求和）", rec.ok === true,
  rec.ok ? "" : JSON.stringify(rec.mismatched));

// 10) 流水可追溯
const rows = credits.records(U, { limit: 100 });
check("流水可查", rows.length > 0, `${rows.length} 条`);
check("流水倒序（最新在前）", rows[0].ts >= rows[rows.length - 1].ts);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
