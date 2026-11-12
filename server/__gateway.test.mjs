/**
 * 模型网关自测（Sprint 1）
 * --------------------------------------------------------------------------
 * 这套测试要钉死四件事，每一件错了都会直接造成资损或界面骗人：
 *   1. 注册表完整性：id 唯一、provider 必须在 PROVIDERS 里、字段类型正确
 *   2. **跨端一致性**：服务端注册表与前端 src/store.js 的 IMAGE_MODELS 不重不漏，
 *      且注册表单价与前端显示的 COST_PER_GENERATION 一致 ——
 *      这两处一旦漂移，就会出现「界面写 10、实际扣 20」这种最伤信任的问题
 *   3. 路由与宽松路径：把 model 交给网关就能定 provider；未注册模型放行但留痕
 *      （历史调用会传 wanx2.1-t2i-turbo 这类后端原始模型名，严格拒绝会打死现网）
 *   4. 额度三段式：reserveAmount 的幂等 / 余额不足 / 只回滚一次，以及 commit 落 consume
 *
 * 纯逻辑测试 + 临时数据目录，不起服务端。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-test-"));
process.env.AI_CANVAS_HOME = HOME;
process.env.AI_CANVAS_VAULT = "file";

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

const registry = await import("./models/registry.js");
const gateway = await import("./gateway.js");
const credits = await import("./credits.js");
const store = await import("../src/store.js");

// 与 server/index.js 的 PROVIDERS 对齐（这里是注册表的合法 provider 集合）
const KNOWN_PROVIDERS = new Set(["wanxiang", "jiemeng", "openai", "gemini", "comfyui"]);

console.log("\n[1] 注册表完整性");
{
  const ids = registry.MODELS.map((m) => m.id);
  check("id 唯一", new Set(ids).size === ids.length, ids.join(","));
  check("每条都有 provider", registry.MODELS.every((m) => KNOWN_PROVIDERS.has(m.provider)));
  check("每条 kind 合法", registry.MODELS.every((m) => ["image", "video"].includes(m.kind)));
  check(
    "modes 是非空数组",
    registry.MODELS.every((m) => Array.isArray(m.modes) && m.modes.length > 0)
  );
  check(
    "sizes 是数组（[] = 不限具体尺寸）",
    registry.MODELS.every((m) => Array.isArray(m.sizes))
  );
  check(
    "maxCount / maxRefImages 是 >=0 的数字",
    registry.MODELS.every((m) => Number.isFinite(m.maxCount) && m.maxCount >= 0 && Number.isFinite(m.maxRefImages) && m.maxRefImages >= 0)
  );
  check("getModel 能取到已知模型", registry.getModel("gpt-image-2")?.provider === "openai");
  check("getModel 对未知模型返回 null（不抛）", registry.getModel("no-such-model") === null);
}

console.log("\n[2] 跨端一致性：服务端注册表 ↔ 前端模型清单");
{
  const serverImageIds = registry.listModels({ kind: "image" }).map((m) => m.id);
  const frontIds = store.IMAGE_MODELS.map((m) => m.id);

  const missing = frontIds.filter((id) => !serverImageIds.includes(id));
  const extra = serverImageIds.filter((id) => !frontIds.includes(id));
  // 2026-10-23：通义万相 / 本地 ComfyUI 已从界面下线，但注册表里保留（hidden）。
  // 所以"服务端多出来"的只允许是 hidden 的那几个，别的仍然算不一致。
  const hiddenIds = registry.MODELS.filter((m) => m.hidden).map((m) => m.id);
  const extraVisible = extra.filter((id) => !hiddenIds.includes(id));
  check("前端每个模型服务端都认识（不漏）", missing.length === 0, `缺：${missing.join(",")}`);
  check(
    "服务端没有前端不认识的图片模型（hidden 除外）",
    extraVisible.length === 0,
    `多：${extraVisible.join(",")}`
  );
  check("hidden 的模型确实不在前端清单里", hiddenIds.every((id) => !frontIds.includes(id)), hiddenIds.join(","));

  const tabMismatch = store.IMAGE_MODELS.filter((m) => {
    const s = registry.getModel(m.id);
    return s && s.tab !== store.providerOf(m.id);
  });
  check("供应商分栏与服务端 tab 一致", tabMismatch.length === 0, tabMismatch.map((m) => m.id).join(","));

  const groupMismatch = store.IMAGE_MODELS.filter((m) => {
    const s = registry.getModel(m.id);
    return s && s.group !== m.group;
  });
  check("计费口径 group 一致", groupMismatch.length === 0, groupMismatch.map((m) => m.id).join(","));

  const costMismatch = registry
    .listModels({ kind: "image" })
    .filter((m) => m.effectiveCost !== store.COST_PER_GENERATION);
  check(
    "图片模型单价 == 前端显示价（界面不许骗人）",
    costMismatch.length === 0,
    costMismatch.map((m) => `${m.id}=${m.effectiveCost}`).join(",")
  );

  const base = credits.COST_TABLE["image.generate"].cost;
  check(
    "注册表单价回落计入费表基价",
    registry.modelCost(registry.getModel("comfyui")) === base,
    `base=${base}`
  );

  const videoBase = credits.COST_TABLE["video.generate"].cost;
  check(
    "视频模型单价 == 视频计费表基价",
    registry.modelCost(registry.getModel("wanx2.1-t2v-turbo")) === videoBase,
    `got ${registry.modelCost(registry.getModel("wanx2.1-t2v-turbo"))}`
  );
}

console.log("\n[3] 路由：由 model_id 决定 provider");
{
  const byModel = gateway.planGenerate({ provider: "", model: "gpt-image-2", size: "1024x1024", n: 1 });
  check("只给 model 也能定 provider（openai）", byModel.provider === "openai", byModel.provider);

  const banana = gateway.planGenerate({ provider: "", model: "nano-banana-pro", size: "1024x1024", n: 1 });
  check("Nano Banana → gemini", banana.provider === "gemini", banana.provider);

  const mismatch = gateway.planGenerate({ provider: "openai", model: "comfyui", size: "1024x1024", n: 1 });
  check(
    "provider 与注册表冲突时留痕（不静默）",
    mismatch.diagnostics.some((d) => d.includes("不一致")),
    mismatch.diagnostics.join("|")
  );

  const defaulted = gateway.planGenerate({ provider: "jiemeng", model: "", size: "1024x1024", n: 1 });
  check(
    "未带 model → 用该 provider 默认模型并留痕",
    defaulted.model?.id === "jiemeng" && defaulted.diagnostics.some((d) => d.includes("默认模型")),
    JSON.stringify({ model: defaulted.model?.id, diag: defaulted.diagnostics })
  );
}

console.log("\n[4] 未注册模型：宽松放行 + 基价 + 留痕");
{
  const legacy = gateway.planGenerate({ provider: "wanxiang", model: "wanx2.1-t2i-turbo", size: "1024x1024", n: 4 });
  check("历史模型名不被拒（否则打死现网）", legacy.ok === true, JSON.stringify(legacy));
  check("标记为未注册", legacy.registered === false);
  check("按基价计费（与改造前一致）", legacy.cost === credits.COST_TABLE["image.generate"].cost, `cost=${legacy.cost}`);
  check("有 diagnostic 说明原因", legacy.diagnostics.some((d) => d.includes("未注册")), legacy.diagnostics.join("|"));

  const noModel = gateway.planGenerate({ provider: "comfyui", model: "", size: "1024x1024", n: 1 });
  check("未注册 provider + 无模型也不崩", noModel.ok === true && typeof noModel.cost === "number");
}

console.log("\n[5] 能力校验：结构化错误码");
{
  const badSize = gateway.planGenerate({ provider: "wanxiang", model: "wanxiang", size: "abc", n: 1 });
  check("尺寸不合法 → INVALID_SIZE", badSize.ok === false && badSize.code === "INVALID_SIZE", badSize.code);

  const zero = gateway.planGenerate({ provider: "wanxiang", model: "wanxiang", size: "0x0", n: 1 });
  check("0x0 → INVALID_SIZE", zero.ok === false && zero.code === "INVALID_SIZE");

  const tooBig = gateway.planGenerate({ provider: "wanxiang", model: "wanxiang", size: "99999x99999", n: 1 });
  check("超上限尺寸 → INVALID_SIZE", tooBig.ok === false && tooBig.code === "INVALID_SIZE");

  const refs = gateway.planGenerate({
    provider: "wanxiang",
    model: "wanxiang",
    size: "1024x1024",
    n: 1,
    referenceImages: new Array(4).fill({ url: "/materials/x.png" })
  });
  check("参考图超上限 → TOO_MANY_REFERENCES", refs.ok === false && refs.code === "TOO_MANY_REFERENCES", refs.code);

  const count = gateway.planGenerate({ provider: "gemini", model: "nano-banana-pro", size: "1024x1024", n: 99 });
  check("张数超上限 → COUNT_TOO_LARGE", count.ok === false && count.code === "COUNT_TOO_LARGE", count.code);

  const mode = gateway.planGenerate({
    provider: "wanxiang",
    model: "wanx2.1-t2v-turbo",
    kind: "image",
    size: "1024x1024",
    n: 1
  });
  check("视频模型当图片用 → MODEL_KIND_MISMATCH", mode.ok === false && mode.code === "MODEL_KIND_MISMATCH", mode.code);

  // 尺寸白名单机制：临时给注册表某条加白名单，验证 SIZE_NOT_ALLOWED 真的会触发
  const target = registry.getModel("comfyui");
  const saved = target.sizes;
  target.sizes = ["512x512"];
  const whitelist = gateway.planGenerate({ provider: "comfyui", model: "comfyui", size: "1024x1024", n: 1 });
  target.sizes = saved;
  check("模型尺寸白名单生效 → SIZE_NOT_ALLOWED", whitelist.ok === false && whitelist.code === "SIZE_NOT_ALLOWED", whitelist.code);
  const back = gateway.planGenerate({ provider: "comfyui", model: "comfyui", size: "1024x1024", n: 1 });
  check("白名单还原后重新放行（机制可逆）", back.ok === true);
}

console.log("\n[6] 额度三段式（reserveAmount）");
{
  const U = "gw-user";
  await credits.grant(U, 100, "测试充值");
  check("初始余额 100", credits.balance(U) === 100, `balance=${credits.balance(U)}`);

  const plan = gateway.planGenerate({ provider: "gemini", model: "nano-banana-pro", size: "1024x1024", n: 1 });
  const ref = "usig_test_ref_1";

  const r1 = await gateway.reserveFor(U, plan, ref);
  check("预扣成功且金额 = 模型单价", r1.ok === true && r1.cost === plan.cost && r1.reserved === true, JSON.stringify(r1));
  check("余额减少到 90", credits.balance(U) === 90, `balance=${credits.balance(U)}`);

  const r2 = await gateway.reserveFor(U, plan, ref);
  check("同 refId 重复预扣 → 幂等不重复扣", r2.duplicate === true && credits.balance(U) === 90, `balance=${credits.balance(U)}`);

  await gateway.commitFor(U, plan, ref);
  check("提交后账本留下 consume 记录", Boolean(credits.findConsumed(U, ref)));
  check("提交不再改动余额", credits.balance(U) === 90, `balance=${credits.balance(U)}`);

  const ref2 = "usig_test_ref_2";
  const r3 = await gateway.reserveFor(U, plan, ref2);
  const rb1 = await gateway.rollbackFor(U, plan, ref2, r3.txId);
  check("失败回滚成功", rb1.ok === true && rb1.refunded === plan.cost, JSON.stringify(rb1));
  check("回滚后余额还原", credits.balance(U) === 90, `balance=${credits.balance(U)}`);
  const rb2 = await gateway.rollbackFor(U, plan, ref2, r3.txId);
  check("同一笔只能回滚一次（防刷算力）", rb2.skipped === true, JSON.stringify(rb2));
  check("重复回滚没有多退钱", credits.balance(U) === 90, `balance=${credits.balance(U)}`);

  const poor = "gw-poor";
  await credits.grant(poor, 5, "测试充值");
  const denied = await gateway.reserveFor(poor, plan, "usig_poor_1");
  check("余额不足被拒", denied.ok === false && denied.code === "INSUFFICIENT_CREDITS", JSON.stringify(denied));
  check("被拒时余额不变", credits.balance(poor) === 5, `balance=${credits.balance(poor)}`);

  const q = gateway.quota(U, { provider: "gemini", model: "nano-banana-pro" });
  check("额度概览：次数 = 余额 / 单价", q.remainingRuns === Math.floor(q.balance / q.unitCost), JSON.stringify(q));
}

console.log("\n[7] 目录下发（/api/models 的载荷）");
{
  const cat = gateway.catalog();
  check("含全部可见注册模型（hidden 不下发）", cat.models.length === registry.visibleModels().length, `${cat.models.length}/${registry.visibleModels().length}`);
  check("每条都带单价与密钥状态", cat.models.every((m) => Number.isFinite(m.cost) && typeof m.hasKey === "boolean"));
  // ComfyUI 已 hidden、不对外下发；这里改为验证"下发列表里没有 hidden 模型"\n  check("下发列表不含 hidden 模型", !cat.models.some((m) => registry.MODELS.find((r) => r.id === m.id)?.hidden));
  check("图片基价 == 计费表基价", cat.baseCost === credits.COST_TABLE["image.generate"].cost, `baseCost=${cat.baseCost}`);
  check("动作映射含视频", cat.actions.video === "video.generate", JSON.stringify(cat.actions));
}

try {
  fs.rmSync(HOME, { recursive: true, force: true });
} catch {
  /* Windows 上可能有句柄占用，忽略 */
}

console.log(`\n模型网关：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
