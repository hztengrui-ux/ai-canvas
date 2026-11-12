// 支付网关适配层
//
// 支持：微信 Native 扫码支付 / 支付宝当面付 / 沙箱（无凭证时的本地模拟）
//
// 三条硬规则（这是上一版缺失、也是 P0 安全问题）：
//  1. 加算力只能由「验签通过的回调」触发，绝不接受前端直接调用
//  2. 回调必须验签 + 校验金额 + 幂等
//  3. 主动查单兜底：回调丢了也能靠轮询补上
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataFile } from "./paths.js";
import * as agg from "./payment-aggregator.js";

const KEY_DIR = dataFile("pay-keys");

// ---------- 配置读取 ----------
// 优先环境变量，其次 ~/.ai-canvas/pay-config.json
function loadPayConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(dataFile("pay-config.json"), "utf8"));
  } catch {
    /* 没配置文件 */
  }
  const env = process.env;
  return {
    provider: env.PAY_PROVIDER || fileCfg.provider || "", // wechat | alipay | ""
    notifyBaseUrl: env.PAY_NOTIFY_BASE_URL || fileCfg.notifyBaseUrl || "",

    wechat: {
      mchId: env.WXPAY_MCHID || fileCfg.wechat?.mchId || "",
      appId: env.WXPAY_APPID || fileCfg.wechat?.appId || "",
      serialNo: env.WXPAY_SERIAL_NO || fileCfg.wechat?.serialNo || "",
      apiV3Key: env.WXPAY_APIV3_KEY || fileCfg.wechat?.apiV3Key || "",
      // 商户私钥（PEM，用于签名）
      privateKey: env.WXPAY_PRIVATE_KEY || fileCfg.wechat?.privateKey || "",
      // 微信平台证书公钥（用于验回调）
      platformPublicKey: env.WXPAY_PLATFORM_PUBLIC_KEY || fileCfg.wechat?.platformPublicKey || ""
    },
    alipay: {
      appId: env.ALIPAY_APP_ID || fileCfg.alipay?.appId || "",
      privateKey: env.ALIPAY_PRIVATE_KEY || fileCfg.alipay?.privateKey || "",
      alipayPublicKey: env.ALIPAY_PUBLIC_KEY || fileCfg.alipay?.alipayPublicKey || "",
      gateway: env.ALIPAY_GATEWAY || fileCfg.alipay?.gateway || "https://openapi.alipay.com/gateway.do"
    }
  };
}

export function payStatus() {
  const c = loadPayConfig();
  const ready = {
    wechat: Boolean(c.wechat.mchId && c.wechat.privateKey && c.wechat.apiV3Key),
    alipay: Boolean(c.alipay.appId && c.alipay.privateKey && c.alipay.alipayPublicKey)
  };
  // 聚合支付配置读取要兜底：配置文件损坏/字段缺失时只影响聚合通道，不能拖垮整个支付状态接口
  let aggregator = null;
  try {
    aggregator = agg.maskedConfig();
    ready.aggregator = agg.isConfigured();
  } catch {
    ready.aggregator = false;
  }
  const { gw } = activeGateway();
  const mode = gw.id;
  return {
    mode,
    configured: ready,
    // 沙箱模式说明：可以完整走通下单→回调→到账，但不产生真实交易
    sandbox: mode === "sandbox",
    // 只回显脱敏后的聚合配置（key/appsecret 永远不出服务端）
    aggregator: aggregator
      ? {
          provider: aggregator.provider,
          gateway: aggregator.gateway,
          pid: aggregator.pid,
          keySet: aggregator.keySet,
          appid: aggregator.appid,
          appsecretSet: aggregator.appsecretSet,
          notifyBaseUrl: aggregator.notifyBaseUrl,
          returnBaseUrl: aggregator.returnBaseUrl,
          methods: aggregator.methods,
          configured: ready.aggregator
        }
      : null,
    hint:
      mode === "sandbox"
        ? "未配置支付凭证，当前为沙箱模式。填写商户号与密钥后自动切换到真实支付。"
        : mode === "aggregator"
          ? `已启用第三方聚合支付（${aggregator?.provider || "聚合"}）`
          : `已启用${mode === "wechat" ? "微信" : "支付宝"}支付`
  };
}

// ---------- 沙箱密钥（首次自动生成，用于本地完整验证签名流程） ----------
function sandboxKeys() {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const priv = path.join(KEY_DIR, "sandbox-private.pem");
  const pub = path.join(KEY_DIR, "sandbox-public.pem");
  if (!fs.existsSync(priv) || !fs.existsSync(pub)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    fs.writeFileSync(priv, privateKey, { mode: 0o600 });
    fs.writeFileSync(pub, publicKey, { mode: 0o600 });
  }
  return { privateKey: fs.readFileSync(priv, "utf8"), publicKey: fs.readFileSync(pub, "utf8") };
}

// ============================================================
// 微信 Native 支付（APIv3）
// ============================================================
const wx = {
  id: "wechat",
  label: "微信支付",

  /** 签名串构造（微信 V3 规范） */
  buildSignStr(method, url, timestamp, nonce, body) {
    return `${method}\n${url}\n${timestamp}\n${nonce}\n${body}\n`;
  },

  sign({ method, url, body, privateKey }) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const message = wx.buildSignStr(method, url, timestamp, nonce, body);
    const signature = crypto.createSign("RSA-SHA256").update(message).sign(privateKey, "base64");
    return `WECHATPAY2-SHA256-RSA2048 mchid="${loadPayConfig().wechat.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${loadPayConfig().wechat.serialNo}"`;
  },

  /**
   * 回调验签。
   * 微信回调头：Wechatpay-Timestamp / Wechatpay-Nonce / Wechatpay-Signature / Wechatpay-Serial
   * 验签串：timestamp\nnonce\nbody\n
   */
  verifyCallback({ rawBody, headers, platformPublicKey }) {
    const timestamp = headers["wechatpay-timestamp"];
    const nonce = headers["wechatpay-nonce"];
    const signature = headers["wechatpay-signature"];
    if (!timestamp || !nonce || !signature) {
      return { ok: false, reason: "缺少微信签名头" };
    }
    // 防重放：时间戳超过 5 分钟拒绝
    const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(skew) || skew > 300) {
      return { ok: false, reason: "回调时间戳超出允许范围" };
    }
    const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
    const valid = crypto
      .createVerify("RSA-SHA256")
      .update(message)
      .verify(platformPublicKey, signature, "base64");
    return valid ? { ok: true } : { ok: false, reason: "微信签名校验失败" };
  },

  /** 解密回调里的 resource（AES-256-GCM） */
  decryptResource(resource, apiV3Key) {
    const { ciphertext, nonce, associated_data: aad } = resource;
    const buf = Buffer.from(ciphertext, "base64");
    const authTag = buf.subarray(buf.length - 16);
    const data = buf.subarray(0, buf.length - 16);
    const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce));
    d.setAuthTag(authTag);
    d.setAAD(Buffer.from(aad || ""));
    return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
  },

  async createPayment(order, cfg) {
    const url = "/v3/pay/transactions/native";
    const bodyObj = {
      appid: cfg.wechat.appId,
      mchid: cfg.wechat.mchId,
      description: `算力充值 ${order.credits} 点`,
      out_trade_no: order.id,
      notify_url: `${cfg.notifyBaseUrl}/api/recharge/callback/wechat`,
      amount: { total: Math.round(order.price * 100), currency: "CNY" } // 微信单位：分
    };
    const body = JSON.stringify(bodyObj);
    const auth = wx.sign({ method: "POST", url, body, privateKey: cfg.wechat.privateKey });
    const res = await fetch(`https://api.mch.weixin.qq.com${url}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: auth
      },
      body
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "微信下单失败");
    return { qrCode: data.code_url, tradeNo: data.code_url, raw: data };
  }
};

// ============================================================
// 支付宝当面付（precreate）
// ============================================================
const ali = {
  id: "alipay",
  label: "支付宝",

  /** 参数按 key 升序拼接成待签串 */
  buildSignStr(params) {
    return Object.keys(params)
      .filter((k) => k !== "sign" && params[k] !== "" && params[k] != null)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
  },

  sign(params, privateKey) {
    const message = ali.buildSignStr(params);
    return crypto.createSign("RSA-SHA256").update(message, "utf8").sign(privateKey, "base64");
  },

  verifyCallback(params, alipayPublicKey) {
    const { sign, sign_type: signType, ...rest } = params;
    if (!sign) return { ok: false, reason: "缺少 sign" };
    const message = ali.buildSignStr(rest);
    const valid = crypto
      .createVerify("RSA-SHA256")
      .update(message, "utf8")
      .verify(alipayPublicKey, sign, "base64");
    return valid ? { ok: true } : { ok: false, reason: "支付宝签名校验失败" };
  },

  async createPayment(order, cfg) {
    const params = {
      app_id: cfg.alipay.appId,
      method: "alipay.trade.precreate",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
      version: "1.0",
      notify_url: `${cfg.notifyBaseUrl}/api/recharge/callback/alipay`,
      biz_content: JSON.stringify({
        out_trade_no: order.id,
        total_amount: order.price.toFixed(2),
        subject: `算力充值 ${order.credits} 点`
      })
    };
    params.sign = ali.sign(params, cfg.alipay.privateKey);

    const body = new URLSearchParams(params).toString();
    const res = await fetch(cfg.alipay.gateway, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body
    });
    const data = await res.json();
    const resp = data.alipay_trade_precreate_response;
    if (!resp || resp.code !== "10000") {
      throw new Error(resp?.sub_msg || resp?.msg || "支付宝下单失败");
    }
    return { qrCode: resp.qr_code, tradeNo: resp.out_trade_no, raw: data };
  }
};

// ============================================================
// 沙箱：本地完整跑通「下单 → 回调验签 → 到账」
// ============================================================
const sandbox = {
  id: "sandbox",
  label: "沙箱支付（未配置凭证）",

  async createPayment(order) {
    const { privateKey } = sandboxKeys();
    // 生成一个真实可验的签名，供本地走完整回调链路
    const payload = JSON.stringify({ out_trade_no: order.id, total: order.price });
    const sig = crypto.createSign("RSA-SHA256").update(payload).sign(privateKey, "base64");
    return {
      qrCode: `sandbox://pay?order=${order.id}&sig=${encodeURIComponent(sig).slice(0, 24)}`,
      tradeNo: `sandbox_${order.id}`,
      sandbox: true,
      payload,
      signature: sig
    };
  },

  verifyCallback({ rawBody, headers }) {
    const signature = headers["x-sandbox-signature"];
    const payload = headers["x-sandbox-payload"] || rawBody;
    if (!signature || !payload) return { ok: false, reason: "缺少沙箱签名头" };
    const { publicKey } = sandboxKeys();
    const valid = crypto
      .createVerify("RSA-SHA256")
      .update(payload)
      .verify(publicKey, signature, "base64");
    return valid ? { ok: true } : { ok: false, reason: "沙箱签名校验失败" };
  }
};

// ============================================================
// 第三方聚合支付（易支付 / 蓝兔 / 虎皮椒 / 自建聚合）
// 协议细节与验签实现都在 payment-aggregator.js，这里只做网关适配。
// ============================================================
const aggregator = {
  id: "aggregator",
  label: "第三方聚合支付",

  async createPayment(order) {
    const r = await agg.createPayment(order);
    // 易支付/虎皮椒返回的是「跳转收银台」链接；能拿到二维码就一并返回
    return {
      payUrl: r.payUrl,
      qrCode: r.qrCode || "",
      tradeNo: r.tradeNo,
      mode: r.mode,
      provider: r.provider,
      raw: r.raw
    };
  }
};

// ============================================================
// 对外统一接口
// ============================================================
const GATEWAYS = { wechat: wx, alipay: ali, sandbox, aggregator };

function aggregatorReady() {
  try {
    return agg.isConfigured();
  } catch {
    return false;
  }
}

/** 当前生效的网关（有凭证用真实，没有用沙箱） */
export function activeGateway() {
  const c = loadPayConfig();
  const id = c.provider && GATEWAYS[c.provider] ? c.provider : "";
  if (id === "aggregator" && aggregatorReady()) return { gw: aggregator, cfg: c };
  if (id === "wechat" && c.wechat.mchId && c.wechat.privateKey) return { gw: wx, cfg: c };
  if (id === "alipay" && c.alipay.appId && c.alipay.privateKey) return { gw: ali, cfg: c };
  // 自动探测：聚合支付优先（它是统一收银台，配了就是要用它），其次微信/支付宝直连
  if (aggregatorReady()) return { gw: aggregator, cfg: c };
  if (c.wechat.mchId && c.wechat.privateKey && c.wechat.apiV3Key) return { gw: wx, cfg: c };
  if (c.alipay.appId && c.alipay.privateKey && c.alipay.alipayPublicKey) return { gw: ali, cfg: c };
  return { gw: sandbox, cfg: c };
}

export async function createPayment(order) {
  const { gw, cfg } = activeGateway();
  const r = await gw.createPayment(order, cfg);
  return { gateway: gw.id, ...r };
}

/**
 * 校验回调。
 * ⚠️ 这个函数是「加算力」的唯一合法入口。
 *    调用方必须先通过它，才能调 credits.markPaid。
 *    返回 Promise：聚合支付的 provider/配置需要异步/动态读取，统一 async 更好接线。
 */
export async function verifyCallback({ gateway, rawBody, headers, params }) {
  const c = loadPayConfig();
  if (gateway === "aggregator") {
    // provider 只从服务端配置读取，绝不信任回调里自报的协议名
    let cfg;
    try {
      cfg = agg.loadConfig();
    } catch (e) {
      return { ok: false, reason: `聚合支付配置读取失败: ${e.message}` };
    }
    const v = agg.verifyNotify({ provider: cfg.provider, params, rawBody });
    if (!v.ok) return v;
    // 虎皮椒成功态是 OD/CD，统一映射成 SUCCESS，下游只认一种成功态
    const st = ["OD", "CD"].includes(String(v.tradeState)) ? "SUCCESS" : v.tradeState;
    return { ok: true, outTradeNo: v.outTradeNo, amount: v.amount, tradeState: st };
  }
  if (gateway === "wechat") {
    const v = wx.verifyCallback({ rawBody, headers, platformPublicKey: c.wechat.platformPublicKey });
    if (!v.ok) return v;
    try {
      const body = JSON.parse(rawBody);
      const data = wx.decryptResource(body.resource, c.wechat.apiV3Key);
      return { ok: true, outTradeNo: data.out_trade_no, amount: data.amount?.total, tradeState: data.trade_state };
    } catch (e) {
      return { ok: false, reason: `微信回调解密失败: ${e.message}` };
    }
  }
  if (gateway === "alipay") {
    const v = ali.verifyCallback(params, c.alipay.alipayPublicKey);
    if (!v.ok) return v;
    return {
      ok: true,
      outTradeNo: params.out_trade_no,
      amount: Math.round(Number(params.total_amount) * 100),
      tradeState: params.trade_status
    };
  }
  const v = sandbox.verifyCallback({ rawBody, headers });
  if (!v.ok) return v;
  try {
    const data = JSON.parse(rawBody);
    return { ok: true, outTradeNo: data.out_trade_no, amount: Math.round(data.total * 100), tradeState: "SUCCESS" };
  } catch {
    return { ok: false, reason: "沙箱回调体解析失败" };
  }
}

/** 沙箱模式下发一张「模拟回调」的签名头，仅用于本地演示 */
export function sandboxNotifyHeaders(order) {
  const { privateKey } = sandboxKeys();
  const payload = JSON.stringify({ out_trade_no: order.id, total: order.price });
  const sig = crypto.createSign("RSA-SHA256").update(payload).sign(privateKey, "base64");
  return { "x-sandbox-payload": payload, "x-sandbox-signature": sig };
}
