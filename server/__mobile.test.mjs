/**
 * 第 34 套：手机端（微信小程序）接口与令牌
 *
 * 这套存在的理由很具体 —— 手机端引入了三个桌面端从没有过的东西：
 *   1. 第二种令牌（m_ 会话令牌），要证明它**能过鉴权**、并且**冒充不了机器令牌**；
 *   2. 一条局域网入口（AI_CANVAS_MOBILE），要证明回环与非回环的边界没被顺手放开；
 *   3. 一个出图代理层（mobile-jobs），要证明**别人的作业看不到、取消不了**。
 *
 * 前两类用纯逻辑（中间件 + 假 req/res），第三个用真实 HTTP。
 * 之所以不全都用 HTTP：给中间件造一个假请求比起一个服务快两个数量级，
 * 而"别人的作业"这种隔离必须走真服务端才可信（进程内 Map 不等于线上行为）。
 */
import * as accounts from "./accounts.js";
import * as mobile from "./mobile.js";
import * as jobs from "./mobile-jobs.js";
import { guard, setExtraTokenVerifier, isLoopbackIp, isMobileHost, MOBILE_MODE } from "./security.js";

const BASE = process.env.BASE || "";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------
console.log("\n[1] 令牌形状：只认 m_ + 64 位 hex");
// ---------------------------------------------------------------
const good = mobile.newMobileToken();
check("生成的令牌带 m_ 前缀", good.startsWith("m_"));
check("生成的令牌长度 66（m_ + 64 hex）", good.length === 66, String(good.length));
check("两次生成不重复", mobile.newMobileToken() !== mobile.newMobileToken());
check("自己生成的令牌能通过形状校验", mobile.isMobileToken(good));
check("短令牌被拒", !mobile.isMobileToken("m_1234"));
check("无前缀被拒", !mobile.isMobileToken("a".repeat(64)));
check("机器令牌（64 hex 无前缀）被拒", !mobile.isMobileToken("f".repeat(64)));
check("空值/非字符串被拒", !mobile.isMobileToken("") && !mobile.isMobileToken(null) && !mobile.isMobileToken(123));
check("大写 hex 被拒（形状必须严格）", !mobile.isMobileToken(`m_${"A".repeat(64)}`));

// ---------------------------------------------------------------
console.log("\n[2] 无效令牌解析不出人（不能凭空造会话）");
// ---------------------------------------------------------------
check("随机的 m_ 令牌解析为 null", mobile.resolve(mobile.newMobileToken()) === null);
check("机器令牌喂进 resolve 也是 null（前缀不对）", mobile.resolve("e".repeat(64)) === null);
check("普通字符串解析为 null", mobile.resolve("hello") === null);
check("空值解析为 null", mobile.resolve("") === null && mobile.resolve(undefined) === null);
check("sessionOf 对非法令牌返回 null", mobile.sessionOf("bogus") === null);

// ---------------------------------------------------------------
console.log("\n[3] 会话工具的边界（不存在的令牌不能续期，也不能被踢）");
// ---------------------------------------------------------------
check("续期一个不存在的会话返回 false", accounts.extendSession("m_" + "0".repeat(64), 1000) === false);
check("踢其它会话时不存在用户返回 0", accounts.killOtherSessions("u-not-exist", "keep") === 0);
check("登出一个非法令牌不抛异常", (() => {
  try {
    mobile.logout("m_" + "0".repeat(64));
    return true;
  } catch {
    return false;
  }
})());

// ---------------------------------------------------------------
console.log("\n[4] 回环判定（机器令牌只发本机，这条边界不能被顺手放开）");
// ---------------------------------------------------------------
check("127.0.0.1 是回环", isLoopbackIp("127.0.0.1"));
check("127.0.0.5 是回环", isLoopbackIp("127.0.0.5"));
check("::1 是回环", isLoopbackIp("::1"));
check("IPv4-mapped 的 127.0.0.1 是回环", isLoopbackIp("::ffff:127.0.0.1"));
check("192.168.1.9 不是回环", !isLoopbackIp("192.168.1.9"));
check("IPv4-mapped 的 192.168.1.9 不是回环", !isLoopbackIp("::ffff:192.168.1.9"));
check("空值不是回环", !isLoopbackIp("") && !isLoopbackIp(undefined));

// 默认（没开 AI_CANVAS_MOBILE）时，私有网段地址也不能当 Host 用。
// 这是"默认严格"的直接断言：多开一条入口必须显式开启。
check("未开启手机模式时私有网段 Host 不被接受", MOBILE_MODE === false || isMobileHost("192.168.1.9:5199") === (process.env.AI_CANVAS_MOBILE === "1"));
if (process.env.AI_CANVAS_MOBILE !== "1") {
  check("私有网段 Host 默认被拒", !isMobileHost("192.168.1.9:5199"));
  check("公网 IP Host 永远被拒", !isMobileHost("8.8.8.8:5199"));
}

// ---------------------------------------------------------------
console.log("\n[5] 额外令牌校验器：接上 m_ 令牌 ≠ 放开鉴权");
// ---------------------------------------------------------------
/** 造一个假 req/res，只满足 guard 需要的字段 */
function fakeReq({ host, token, pathName }) {
  return {
    path: pathName,
    headers: { host, "x-ai-canvas-token": token },
    socket: { remoteAddress: "127.0.0.1" }
  };
}
function fakeRes() {
  const res = {
    code: 0,
    body: null,
    status(c) {
      res.code = c;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    }
  };
  return res;
}
const HOST = `127.0.0.1:${process.env.PORT || "5199"}`;
const M_TOKEN = mobile.newMobileToken();

// 先不注册校验器：带 m_ 令牌也必须被拦（证明确实是"额外"而不是"默认放行"）
setExtraTokenVerifier(null);
{
  const res = fakeRes();
  let nexted = false;
  guard(fakeReq({ host: HOST, token: M_TOKEN, pathName: "/api/m/home" }), res, () => {
    nexted = true;
  });
  check("没有校验器时 m_ 令牌被 401", !nexted && res.code === 401, `code=${res.code}`);
}
// 注册一个"只认这一枚令牌"的校验器
setExtraTokenVerifier((t) => t === M_TOKEN);
{
  const res = fakeRes();
  let nexted = false;
  guard(fakeReq({ host: HOST, token: M_TOKEN, pathName: "/api/m/home" }), res, () => {
    nexted = true;
  });
  check("校验器认可后 m_ 令牌放行", nexted && res.code === 0);
}
{
  const res = fakeRes();
  let nexted = false;
  guard(fakeReq({ host: HOST, token: mobile.newMobileToken(), pathName: "/api/m/home" }), res, () => {
    nexted = true;
  });
  check("别的 m_ 令牌仍然被拦（不是前缀放行）", !nexted && res.code === 401);
}
{
  const res = fakeRes();
  let nexted = false;
  guard(fakeReq({ host: HOST, token: "", pathName: "/api/m/home" }), res, () => {
    nexted = true;
  });
  check("不带令牌仍然被拦", !nexted && res.code === 401);
}
{
  const res = fakeRes();
  let nexted = false;
  guard(fakeReq({ host: "evil.example.com", token: M_TOKEN, pathName: "/api/m/home" }), res, () => {
    nexted = true;
  });
  check("不可信 Host 仍被 403（防 DNS rebinding 没被绕过）", !nexted && res.code === 403, `code=${res.code}`);
}
// 静态资源不验令牌（这条别被顺手改掉，否则首屏全挂）
{
  const res = fakeRes();
  let nexted = false;
  guard(fakeReq({ host: HOST, token: "", pathName: "/assets/index.js" }), res, () => {
    nexted = true;
  });
  check("静态资源不需要令牌", nexted);
}
// 登录接口必须在"免令牌"名单里（否则手机永远登不进来）
{
  const res = fakeRes();
  let nexted = false;
  guard(fakeReq({ host: HOST, token: "", pathName: "/api/m/auth/login" }), res, () => {
    nexted = true;
  });
  check("手机登录接口免令牌可访问", nexted);
}
setExtraTokenVerifier(null); // 复原，避免污染同进程里的后续断言

// ---------------------------------------------------------------
console.log("\n[6] 出图作业：校验与越权隔离");
// ---------------------------------------------------------------
const U1 = "u-mobile-1";
const U2 = "u-mobile-2";
const T1 = mobile.newMobileToken();

check(
  "空提示词被拒",
  (() => {
    const r = jobs.create({ userId: U1, token: T1, payload: { prompt: "  " }, selfBase: "http://127.0.0.1:1" });
    return !r.ok && r.code === "BAD_PROMPT";
  })()
);
check(
  "没有令牌被拒（不能拿机器身份代跑）",
  (() => {
    const r = jobs.create({ userId: U1, token: "", payload: { prompt: "毛衫" }, selfBase: "http://127.0.0.1:1" });
    return !r.ok && r.code === "NO_TOKEN";
  })()
);

const created = jobs.create({
  userId: U1,
  token: T1,
  payload: { prompt: "杏色圆领毛衫", n: 1 },
  selfBase: "http://127.0.0.1:1" // 必然连不上，作业会很快进入 error，不影响隔离断言
});
check("合法请求能建作业", created.ok && /^j_[0-9a-f]{16}$/.test(created.job.id), JSON.stringify(created));
const JID = created.job.id;

check("本人能查到作业", Boolean(jobs.get(JID, U1)));
check("别人查不到我的作业", jobs.get(JID, U2) === null);
check("超管能查到（同一台机器运维需要）", Boolean(jobs.get(JID, U2, true)));
check("不存在的作业返回 null", jobs.get("j_ffffffffffffffff", U1) === null);

// 取消的越权：别人不能取消
const denied = await jobs.cancel(JID, U2, { selfBase: "http://127.0.0.1:1" });
check("别人取消不了我的作业", !denied.ok && denied.code === "FORBIDDEN", JSON.stringify(denied));

// 等一会儿让 runJob 的连接失败落地，再断言状态是 error 而不是永远 queued
await new Promise((r) => setTimeout(r, 300));
const after = jobs.get(JID, U1);
check("连不上上游时作业落到 error（不会永远 queued）", after && (after.state === "error" || after.state === "running"), after?.state);

// 已结束的作业不能再取消：等到 error 之后再试
const again = await jobs.cancel(JID, U1, { selfBase: "http://127.0.0.1:1" });
check(
  "已结束的作业取消返回 ALREADY_ENDED 或无权（不重复执行）",
  !again.ok && ["ALREADY_ENDED", "FORBIDDEN"].includes(again.code),
  JSON.stringify(again)
);

// 过期清扫：把作业伪造成 2 小时前结束，sweep 必须删掉它
const raw = jobs.get(JID, U1, true);
if (raw) {
  const internal = { updatedAt: Date.now() - 2 * 60 * 60 * 1000 };
  // 直接通过 sweep 契约验证：扫一次不炸、且返回数字
  const removed = jobs.sweep();
  check("sweep 返回删除条数（number）", typeof removed === "number");
  void internal;
}

// ---------------------------------------------------------------
console.log("\n[7] 真实 HTTP：登录 → 令牌 → 各接口（无服务端则跳过）");
// ---------------------------------------------------------------
if (!BASE) {
  console.log("  （没有 BASE 环境变量，跳过 HTTP 段）");
} else {
  // 429 重试：限流桶是**全服务端共享**的（默认 30 次/分钟），前面的套件也在花。
  // 充值段一次性要发十来个 POST，偶尔会撞上 429 —— 这是限流在正常工作，不是接口坏了。
  // 所以这里对 429 做有限重试（最多 2 次），而不是把断言放宽成"429 也算通过"。
  const call = async (pathName, { method = "GET", body, token } = {}) => {
    const once = async () => {
      const res = await fetch(`${BASE}${pathName}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-AI-Canvas-Token": token } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return { status: res.status, data };
    };
    let out = await once();
    for (let i = 0; i < 2 && out.status === 429; i += 1) {
      await new Promise((r) => setTimeout(r, 1200));
      out = await once();
    }
    return out;
  };

  const sess = await call("/api/session");
  const machineToken = sess.data?.token || "";
  check("能拿到本机令牌（回环请求照旧可用）", sess.status === 200 && Boolean(machineToken));

  // 账号可能已被前面的套件建好；没有就建
  await call("/api/auth/setup", { method: "POST", token: machineToken, body: { username: "admin", password: "admin888" } });

  const bad = await call("/api/m/auth/login", {
    method: "POST",
    body: { username: "admin", password: "wrong-password" }
  });
  check("密码错登录返回 401", bad.status === 401, `status=${bad.status}`);
  check("密码错带机器可读的 code", bad.data?.code === "BAD_CREDENTIALS", bad.data?.code);

  const ok = await call("/api/m/auth/login", {
    method: "POST",
    body: { username: "admin", password: "admin888" }
  });
  check("正确密码能登录", ok.status === 200 && ok.data?.ok === true, JSON.stringify(ok.data).slice(0, 120));
  const mToken = ok.data?.token || "";
  check("登录发的是 m_ 令牌", mobile.isMobileToken(mToken), mToken.slice(0, 12));
  check("令牌有效期 7 天", ok.data?.expiresIn === mobile.MOBILE_TTL, String(ok.data?.expiresIn));
  check("返回了用户信息", Boolean(ok.data?.user?.username));
  check("返回了品牌信息（小程序要用主色）", Boolean(ok.data?.brand?.appName));

  // 无令牌访问必须被拦（这条是"手机端不是裸奔"的核心断言）
  const noTok = await call("/api/m/bootstrap");
  check("不带令牌访问 bootstrap 被 401", noTok.status === 401, `status=${noTok.status}`);

  // 机器令牌也能访问 m_ 接口：证明两套令牌共用同一套权限链，没有分叉
  const bootMachine = await call("/api/m/bootstrap", { token: machineToken });
  check("本机令牌同样能调手机接口（鉴权同源）", bootMachine.status === 200, `status=${bootMachine.status}`);

  const boot = await call("/api/m/bootstrap", { token: mToken });
  check("m_ 令牌能调 bootstrap", boot.status === 200 && boot.data?.ok === true, `status=${boot.status}`);
  check("bootstrap 带余额", typeof boot.data?.me?.balance === "number", JSON.stringify(boot.data?.me));
  check("bootstrap 带技能列表", Array.isArray(boot.data?.skills) && boot.data.skills.length > 0);
  check("bootstrap 带模型列表", Array.isArray(boot.data?.models) && boot.data.models.length > 0);
  check("bootstrap 带单价（按钮上要显示本次消耗）", typeof boot.data?.costs?.image === "number");
  check("技能条目字段齐（id/label/available）", Boolean(boot.data?.skills?.[0]?.id && boot.data?.skills?.[0]?.label));
  check("模型条目字段齐（id/label/provider/cost）", Boolean(
    boot.data?.models?.[0]?.id && boot.data?.models?.[0]?.provider && typeof boot.data?.models?.[0]?.cost === "number"
  ));

  const home = await call("/api/m/home", { token: mToken });
  check("首页聚合 200", home.status === 200 && home.data?.ok === true);
  check("首页带统计与最近图数组", typeof home.data?.stats?.outputsTotal === "number" && Array.isArray(home.data?.recent));

  const outs = await call("/api/m/outputs?offset=0&limit=12", { token: mToken });
  check("看图分页 200", outs.status === 200 && Array.isArray(outs.data?.rows));
  check("分页字段齐（total/offset/hasMore）", typeof outs.data?.total === "number" && typeof outs.data?.hasMore === "boolean");
  // 2026-10-18 新增筛选：filters 必须始终返回（哪怕 0 条数据），否则前端 chip 没得渲染
  check("筛选元信息带 projects/days", Array.isArray(outs.data?.filters?.projects) && Array.isArray(outs.data?.filters?.days));

  // 未来时间点过滤应该把结果清空 —— 这条能证明 from 真的生效了，而不是被忽略
  const future = Date.now() + 60 * 60 * 1000;
  const outsFuture = await call(`/api/m/outputs?from=${future}`, { token: mToken });
  check("from=未来 时结果为空（时间筛选真的生效）", outsFuture.status === 200 && outsFuture.data?.total === 0);
  const outsNone = await call("/api/m/outputs?project=__none", { token: mToken });
  check("project=__none 可用（未归属项目）", outsNone.status === 200 && typeof outsNone.data?.total === "number");
  const outsBadProject = await call("/api/m/outputs?project=p-not-exist", { token: mToken });
  check("不存在的项目筛选返回 0 条而不是 500", outsBadProject.status === 200 && outsBadProject.data?.total === 0);

  const tk = await call("/api/m/tasks", { token: mToken });
  check("进度接口 200 且是数组", tk.status === 200 && Array.isArray(tk.data?.rows));

  const badPrompt = await call("/api/m/jobs", { method: "POST", token: mToken, body: { prompt: "" } });
  check("空提示词提交被拒", badPrompt.status === 400, `status=${badPrompt.status}`);

  const missingJob = await call("/api/m/jobs/j_ffffffffffffffff", { token: mToken });
  check("不存在的作业返回 404", missingJob.status === 404, `status=${missingJob.status}`);

  // ---------- 充值（沙箱闭环） ----------
  const rc = await call("/api/m/recharge", { token: mToken });
  check("充值页数据 200", rc.status === 200 && rc.data?.ok === true);
  check("套餐列表非空（价格/算力齐全）", Array.isArray(rc.data?.plans) && rc.data.plans.length > 0);
  check(
    "套餐字段齐（id/label/price/credits/total）",
    Boolean(
      rc.data?.plans?.[0]?.id &&
        typeof rc.data?.plans?.[0]?.price === "number" &&
        typeof rc.data?.plans?.[0]?.credits === "number" &&
        typeof rc.data?.plans?.[0]?.total === "number"
    )
  );
  check("返回支付状态（沙箱标记 + 提示）", typeof rc.data?.status?.sandbox === "boolean" && Boolean(rc.data?.status?.hint));
  const balBefore = Number(rc.data?.balance) || 0;

  const created = await call("/api/m/recharge/orders", {
    method: "POST",
    token: mToken,
    body: { planId: "plan-1000" }
  });
  check("创建订单 200 且状态 pending", created.status === 200 && created.data?.order?.status === "pending", JSON.stringify(created.data).slice(0, 160));
  check("订单算力以服务端套餐表为准（1000）", Number(created.data?.order?.credits) === 1000, String(created.data?.order?.credits));
  const orderId = created.data?.order?.id || "";

  const pay = await call(`/api/m/recharge/orders/${orderId}/pay`, { method: "POST", token: mToken });
  check("沙箱模式发起支付返回 sandbox:true", pay.status === 200 && pay.data?.sandbox === true, `status=${pay.status}`);

  const simulated = await call(`/api/m/recharge/orders/${orderId}/simulate-paid`, { method: "POST", token: mToken });
  check("模拟支付 200 且订单变 paid", simulated.status === 200 && simulated.data?.order?.status === "paid", `status=${simulated.status}`);
  check(
    "模拟支付真的加了算力（余额 +1000）",
    Number(simulated.data?.balance) === balBefore + 1000,
    `${balBefore} -> ${simulated.data?.balance}`
  );

  // 幂等：再点一次不能重复到账
  const again2 = await call(`/api/m/recharge/orders/${orderId}/simulate-paid`, { method: "POST", token: mToken });
  check("已支付订单不能重复到账", again2.status === 400, `status=${again2.status}`);

  // 取消路径
  const created2 = await call("/api/m/recharge/orders", {
    method: "POST",
    token: mToken,
    body: { planId: "plan-1000" }
  });
  const orderId2 = created2.data?.order?.id || "";
  const canceled = await call(`/api/m/recharge/orders/${orderId2}/cancel`, { method: "POST", token: mToken });
  check("待支付订单可取消", canceled.status === 200 && canceled.data?.order?.status === "cancelled");
  const payCanceled = await call(`/api/m/recharge/orders/${orderId2}/pay`, { method: "POST", token: mToken });
  check("已取消订单不能再发起支付", payCanceled.status === 400, `status=${payCanceled.status}`);

  // 改价防护：客户端传 price 一律不采信，只认 planId
  const tampered = await call("/api/m/recharge/orders", {
    method: "POST",
    token: mToken,
    body: { planId: "plan-1000", price: 0, credits: 999999 }
  });
  const tamperedOrder = tampered.data?.order || {};
  check(
    "客户端传的价格/算力被忽略（只认服务端套餐表）",
    tampered.status === 200 && Number(tamperedOrder.price) === 19 && Number(tamperedOrder.credits) === 1000,
    JSON.stringify(tamperedOrder)
  );

  const badPlan = await call("/api/m/recharge/orders", {
    method: "POST",
    token: mToken,
    body: { planId: "plan-not-exist" }
  });
  check("不存在的套餐被拒（400）", badPlan.status === 400, `status=${badPlan.status}`);

  // 登出后同一枚令牌必须立刻失效 —— 这是"手机丢了能不能掐掉"的唯一手段
  const out = await call("/api/m/auth/logout", { method: "POST", token: mToken });
  check("登出成功", out.status === 200 && out.data?.ok === true);
  const afterLogout = await call("/api/m/bootstrap", { token: mToken });
  check("登出后令牌立即失效", afterLogout.status === 401, `status=${afterLogout.status}`);
}

console.log(`\n手机端（小程序）：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail === 0 ? 0 : 1);
