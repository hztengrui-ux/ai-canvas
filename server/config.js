import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { getSecret, setSecret, vaultStatus } from "./vault.js";
import { dataFile, HOME as CONFIG_DIR } from "./paths.js";

const CONFIG_FILE = dataFile("config.json");

/**
 * 老版本把产物/素材放在这两个固定位置（cwd 与用户目录）。
 * 机器上还留着这些目录时继续用它们 —— 迁库只做"新用户/新安装走新默认"，
 * 不做静默搬家，免得用户升级后发现素材"不见了"。
 */
const LEGACY_OUTPUTS_DIR = path.join(process.cwd(), "outputs");
const LEGACY_MATERIAL_DIR = path.join(os.homedir(), "ai-canvas-materials");

export const MATERIAL_CATEGORIES = [
  { id: "clothing", label: "服装" },
  { id: "model", label: "模特" },
  { id: "scene", label: "场景" },
  { id: "props", label: "道具" },
  { id: "other", label: "其他" }
];

// 注意：这里永远不存 apiKey —— 密钥一律进 vault
const DEFAULT_CONFIG = {
  // 闭源 · 国内
  // i2iModel：带参考图时用的模型。t2i 系列不支持图片输入，必须换成 wan2.6-image 这类。
  wanxiang: { model: "wanx2.1-t2i-turbo", i2iModel: "wan2.6-image", videoModel: "wanx2.1-t2v-turbo" },
  jiemeng: { model: "doubao-seedream-4-0" },
  // 闭源 · 国际（OpenAI 兼容 Images API / Gemini 图像生成）
  openai: { model: "gpt-image-2", baseUrl: "https://api.openai.com/v1" },
  gemini: { model: "nano-banana-pro", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  // 语义处理（LLM，OpenAI 兼容 /chat/completions）
  //
  // 为什么单独放一个 provider 而不是塞进某家图像 provider：
  //   豆包 2.1（Doubao-Seed-2.1 Pro/Turbo）是**语言模型**，不能出图；
  //   出图那条线是豆包·Seedream（见 jiemeng provider）。
  //   中转站/聚合 API 基本都提供 OpenAI 兼容的 /chat/completions，
  //   所以这里只要可配 baseUrl + model + key，就能同时接官方方舟和聚合站。
  llm: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-1-pro",
    temperature: 0.6,
    maxTokens: 900
  },
  // 上游模型名覆盖：{ "注册表 id": "中转站里的真实模型名" }
  // 官方默认值在 server/models/registry.js 的 apiId 字段里，这里只放"用户覆盖"。
  models: {},
  // 开源 · 本地
  // ipadapterModel / clipVisionModel：多参考图融合专用。留空＝自动从 /object_info 挑，
  // 机器上有多个时可以手指定，别被自动探测锁死。
  comfyui: {
    baseUrl: "http://127.0.0.1:8188",
    checkpoint: "",
    profile: "",
    ipadapterModel: "",
    clipVisionModel: ""
  },
  // 产物目录。
  //
  // 2026-10-16 调整默认值（用户要求："以后任务不要放在 C 盘，一定要放在 E 盘"）：
  // 以前默认是 `process.cwd()/outputs` —— 打包安装版跑起来 cwd 在安装目录，
  // 于是产物落在 C 盘；换台机器/换个用户也会各自散一份。
  // 现在统一跟随数据根（AI_CANVAS_HOME，本项目指向 E:\ai-canvas-data），
  // 一个开关控制全部落盘位置。**老目录若已存在仍优先用老目录**，不动存量文件。
  outputsDir: process.env.AI_CANVAS_OUTPUTS
    ? path.resolve(process.env.AI_CANVAS_OUTPUTS)
    : fs.existsSync(LEGACY_OUTPUTS_DIR)
      ? LEGACY_OUTPUTS_DIR
      : path.join(CONFIG_DIR, "outputs"),
  // 素材库目录。
  //
  // ⚠️ 2026-10-14：以前这里硬编码 os.homedir()，是**唯一**不跟随 AI_CANVAS_HOME 的目录 ——
  // 于是测试/沙箱里上传素材会往真实用户目录写，直接 EPERM（实测：
  // "EPERM: operation not permitted, open 'C:\\Users\\<user>\\ai-canvas-materials\\props\\xxx.png'"）。
  // 现在支持 AI_CANVAS_MATERIALS 覆盖（与 AI_CANVAS_OUTPUTS 对称）。
  // 2026-10-16 再把**默认值**也挪进数据根：用户明确要求素材不要留在 C 盘，
  // 存量素材已迁到 <数据根>/materials；老目录若还在，仍然优先读老目录（不动存量）。
  materialDir: process.env.AI_CANVAS_MATERIALS
    ? path.resolve(process.env.AI_CANVAS_MATERIALS)
    : fs.existsSync(LEGACY_MATERIAL_DIR)
      ? LEGACY_MATERIAL_DIR
      : path.join(CONFIG_DIR, "materials"),
  limits: { dailyGenerations: 200, perMinute: 30, maxConcurrent: 2 }
};

// 参与「配置块」读写的 provider（顺序即界面顺序）
export const PROVIDER_KEYS = ["wanxiang", "jiemeng", "openai", "gemini", "comfyui", "llm"];

// 需要密钥的 provider（保险箱条目名）
const SECRET_NAMES = {
  wanxiang: "provider.wanxiang.apiKey",
  jiemeng: "provider.jiemeng.apiKey",
  openai: "provider.openai.apiKey",
  gemini: "provider.gemini.apiKey",
  llm: "provider.llm.apiKey"
};

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeRaw(obj) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
}

function pick(target, key) {
  return { ...(DEFAULT_CONFIG[key] || {}), ...(target?.[key] || {}) };
}

// 启动时把历史版本残留在 config.json 里的明文密钥搬进保险箱并抹除
function migratePlaintextKeys() {
  const raw = readRaw();
  let changed = false;
  for (const [provider, secretName] of Object.entries(SECRET_NAMES)) {
    const plain = raw?.[provider]?.apiKey;
    if (typeof plain === "string" && plain.trim()) {
      if (!getSecret(secretName)) setSecret(secretName, plain.trim());
      delete raw[provider].apiKey;
      changed = true;
      console.log(`[vault] 已把 ${provider} 的明文密钥迁入「${vaultStatus().label}」并从 config.json 抹除`);
    }
  }
  if (changed) writeRaw(raw);
}
migratePlaintextKeys();

export function loadConfig() {
  const raw = readRaw();
  const merged = {
    limits: pick(raw, "limits"),
    models: raw.models && typeof raw.models === "object" ? raw.models : {},
    outputsDir: raw.outputsDir || DEFAULT_CONFIG.outputsDir,
    materialDir: raw.materialDir || DEFAULT_CONFIG.materialDir
  };
  for (const key of PROVIDER_KEYS) merged[key] = pick(raw, key);
  // 双保险：即便文件被外部写脏，也不把密钥带进内存配置
  for (const provider of Object.keys(SECRET_NAMES)) delete merged[provider]?.apiKey;
  return merged;
}

export function saveConfig(patch = {}) {
  const raw = readRaw();
  const clean = JSON.parse(JSON.stringify(patch));
  for (const provider of Object.keys(SECRET_NAMES)) {
    if (clean[provider]) delete clean[provider].apiKey;
  }
  const next = { ...raw, ...clean };
  for (const key of [...PROVIDER_KEYS, "limits"]) {
    if (clean[key]) next[key] = { ...(raw[key] || {}), ...clean[key] };
  }
  // models 是"模型 id → 上游模型名"的覆盖表：允许只传要改的键，不传的保留
  if (clean.models && typeof clean.models === "object") {
    next.models = { ...(raw.models || {}), ...clean.models };
  }
  for (const provider of Object.keys(SECRET_NAMES)) delete next[provider]?.apiKey;
  writeRaw(next);
  return loadConfig();
}

// ---------- 密钥读写（只走保险箱） ----------
export function getProviderKey(provider) {
  const name = SECRET_NAMES[provider];
  if (!name) return "";
  return getSecret(name) || "";
}

export function setProviderKey(provider, value) {
  const name = SECRET_NAMES[provider];
  if (!name) return;
  setSecret(name, String(value || "").trim());
}

export function maskedConfig() {
  const c = loadConfig();
  const mask = (key) => (key ? key.slice(0, 6) + "****" + key.slice(-4) : "");
  const out = {
    limits: c.limits,
    vault: vaultStatus(),
    hasKey: {}
  };
  for (const provider of PROVIDER_KEYS) out[provider] = c[provider];
  for (const provider of Object.keys(SECRET_NAMES)) {
    const key = getProviderKey(provider);
    out[provider] = { ...c[provider], apiKey: mask(key) };
    out.hasKey[provider] = Boolean(key);
  }
  // 兼容旧字段
  out.hasWanxiangKey = out.hasKey.wanxiang;
  out.hasJiemengKey = out.hasKey.jiemeng;
  return out;
}

export function outputsDir() {
  const c = loadConfig();
  fs.mkdirSync(c.outputsDir, { recursive: true });
  return c.outputsDir;
}

export function materialDir() {
  const c = loadConfig();
  // 环境变量优先级最高：测试与受限环境靠它把素材目录也隔离进临时目录
  const dir = process.env.AI_CANVAS_MATERIALS
    ? path.resolve(process.env.AI_CANVAS_MATERIALS)
    : c.materialDir;
  fs.mkdirSync(dir, { recursive: true });
  for (const cat of MATERIAL_CATEGORIES) {
    fs.mkdirSync(path.join(dir, cat.id), { recursive: true });
  }
  return dir;
}

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}
