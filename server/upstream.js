// 上游签名（upstream signature）与结果缓存
//
// 解决的问题：
//   用户在结果节点上改个备注、改个标题，再点一次「重新生成」，
//   服务端会当成一次全新任务重新预扣算力 —— 用户视角就是「什么都没变又被扣了 10 点」。
//
// 做法（与 SynMew 的 workshopUpstreamSignature 同思路）：
//   把「真正影响模型输出」的那几个字段按固定顺序规范化后取 sha256，
//   用这个哈希作为账本 refId。同输入 → 同 refId → 命中已消费记录 → 不再扣费，
//   直接把上一次的生成结果返回。
//
// 铁律：
//   1. 只把影响输出的字段放进签名；remark / title / 任务名 / 时间戳一律排除。
//   2. 命中缓存不等于「永久免费」：缓存有 TTL，过期后重新计费（防止无限白嫖历史结果）。
//   3. 缓存只记本地落地文件的相对 URL，返回前必须校验文件还在（outputs 可能被清理）。
//   4. 缓存按 userId 隔离 —— 否则 A 用户付费生成的结果会被 B 用户命中，
//      既是白嫖，也是把 A 的图泄露给 B。
//   5. 签名带版本号。签名规则一改，旧条目整体作废，不会出现「新旧规则算出的签名撞车」。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataFile, HOME as DIR } from "./paths.js";
import { outputsDir, materialDir } from "./config.js";

const CACHE_FILE = dataFile("gen-cache.json");

// 签名规则版本。改动 SIGNED_FIELDS 或规范化规则时必须 +1，
// sweep() 会清掉不属于当前版本的条目。
export const SIG_VERSION = "v2";

/** 参与签名的字段（顺序固定，缺字段也要占位，保证稳定） */
const SIGNED_FIELDS = [
  "kind", // image | video —— 防止图片与视频签名撞车
  "provider",
  "model",
  "prompt",
  "negativePrompt",
  "size",
  "n",
  "steps",
  "cfg",
  "seed",
  "referenceImages", // 图生图参考图（P0-0 打通后生效）
  "firstFrame", // 视频首帧
  "resolution", // 视频分辨率
  "duration" // 视频时长
];

// 缓存有效期：默认 12 小时。0 表示不缓存。
const TTL_MS = Number(process.env.AI_CANVAS_CACHE_TTL || 12 * 60 * 60 * 1000);

// 最多保留的缓存条数，超出按时间淘汰最旧的
const MAX_ENTRIES = 500;

function norm(v) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v).trim();
}

/** 本地产物目录 → URL 前缀的映射，用于把 /outputs/xxx 还原成真实文件路径 */
function resolveLocal(url) {
  const map = [["/outputs/", outputsDir], ["/materials/", materialDir]];
  for (const [prefix, fn] of map) {
    if (!url.startsWith(prefix)) continue;
    try {
      return path.join(fn(), url.slice(prefix.length));
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * 单个素材的签名。
 *
 * 本地文件 → 只取内容 sha256，**不带文件名**：
 *   同一张图重新上传会得到新的 /outputs/xxx.png，但内容没变，
 *   带文件名就会算成两个任务、多扣一次钱 —— 这是必须避开的坑。
 * 远程直链 → 只能用 URL 本身（无法验证远端内容是否变过，已知局限）。
 * 文件已删除 → 退化成 "<url>@missing"，宁可算新任务也不能让异常吞掉整条签名。
 */
function assetSig(url, givenSha = "") {
  if (!url) return "";
  if (givenSha) return givenSha; // 上传端算好了就直接采信
  if (!url.startsWith("/")) return url; // 远程直链
  const file = resolveLocal(url);
  if (!file) return url;
  try {
    const buf = fs.readFileSync(file);
    return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32);
  } catch {
    return `${url}@missing`;
  }
}

/** 参考图列表签名；把首帧等单图场景也复用这条路径 */
function refSig(list) {
  if (!list) return "";
  const items = Array.isArray(list) ? list : [list];
  const parts = items
    .map((item) => {
      const url = norm(typeof item === "string" ? item : item?.url || item?.path);
      if (!url) return "";
      const given = norm(typeof item === "object" ? item?.sha256 : "");
      return assetSig(url, given);
    })
    .filter(Boolean);
  // 顺序不敏感（用户在画布上换参考图顺序不应算两次任务）
  return parts.sort().join("|");
}

/**
 * 计算上游签名。
 * @param {object} input 生成入参
 * @returns {string} 形如 "usig_v2_<32位hex>"，入参不足时返回 ""
 */
export function upstreamSignature(input = {}) {
  const kind = norm(input.kind) || "image";
  const payload = {
    kind,
    provider: norm(input.provider),
    model: norm(input.model),
    prompt: norm(input.prompt),
    negativePrompt: norm(input.negativePrompt),
    size: norm(input.size),
    n: norm(input.n),
    steps: norm(input.steps),
    cfg: norm(input.cfg),
    seed: norm(input.seed),
    referenceImages: refSig(input.referenceImages),
    firstFrame: refSig(input.firstFrame),
    resolution: norm(input.resolution),
    duration: norm(input.duration)
  };
  // 除素材外全空 → 认为是无效任务，不参与去重（避免所有空任务共用一个 refId）
  const meaningful = SIGNED_FIELDS.filter(
    (k) => !["referenceImages", "firstFrame"].includes(k) && k !== "kind"
  ).some((k) => payload[k]);
  if (!meaningful && !payload.referenceImages && !payload.firstFrame) return "";

  const canon = SIGNED_FIELDS.map((k) => `${k}=${payload[k]}`).join("&");
  const hex = crypto.createHash("sha256").update(canon, "utf8").digest("hex").slice(0, 32);
  return `usig_${SIG_VERSION}_${hex}`;
}

/** 短摘要，日志/审计里展示用 */
export function shortSig(sig) {
  return String(sig || "").replace(/^usig_/, "").slice(0, 12);
}

/** 签名是否属于当前版本（旧版本条目一律视为失效） */
function isCurrent(sig) {
  return String(sig || "").startsWith(`usig_${SIG_VERSION}_`);
}

// ---------- 结果缓存 ----------
function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return c && typeof c.entries === "object" && c.entries ? c : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function writeCache(c) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2), { encoding: "utf8", mode: 0o600 });
}

/** 缓存是否仍然可用：TTL 内 + 产物文件都还在 */
function stillValid(entry) {
  if (!entry || !Array.isArray(entry.items) || !entry.items.length) return false;
  if (TTL_MS > 0 && Date.now() - entry.ts > TTL_MS) return false;
  return entry.items.every((img) => {
    const url = String(img?.url || "");
    if (!url.startsWith("/")) return true; // 远程直链不校验
    const file = resolveLocal(url);
    return file ? fs.existsSync(file) : false;
  });
}

/**
 * 命中则返回缓存结果（含 items），否则返回 null。
 * @param {string} sig 上游签名
 * @param {string} userId 当前账号 —— 缓存按用户隔离
 */
export function cacheGet(sig, userId = "") {
  if (!sig || !isCurrent(sig)) return null;
  const c = readCache();
  const entry = c.entries[sig];
  if (!entry) return null;
  // 铁律 4：不是本人的结果不能命中
  if (String(entry.userId || "") !== String(userId || "")) return null;
  if (!stillValid(entry)) {
    delete c.entries[sig];
    writeCache(c);
    return null;
  }
  return { ...entry, cached: true, savedCost: Number(entry.cost) || 0 };
}

/**
 * 生成成功后写缓存。
 * @param {string} sig 上游签名
 * @param {{items: Array, cost: number, provider?: string, model?: string, userId?: string, kind?: string}} info
 */
export function cachePut(sig, { items, cost, provider, model, userId, kind }) {
  if (!sig || !isCurrent(sig)) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  const c = readCache();
  c.entries[sig] = {
    kind: String(kind || "image"),
    items: list.map((i) => ({ url: i.url, remoteUrl: i.remoteUrl || "" })),
    cost: Number(cost) || 0,
    provider: String(provider || ""),
    model: String(model || ""),
    userId: String(userId || ""),
    ts: Date.now()
  };
  // 超出上限按时间淘汰最旧的
  const keys = Object.keys(c.entries);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (c.entries[a].ts || 0) - (c.entries[b].ts || 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete c.entries[k]);
  }
  writeCache(c);
}

/**
 * 全量清理：过期 / 产物已删除 / 版本不匹配的条目。
 * 惰性清理只在 get 时发生，长期不访问的死条目会一直占着文件 —— 启动时跑一次。
 * @returns {{removed: number, kept: number}}
 */
export function sweep() {
  const c = readCache();
  const keys = Object.keys(c.entries || {});
  let removed = 0;
  for (const k of keys) {
    if (!isCurrent(k) || !stillValid(c.entries[k])) {
      delete c.entries[k];
      removed += 1;
    }
  }
  if (removed) writeCache(c);
  return { removed, kept: Object.keys(c.entries).length };
}

/** 缓存统计（设置页 / 对账展示） */
export function cacheStats() {
  const c = readCache();
  const keys = Object.keys(c.entries || {});
  let alive = 0;
  let saved = 0;
  for (const k of keys) {
    if (stillValid(c.entries[k])) {
      alive += 1;
      saved += Number(c.entries[k].cost) || 0;
    }
  }
  return { total: keys.length, alive, savedCost: saved, ttlMs: TTL_MS, version: SIG_VERSION };
}

/** 清空缓存（设置页「清理生成缓存」按钮） */
export function cacheClear() {
  writeCache({ entries: {} });
  return { ok: true };
}
