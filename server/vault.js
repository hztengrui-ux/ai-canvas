// 密钥保险箱
//
// 后端优先级：
//   1) 操作系统凭据管理器（Windows 凭据管理器 / macOS Keychain / libsecret）
//   2) 本地加密文件 —— **每条密钥一个 .enc 文件**，目录 data/secrets/
//
// 为什么从「一个大 JSON」改成「每个密钥一个文件」（对齐 SynMew 的 data/secrets/*.enc）：
//   · 改一个 provider 的 Key 不会整体重写整个保险箱，写坏只坏一条；
//   · 备份 / 同步 / 删库可以逐条操作，不用把别人的密钥一起搬走；
//   · 文件权限、审计、排查（哪个 Key 最后被改）都能定位到单条；
//   · 单条解密失败不影响其他条（大文件是一次全解，坏一处全丢）。
//
// 每条文件格式（AES-256-GCM，密钥由机器特征 + 随机盐派生）：
//   { v, alg, name, iv, tag, data, updatedAt }
// 明文永不落盘；config.json 里出现的明文密钥会在启动时被迁移进来并抹除（见 config.js）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { dataFile, HOME as CONFIG_DIR } from "./paths.js";

const SERVICE = "ai-canvas";
const SECRETS_DIR = dataFile("secrets");
const SALT_FILE = dataFile(".vault-salt");
// 旧版单文件（升级迁移用）
const LEGACY_FILE = dataFile("secrets.enc.json");

let keyring = null;
let backend = "file";
let backendReason = "";

// AI_CANVAS_VAULT=file 可强制走「本地加密文件」后端。
// 用途：系统凭据管理器可用时也要能验证分文件加密这条路径（测试 / 排障）。
const FORCE_FILE = process.env.AI_CANVAS_VAULT === "file";

// 只读探测：能读到 null 说明凭据库可访问；抛错说明当前平台不可用
try {
  if (FORCE_FILE) throw new Error("AI_CANVAS_VAULT=file：强制使用本地加密文件");
  const mod = await import("@napi-rs/keyring");
  const probe = new mod.Entry(`${SERVICE}-probe`, "probe");
  probe.getPassword();
  keyring = mod;
  backend = "keyring";
} catch (error) {
  backend = "file";
  backendReason = error?.message || String(error);
}

export function vaultBackend() {
  return backend;
}

export function vaultStatus() {
  return {
    backend,
    label: backend === "keyring" ? "系统凭据管理器" : "本地加密文件",
    encrypted: true,
    reason: backendReason,
    dir: SECRETS_DIR,
    fileCount: backend === "keyring" ? null : listSecretFiles().length
  };
}

// ---------- 文件名安全化 ----------
// 条目名形如 provider.wanxiang.apiKey，点号保留可读，其余字符全部替换，
// 杜绝 ../ 之类的路径穿越。
function fileOf(name) {
  const safe = String(name || "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safe || safe === "." || safe === "..") throw new Error("密钥名不合法");
  return path.join(SECRETS_DIR, `${safe}.enc`);
}

function listSecretFiles() {
  try {
    return fs
      .readdirSync(SECRETS_DIR)
      .filter((f) => f.endsWith(".enc"))
      .sort();
  } catch {
    return [];
  }
}

/** 列出已保存的密钥名（只给名字，绝不给值） */
export function listSecrets() {
  if (backend === "keyring") return [];
  return listSecretFiles().map((f) => f.replace(/\.enc$/, ""));
}

// ---------- 加密文件回退实现 ----------
function ensureSalt() {
  try {
    const existing = fs.readFileSync(SALT_FILE, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch { /* 首次运行 */ }
  const salt = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SALT_FILE, salt, { mode: 0o600 });
  return salt;
}

function machineKey() {
  const salt = ensureSalt();
  const material = [
    os.hostname(),
    (() => { try { return os.userInfo().username; } catch { return "unknown"; } })(),
    process.env.COMPUTERNAME || "",
    process.env.USERDOMAIN || "",
    salt
  ].join("|");
  return crypto.scryptSync(material, salt, 32);
}

function encrypt(name, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", machineKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    name: String(name),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    updatedAt: Date.now()
  };
}

function decrypt(raw) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", machineKey(), Buffer.from(raw.iv, "base64"));
  decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(raw.data, "base64")), decipher.final()]).toString("utf8");
}

function readSecretFile(name) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(name), "utf8"));
    return decrypt(raw);
  } catch {
    // 解密失败（换了机器 / 文件被改）当作「没有这条密钥」，绝不能抛到调用方
    return "";
  }
}

function writeSecretFile(name, plain) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.writeFileSync(fileOf(name), JSON.stringify(encrypt(name, plain), null, 2), { mode: 0o600 });
}

// ---------- 旧版单文件迁移 ----------
// 老版本把所有密钥塞在一个 secrets.enc.json 里。
// 启动时拆成单文件；旧文件改名保留（不删），出问题还能回滚。
function migrateLegacy() {
  if (backend === "keyring") return 0;
  let legacyRaw;
  try {
    legacyRaw = JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8"));
  } catch {
    return 0;
  }
  let store = null;
  try {
    store = JSON.parse(decrypt(legacyRaw));
  } catch {
    return 0; // 旧文件解不开（换了机器），不动它
  }

  let moved = 0;
  for (const [name, value] of Object.entries(store || {})) {
    if (!value) continue;
    if (readSecretFile(name)) continue; // 新结构已存在则以新结构为准
    writeSecretFile(name, value);
    moved += 1;
  }
  try {
    fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated-${Date.now()}`);
  } catch { /* 改不了就算了，内容已迁走 */ }
  if (moved) console.log(`[vault] 旧版保险箱已拆分为 ${moved} 个独立加密文件 → ${SECRETS_DIR}`);
  return moved;
}
migrateLegacy();

// ---------- 统一接口 ----------
export function getSecret(name) {
  if (!name) return "";
  if (backend === "keyring") {
    try {
      return new keyring.Entry(SERVICE, name).getPassword() || "";
    } catch {
      return "";
    }
  }
  return readSecretFile(name);
}

export function setSecret(name, value) {
  if (!name) return;
  if (backend === "keyring") {
    const entry = new keyring.Entry(SERVICE, name);
    if (value) entry.setPassword(value);
    else { try { entry.deletePassword(); } catch { /* 不存在 */ } }
    return;
  }
  if (value) {
    writeSecretFile(name, value);
    return;
  }
  deleteSecret(name);
}

export function deleteSecret(name) {
  if (!name) return;
  if (backend === "keyring") {
    try {
      new keyring.Entry(SERVICE, name).deletePassword();
    } catch { /* 不存在 */ }
    return;
  }
  try {
    fs.unlinkSync(fileOf(name));
  } catch { /* 本来就没有 */ }
}

/** 保险箱自检：写一条 → 读回 → 删掉，确认当前机器能正常加解密 */
export function selfTest() {
  if (backend === "keyring") return { ok: true, backend, skipped: "系统凭据管理器无需自检" };
  const probe = "__selftest__";
  const sample = crypto.randomBytes(16).toString("hex");
  try {
    writeSecretFile(probe, sample);
    const back = readSecretFile(probe);
    deleteSecret(probe);
    return { ok: back === sample, backend, dir: SECRETS_DIR };
  } catch (error) {
    return { ok: false, backend, error: error.message || String(error) };
  }
}
