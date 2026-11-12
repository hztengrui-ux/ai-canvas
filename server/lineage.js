// 资产血缘（E6）
//
// 2026-09-25 之前：生成完了就只剩一个 /outputs/xxxx.png。
// 三周后回看这张图 —— 用的什么提示词、哪个模型、参考了哪张毛衫图、
// 花了多少点、当时点了哪张谁画的，全都没了。**复现不了的结果约等于没有结果。**
//
// 设计取舍：
//
// 1. **sidecar 文件而不是集中库。** 每张图旁边放一个 `<file>.meta.json`，跟图同生死。
//    删除原图时元数据跟着走，不会留下指向已不存在资源的孤儿记录；
//    导出打包时也能顺带带上，到了别人机器上血缘还在。
//
// 2. **写失败绝不许影响生成。** 图已经算出来了，用户已经付过费，
//    这时候因为元数据 writeFileSync 抛异常就把结果吞掉，是本末倒置。
//    所以这里一律吞掉错误、只打 warn。
//
// 3. **文件名来自 URL，必须防穿越。** 跟 materials.js 同一个教训：
//    用户可控的路径拼出来的东西，不校验就是任意文件读写。
import fs from "node:fs";
import path from "node:path";
import { outputsDir, newId } from "./config.js";

export const META_SUFFIX = ".meta.json";

/**
 * 拼 sidecar 路径。
 *
 * 防线一（主）：basename —— 只取路径最后一段，"../../etc/passwd" 会被压成 "passwd"，
 *              压根走不出 outputs 目录。文件名来自 URL，这步不能省。
 * 防线二（辅）：下面这个 startsWith —— 万一哪天有人绕过 basename 直接拼路径，
 *              这一步还能拦住。两层都不贵，别删其一。
 */
export function metaPathFor(file) {
  const dir = path.resolve(outputsDir());
  const base = path.basename(String(file || ""));
  if (!base) throw new Error("文件名为空");
  const target = path.resolve(dir, `${base}${META_SUFFIX}`);
  // 必须真的在目录内，不能只是「前缀相同」（/a/b 和 /a/bc 同前缀但后者跑了出去）
  if (target !== dir && !target.startsWith(dir + path.sep)) {
    throw new Error("非法的文件名（路径穿越被拦截）");
  }
  return target;
}

/** 参考图形状很自由（字符串 / {url} / {name}），进血缘前统一成一种形状 */
function normalizeRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.slice(0, 12).map((r) => {
    if (typeof r === "string") return { url: r, name: "" };
    return { url: String(r?.url || ""), name: String(r?.name || r?.fileName || "") };
  });
}

/**
 * 构造血缘条目（纯函数，不碰磁盘，方便单测）。
 * 注意：只记录「怎样才能复现这张图」的信息，不存图片二进制。
 */
export function buildEntry(info = {}) {
  const file = String(info.file || "");
  const base = file ? path.basename(file) : "";
  return {
    v: 1,
    id: info.id || newId(),
    file: base,
    url: base ? `/outputs/${base}` : "",
    createdAt: info.createdAt || new Date().toISOString(),
    // ---- 复现所必需的模型输入 ----
    provider: info.provider || "",
    model: info.model || "",
    prompt: info.prompt || "",
    negativePrompt: info.negativePrompt || "",
    size: info.size || "",
    steps: info.steps ?? null,
    cfg: info.cfg ?? null,
    seed: info.seed ?? null,
    strength: info.strength ?? 0,
    printArea: info.printArea || "auto",
    keepTexture: info.keepTexture !== false,
    references: normalizeRefs(info.references),
    // ---- 当时的账目与节点上下文 ----
    cost: info.cost ?? 0,
    taskId: info.taskId || "",
    batchId: info.batchId || "",
    batchIndex: info.batchIndex ?? 0,
    nodeId: info.nodeId || "",
    projectId: info.projectId || "",
    // 2026-10-18：项目名一起落盘。
    // 项目本身存在渲染层 localStorage（服务端没有项目表），所以名字只有在生成时
    // 由桌面端上报这一条路可走。手机端"按项目筛选"要显示人名而不是一串 id，靠的就是它。
    projectName: info.projectName || "",
    userId: info.userId || "",
    username: info.username || "",
    remark: info.remark || ""
  };
}

/**
 * 落盘。成功返回条目；失败返回 null —— 调用方拿到 null 当「没有血缘」处理即可，
 * 不要因为这个把已经生成好的结果判成失败。
 */
export function record(file, info = {}) {
  const entry = buildEntry({ ...info, file });
  if (!entry.file) return null;
  try {
    const target = metaPathFor(entry.file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(entry, null, 2), "utf8");
    return entry;
  } catch (e) {
    console.warn(`[lineage] 血缘写入失败（不影响本次生成）：${e?.message || e}`);
    return null;
  }
}

/** 读某张图的血缘；不存在或已损坏都返回 null（老图没有 sidecar 是正常情况） */
export function read(file) {
  try {
    const txt = fs.readFileSync(metaPathFor(file), "utf8");
    const json = JSON.parse(txt);
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

/** 按 taskId 反查这次任务产出了哪些图 */
export function readByTask(taskId) {
  const want = String(taskId || "");
  if (!want) return [];
  return listAll().filter((e) => e.taskId === want);
}

/** 扫一遍 outputs 目录收集全部血缘（图的元信息量级很小，够用；出错的跳过不炸） */
export function listAll(limit = 500) {
  let dir;
  try {
    dir = outputsDir();
    if (!fs.existsSync(dir)) return [];
  } catch {
    return [];
  }
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(META_SUFFIX));
  } catch {
    return [];
  }
  for (const n of names.slice(0, limit)) {
    const e = read(n.slice(0, -META_SUFFIX.length));
    if (e) out.push(e);
  }
  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

/**
 * 给界面用的一句话摘要 —— 让人扫一眼就知道这张图是怎么来的。
 * 纯函数，可单测。
 */
export function summarize(entry) {
  if (!entry) return { title: "来源未知", lines: [], reproducible: false };
  const lines = [];
  if (entry.model || entry.provider) lines.push(`模型：${entry.model || entry.provider}`);
  if (entry.size) lines.push(`画幅：${entry.size}`);
  if (entry.steps != null && entry.cfg != null) lines.push(`步数 ${entry.steps} / CFG ${entry.cfg}`);
  if (entry.seed != null) lines.push(`随机种子：${entry.seed}`);
  if (Number(entry.strength) > 0) lines.push(`重绘强度：${entry.strength}`);
  if (entry.references?.length) lines.push(`参考图 ${entry.references.length} 张`);
  if (Number(entry.cost) > 0) lines.push(`消耗 ${entry.cost} 点`);
  return {
    title: entry.prompt ? entry.prompt.slice(0, 60) : "（无提示词）",
    lines,
    // 能不能「照着再来一次」——没 prompt 就没法复现，界面上别给假的希望
    reproducible: Boolean(entry.prompt && entry.provider)
  };
}
