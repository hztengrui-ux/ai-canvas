// 参考图（垫图）预处理 —— 四家云端 provider 共用
//
// 为什么一定要读盘转 base64：
//   前端给的参考图 url 形如 `/outputs/xxx.png`，那是**本机 Express** 的路径。
//   万相 / 即梦 / OpenAI / Gemini 全在公网，它们拿到这个地址会去自己那边回调，
//   必然 404（除非用户做了内网穿透或把图传到公有 OSS）。
//   所以：本地文件一律读盘 → base64 → data URI 内联发送，不赌外网可达性。
//
// 另外一个容易漏的点：ComfyUI 那边的图是「上传到 input 目录再给文件名」，
// 云端这边是「内联 base64」，两套传输方式不同，但**路径校验与体积上限必须一致**，
// 否则同一个恶意 url 在本地通道被拦住、在云端通道就漏了。所以把校验收敛到这里。
import fs from "node:fs";
import path from "node:path";
import { outputsDir, materialDir } from "../config.js";

// 单张上限 8MB：即梦硬限 10MB（4.0 起 30MB），OpenAI edits 实务上 ~4MB 会 413，
// 取 8 是兼顾；超了就跳过并回报，绝不静默丢图。
export const MAX_REF_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif"
};

export function mimeOf(name) {
  return MIME_BY_EXT[String(path.extname(name || "")).toLowerCase()] || "image/png";
}

/**
 * 把前端给的 url 解析成本地磁盘文件。
 * 只接受 outputs / materials 两个目录下的相对路径，并做穿越校验 —— 前端 url 不可信。
 */
export function resolveLocalFile(url) {
  const clean = String(url || "").split("?")[0].split("#")[0].replace(/^\/+/, "");
  if (!clean) return "";

  let root = "";
  let rel = "";
  if (clean.startsWith("outputs/")) {
    root = outputsDir();
    rel = clean.slice("outputs/".length);
  } else if (clean.startsWith("materials/")) {
    root = materialDir();
    rel = clean.slice("materials/".length);
  } else {
    return "";
  }

  const abs = path.resolve(root, rel);
  const rootAbs = path.resolve(root);
  if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) return ""; // 路径穿越
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : "";
}

function dataUri(buf, mime) {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * 读取参考图，统一产出 `{ name, mime, buf, dataUri, b64 }`。
 * - 本地 /outputs、/materials 相对路径 → 读盘
 * - http(s) 绝对地址 → 下载（多用于素材库里已经存过的公网图）
 * - 超体积 / 读不到 → 跳过，通过 onProgress 回报，不让整单失败
 */
export async function loadReferences(refs, options = {}) {
  const { max = 4, onProgress, label = "参考图" } = options;
  const list = (Array.isArray(refs) ? refs : []).slice(0, Math.max(1, Number(max) || 1));
  const out = [];
  const skipped = [];

  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    const url = String(raw?.url || raw || "").trim();
    if (!url) continue;

    let buf = null;
    let name = `ref-${i + 1}.png`;

    if (/^data:image\//i.test(url)) {
      // 已经是 data URI（前端直接塞进来的），拆出来复用
      const m = url.match(/^data:([^;,]+);base64,(.*)$/i);
      if (!m) continue;
      buf = Buffer.from(m[2], "base64");
      name = `ref-${i + 1}.${(m[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "")}`;
    } else if (/^https?:/i.test(url)) {
      try {
        const r = await fetch(url);
        if (!r.ok) {
          skipped.push(`${name}（HTTP ${r.status}）`);
          continue;
        }
        buf = Buffer.from(await r.arrayBuffer());
        name = decodeURIComponent(url.split("?")[0].split("/").pop() || name) || name;
      } catch (e) {
        skipped.push(`${url.slice(0, 40)}（下载失败：${e.message || "网络错误"}）`);
        continue;
      }
    } else {
      const file = resolveLocalFile(url);
      if (!file) {
        skipped.push(`${url.slice(0, 40)}（不在 outputs/materials 目录内）`);
        continue;
      }
      buf = fs.readFileSync(file);
      name = path.basename(file);
    }

    if (!buf?.length) {
      skipped.push(`${name}（空文件）`);
      continue;
    }
    if (buf.length > MAX_REF_BYTES) {
      skipped.push(`${name}（${(buf.length / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_REF_BYTES / 1024 / 1024}MB 上限）`);
      continue;
    }

    const mime = mimeOf(name);
    out.push({ name, mime, buf, b64: buf.toString("base64"), dataUri: dataUri(buf, mime) });
  }

  if (out.length) onProgress?.(`已载入 ${out.length} 张${label}`);
  if (skipped.length) onProgress?.(`${label}跳过 ${skipped.length} 张：${skipped.join("、")}`);

  return out;
}

/**
 * 商品一致性约束 → 自然语言后缀。
 *
 * 云端模型没有 ComfyUI 那种「印花区域遮罩 + 纹理保留」的硬参数，
 * 只能把约束写进提示词。写成结构化短句而不是长篇描述，
 * 是因为万相/即梦的 prompt 都有长度上限（万相 2.1 系列仅 500 字符）。
 */
export function productIntentSuffix({ printArea = "auto", keepTexture = true } = {}) {
  const parts = [];
  const areaMap = {
    auto: "印花位置由你判断最合适的区域",
    chest: "印花位于胸前居中区域",
    full: "印花铺满整件衣服正面",
    sleeve: "印花位于袖口区域",
    back: "印花位于背面居中区域"
  };
  const area = areaMap[String(printArea || "auto")] || areaMap.auto;
  parts.push(area);
  if (keepTexture !== false) parts.push("保留原图的针织纹理与面料质感");
  parts.push("保持服装版型、领口与配色不变");
  return parts.join("；");
}

/**
 * 把商品约束拼到提示词尾部（只在有参考图时才有意义）。
 */
export function withProductIntent(prompt, refs, productOpts) {
  const base = String(prompt || "").trim();
  if (!refs?.length) return base;
  const suffix = productIntentSuffix(productOpts);
  if (!suffix) return base;
  return `${base}。${suffix}`;
}
