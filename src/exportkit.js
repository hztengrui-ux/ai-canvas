/**
 * 导出中心（补齐差距 E8）
 *
 * 现状：只有 ResultNode 里一行 `a.download = ai-canvas-${Date.now()}-${i+1}.png`
 * —— 无命名规则、无打包、无项目导出。
 *
 * 这里实现：
 *   1. 统一命名规则（项目名-日期-序号，中文与空格会被清洗掉）
 *   2. 单张 / 多张下载（多张按 180ms 间隔串行，规避浏览器并发下载拦截）
 *   3. 打包 ZIP —— **零依赖**手写 store 模式 ZIP，不引 jszip
 *   4. 项目 JSON 导出 / 导入（含节点图，可跨机器迁移）
 */
import { store } from "./store.js";

// ---------------- CRC32（ZIP 必需） ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------- 命名规则 ----------------
/** 清洗成安全文件名：去掉路径分隔符与控制字符，中文保留 */
export function safeName(s) {
  return String(s || "")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "")
    .replace(/\s+/g, "")
    .slice(0, 40);
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 生成导出文件名
 * @param {number} seq 从 1 开始
 * @param {string} ext 扩展名（不含点）
 */
export function assetName(seq, ext = "png", prefix = "") {
  const base = safeName(prefix || store.projectName || "ai-canvas") || "ai-canvas";
  return `${base}-${stamp()}-${String(seq).padStart(3, "0")}.${ext}`;
}

// ---------------- 下载 ----------------
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分浏览器会中断下载，延迟释放
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadUrl(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 串行下载多张，避免浏览器把并发下载判为弹窗拦截 */
export async function downloadMany(items, { gap = 200, prefix = "" } = {}) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const ext = (String(it.url || "").split("?")[0].split(".").pop() || "png").toLowerCase();
    downloadUrl(it.url, assetName(i + 1, ext.length <= 4 ? ext : "png", prefix));
    if (i < items.length - 1) await new Promise((r) => setTimeout(r, gap));
  }
  return items.length;
}

// ---------------- 极简 ZIP（store 模式，无压缩） ----------------
/**
 * @param {Array<{name:string, data:Uint8Array}>} files
 * @returns {Blob}
 */
export function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true); // version needed
    dv.setUint16(6, 0x0800, true); // flags: UTF-8 文件名
    dv.setUint16(8, 0, true); // method: store
    dv.setUint16(10, 0, true); // mod time
    dv.setUint16(12, 0, true); // mod date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);

    chunks.push(local, f.data);

    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // relative offset of local header
    cen.set(nameBytes, 46);
    central.push(cen);

    offset += local.length + size;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, end], { type: "application/zip" });
}

/** 把一组远程图片打包下载（先 fetch 再打包） */
export async function downloadZip(items, { prefix = "", onProgress } = {}) {
  const files = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    try {
      const res = await fetch(it.url);
      const buf = new Uint8Array(await res.arrayBuffer());
      const ext = (String(it.url).split("?")[0].split(".").pop() || "png").toLowerCase();
      files.push({ name: assetName(i + 1, ext.length <= 4 ? ext : "png", prefix), data: buf });
    } catch { /* 单张失败不中断整包 */ }
    onProgress?.(i + 1, items.length);
  }
  if (!files.length) throw new Error("没有可打包的文件");
  downloadBlob(makeZip(files), `${safeName(prefix || store.projectName) || "ai-canvas"}-${stamp()}.zip`);
  return files.length;
}

// ---------------- 项目 JSON ----------------
export function exportProject(graph) {
  const payload = {
    format: "ai-canvas-project",
    version: 1,
    exportedAt: new Date().toISOString(),
    name: store.projectName,
    graph
  };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    `${safeName(store.projectName) || "ai-canvas"}-${stamp()}.json`
  );
}

export async function importProject(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (data?.format !== "ai-canvas-project") throw new Error("不是有效的项目文件");
  if (!data.graph || !Array.isArray(data.graph.nodes)) throw new Error("项目文件里没有节点数据");
  return data;
}
