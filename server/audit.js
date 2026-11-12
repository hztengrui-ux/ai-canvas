// 安全审计：登录/登出/改密/生成/设置变更留痕，JSONL 落盘，按天分文件
import fs from "node:fs";
import path from "node:path";
import { dataFile } from "./paths.js";

const DIR = dataFile("audit");
const KEEP_DAYS = 30;

// 事件类型 -> 中文标签 + 风险级别
export const EVENT_META = {
  "auth.login": { label: "登录成功", level: "info" },
  "auth.login.failed": { label: "登录失败", level: "warn" },
  "auth.logout": { label: "登出", level: "info" },
  "auth.password.changed": { label: "修改密码", level: "warn" },
  "auth.user.created": { label: "创建账号", level: "warn" },
  "auth.locked": { label: "账号锁定", level: "danger" },
  "generate.image": { label: "生成图片", level: "info" },
  "generate.video": { label: "生成视频", level: "info" },
  "settings.changed": { label: "修改设置", level: "warn" },
  "admin.action": { label: "后台操作", level: "warn" },
  "security.blocked": { label: "请求被拦截", level: "danger" },
  "app.started": { label: "服务启动", level: "info" }
};

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function fileOf(day) {
  return path.join(DIR, `${day}.jsonl`);
}

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

// ---------- 写入 ----------
export function record(type, detail = {}, ctx = {}) {
  ensureDir();
  const entry = {
    ts: new Date().toISOString(),
    type,
    label: EVENT_META[type]?.label || type,
    level: EVENT_META[type]?.level || "info",
    user: ctx.username || detail.username || "-",
    ip: ctx.ip || "",
    ua: String(ctx.ua || "").slice(0, 160),
    detail
  };
  try {
    fs.appendFileSync(fileOf(dayKey()), JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn("[audit] 写入失败:", err.message);
  }
  return entry;
}

// ---------- 读取 ----------
export function query({ limit = 100, level = "", type = "", days = 7 } = {}) {
  ensureDir();
  const out = [];
  const now = Date.now();

  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86400000);
    const file = fileOf(dayKey(d));
    if (!fs.existsSync(file)) continue;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").filter(Boolean);
    for (let j = lines.length - 1; j >= 0; j--) {
      try {
        const e = JSON.parse(lines[j]);
        if (level && e.level !== level) continue;
        if (type && e.type !== type) continue;
        out.push(e);
        if (out.length >= limit) return out;
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  return out;
}

export function stats(days = 7) {
  const all = query({ limit: 5000, days });
  const by = { info: 0, warn: 0, danger: 0 };
  const byType = {};
  for (const e of all) {
    by[e.level] = (by[e.level] || 0) + 1;
    byType[e.type] = (byType[e.type] || 0) + 1;
  }
  return { total: all.length, byLevel: by, byType };
}

// ---------- 清理老日志 ----------
export function sweep() {
  ensureDir();
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let removed = 0;
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      const day = f.replace(".jsonl", "");
      if (new Date(day).getTime() < cutoff) {
        fs.unlinkSync(path.join(DIR, f));
        removed += 1;
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}

export function auditDir() {
  ensureDir();
  return DIR;
}
