// 第三方聚合支付适配层：易支付/蓝兔/彩虹（epay）、虎皮椒（xunhupay）、自建聚合（custom）
//
// 为什么要单独一层：
//   1. 充值订单只有一套（credits.js），但上游支付协议有三套，协议差异必须收敛在一个文件里；
//   2. 密钥只写不读 —— 后台接口只回 keySet / appsecretSet，任何对外函数都不把明文带回响应；
//   3. 金额一律先换算成「分」的整数再参与比较，浮点数只出现在展示和网关参数字符串里。
//
// 配置优先级：环境变量 AGG_* > pay-config.json 的 aggregator 段。
// 出站请求：统一全局 fetch + AbortSignal.timeout(10s)，不新增任何 npm 依赖。
import crypto from "node:crypto";
import fs from "node:fs";
import { dataFile, HOME } from "./paths.js";

// 支付回调固定路径：index.js 需要把它加入 AUTH_PUBLIC（Lead 接线时用这个常量保持一致）
export const NOTIFY_PATH = "/api/recharge/callback/aggregator";

const TIMEOUT_MS = 10000;
export const PROVIDERS = ["epay", "xunhupay", "custom"];
const DEFAULT_METHODS = ["wxpay", "alipay"];

// 签名串里永不参与计算的字段：
//   sign / sign_type / hash 是各协议自己的签名字段；
//   key / appsecret 只是兜底，防止调用方把密钥误塞进 params 后被拼进待签串。
const SIGN_EXCLUDE = new Set(["sign", "sign_type", "hash", "key", "appsecret"]);

const CONFIG_FILE = () => dataFile("pay-config.json");

// ============================================================
// 基础工具（全部无副作用，便于测试）
// ============================================================

function md5(text) {
  return crypto.createHash("md5").update(String(text), "utf8").digest("hex").toLowerCase();
}

function hmacSha256(text, secret) {
  return crypto.createHmac("sha256", String(secret)).update(String(text), "utf8").digest("hex").toLowerCase();
}

/** 定长比较，避免签名比对被时间侧信道利用 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? "").toLowerCase(), "utf8");
  const y = Buffer.from(String(b ?? "").toLowerCase(), "utf8");
  if (x.length === 0 || x.length !== y.length) return false;
  try {
    return crypto.timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

function stripSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

/** 元 → 分：四舍五入到整数分，禁止浮点直接比较 */
function yuanToCents(value) {
  const cents = Math.round(Number(value) * 100);
  return Number.isFinite(cents) ? cents : NaN;
}

/** 分 → 元字符串（网关参数只收两位小数字符串） */
function centsToYuan(cents) {
  return (Number(cents) / 100).toFixed(2);
}

/** 按 k 升序拼 k=v&…，排除签名字段与空值 —— 三种协议共用同一套待签串规则 */
function canonicalString(params) {
  const obj = params && typeof params === "object" ? params : {};
  return Object.keys(obj)
    .filter((key) => !SIGN_EXCLUDE.has(key))
    .filter((key) => {
      const value = obj[key];
      return value !== undefined && value !== null && String(value) !== "";
    })
    .sort()
    .map((key) => `${key}=${obj[key]}`)
    .join("&");
}

function sanitizeMethods(methods) {
  if (!Array.isArray(methods)) return DEFAULT_METHODS.slice();
  const rows = methods
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return rows.length ? rows : DEFAULT_METHODS.slice();
}

function validProvider(provider) {
  return PROVIDERS.includes(String(provider || "").trim().toLowerCase());
}

function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase();
}

/** 各协议签名密钥取值：epay/custom 用 key，xunhupay 用 appsecret */
function secretOf(provider, cfg) {
  const prov = normalizeProvider(provider);
  if (prov === "epay" || prov === "custom") return String(cfg?.key || "");
  if (prov === "xunhupay") return String(cfg?.appsecret || "");
  return "";
}

// ============================================================
// 配置读写
// ============================================================

function readConfigFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // 配置文件不存在 / 损坏都按「空配置」处理，不能因为读配置把服务打挂
    return {};
  }
}

function writeConfigFile(obj) {
  fs.mkdirSync(HOME, { recursive: true });
  const text = JSON.stringify(obj, null, 2) + "\n";
  fs.writeFileSync(CONFIG_FILE(), text, { encoding: "utf8", mode: 0o600 });
  try {
    // Windows 上 chmod 只影响只读位，失败不算错；POSIX 上确保 0600
    fs.chmodSync(CONFIG_FILE(), 0o600);
  } catch {
    /* 忽略：不支持的平台 */
  }
}

/**
 * 读取聚合支付配置（环境变量优先，其次 pay-config.json.aggregator）。
 * 返回的是内部结构，含明文密钥，**只允许在服务端计算签名时使用，禁止直接回给前端**。
 */
export function loadConfig() {
  const fileCfg = readConfigFile();
  const saved = fileCfg.aggregator && typeof fileCfg.aggregator === "object" ? fileCfg.aggregator : {};
  const env = process.env;
  const provider = normalizeProvider(env.AGG_PROVIDER || saved.provider || "epay") || "epay";
  return {
    provider,
    gateway: stripSlash(env.AGG_GATEWAY || saved.gateway || ""),
    pid: String(env.AGG_PID || saved.pid || "").trim(),
    key: String(env.AGG_KEY || saved.key || ""),
    appid: String(env.AGG_APPID || saved.appid || "").trim(),
    appsecret: String(env.AGG_APPSECRET || saved.appsecret || ""),
    notifyBaseUrl: stripSlash(env.AGG_NOTIFY_BASE_URL || saved.notifyBaseUrl || ""),
    returnBaseUrl: stripSlash(env.AGG_RETURN_BASE_URL || saved.returnBaseUrl || ""),
    methods: sanitizeMethods(saved.methods),
    // custom 协议的显式地址（不写就按 gateway 推导），兼容 customCreateUrl/customQueryUrl 别名
    createUrl: String(env.AGG_CREATE_URL || saved.createUrl || saved.customCreateUrl || "").trim(),
    queryUrl: String(env.AGG_QUERY_URL || saved.queryUrl || saved.customQueryUrl || "").trim()
  };
}

/**
 * 保存聚合支付配置：深合并进 pay-config.json 的 aggregator 段，保留 wechat/alipay/provider 等其它段。
 * 密钥特殊语义：传 "" = 保持原值（前端只拿到 keySet，回传空串代表没改）；
 *             传 "__CLEAR__" = 清除。
 * 返回脱敏后的配置（绝不含明文密钥）。
 */
export function saveConfig(patch) {
  const input = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const fileCfg = readConfigFile();
  const current = fileCfg.aggregator && typeof fileCfg.aggregator === "object" ? { ...fileCfg.aggregator } : {};

  const known = [
    "provider",
    "gateway",
    "pid",
    "key",
    "appid",
    "appsecret",
    "notifyBaseUrl",
    "returnBaseUrl",
    "methods",
    "createUrl",
    "queryUrl"
  ];
  const clean = {};
  for (const field of known) {
    if (Object.prototype.hasOwnProperty.call(input, field)) clean[field] = input[field];
  }
  // 兼容契约之外但语义明确的别名
  if (clean.createUrl === undefined && input.customCreateUrl !== undefined) clean.createUrl = input.customCreateUrl;
  if (clean.queryUrl === undefined && input.customQueryUrl !== undefined) clean.queryUrl = input.customQueryUrl;

  if (clean.provider !== undefined) {
    const provider = normalizeProvider(clean.provider);
    if (provider && !validProvider(provider)) throw new Error(`未知支付协议: ${clean.provider}`);
    clean.provider = provider;
  }
  for (const field of ["gateway", "notifyBaseUrl", "returnBaseUrl"]) {
    if (clean[field] !== undefined) clean[field] = stripSlash(clean[field]);
  }
  for (const field of ["pid", "appid", "createUrl", "queryUrl"]) {
    if (clean[field] !== undefined) clean[field] = String(clean[field] ?? "").trim();
  }
  for (const field of ["key", "appsecret"]) {
    if (clean[field] === undefined) continue;
    const value = String(clean[field] ?? "");
    if (value === "__CLEAR__") {
      delete current[field];
      delete clean[field];
    } else if (value === "") {
      // 空串 = 前端没有重新填写，保持原密钥不变
      delete clean[field];
    } else {
      clean[field] = value;
    }
  }
  if (clean.methods !== undefined) clean.methods = sanitizeMethods(clean.methods);

  writeConfigFile({ ...fileCfg, aggregator: { ...current, ...clean } });
  return maskedConfig();
}

/** 脱敏配置：任何响应都只能用它 —— 不含 key/appsecret 明文，只回 keySet/appsecretSet */
export function maskedConfig() {
  const cfg = loadConfig();
  return {
    provider: cfg.provider,
    gateway: cfg.gateway,
    pid: cfg.pid,
    keySet: Boolean(cfg.key),
    appid: cfg.appid,
    appsecretSet: Boolean(cfg.appsecret),
    notifyBaseUrl: cfg.notifyBaseUrl,
    returnBaseUrl: cfg.returnBaseUrl,
    methods: cfg.methods.slice(),
    configured: isConfigured(cfg)
  };
}

/** 是否配置齐全：epay/gateway+pid+key；xunhupay/gateway+appid+appsecret；custom/key+下单地址 */
export function isConfigured(cfg) {
  const current = cfg && typeof cfg === "object" ? cfg : loadConfig();
  const provider = normalizeProvider(current.provider);
  if (provider === "epay") {
    return Boolean(stripSlash(current.gateway) && String(current.pid || "") && String(current.key || ""));
  }
  if (provider === "xunhupay") {
    return Boolean(stripSlash(current.gateway) && String(current.appid || "") && String(current.appsecret || ""));
  }
  if (provider === "custom") {
    return Boolean((String(current.createUrl || "") || stripSlash(current.gateway)) && String(current.key || ""));
  }
  return false;
}

// ============================================================
// 签名（纯函数：不传 secret 时才回退到读配置，传了 secret 就完全无副作用）
// ============================================================

/**
 * 构造签名串并计算签名。
 * - epay：  sign = md5(待签串 + key)
 * - xunhupay：sign = md5(待签串 + appsecret)
 * - custom：sign = HMAC-SHA256(待签串, key)
 * 返回 { signStr, sign }；signStr 是「不含密钥」的 k=v&… 待签串，便于日志/测试核对。
 */
export function signParams(params, provider, secret) {
  const prov = normalizeProvider(provider);
  if (!validProvider(prov)) throw new Error(`未知支付协议: ${provider}`);
  const signStr = canonicalString(params);
  const key = secret !== undefined && secret !== null ? String(secret) : secretOf(prov, loadConfig());
  if (!key) throw new Error("缺少签名密钥");
  if (prov === "custom") return { signStr, sign: hmacSha256(signStr, key) };
  return { signStr, sign: md5(signStr + key) };
}

// ============================================================
// 下单
// ============================================================

function orderTitle(order) {
  const credits = Number(order?.credits || 0);
  return `算力充值 ${credits} 点`;
}

/** 回调地址按「站点根地址 + 固定回调路径」拼装，订单号带进 return_url 便于前端回显 */
function resolveUrls(cfg, order) {
  const base = stripSlash(cfg.notifyBaseUrl || cfg.returnBaseUrl);
  if (!base) throw new Error("未配置回调地址（notifyBaseUrl / AGG_NOTIFY_BASE_URL）");
  const notifyUrl = `${base}${NOTIFY_PATH}`;
  const returnUrl = cfg.returnBaseUrl
    ? `${stripSlash(cfg.returnBaseUrl)}/#/recharge?out_trade_no=${encodeURIComponent(order.id)}`
    : base;
  return { notifyUrl, returnUrl };
}

function pickMethod(cfg, order) {
  const wanted = String(order?.payMethod || "").trim().toLowerCase();
  if (wanted === "wxpay" || wanted === "alipay") return wanted;
  const methods = Array.isArray(cfg.methods) && cfg.methods.length ? cfg.methods : DEFAULT_METHODS;
  return methods.includes("wxpay") ? "wxpay" : methods[0] || "wxpay";
}

async function readJsonResponse(res, label) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}返回非 JSON（HTTP ${res.status}）`);
  }
}

async function epayCreate(order, cfg, cents, title, urls) {
  const params = {
    pid: cfg.pid,
    type: pickMethod(cfg, order),
    out_trade_no: order.id,
    notify_url: urls.notifyUrl,
    return_url: urls.returnUrl,
    name: title,
    money: centsToYuan(cents),
    sign_type: "MD5"
  };
  const { sign } = signParams(params, "epay", cfg.key);
  const query = new URLSearchParams({ ...params, sign }).toString();
  const requestUrl = `${cfg.gateway}/submit.php?${query}`;

  // 易支付 submit.php 通常会 302 到收银台；个别部署直接返回自动提交的 HTML 页。
  // 两种情况都把「可交给浏览器打开的地址」作为 payUrl 返回。
  const res = await fetch(requestUrl, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const location = res.headers.get("location") || "";
  let payUrl = requestUrl;
  if (res.status >= 300 && res.status < 400 && location) {
    try {
      payUrl = new URL(location, cfg.gateway).href;
    } catch {
      payUrl = location;
    }
  }
  try {
    await res.text(); // 消费响应体，避免连接悬挂
  } catch {
    /* 忽略 */
  }
  return {
    provider: "epay",
    mode: "redirect",
    payUrl,
    qrCode: "",
    tradeNo: order.id,
    raw: { status: res.status, location, method: params.type }
  };
}

async function xunhupayCreate(order, cfg, cents, title, urls) {
  const params = {
    appid: cfg.appid,
    trade_order_id: order.id,
    total_fee: centsToYuan(cents),
    title,
    time: String(Math.floor(Date.now() / 1000)),
    notify_url: urls.notifyUrl,
    return_url: urls.returnUrl,
    nonce_str: crypto.randomBytes(8).toString("hex")
  };
  const { sign: hash } = signParams(params, "xunhupay", cfg.appsecret);
  const body = new URLSearchParams({ ...params, hash }).toString();
  const res = await fetch(`${cfg.gateway}/payment/do.html`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const json = await readJsonResponse(res, "虎皮椒下单");
  if (Number(json.errcode) !== 0) {
    throw new Error(json.errmsg || `虎皮椒下单失败（errcode=${json.errcode}）`);
  }
  const data = json.data && typeof json.data === "object" ? json.data : {};
  const payUrl = data.url || data.pay_url || "";
  const qrCode = data.qrcode || data.qr_code || "";
  return {
    provider: "xunhupay",
    mode: qrCode ? "qrcode" : "redirect",
    payUrl,
    qrCode,
    // 虎皮椒返回字段历史上拼作 oderid，两种都兼容
    tradeNo: data.oderid || data.orderid || data.trade_no || order.id,
    raw: json
  };
}

async function customCreate(order, cfg, cents, title, urls) {
  const createUrl = cfg.createUrl || `${cfg.gateway}/payment/create`;
  const payload = {
    out_trade_no: order.id,
    amount: cents, // 自建聚合统一用「分」的整数字段
    subject: title,
    notify_url: urls.notifyUrl,
    return_url: urls.returnUrl,
    method: pickMethod(cfg, order)
  };
  const rawBody = JSON.stringify(payload);
  // 契约规定：X-Agg-Sign = HMAC-SHA256(rawBody, key)，签名覆盖逐字节的请求体
  const sign = hmacSha256(rawBody, cfg.key);
  const res = await fetch(createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agg-Sign": sign },
    body: rawBody,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const json = await readJsonResponse(res, "自建聚合下单");
  if (!res.ok) throw new Error(json.message || json.error || `自建聚合下单失败（HTTP ${res.status}）`);
  const data = json.data && typeof json.data === "object" ? json.data : json;
  const payUrl = data.payUrl || data.pay_url || data.url || "";
  const qrCode = data.qrCode || data.qr_code || "";
  const tradeNo = data.tradeNo || data.trade_no || json.trade_no || order.id;
  if (!payUrl && !qrCode) throw new Error("自建聚合下单返回缺少支付地址");
  return {
    provider: "custom",
    mode: qrCode ? "qrcode" : "redirect",
    payUrl,
    qrCode,
    tradeNo,
    raw: json
  };
}

/**
 * 创建支付单。
 * order 结构沿用 credits.js 的订单：{ id, price(元), credits, payMethod? }。
 * 返回 { provider, mode:"redirect"|"qrcode", payUrl, qrCode, tradeNo, raw }。
 */
export async function createPayment(order, cfg) {
  if (!order || !order.id) throw new Error("创建支付单缺少订单号");
  const current = cfg && typeof cfg === "object" ? cfg : loadConfig();
  if (!isConfigured(current)) throw new Error("聚合支付未配置完整（gateway/pid/key 或 appid/appsecret）");
  const cents = yuanToCents(order.price);
  if (!Number.isFinite(cents) || cents <= 0) throw new Error("订单金额无效");
  const title = orderTitle(order);
  const urls = resolveUrls(current, order);
  const provider = normalizeProvider(current.provider);
  if (provider === "epay") return epayCreate(order, current, cents, title, urls);
  if (provider === "xunhupay") return xunhupayCreate(order, current, cents, title, urls);
  if (provider === "custom") return customCreate(order, current, cents, title, urls);
  throw new Error(`未知支付协议: ${current.provider}`);
}

// ============================================================
// 回调验签
// ============================================================

function failNotify(reason, params) {
  return { ok: false, reason, outTradeNo: "", amount: 0, tradeState: "", raw: params || {} };
}

function verifyEpay(params, cfg) {
  if (!params.sign) return failNotify("缺少 sign", params);
  if (!cfg.key) return failNotify("未配置签名密钥", params);
  const expected = md5(canonicalString(params) + cfg.key);
  if (!safeEqual(params.sign, expected)) return failNotify("签名校验失败", params);
  // 签名通过后再校验商户号，避免把风控信息泄露给伪造请求
  if (cfg.pid && params.pid != null && String(params.pid) !== String(cfg.pid)) {
    return failNotify("商户号不匹配", params);
  }
  const amount = yuanToCents(params.money);
  if (!Number.isFinite(amount) || amount < 0) return failNotify("金额格式错误", params);
  return {
    ok: true,
    outTradeNo: String(params.out_trade_no || ""),
    amount,
    tradeState: String(params.trade_status || ""),
    raw: params
  };
}

function verifyXunhupay(params, cfg) {
  if (!params.hash) return failNotify("缺少 hash", params);
  if (!cfg.appsecret) return failNotify("未配置 appsecret", params);
  const expected = md5(canonicalString(params) + cfg.appsecret);
  if (!safeEqual(params.hash, expected)) return failNotify("签名校验失败", params);
  if (cfg.appid && params.appid != null && String(params.appid) !== String(cfg.appid)) {
    return failNotify("appid 不匹配", params);
  }
  const amount = yuanToCents(params.total_fee);
  if (!Number.isFinite(amount) || amount < 0) return failNotify("金额格式错误", params);
  return {
    ok: true,
    outTradeNo: String(params.trade_order_id || ""),
    amount,
    tradeState: String(params.status || ""),
    raw: params
  };
}

function verifyCustom(params, cfg, rawBody) {
  if (!cfg.key) return failNotify("未配置签名密钥", params);
  // 优先按「原始请求体」验签（真实网关通常这么签）；没拿到 rawBody 时回退到规范化 k=v 串，
  // 这样 Lead 即使只传 params 也能验签，不要求 index.js 额外接线。
  let source = params;
  let message;
  if (rawBody !== undefined && rawBody !== null) {
    message = String(rawBody);
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return failNotify("rawBody 不是合法 JSON", params);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return failNotify("rawBody 结构错误", params);
    }
    // 防解析差异攻击：验签用 rawBody 时，入账字段也必须来自 rawBody；
    // 若调用方同时传了 params，则要求两者（除 sign 外）逐字段一致。
    if (Object.keys(params).length > 0 && canonicalString(parsed) !== canonicalString(params)) {
      return failNotify("参数与原始报文不一致", params);
    }
    source = parsed;
  } else {
    message = canonicalString(params);
  }
  // 签名可能放在 JSON body 里，也可能由调用方从请求头取出后放进 params（签名不参与一致性比对）
  const sign = source.sign || params.sign;
  if (!sign) return failNotify("缺少 sign", source);
  const expected = hmacSha256(message, cfg.key);
  if (!safeEqual(sign, expected)) return failNotify("签名校验失败", source);
  const amount = Math.round(Number(source.amount));
  if (!Number.isFinite(amount) || amount < 0) return failNotify("金额格式错误", source);
  return {
    ok: true,
    outTradeNo: String(source.out_trade_no || ""),
    amount,
    tradeState: String(source.status || ""),
    raw: source
  };
}

/**
 * 回调验签（加算力前的唯一校验入口）。
 * 返回 { ok, reason?, outTradeNo, amount(分), tradeState, raw }。
 * custom 协议可选传 rawBody 以按原始字节验 HMAC。
 */
export function verifyNotify({ provider, params, rawBody } = {}) {
  const prov = normalizeProvider(provider);
  const input = params && typeof params === "object" ? params : {};
  try {
    const cfg = loadConfig();
    if (prov === "epay") return verifyEpay(input, cfg);
    if (prov === "xunhupay") return verifyXunhupay(input, cfg);
    if (prov === "custom") return verifyCustom(input, cfg, rawBody);
    return failNotify(`未知支付协议: ${provider}`, input);
  } catch (err) {
    return failNotify(err.message || "回调验签异常", input);
  }
}

// ============================================================
// 主动查单
// ============================================================

function queryFail(reason, outTradeNo) {
  return { ok: false, paid: false, amount: 0, tradeNo: String(outTradeNo || ""), reason, raw: null };
}

async function epayQuery(outTradeNo, cfg) {
  const url =
    `${cfg.gateway}/api.php?act=order` +
    `&pid=${encodeURIComponent(cfg.pid)}` +
    `&key=${encodeURIComponent(cfg.key)}` +
    `&out_trade_no=${encodeURIComponent(outTradeNo)}`;
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, paid: false, amount: 0, tradeNo: outTradeNo, reason: "易支付查单返回非 JSON", raw: text.slice(0, 300) };
  }
  const data = json.data && typeof json.data === "object" ? json.data : json;
  const paid =
    Number(data.status) === 1 ||
    data.status === true ||
    String(data.status || "").toLowerCase() === "paid" ||
    String(data.trade_status || "") === "TRADE_SUCCESS";
  const amount = yuanToCents(data.money ?? data.total_amount ?? 0);
  return {
    ok: true,
    paid,
    amount: Number.isFinite(amount) ? amount : 0,
    tradeNo: String(data.trade_no || outTradeNo),
    raw: json
  };
}

async function xunhupayQuery(outTradeNo, cfg) {
  const params = {
    appid: cfg.appid,
    out_trade_no: outTradeNo,
    time: String(Math.floor(Date.now() / 1000)),
    nonce_str: crypto.randomBytes(8).toString("hex")
  };
  const { sign: hash } = signParams(params, "xunhupay", cfg.appsecret);
  const body = new URLSearchParams({ ...params, hash }).toString();
  const res = await fetch(`${cfg.gateway}/payment/query.html`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const json = await readJsonResponse(res, "虎皮椒查单");
  if (Number(json.errcode) !== 0) {
    return { ok: true, paid: false, amount: 0, tradeNo: outTradeNo, reason: json.errmsg || "", raw: json };
  }
  const data = json.data && typeof json.data === "object" ? json.data : {};
  const status = String(data.status || "");
  const paid = status === "OD" || status === "CD"; // 契约：OD/CD 视为支付成功
  const amount = yuanToCents(data.total_fee ?? 0);
  return {
    ok: true,
    paid,
    amount: Number.isFinite(amount) ? amount : 0,
    tradeNo: String(data.transaction_id || data.open_order_id || outTradeNo),
    raw: json
  };
}

async function customQuery(outTradeNo, cfg) {
  const queryUrl = cfg.queryUrl || `${cfg.gateway}/payment/query`;
  const rawBody = JSON.stringify({ out_trade_no: outTradeNo });
  const sign = hmacSha256(rawBody, cfg.key);
  const res = await fetch(queryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agg-Sign": sign },
    body: rawBody,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const json = await readJsonResponse(res, "自建聚合查单");
  if (!res.ok) return { ok: false, paid: false, amount: 0, tradeNo: outTradeNo, reason: json.message || `HTTP ${res.status}`, raw: json };
  const data = json.data && typeof json.data === "object" ? json.data : json;
  const paid = String(data.status || "").toLowerCase() === "paid";
  const amount = Math.round(Number(data.amount ?? 0)); // 自建聚合金额字段本身就是分
  return {
    ok: true,
    paid,
    amount: Number.isFinite(amount) ? amount : 0,
    tradeNo: String(data.trade_no || data.tradeNo || outTradeNo),
    raw: json
  };
}

/**
 * 主动查单：回调丢了也能靠它补单。
 * 返回 { ok, paid, amount(分), tradeNo, raw }；网络/协议层异常不抛错，用 ok:false + reason 返回，
 * 方便充值自动任务记报告而不是整轮任务中断。
 */
export async function queryOrder(outTradeNo, { cfg } = {}) {
  const orderId = String(outTradeNo || "").trim();
  const current = cfg && typeof cfg === "object" ? cfg : loadConfig();
  if (!orderId) return queryFail("缺少订单号", "");
  if (!isConfigured(current)) return queryFail("聚合支付未配置完整", orderId);
  const provider = normalizeProvider(current.provider);
  try {
    if (provider === "epay") return await epayQuery(orderId, current);
    if (provider === "xunhupay") return await xunhupayQuery(orderId, current);
    if (provider === "custom") return await customQuery(orderId, current);
    return queryFail(`未知支付协议: ${current.provider}`, orderId);
  } catch (err) {
    return queryFail(err.message || "查单失败", orderId);
  }
}

// ============================================================
// 连通性测试
// ============================================================

/**
 * 测试网关连通性 / 配置完整性。
 * 返回 { ok, provider, latencyMs, message }；只打出口请求，不产生交易。
 */
export async function testConnection(cfg) {
  const current = cfg && typeof cfg === "object" ? cfg : loadConfig();
  const provider = normalizeProvider(current.provider);
  const startedAt = Date.now();
  if (!validProvider(provider)) {
    return { ok: false, provider, latencyMs: 0, message: `未知支付协议: ${current.provider || "（空）"}` };
  }
  if (!isConfigured(current)) {
    return { ok: false, provider, latencyMs: 0, message: "聚合支付配置不完整（协议参数或密钥缺失）" };
  }
  const target =
    provider === "custom" ? String(current.createUrl || "") || stripSlash(current.gateway) : stripSlash(current.gateway);
  if (!target) {
    return { ok: false, provider, latencyMs: 0, message: "未配置网关地址" };
  }
  try {
    const res = await fetch(target, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    try {
      await res.text();
    } catch {
      /* 忽略 */
    }
    const latencyMs = Date.now() - startedAt;
    // 能拿到 <500 的 HTTP 响应就说明网络与网关可达（404/403 也算可达，不算配置正确性）
    const ok = res.status < 500;
    return {
      ok,
      provider,
      latencyMs,
      message: ok ? `连接正常（HTTP ${res.status}）` : `网关异常（HTTP ${res.status}）`
    };
  } catch (err) {
    return {
      ok: false,
      provider,
      latencyMs: Date.now() - startedAt,
      message: `连接失败：${err?.message || err}`
    };
  }
}
