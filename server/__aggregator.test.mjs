// 聚合支付自测：本地起 http 服务模拟 epay / xunhupay / custom 三种协议
//
// 覆盖：
//   1. 签名串构造（排序、排除 sign/sign_type/hash、空值过滤）与三种签名算法
//   2. 下单参数（金额元→分、回调地址、协议字段）
//   3. 回调验签（成功、篡改金额、篡改商户号、缺签名全部拒绝）
//   4. 金额换算（元字符串 → 分整数，重点验证 Math.round 消除浮点误差）
//   5. 主动查单 / 连通性测试 / 配置脱敏（密钥绝不回显）
//   6. 后台路由挂载 + 权限码 + 审计明细不落密钥
//
// 运行：node server/__aggregator.test.mjs
// 数据目录：自动建在 <项目>/.tmp/agg-test-xxx，不碰真实 ~/.ai-canvas
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const TMP_ROOT = path.join(ROOT, ".tmp");
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = fs.mkdtempSync(path.join(TMP_ROOT, "agg-test-"));

// 必须先固定 AI_CANVAS_HOME 再动态 import，paths.js 的 HOME 是模块加载期常量
process.env.AI_CANVAS_HOME = DATA_DIR;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("AGG_")) delete process.env[key];
}
delete process.env.AGG_PROVIDER;
delete process.env.PAY_PROVIDER;
delete process.env.PAY_NOTIFY_BASE_URL;

const EPAY_KEY = "epay_key_TEST_123";
const XH_SECRET = "xunhupay_secret_TEST_456";
const CUSTOM_KEY = "custom_key_TEST_789";
const EPAY_PID = "1001";
const XH_APPID = "xh_app_TEST";

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

// ---------- 与模块同口径的测试侧工具 ----------
const EXCLUDE = new Set(["sign", "sign_type", "hash", "key", "appsecret"]);
function canonical(params) {
  return Object.keys(params || {})
    .filter((key) => !EXCLUDE.has(key))
    .filter((key) => {
      const value = params[key];
      return value !== undefined && value !== null && String(value) !== "";
    })
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}
function md5(text) {
  return crypto.createHash("md5").update(String(text), "utf8").digest("hex").toLowerCase();
}
function hmac(text, secret) {
  return crypto.createHmac("sha256", String(secret)).update(String(text), "utf8").digest("hex").toLowerCase();
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------- 模拟支付网关 ----------
const received = { epayCreate: [], epayQuery: [], xhCreate: [], xhQuery: [], customCreate: [], customQuery: [] };

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  try {
    const bodyText = req.method === "POST" ? await readBody(req) : "";

    // 易支付：下单收银台（校验签名后 302 到收银页）
    if (req.method === "GET" && url.pathname === "/submit.php") {
      const q = Object.fromEntries(url.searchParams.entries());
      received.epayCreate.push(q);
      if (q.sign !== md5(canonical(q) + EPAY_KEY) || q.sign_type !== "MD5") {
        return send(400, { error: "sign" });
      }
      return send(302, "", { Location: `https://cashier.example.test/pay?out_trade_no=${encodeURIComponent(q.out_trade_no)}` });
    }

    // 易支付：查单
    if (req.method === "GET" && url.pathname === "/api.php") {
      const q = Object.fromEntries(url.searchParams.entries());
      received.epayQuery.push(q);
      if (q.act !== "order" || q.pid !== EPAY_PID || q.key !== EPAY_KEY) {
        return send(403, { code: -1, msg: "auth" });
      }
      return send(200, {
        code: 1,
        msg: "查询成功",
        data: { out_trade_no: q.out_trade_no, trade_no: "epay_trade_1", money: "19.00", status: 1 }
      });
    }

    // 虎皮椒：下单
    if (req.method === "POST" && url.pathname === "/payment/do.html") {
      const q = Object.fromEntries(new URLSearchParams(bodyText).entries());
      received.xhCreate.push(q);
      if (q.hash !== md5(canonical(q) + XH_SECRET)) return send(200, { errcode: 1, errmsg: "hash error", data: {} });
      return send(200, {
        errcode: 0,
        errmsg: "",
        data: { url: "weixin://wxpay/bizpayurl?pr=test", qrcode: "https://qr.example.test/xh.png", oderid: "xh_trade_1" }
      });
    }

    // 虎皮椒：查单
    if (req.method === "POST" && url.pathname === "/payment/query.html") {
      const q = Object.fromEntries(new URLSearchParams(bodyText).entries());
      received.xhQuery.push(q);
      if (q.hash !== md5(canonical(q) + XH_SECRET)) return send(200, { errcode: 1, errmsg: "hash error", data: {} });
      return send(200, { errcode: 0, data: { status: "OD", total_fee: "19.00", transaction_id: "xh_trade_1" } });
    }

    // 自建聚合：下单（X-Agg-Sign = HMAC-SHA256(rawBody, key)）
    if (req.method === "POST" && url.pathname === "/payment/create") {
      received.customCreate.push({ raw: bodyText, sign: req.headers["x-agg-sign"] || "" });
      if (req.headers["x-agg-sign"] !== hmac(bodyText, CUSTOM_KEY)) {
        return send(401, { error: "sign" });
      }
      return send(200, { payUrl: "https://custom.example.test/pay/1", qrCode: "https://custom.example.test/qr.png", tradeNo: "cu_trade_1" });
    }

    // 自建聚合：查单
    if (req.method === "POST" && url.pathname === "/payment/query") {
      received.customQuery.push({ raw: bodyText, sign: req.headers["x-agg-sign"] || "" });
      if (req.headers["x-agg-sign"] !== hmac(bodyText, CUSTOM_KEY)) {
        return send(401, { error: "sign" });
      }
      return send(200, { status: "paid", amount: 1900, trade_no: "cu_trade_1" });
    }

    // 连通性测试的落点
    return send(200, { ok: true, path: url.pathname });
  } catch (err) {
    return send(500, { error: err.message });
  }
});

await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const PORT = mock.address().port;
const GATEWAY = `http://127.0.0.1:${PORT}`;
const NOTIFY_BASE = "https://notify.example.test";
const RETURN_BASE = "https://return.example.test";
console.log(`\n模拟网关：${GATEWAY}`);
console.log(`数据目录：${DATA_DIR}\n`);

// env 固定后再 import，才能保证 paths.HOME 指向临时目录
const agg = await import("./payment-aggregator.js");
const admin = await import("./payment-admin.js");

const ORDER = { id: "ord_test_1", price: 19, credits: 1000, bonus: 0, payMethod: "" };
const SMALL_ORDER = { id: "ord_test_2", price: 0.07, credits: 10 };

// ============================================================
// 1. 签名串与签名算法
// ============================================================
console.log("=== 1. 签名串 / 签名算法 ===");
check("NOTIFY_PATH 与契约一致", agg.NOTIFY_PATH === "/api/recharge/callback/aggregator", agg.NOTIFY_PATH);

const epayParams = {
  pid: EPAY_PID,
  type: "wxpay",
  out_trade_no: "ord_test_1",
  notify_url: `${NOTIFY_BASE}/api/recharge/callback/aggregator`,
  return_url: `${RETURN_BASE}/#/recharge?out_trade_no=ord_test_1`,
  name: "算力充值 1000 点",
  money: "19.00",
  sign_type: "MD5"
};
const epaySig = agg.signParams(epayParams, "epay", EPAY_KEY);
check(
  "epay 待签串按 k 升序拼接",
  epaySig.signStr.startsWith("money=19.00&name=算力充值 1000 点&notify_url=") &&
    epaySig.signStr.endsWith("&type=wxpay"),
  epaySig.signStr
);
check("epay 待签串排除 sign_type", !epaySig.signStr.includes("sign_type="));
check("epay 签名 = md5(待签串 + key)", epaySig.sign === md5(epaySig.signStr + EPAY_KEY));
check(
  "签名串过滤空值",
  agg.signParams({ ...epayParams, empty_field: "" }, "epay", EPAY_KEY).signStr === epaySig.signStr
);

const xhParams = { appid: XH_APPID, trade_order_id: "ord_test_1", total_fee: "19.00", nonce_str: "abc", time: "1700000000" };
const xhSig = agg.signParams(xhParams, "xunhupay", XH_SECRET);
check("xunhupay 待签串不含 hash", !xhSig.signStr.includes("hash="));
check("xunhupay hash = md5(待签串 + appsecret)", xhSig.sign === md5(xhSig.signStr + XH_SECRET));

const customParams = { out_trade_no: "ord_test_1", amount: 1900, status: "paid" };
const customSig = agg.signParams(customParams, "custom", CUSTOM_KEY);
check("custom 签名 = HMAC-SHA256(待签串, key)", customSig.sign === hmac(customSig.signStr, CUSTOM_KEY));
check("custom 待签串金额用分整数", customSig.signStr === "amount=1900&out_trade_no=ord_test_1&status=paid", customSig.signStr);

let unknownThrew = false;
try {
  agg.signParams({}, "paypal", "x");
} catch {
  unknownThrew = true;
}
check("未知协议拒绝签名", unknownThrew);

// ============================================================
// 2. 配置读写 / 脱敏 / 密钥只写不读
// ============================================================
console.log("\n=== 2. 配置读写 / 脱敏 ===");
const initial = agg.loadConfig();
check("默认协议 epay", initial.provider === "epay", initial.provider);
check("初始未配置", agg.isConfigured() === false);
check("默认支付方式 wxpay/alipay", initial.methods.join(",") === "wxpay,alipay");

agg.saveConfig({
  provider: "epay",
  gateway: `${GATEWAY}/`,
  pid: EPAY_PID,
  key: EPAY_KEY,
  notifyBaseUrl: `${NOTIFY_BASE}/`,
  returnBaseUrl: RETURN_BASE
});
const loaded = agg.loadConfig();
check("保存后读取一致", loaded.pid === EPAY_PID && loaded.provider === "epay");
check("gateway 尾部斜杠归一化", loaded.gateway === GATEWAY, loaded.gateway);
check("notifyBaseUrl 尾部斜杠归一化", loaded.notifyBaseUrl === NOTIFY_BASE, loaded.notifyBaseUrl);
check("配置齐全", agg.isConfigured() === true);

const masked = agg.maskedConfig();
check("脱敏配置没有 key 字段", !Object.prototype.hasOwnProperty.call(masked, "key"));
check("脱敏配置没有 appsecret 字段", !Object.prototype.hasOwnProperty.call(masked, "appsecret"));
check("keySet 正确", masked.keySet === true && masked.appsecretSet === false);
check("脱敏配置/JSON 不含明文密钥", !JSON.stringify(masked).includes(EPAY_KEY));

const fileData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "pay-config.json"), "utf8"));
check("配置文件内部保存密钥（仅服务端落盘）", fileData.aggregator.key === EPAY_KEY);
if (process.platform !== "win32") {
  const mode = fs.statSync(path.join(DATA_DIR, "pay-config.json")).mode & 0o777;
  check("配置文件权限 0600", (mode & 0o077) === 0, mode.toString(8));
} else {
  console.log("  ⏭️  配置文件权限 0600 检查在 Windows 上跳过（chmod 不支持 POSIX 位）");
}

agg.saveConfig({ key: "" });
check('key 传 "" = 保持原密钥', agg.loadConfig().key === EPAY_KEY);
agg.saveConfig({ key: "__CLEAR__" });
check('key 传 "__CLEAR__" = 清除密钥', agg.loadConfig().key === "" && agg.maskedConfig().keySet === false);
agg.saveConfig({ key: EPAY_KEY });
check("密钥可重新写入", agg.loadConfig().key === EPAY_KEY && agg.isConfigured());

process.env.AGG_KEY = "env_key_999";
check("环境变量 AGG_KEY 优先于文件", agg.loadConfig().key === "env_key_999");
check("环境变量覆盖时脱敏仍不回显", !JSON.stringify(agg.maskedConfig()).includes("env_key_999"));
delete process.env.AGG_KEY;

// ============================================================
// 3. 下单（epay / xunhupay / custom）
// ============================================================
console.log("\n=== 3. 下单 ===");
const epayPay = await agg.createPayment(ORDER);
check("epay 下单返回 provider=epay", epayPay.provider === "epay");
check("epay 下单返回 redirect 模式", epayPay.mode === "redirect", epayPay.mode);
check("epay 302 后得到收银台地址", String(epayPay.payUrl).startsWith("https://cashier.example.test/pay"), epayPay.payUrl);
check("epay tradeNo 先回订单号", epayPay.tradeNo === ORDER.id);
const epayReq = received.epayCreate[received.epayCreate.length - 1];
check("epay 下单带 pid", epayReq.pid === EPAY_PID);
check("epay 下单 type=wxpay", epayReq.type === "wxpay");
check("epay 下单带 out_trade_no", epayReq.out_trade_no === ORDER.id);
check("epay 下单金额 19.00 元", epayReq.money === "19.00", epayReq.money);
check("epay 下单商品名含算力点数", epayReq.name.includes("1000"), epayReq.name);
check(
  "epay 回调地址 = notifyBaseUrl + 固定回调路径",
  epayReq.notify_url === `${NOTIFY_BASE}/api/recharge/callback/aggregator`,
  epayReq.notify_url
);
check("epay return_url 带订单号", epayReq.return_url.includes(ORDER.id), epayReq.return_url);
check("网关侧验签通过（签名串可被独立复算）", epayReq.sign === md5(canonical(epayReq) + EPAY_KEY));

await agg.createPayment(SMALL_ORDER);
const smallReq = received.epayCreate[received.epayCreate.length - 1];
check("金额换算 0.07 元 → 7 分（无浮点尾巴）", smallReq.money === "0.07", smallReq.money);

agg.saveConfig({ provider: "xunhupay", appid: XH_APPID, appsecret: XH_SECRET });
check("xunhupay 配置齐全", agg.isConfigured() === true);
const xhPay = await agg.createPayment(ORDER);
check("xunhupay 下单返回 provider=xunhupay", xhPay.provider === "xunhupay");
check("xunhupay 下单返回 qrcode 模式", xhPay.mode === "qrcode", xhPay.mode);
check("xunhupay 返回支付地址/二维码", Boolean(xhPay.payUrl && xhPay.qrCode), `${xhPay.payUrl} | ${xhPay.qrCode}`);
check("xunhupay tradeNo 取上游 oderid", xhPay.tradeNo === "xh_trade_1", xhPay.tradeNo);
check("xunhupay 下单返回不含 appsecret", !JSON.stringify(xhPay).includes(XH_SECRET));
const xhReq = received.xhCreate[received.xhCreate.length - 1];
check("xunhupay 下单带 appid", xhReq.appid === XH_APPID);
check("xunhupay 下单带 trade_order_id", xhReq.trade_order_id === ORDER.id);
check("xunhupay 下单金额 19.00 元", xhReq.total_fee === "19.00", xhReq.total_fee);
check("xunhupay 下单带 nonce_str/time", Boolean(xhReq.nonce_str) && Boolean(xhReq.time));
check("xunhupay 网关侧验签通过", xhReq.hash === md5(canonical(xhReq) + XH_SECRET));

agg.saveConfig({ provider: "custom", key: CUSTOM_KEY });
check("custom 配置齐全", agg.isConfigured() === true);
const customPay = await agg.createPayment(ORDER);
check("custom 下单返回 provider=custom", customPay.provider === "custom");
check("custom 返回支付地址/二维码", Boolean(customPay.payUrl && customPay.qrCode));
check("custom tradeNo 取上游", customPay.tradeNo === "cu_trade_1", customPay.tradeNo);
const customReq = received.customCreate[received.customCreate.length - 1];
check("custom 下单 X-Agg-Sign = HMAC(rawBody)", customReq.sign === hmac(customReq.raw, CUSTOM_KEY));
const customBody = JSON.parse(customReq.raw);
check("custom 下单 amount 为 1900 分整数", customBody.amount === 1900, String(customBody.amount));
check("custom 下单带 out_trade_no", customBody.out_trade_no === ORDER.id);
check("custom 下单带 notify_url", customBody.notify_url === `${NOTIFY_BASE}/api/recharge/callback/aggregator`);

// 未配置时下单必须报错，不能静默走沙箱
agg.saveConfig({ key: "__CLEAR__" });
let unconfiguredThrew = false;
try {
  await agg.createPayment(ORDER);
} catch (err) {
  unconfiguredThrew = /未配置完整/.test(err.message);
}
check("未配置时下单直接报错", unconfiguredThrew);
agg.saveConfig({ key: CUSTOM_KEY });

// ============================================================
// 4. 回调验签（成功 + 篡改拒绝）
// ============================================================
console.log("\n=== 4. 回调验签 ===");
agg.saveConfig({ provider: "epay", pid: EPAY_PID, key: EPAY_KEY });
function epayNotify(overrides = {}) {
  const base = {
    pid: EPAY_PID,
    trade_no: "epay_trade_1",
    out_trade_no: ORDER.id,
    type: "wxpay",
    name: "算力充值 1000 点",
    money: "19.00",
    trade_status: "TRADE_SUCCESS",
    ...overrides
  };
  return { ...base, sign_type: "MD5", sign: md5(canonical(base) + EPAY_KEY) };
}
const epayOk = agg.verifyNotify({ provider: "epay", params: epayNotify() });
check("epay 合法回调通过", epayOk.ok === true, epayOk.reason || "");
check("epay 回调订单号正确", epayOk.outTradeNo === ORDER.id);
check("epay 回调金额 19.00 元 → 1900 分", epayOk.amount === 1900, String(epayOk.amount));
check("epay 回调交易状态透传", epayOk.tradeState === "TRADE_SUCCESS");

const epayTampered = agg.verifyNotify({ provider: "epay", params: { ...epayNotify(), money: "0.01" } });
check("epay 篡改金额被拒绝", epayTampered.ok === false && /签名/.test(epayTampered.reason), epayTampered.reason);
const epayWrongPid = agg.verifyNotify({ provider: "epay", params: epayNotify({ pid: "9999" }) });
check("epay 伪造商户号被拒绝", epayWrongPid.ok === false && /商户号/.test(epayWrongPid.reason), epayWrongPid.reason);
const epayNoSign = epayNotify();
delete epayNoSign.sign;
check("epay 缺签名被拒绝", agg.verifyNotify({ provider: "epay", params: epayNoSign }).ok === false);

check("金额换算 0.29 元 → 29 分（Math.round 消误差）", agg.verifyNotify({ provider: "epay", params: epayNotify({ money: "0.29" }) }).amount === 29);
check("金额换算 19 元 → 1900 分", agg.verifyNotify({ provider: "epay", params: epayNotify({ money: "19" }) }).amount === 1900);
check("金额换算 19.99 元 → 1999 分", agg.verifyNotify({ provider: "epay", params: epayNotify({ money: "19.99" }) }).amount === 1999);

agg.saveConfig({ provider: "xunhupay", appid: XH_APPID, appsecret: XH_SECRET });
function xhNotify(overrides = {}) {
  const base = {
    appid: XH_APPID,
    trade_order_id: ORDER.id,
    total_fee: "19.00",
    transaction_id: "xh_trade_1",
    status: "OD",
    time: "1700000000",
    nonce_str: "nonce_test",
    ...overrides
  };
  return { ...base, hash: md5(canonical(base) + XH_SECRET) };
}
const xhOk = agg.verifyNotify({ provider: "xunhupay", params: xhNotify() });
check("xunhupay 合法回调通过", xhOk.ok === true, xhOk.reason || "");
check("xunhupay 回调金额 1900 分", xhOk.amount === 1900);
check("xunhupay 回调状态 OD 透传", xhOk.tradeState === "OD");
check("xunhupay 篡改金额被拒绝", agg.verifyNotify({ provider: "xunhupay", params: { ...xhNotify(), total_fee: "0.01" } }).ok === false);
check(
  "xunhupay 伪造 appid 被拒绝",
  agg.verifyNotify({ provider: "xunhupay", params: xhNotify({ appid: "other_app" }) }).ok === false
);

agg.saveConfig({ provider: "custom", key: CUSTOM_KEY });
function customNotify(overrides = {}) {
  const base = { out_trade_no: ORDER.id, amount: 1900, status: "paid", ...overrides };
  return { ...base, sign: hmac(canonical(base), CUSTOM_KEY) };
}
const customOk = agg.verifyNotify({ provider: "custom", params: customNotify() });
check("custom 合法回调通过", customOk.ok === true, customOk.reason || "");
check("custom 回调金额即 1900 分", customOk.amount === 1900);
check("custom 篡改金额被拒绝", agg.verifyNotify({ provider: "custom", params: { ...customNotify(), amount: 1 } }).ok === false);
const customRawParams = { out_trade_no: ORDER.id, amount: 1900, status: "paid" };
const customRawBody = JSON.stringify(customRawParams);
const customRawSign = hmac(customRawBody, CUSTOM_KEY);
const customByRaw = agg.verifyNotify({
  provider: "custom",
  params: { ...customRawParams, sign: customRawSign },
  rawBody: customRawBody
});
check("custom 传 rawBody 时按原始字节验签", customByRaw.ok === true, customByRaw.reason || "");
check(
  "custom rawBody 与 params 不一致时拒绝",
  agg.verifyNotify({ provider: "custom", params: { ...customRawParams, amount: 1, sign: customRawSign }, rawBody: customRawBody }).ok === false
);

// ============================================================
// 5. 主动查单 / 连通性测试
// ============================================================
console.log("\n=== 5. 查单 / 连通性 ===");
agg.saveConfig({ provider: "epay", pid: EPAY_PID, key: EPAY_KEY });
const epayQuery = await agg.queryOrder(ORDER.id);
check("epay 查单成功", epayQuery.ok === true && epayQuery.paid === true, epayQuery.reason || "");
check("epay 查单金额 1900 分", epayQuery.amount === 1900, String(epayQuery.amount));
check("epay 查单交易号", epayQuery.tradeNo === "epay_trade_1");
const epayQueryReq = received.epayQuery[received.epayQuery.length - 1];
check("epay 查单参数含 pid/out_trade_no", epayQueryReq.pid === EPAY_PID && epayQueryReq.out_trade_no === ORDER.id);

agg.saveConfig({ provider: "xunhupay", appid: XH_APPID, appsecret: XH_SECRET });
const xhQuery = await agg.queryOrder(ORDER.id);
check("xunhupay 查单成功", xhQuery.ok === true && xhQuery.paid === true, xhQuery.reason || "");
check("xunhupay 查单金额 1900 分", xhQuery.amount === 1900);
check("xunhupay 查单带签名", Boolean(received.xhQuery[received.xhQuery.length - 1]?.hash));

agg.saveConfig({ provider: "custom", key: CUSTOM_KEY });
const customQuery = await agg.queryOrder(ORDER.id);
check("custom 查单成功", customQuery.ok === true && customQuery.paid === true, customQuery.reason || "");
check("custom 查单金额 1900 分", customQuery.amount === 1900);
check("custom 查单带 X-Agg-Sign", received.customQuery[received.customQuery.length - 1]?.sign === hmac(received.customQuery[received.customQuery.length - 1]?.raw, CUSTOM_KEY));

check("未知订单号查单直接失败", (await agg.queryOrder("")).ok === false);
agg.saveConfig({ key: "__CLEAR__" });
check("未配置时查单返回 ok:false 而非抛错", (await agg.queryOrder(ORDER.id)).ok === false);
agg.saveConfig({ key: CUSTOM_KEY });

agg.saveConfig({ provider: "epay", pid: EPAY_PID, key: EPAY_KEY });
const conn = await agg.testConnection();
check("连通性测试通过", conn.ok === true && conn.provider === "epay", conn.message);
check("连通性测试有耗时", typeof conn.latencyMs === "number" && conn.latencyMs >= 0);
const connUnknown = await agg.testConnection({ ...agg.loadConfig(), provider: "wechat" });
check("未知协议连通性测试失败", connUnknown.ok === false && /未知支付协议/.test(connUnknown.message), connUnknown.message);
agg.saveConfig({ key: "__CLEAR__" });
check("配置不全时连通性测试失败", (await agg.testConnection()).ok === false);
agg.saveConfig({ key: EPAY_KEY });

// ============================================================
// 6. 后台路由 / 权限 / 审计
// ============================================================
console.log("\n=== 6. 后台路由 / 权限 / 审计 ===");
function fakeApp() {
  const routes = [];
  const add = (method) => (pathname, ...handlers) => routes.push({ method, path: pathname, handlers });
  return { routes, get: add("GET"), put: add("PUT"), post: add("POST") };
}
const app = fakeApp();
const permCodes = [];
admin.mountPaymentAdmin(app, {
  requireLogin: (req, res, next) => next(),
  requirePerm: (code) => {
    permCodes.push(code);
    return (req, res, next) => next();
  }
});

const getRoute = app.routes.find((r) => r.method === "GET" && r.path === "/api/admin/payment/channels");
const putRoute = app.routes.find((r) => r.method === "PUT" && r.path === "/api/admin/payment/channels");
const testRoute = app.routes.find((r) => r.method === "POST" && r.path === "/api/admin/payment/channels/test");
check("挂载 GET /api/admin/payment/channels", Boolean(getRoute));
check("挂载 PUT /api/admin/payment/channels", Boolean(putRoute));
check("挂载 POST /api/admin/payment/channels/test", Boolean(testRoute));
check("GET 使用 admin:payment:view", getRoute?.handlers.length === 3);
check("权限码注册正确", permCodes.filter((c) => c === "admin:payment:view").length === 1 && permCodes.filter((c) => c === "admin:payment:config").length === 2);

async function invoke(route, req = {}) {
  const handler = route.handlers[route.handlers.length - 1];
  const res = {
    headersSent: false,
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    }
  };
  const request = {
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    user: { username: "tester" },
    body: {},
    query: {},
    ...req
  };
  await handler(request, res);
  return res;
}

const getRes = await invoke(getRoute);
check("GET 返回 200", getRes.statusCode === 200);
check("GET mode 为字符串", typeof getRes.body?.mode === "string", getRes.body?.mode);
check("GET sandbox 为布尔", typeof getRes.body?.sandbox === "boolean");
check("GET 聚合通道已配置", getRes.body?.channels?.aggregator?.configured === true);
check("GET 聚合通道 keySet", getRes.body?.channels?.aggregator?.keySet === true);
check("GET 响应不含明文密钥", !JSON.stringify(getRes.body).includes(EPAY_KEY));
check("GET 含 wechat/alipay 通道", Boolean(getRes.body?.channels?.wechat && getRes.body?.channels?.alipay));

const testRes = await invoke(testRoute, { body: { provider: "epay" } });
check("POST test 返回连通结果", testRes.body?.ok === true && testRes.body?.provider === "epay", testRes.body?.message);
check("POST test 返回 latencyMs", typeof testRes.body?.latencyMs === "number");

const emptyRes = await invoke(putRoute, { body: {} });
check("PUT 空 body 返回 400", emptyRes.statusCode === 400 && /没有可保存/.test(emptyRes.body?.error), emptyRes.body?.error);
const badProviderRes = await invoke(putRoute, { body: { provider: "paypal" } });
check("PUT 非法通道返回 400", badProviderRes.statusCode === 400 && /未知支付通道/.test(badProviderRes.body?.error), badProviderRes.body?.error);

const putRes = await invoke(putRoute, {
  body: {
    provider: "aggregator",
    aggregator: { provider: "xunhupay", gateway: GATEWAY, appid: "app_2", appsecret: XH_SECRET, pid: "", key: "" }
  }
});
check("PUT 保存成功", putRes.statusCode === 200 && putRes.body?.ok === true);
check("PUT 返回聚合协议已切换", putRes.body?.channels?.aggregator?.provider === "xunhupay");
check("PUT 回传 appsecretSet", putRes.body?.channels?.aggregator?.appsecretSet === true);
check("PUT 回传 keySet（空串=保持原密钥）", putRes.body?.channels?.aggregator?.keySet === true);
check("PUT 响应不含 appsecret 明文", !JSON.stringify(putRes.body).includes(XH_SECRET));
check("PUT 响应不含旧 key 明文", !JSON.stringify(putRes.body).includes(EPAY_KEY));

const savedFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "pay-config.json"), "utf8"));
check("PUT 切换顶层生效通道", savedFile.provider === "aggregator", savedFile.provider);
check("PUT 写入聚合协议配置", savedFile.aggregator.provider === "xunhupay" && savedFile.aggregator.appid === "app_2");

function auditText() {
  const dir = path.join(DATA_DIR, "audit");
  try {
    return fs
      .readdirSync(dir)
      .map((file) => fs.readFileSync(path.join(dir, file), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}
const auditLog = auditText();
check("写操作已落审计", auditLog.includes('"action":"payment.channel.save"'));
check("审计不含密钥明文", !auditLog.includes(XH_SECRET) && !auditLog.includes(EPAY_KEY), "已扫描 audit JSONL");
check("审计记录字段名与密钥状态", auditLog.includes('"appsecretSet":true'));

// ============================================================
// 收尾
// ============================================================
mock.closeAllConnections?.();
await new Promise((resolve) => mock.close(resolve));
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  // 失败时保留数据目录（配置 / 审计 JSONL）方便排查
  console.log(`临时数据目录（失败保留）：${DATA_DIR}\n`);
} else {
  // 全绿时清理，避免 .tmp 里越堆越多
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结果 */
  }
  console.log(`临时数据目录已清理：${DATA_DIR}\n`);
}
// Windows 上 process.exit 若与 undici keep-alive 连接收尾撞车会触发 libuv 断言，
// 先让事件循环空转一拍再退出。
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(fail ? 1 : 0);
