// 聚合支付后台接口：通道状态查看 / 配置保存 / 连通性测试
//
// 与 admin.js 保持同一套写法：requireLogin + requirePerm 双层校验，写操作落审计。
// 安全红线：
//  1. 任何响应都不得包含 key / appsecret 明文，只回 keySet / appsecretSet；
//  2. 审计明细同样不能带密钥（只记字段名与布尔状态）；
//  3. 当前生效通道的切换写 pay-config.json 顶层 provider，供 payments.js 的 activeGateway 读取。
import fs from "node:fs";
import { dataFile, HOME } from "./paths.js";
import * as audit from "./audit.js";
import { loadConfig, saveConfig, maskedConfig, testConnection } from "./payment-aggregator.js";
import { payStatus } from "./payments.js";

const ACTIVE_PROVIDERS = ["", "aggregator", "wechat", "alipay"];
const PAY_CONFIG_FILE = () => dataFile("pay-config.json");

function ctx(req, user) {
  return {
    username: user?.username || "-",
    ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim(),
    ua: req.headers["user-agent"] || ""
  };
}

function readPayFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PAY_CONFIG_FILE(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writePayFile(obj) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(PAY_CONFIG_FILE(), JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(PAY_CONFIG_FILE(), 0o600);
  } catch {
    /* Windows 只支持只读位，忽略 */
  }
}

/** 当前生效通道：只允许 ""（自动）/ aggregator / wechat / alipay */
function normalizeActiveProvider(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const provider = raw === "auto" ? "" : raw;
  if (!ACTIVE_PROVIDERS.includes(provider)) throw new Error(`未知支付通道: ${value}`);
  return provider;
}

function writeActiveProvider(provider) {
  const fileCfg = readPayFile();
  fileCfg.provider = provider;
  writePayFile(fileCfg);
}

/**
 * 组装通道状态。
 * mode / sandbox / hint 以 payments.js 的 payStatus() 为准（Lead 接线后聚合支付会出现在这里），
 * aggregator 细节用 maskedConfig()，wechat/alipay 只暴露「是否已配置」的布尔位。
 */
function buildChannels() {
  let status = { mode: "sandbox", sandbox: true, configured: {}, hint: "未配置支付凭证，当前为沙箱模式。" };
  try {
    status = payStatus();
  } catch {
    /* 兼容 payments.js 未接线/抛错的场景，退回沙箱描述 */
  }
  const fileCfg = readPayFile();
  const wechat = fileCfg.wechat && typeof fileCfg.wechat === "object" ? fileCfg.wechat : {};
  const alipay = fileCfg.alipay && typeof fileCfg.alipay === "object" ? fileCfg.alipay : {};
  const env = process.env;
  const aggregator = maskedConfig();
  const mode = status.mode || (aggregator.configured ? "aggregator" : "sandbox");
  let hint = status.hint || (aggregator.configured ? "聚合支付已配置" : "未配置支付凭证，当前为沙箱模式。");
  if (aggregator.configured && mode === "sandbox") {
    hint = "聚合支付配置已完整，但当前生效通道仍是沙箱。";
  }
  if (env.PAY_PROVIDER) {
    hint = `${hint}（环境变量 PAY_PROVIDER 已固定当前通道）`;
  }
  return {
    mode,
    sandbox: Boolean(status.sandbox ?? mode === "sandbox"),
    channels: {
      wechat: {
        configured: Boolean(status.configured?.wechat),
        mchIdSet: Boolean(env.WXPAY_MCHID || wechat.mchId),
        appIdSet: Boolean(env.WXPAY_APPID || wechat.appId),
        apiV3KeySet: Boolean(env.WXPAY_APIV3_KEY || wechat.apiV3Key),
        privateKeySet: Boolean(env.WXPAY_PRIVATE_KEY || wechat.privateKey),
        platformPublicKeySet: Boolean(env.WXPAY_PLATFORM_PUBLIC_KEY || wechat.platformPublicKey)
      },
      alipay: {
        configured: Boolean(status.configured?.alipay),
        appIdSet: Boolean(env.ALIPAY_APP_ID || alipay.appId),
        privateKeySet: Boolean(env.ALIPAY_PRIVATE_KEY || alipay.privateKey),
        alipayPublicKeySet: Boolean(env.ALIPAY_PUBLIC_KEY || alipay.alipayPublicKey)
      },
      aggregator
    },
    hint
  };
}

/**
 * 挂载聚合支付后台路由。
 * @param app Express 实例
 * @param {{requirePerm: Function, requireLogin: Function}} deps 由 index.js 注入，与 mountAdmin 一致
 */
export function mountPaymentAdmin(app, { requirePerm, requireLogin } = {}) {
  if (!app || typeof app.get !== "function" || typeof app.put !== "function") {
    throw new Error("mountPaymentAdmin 需要 express app");
  }
  if (typeof requirePerm !== "function" || typeof requireLogin !== "function") {
    throw new Error("mountPaymentAdmin 需要 requirePerm / requireLogin");
  }

  // 与 admin.js 的 wrap 等价，额外兼容 async handler（Error 统一 400 + {error}）
  const wrap = (fn) => (req, res) => {
    const fail = (err) => {
      if (!res.headersSent) res.status(400).json({ error: err?.message || "操作失败" });
    };
    try {
      const out = fn(req, res);
      if (out && typeof out.then === "function") {
        // 返回 promise 便于上层/测试等待，也保证 res.json 只执行一次
        return out
          .then((data) => {
            if (data !== undefined && !res.headersSent) res.json(data);
          })
          .catch(fail);
      }
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      fail(err);
    }
  };

  const log = (req, action, detail = {}) =>
    audit.record("admin.action", { action, ...detail }, ctx(req, req.user));

  // ---------- 查看通道状态 ----------
  app.get(
    "/api/admin/payment/channels",
    requireLogin,
    requirePerm("admin:payment:view"),
    wrap(() => buildChannels())
  );

  // ---------- 保存通道配置 ----------
  app.put(
    "/api/admin/payment/channels",
    requireLogin,
    requirePerm("admin:payment:config"),
    wrap((req) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const hasProvider = Object.prototype.hasOwnProperty.call(body, "provider");
      const hasAggregator =
        body.aggregator && typeof body.aggregator === "object" && !Array.isArray(body.aggregator);
      if (!hasProvider && !hasAggregator) throw new Error("没有可保存的支付配置");

      // 先校验再落盘：别出现「provider 非法写了一半」的状态
      const nextProvider = hasProvider ? normalizeActiveProvider(body.provider) : undefined;
      const patch = hasAggregator ? { ...body.aggregator } : null;

      if (patch) saveConfig(patch); // 只写 aggregator 段，保留 wechat/alipay
      if (hasProvider) writeActiveProvider(nextProvider); // 再写顶层 provider，两者互不覆盖

      const status = buildChannels();
      // 审计只记「改了哪些字段 + 密钥是否已设置」，绝不落明文密钥
      log(req, "payment.channel.save", {
        provider: status.mode,
        activeProvider: hasProvider ? nextProvider : "(未变)",
        aggregatorProvider: status.channels.aggregator.provider,
        changed: patch
          ? Object.keys(patch).filter((key) => key !== "key" && key !== "appsecret")
          : [],
        secretFields: patch ? Object.keys(patch).filter((key) => key === "key" || key === "appsecret") : [],
        keySet: status.channels.aggregator.keySet,
        appsecretSet: status.channels.aggregator.appsecretSet
      });
      // 契约：{ok, channels}；额外带上 mode/sandbox/hint 方便前端保存后直接刷新状态
      return { ok: true, ...status };
    })
  );

  // ---------- 连通性测试（只读操作，不写审计） ----------
  app.post(
    "/api/admin/payment/channels/test",
    requireLogin,
    requirePerm("admin:payment:config"),
    wrap(async (req) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const base = loadConfig();
      const wanted = String(body.provider ?? "").trim();
      const provider = wanted ? wanted.toLowerCase() : base.provider;
      return testConnection({ ...base, provider });
    })
  );
}
