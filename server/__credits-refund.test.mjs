/**
 * 算力退费：refId 复用不再吞掉退费 + 悬空预扣回收 + 重复提交不重复扣
 * --------------------------------------------------------------------------
 * 这是一次**真实事故**的回归测试（2026-10-16）：
 *
 * 用户截图显示 3 个失败任务（万相 Invalid API-key），账本里对应 3 笔 -10 预扣，
 * 但**一笔退费都没有** —— 余额 7950 → 7920，30 算力永久卡住。
 *
 * 根因：refId 是「请求内容签名」（同一提示词+参数 → 同一个 refId），
 * 而旧 rollback 的幂等判断是**按 refId 全局查重**：
 *     const already = rows.some(r => r.type === "rollback" && r.refId === refId);
 * 用户 10-04 跑过同样请求并退过费，于是 10-16 再失败时被判成"已退过"直接跳过。
 *
 * 同一个根因还坏了第二处：reserveAmount 用「历史上出现过 consume/rollback」判断
 * "这笔已了结"，导致"同请求重复提交不重复扣费"的复用逻辑永久失效。
 *
 * 第三个问题：进程被杀（关应用/崩溃）时 catch 里的 rollback 根本没机会跑，
 * 钱没人管 —— 所以补 recoverStale()，启动时回收陈年悬空预扣。
 *
 * 用临时 AI_CANVAS_HOME，绝不碰用户真实账本。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ai-canvas-credits-"));
process.env.AI_CANVAS_HOME = HOME;

const credits = await import("./credits.js");

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

const ACTION = "image.generate";
const REF = "sig-reused-abc"; // 同内容请求 → 同 refId（真实签名行为）
let seq = 0;
async function newUser(balance = 1000) {
  const id = `u-${++seq}`;
  await credits.grant(id, balance, "测试发放");
  return id;
}

console.log("\n[1] 幂等：同一笔预扣不会退两次");
{
  const u = await newUser();
  const r1 = await credits.reserveAmount(u, ACTION, REF, 10);
  check("预扣成功且带 txId", r1.reserved === true && Boolean(r1.txId), JSON.stringify(r1));
  const b1 = credits.balance(u);
  check("余额被扣掉 10", b1 === 990, String(b1));

  const rb1 = await credits.rollback(u, REF, r1.txId);
  const b2 = credits.balance(u);
  check("第一次退费生效", rb1.refunded === 10 && b2 === 1000, `refunded=${rb1.refunded} ${b1}→${b2}`);

  const rb2 = await credits.rollback(u, REF, r1.txId);
  const b3 = credits.balance(u);
  check("重复退费被跳过（不会多退钱）", rb2.skipped === true && b3 === b2, `skipped=${rb2.skipped} ${b2}→${b3}`);
}

console.log("\n[2] 真实事故场景：同 refId 隔天重试失败，必须退费");
{
  const u = await newUser();
  // 第一次：预扣 → 失败 → 退费（陈年旧账，10-04 那笔）
  const a1 = await credits.reserveAmount(u, ACTION, REF, 10);
  await credits.rollback(u, REF, a1.txId);
  const afterFirst = credits.balance(u);

  // 第二次：用户第二天重试同一个请求（refId 相同）→ 又失败 → 必须退费
  const a2 = await credits.reserveAmount(u, ACTION, REF, 10);
  const afterReserve = credits.balance(u);
  check("第二次预扣确实扣了钱（新的一次尝试该扣就扣）", a2.reserved === true && afterReserve === afterFirst - 10, `${afterFirst}→${afterReserve}`);

  const rb = await credits.rollback(u, REF, a2.txId);
  const afterRefund = credits.balance(u);
  check(
    "同 refId 的第二次失败**能退回**（旧代码在这里吞掉退费）",
    rb.refunded === 10 && afterRefund === afterFirst,
    `refunded=${rb.refunded} ${afterReserve}→${afterRefund}（期望回到 ${afterFirst}）`
  );

  const rows = credits.records(u, { limit: 100 });
  const reserves = rows.filter((r) => r.type === "reserve").length;
  const rollbacks = rows.filter((r) => r.type === "rollback").length;
  check("预扣与退费笔数配平", reserves === 2 && rollbacks === 2, `reserve=${reserves} rollback=${rollbacks}`);
  check(
    "退费记录带上了 reserveTxId（以后能精确配对）",
    rows.some((r) => r.type === "rollback" && r.reserveTxId),
    JSON.stringify(rows.filter((r) => r.type === "rollback").map((r) => r.reserveTxId))
  );
}

console.log("\n[3] 重复提交不重复扣（同一笔未收口的预扣要复用）");
{
  const u = await newUser();
  const first = await credits.reserveAmount(u, ACTION, "sig-dblclick", 10);
  const second = await credits.reserveAmount(u, ACTION, "sig-dblclick", 10);
  check("第一次真扣", first.reserved === true);
  check("第二次识别为重复并复用（不再扣钱）", second.duplicate === true && second.reserved === false, JSON.stringify(second));
  check("余额只被扣了一次", credits.balance(u) === 990, String(credits.balance(u)));
  check("复用的 txId 指向同一笔预扣", second.txId === first.txId, `${first.txId} vs ${second.txId}`);

  // 收口之后，再提交同样内容 = 一次**新的**生成，应该重新扣费
  await credits.commit(u, ACTION, "sig-dblclick");
  const third = await credits.reserveAmount(u, ACTION, "sig-dblclick", 10);
  check("已结算后再提交同样内容要重新扣费（这是新的一次生成）", third.reserved === true, JSON.stringify(third));
  check("余额第二次被扣", credits.balance(u) === 980, String(credits.balance(u)));
  await credits.rollback(u, "sig-dblclick", third.txId); // 收口，别把悬空账漏给下一节
}

console.log("\n[4] 悬空预扣回收（进程被杀的钱不会永久卡住）");
{
  const u = await newUser();
  await credits.reserveAmount(u, ACTION, "sig-killed-1", 10);
  await credits.reserveAmount(u, ACTION, "sig-killed-2", 10);
  const held = credits.balance(u);

  const fresh = await credits.recoverStale();
  check("刚发生的预扣不会被回收（正在跑的任务不能动）", fresh.count === 0 && credits.balance(u) === held, `count=${fresh.count}`);

  const later = await credits.recoverStale({ now: Date.now() + 2 * 60 * 60 * 1000 });
  const mine = later.refs.filter((x) => x.userId === u);
  check("超时未收口的预扣被回收", mine.length === 2 && later.refunded >= 20, JSON.stringify(mine));
  check("钱真的回到余额上", credits.balance(u) === held + 20, `${held}→${credits.balance(u)}`);
  check("回收记录写明退的是哪一笔预扣", mine.every((x) => x.reserveTxId), JSON.stringify(mine));

  const again = await credits.recoverStale({ now: Date.now() + 3 * 60 * 60 * 1000 });
  check("重复回收不会多退", again.count === 0, `count=${again.count}`);

  // 已成功结算的生成不能被当成悬空
  const u2 = await newUser();
  await credits.reserveAmount(u2, ACTION, "sig-done", 10);
  await credits.commit(u2, ACTION, "sig-done");
  const before = credits.balance(u2);
  const after = await credits.recoverStale({ now: Date.now() + 2 * 60 * 60 * 1000 });
  const touchedDone = after.refs.some((x) => x.refId === "sig-done");
  check("已成功结算的生成不会被误判成悬空", !touchedDone, `refs=${JSON.stringify(after.refs)}`);
  check("结算过的任务确实扣了钱（没被退）", credits.balance(u2) === before && before === 990, String(before));
}

console.log("\n[5] 账本一致性");
{
  const rec = credits.reconcile();
  check("账本对账通过（余额与流水一致）", rec.ok !== false, JSON.stringify(rec).slice(0, 160));
}

console.log(`\n退费与悬空回收：${pass} 项通过，${fail} 项失败\n`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
