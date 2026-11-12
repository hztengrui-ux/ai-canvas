// 本地网关安全层：Host 校验（防 DNS rebinding）、Origin 校验（防跨站调用）、
// 会话令牌、令牌桶限流、并发上限、每日生成预算熔断。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { dataFile } from "./paths.js";
import { allowedLocalPorts } from "./ports.js";

export const SESSION_COOKIE = "aic_session";
const TOKEN_HEADER = "x-ai-canvas-token";

// 会话令牌：持久化，保证桌面端重启后仍能识别已登录的会话。
// 令牌文件权限 0600（仅当前用户可读），且服务只绑定 127.0.0.1。
// 若每次启动都随机生成，落盘的登录会话会因令牌变化而失效，
// 结果就是「每次打开桌面端都要重新登录」。
const TOKEN_FILE = dataFile(".session-token");

function loadOrCreateSessionToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {
    /* 首次运行 */
  }
  const t = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, t, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* 写不了就退回内存态 */
  }
  return t;
}

const SESSION_TOKEN = loadOrCreateSessionToken();

// ---------- 每会话双令牌（进程级，不落盘） ----------
//
// 三个令牌的分工（之前只有一个，读写不分家）：
//   SESSION_TOKEN   持久化。代表「谁在这个浏览器里登录着」——必须落盘，
//                   否则桌面端每次重启都要重新登录（见上面的注释）。
//   RUNTIME_TOKEN   每次进程启动随机。代表「这个端口上的服务确实是我刚拉起的那一个」。
//                   主进程用它校验就绪探针的响应头：端口被别的程序占用时不会误判就绪。
//   MUTATION_TOKEN  每次进程启动随机。代表「这次写操作来自被主进程授权的渲染进程」。
//                   由主进程经 IPC 下发给页面，所有变更类接口必须携带。
//
// Electron 主进程在 fork 服务时把后两者注入环境变量（父进程 → 子进程单向），
// 因此两端天然共享同一份随机值，且不经过磁盘、不进日志。
//
// 未注入时（开发态 `npm run dev`、浏览器直连、测试进程）变更令牌层不启用：
// 保持单机工具原有行为，也避免把既有测试全部打红。这与参考实现一致 ——
// 「配置了才强制」，而不是「默认把所有人挡在外面」。
const RUNTIME_HEADER = "x-ai-canvas-runtime-token";
const MUTATION_HEADER = "x-ai-canvas-mutation-token";

function readInjectedToken(envValue) {
  const s = String(envValue || "").trim();
  return /^[0-9a-f]{64}$/.test(s) ? s : "";
}

export const RUNTIME_TOKEN =
  readInjectedToken(process.env.AI_CANVAS_RUNTIME_TOKEN) || crypto.randomBytes(32).toString("hex");
export const MUTATION_TOKEN =
  readInjectedToken(process.env.AI_CANVAS_MUTATION_TOKEN) || crypto.randomBytes(32).toString("hex");
export const MUTATION_ENFORCED = Boolean(readInjectedToken(process.env.AI_CANVAS_MUTATION_TOKEN));

export function runtimeToken() {
  return RUNTIME_TOKEN;
}

export function mutationToken() {
  return MUTATION_TOKEN;
}

// 无需本地令牌即可读的接口（仅限无敏感信息的公开读）
// 登录页在认证之前就要拿品牌与支付通道状态
const PUBLIC_READ = new Set(["/api/brand", "/api/recharge/pay-status"]);
// 手机端登录：这时候还没有任何令牌，必须能进；安全由「账号密码 + 失败锁定 + 限流」保证。
PUBLIC_READ.add("/api/m/auth/login");

const LOCAL_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// 允许的本机端口。
// 必须把「服务自己实际监听的端口」也算进来：桌面端会动态选端口（避免 5181
// 被占用时启动失败），白标多品牌还会派生不同端口段（见 ports.js）。
// 因此这份集合统一由 ports.js 计算：显式列表 + PORT + 品牌派生端口。
// 如果这里只认写死的 5180/5181，服务就会把自己的请求以 BAD_HOST 拦掉，
// 表现为 Electron 一直等不到服务就绪。
const ALLOWED_PORTS = allowedLocalPorts();

// ---------- 嵌入模式 ----------
// 默认关闭：只有显式配置了可信父页面来源时才放开，保持单机工具的严格默认。
//   AI_CANVAS_EMBED_ORIGINS=https://crm.example.com,https://admin.example.com
//   AI_CANVAS_EMBED_HOSTS=canvas.example.com   （可选；默认从 origins 推导）
const EMBED_ORIGINS = new Set(
  String(process.env.AI_CANVAS_EMBED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean)
);

const EMBED_HOSTS = new Set(
  (process.env.AI_CANVAS_EMBED_HOSTS
    ? String(process.env.AI_CANVAS_EMBED_HOSTS).split(",")
    : [...EMBED_ORIGINS].map((o) => {
        try {
          return new URL(o).host;
        } catch {
          return "";
        }
      })
  )
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

export const EMBED_MODE = EMBED_ORIGINS.size > 0;

const USAGE_FILE = dataFile("usage.json");

// ---------- 基础工具 ----------
function parseHost(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const m = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::(\d+))?$/.exec(value.trim().toLowerCase());
  if (!m) return null;
  return { name: m[1], port: m[2] || "80" };
}

export function isLocalHost(value) {
  const parsed = parseHost(value);
  if (!parsed) return false;
  if (!LOCAL_NAMES.has(parsed.name)) return false;
  return ALLOWED_PORTS.has(parsed.port);
}

// ---------- 手机端（局域网） ----------
// 桌面端只认回环地址；手机端要能用 192.168.x.x 访问，所以这里单独开一条：
//   AI_CANVAS_MOBILE=1  或  AI_CANVAS_BIND=0.0.0.0（见 index.js）
// 只放行**私有网段**，公网 IP / 域名一律不走这条路（公网要走嵌入模式的白名单）。
export const MOBILE_MODE =
  String(process.env.AI_CANVAS_MOBILE || "") === "1" ||
  String(process.env.AI_CANVAS_BIND || "") === "0.0.0.0";

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** 是否来自私有网段的手机端请求（仅在 MOBILE_MODE 下成立） */
export function isMobileHost(value) {
  if (!MOBILE_MODE) return false;
  const parsed = parseHost(value);
  if (!parsed) return false;
  if (!PRIVATE_V4.test(parsed.name)) return false;
  // 端口仍限定在允许集合里：手机访问的是同一个服务，端口必然在名单内（ports.js 会把 PORT 算进去）
  return ALLOWED_PORTS.has(parsed.port);
}

/** 回环地址判断（用于「机器令牌只发给本机」这条硬边界） */
export function isLoopbackIp(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  // Express 在 IPv4-mapped 情况下会给 ::ffff:127.0.0.1
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  if (ip === "::1" || ip === "127.0.0.1") return true;
  return /^127\./.test(ip);
}

// 可信 Host：部署到域名（嵌入模式）时，Host 头会是该域名
function isTrustedHost(value) {
  if (!EMBED_HOSTS.size) return false;
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  if (EMBED_HOSTS.has(raw)) return true;
  const parsed = parseHost(raw);
  if (!parsed) return false;
  return EMBED_HOSTS.has(parsed.name) || EMBED_HOSTS.has(`${parsed.name}:${parsed.port}`);
}

function isAllowedOrigin(origin) {
  if (typeof origin !== "string" || !origin || origin === "null") return false;
  if (EMBED_ORIGINS.has(origin.replace(/\/+$/, ""))) return true;
  try {
    return isLocalHost(new URL(origin).host);
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------- 额外令牌校验器（手机端会话令牌） ----------
// 桌面端只认一枚「机器令牌」（SESSION_TOKEN）；手机端用的是账号会话令牌（m_ 前缀）。
// security.js 不能反过来 import accounts.js（会形成循环依赖），所以留一个钩子，
// 由 index.js 在启动时注册：setExtraTokenVerifier((t) => Boolean(accounts.currentUser(t)))
let extraTokenVerifier = null;

export function setExtraTokenVerifier(fn) {
  extraTokenVerifier = typeof fn === "function" ? fn : null;
}

function verifyExtra(token) {
  if (!extraTokenVerifier) return false;
  if (typeof token !== "string" || !token) return false;
  try {
    return Boolean(extraTokenVerifier(token));
  } catch {
    return false;
  }
}

function hasValidToken(req) {
  const header = req.headers[TOKEN_HEADER];
  if (typeof header === "string" && header) {
    if (safeEqual(header, SESSION_TOKEN)) return true;
    if (verifyExtra(header)) return true;
  }
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (cookie) {
    if (safeEqual(cookie, SESSION_TOKEN)) return true;
    if (verifyExtra(cookie)) return true;
  }
  return false;
}

// 取出请求携带的本地令牌原文（用于把账号会话绑定到这个令牌上）
export function readLocalToken(req) {
  const header = req.headers[TOKEN_HEADER];
  if (typeof header === "string" && header) {
    if (safeEqual(header, SESSION_TOKEN)) return SESSION_TOKEN;
    // 手机端：返回它自己那枚令牌，后续 accounts.currentUser(token) 才能解析出人。
    // 必须只在**校验通过之后**才返回，否则等于把任意 header 当凭据。
    if (verifyExtra(header)) return header;
  }
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (cookie) {
    if (safeEqual(cookie, SESSION_TOKEN)) return SESSION_TOKEN;
    if (verifyExtra(cookie)) return cookie;
  }
  return "";
}

export function localToken() {
  return SESSION_TOKEN;
}

// ---------- 中间件 ----------
function reject(res, status, error, code) {
  res.status(status).json({ error, code });
}

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // 每个响应回显本次运行的随机标识（非鉴权凭据，不授予任何权限）：
  // 主进程的就绪探针据此确认「这个端口上的服务确实是我 fork 出来的」，
  // 避免端口被别的程序占用时误判就绪。
  res.setHeader("X-AI-Canvas-Runtime-Token", RUNTIME_TOKEN);

  if (EMBED_MODE) {
    // 嵌入模式：用 CSP frame-ancestors 精确限定「谁可以嵌我」，而不是一刀切 DENY
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors 'self' ${[...EMBED_ORIGINS].join(" ")}`
    );
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  } else {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  }
  next();
}

export function guard(req, res, next) {
  // 1) Host 头必须可信 —— 防 DNS rebinding（本机地址，或嵌入模式下的白名单域名，
  //    或手机端联调时的私有网段地址）
  if (
    !isLocalHost(req.headers.host) &&
    !isTrustedHost(req.headers.host) &&
    !isMobileHost(req.headers.host)
  ) {
    return reject(res, 403, "拒绝访问：Host 头不在允许列表", "BAD_HOST");
  }
  // 2) 带 Origin 的跨站请求：只放行本机与嵌入白名单
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    return reject(res, 403, "拒绝访问：来源站点不被允许", "BAD_ORIGIN");
  }
  // 3) 静态资源到此为止，接口再验令牌
  if (!req.path.startsWith("/api/")) return next();
  if (req.path === "/api/session") return next();

  // 支付回调豁免本地令牌校验。
  // 回调来自支付网关的服务器，携带的是网关签名而不是本地会话令牌。
  // 这道防线由「回调验签」接管 —— 强度不低于令牌：令牌只能证明「本机浏览器」，
  // 签名能证明「请求确实来自支付网关」。
  if (req.path.startsWith("/api/recharge/callback/")) return next();

  // 无敏感信息的公开读接口：登录页在认证之前就要用
  if (PUBLIC_READ.has(req.path)) return next();

  if (!hasValidToken(req)) {
    return reject(res, 401, "会话已失效，请刷新创作台页面", "SESSION_REQUIRED");
  }
  next();
}

// ---------- 变更令牌门（只拦写操作） ----------
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// 写操作豁免：这些请求的凭据不是「本地渲染进程的变更令牌」
//   · 支付回调：来自支付网关服务器，凭回调验签（强度不低于令牌：令牌只证明
//     「本机浏览器」，签名能证明「请求确实来自网关」）
//   · 手机端 /api/m/*：手机不可能拿到主进程注入的变更令牌（那是 Electron 内存里的），
//     它的凭据是**自己的 m_ 会话令牌**，且只能走 header、不吃 cookie ——
//     没有 cookie 就没有 CSRF 面，变更令牌这一层对它没有意义。
//     ⚠️ 不加这条豁免，桌面版一开手机模式，小程序所有写操作都会 403，
//     现象是"能登录、能看图、但一点出图就失败"，极难定位。
const MUTATION_EXEMPT_PREFIXES = ["/api/recharge/callback/", "/api/m/"];

/**
 * 变更令牌校验（默认放行读、默认拒绝未授权写）。
 *
 * 设计取舍：
 *   · 只对「变更方法 + /api」生效 —— 静态资源、GET 查询不受影响，
 *     否则页面首屏与只读面板会被无谓地拦掉；
 *   · 只在主进程注入令牌时启用（MUTATION_ENFORCED）—— 浏览器/开发态保持原行为；
 *   · 比较用 timingSafeEqual，避免按字节提前返回的时序侧信道。
 */
export function mutationGuard(req, res, next) {
  if (!MUTATION_ENFORCED) return next();
  if (!req.path.startsWith("/api/")) return next();
  if (SAFE_METHODS.has(String(req.method || "").toUpperCase())) return next();
  if (MUTATION_EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();

  const got = req.headers[MUTATION_HEADER];
  if (typeof got === "string" && got && safeEqual(got, MUTATION_TOKEN)) return next();

  return reject(res, 403, "拒绝访问：缺少或错误的本地变更令牌", "MUTATION_TOKEN_REQUIRED");
}

export function sessionHandler(req, res) {
  // ⚠️ 手机端上线后必须补的边界：这枚机器令牌等价于「本机渲染进程」，
  // 它绕过账号密码、而且全站 /api 都认它。一旦服务监听到 0.0.0.0，
  // 局域网里任何设备只要 GET /api/session 就能拿到它 —— 等于把后门发给整个网段。
  // 所以只发给回环地址；手机端走 /api/m/auth/login 拿自己的 m_ 令牌。
  if (!isLocalHost(req.headers.host) && !isLoopbackIp(req.socket?.remoteAddress || req.ip)) {
    return reject(res, 403, "本机令牌只允许在本机获取", "LOCAL_ONLY");
  }
  // 嵌入模式下页面可能处于跨站 iframe 中，cookie 用 none 才可能被携带；
  // 但前端主链路走 header 令牌，不依赖 cookie，这里只在 HTTPS 下放宽。
  const embeddedSecure = EMBED_MODE && req.secure;
  res.cookie(SESSION_COOKIE, SESSION_TOKEN, {
    httpOnly: true,
    sameSite: embeddedSecure ? "none" : "strict",
    secure: embeddedSecure,
    path: "/",
    maxAge: 12 * 60 * 60 * 1000
  });
  res.json({ ok: true, token: SESSION_TOKEN, embedMode: EMBED_MODE });
}

// ---------- 限流 ----------
const buckets = new Map();

function takeToken(key, capacity, refillPerSec) {
  const now = Date.now();
  const bucket = buckets.get(key) || { tokens: capacity, ts: now };
  bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.ts) / 1000) * refillPerSec);
  bucket.ts = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

export function rateLimit(req, res, next) {
  const { perMinute } = limits();
  if (!takeToken("global", perMinute, perMinute / 60)) {
    return reject(res, 429, `请求过于频繁（上限 ${perMinute} 次/分钟），请稍后再试`, "RATE_LIMITED");
  }
  next();
}

// ---------- 并发闸门 ----------
let inFlight = 0;

export function acquireSlot() {
  const { maxConcurrent } = limits();
  if (inFlight >= maxConcurrent) return false;
  inFlight += 1;
  return true;
}

export function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1);
}

// ---------- 每日预算 ----------
function limits() {
  const { limits: cfg } = loadConfig();
  return {
    dailyGenerations: Number(process.env.AI_CANVAS_DAILY_LIMIT || cfg.dailyGenerations || 200),
    perMinute: Number(cfg.perMinute || 30),
    maxConcurrent: Number(cfg.maxConcurrent || 2)
  };
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function readUsage() {
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    if (raw?.date === today()) return raw;
  } catch { /* 首次运行 */ }
  return { date: today(), images: 0, videos: 0 };
}

function writeUsage(usage) {
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function budgetRemaining() {
  const { dailyGenerations } = limits();
  const usage = readUsage();
  return Math.max(0, dailyGenerations - (usage.images + usage.videos));
}

export function budgetExceeded() {
  return budgetRemaining() <= 0;
}

export function bumpUsage(kind) {
  const usage = readUsage();
  if (kind === "video") usage.videos += 1;
  else usage.images += 1;
  writeUsage(usage);
  return usage;
}

export function securityStatus() {
  const { dailyGenerations, perMinute, maxConcurrent } = limits();
  const usage = readUsage();
  return {
    hostCheck: true,
    originCheck: true,
    sessionToken: true,
    embedMode: EMBED_MODE,
    embedOrigins: [...EMBED_ORIGINS],
    embedHosts: [...EMBED_HOSTS],
    allowedPorts: [...ALLOWED_PORTS],
    inFlight,
    maxConcurrent,
    perMinute,
    dailyGenerations,
    used: usage.images + usage.videos,
    remaining: budgetRemaining(),
    token: SESSION_TOKEN,
    // 变更令牌是否启用（只暴露布尔值：令牌本身不下发到任何读接口）
    mutationEnforced: MUTATION_ENFORCED
  };
}
