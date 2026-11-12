// 文件批量引擎（全自动批量工作台的服务端部分）
//
// 与 server/batch.js 的区别（别混用）：
//   batch.js      —— 「同一段提示词 → 出 N 张图」的**画布批量铺图**，按批次切分图片数；
//   filebatch.js  —— 「一个文件夹 → 每个文件跑一次完整流水线」的**文件批量**，
//                    批次单位是文件，进度按文件计，结果按原目录结构落盘。
//
// 为什么内部调 /api/generate，而不是直接调 PROVIDERS[provider].generate：
//   1. 算力预扣/失败退回、上游签名缓存、任务取消、血缘记录全在那条链路里；
//      绕过去就等于自己重写一遍，且以后改一处要改两处。
//   2. 手机端作业（mobile-jobs.js）已经验证过这个模式可行：服务端自调、把 SSE 转成状态。
//   所以这里复用它的两个前提：selfBase（本机回环地址）与调用方的鉴权头。
//
// 安全：所有文件访问都过 resolveInside()，禁止 .. 越界；扫描有数量/深度上限。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getModel } from "./models/registry.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp"]);
const MAX_FILES = 2000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", ".thumbnails"]);

let current = null; // 同一时间只跑一个文件批次（多批次会抢上游配额，先串行）

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 拼绝对路径并确认它落在 root 之内（防路径穿越） */
export function resolveInside(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, String(rel || ""));
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (abs !== base && !abs.startsWith(prefix)) throw fail("PATH_ESCAPE", "路径越界");
  return abs;
}

/**
 * 扫描文件夹，返回可批量的图片清单。
 * @param {{dir:string, recursive?:boolean}} input
 */
export function scan({ dir, recursive = true } = {}) {
  const root = path.resolve(String(dir || "").trim());
  if (!root) throw fail("NO_DIR", "请先选择文件夹");
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    throw fail("DIR_NOT_FOUND", "文件夹不存在或没有权限访问");
  }
  if (!st.isDirectory()) throw fail("NOT_DIR", "这不是一个文件夹");

  const files = [];
  const skippedDirs = [];
  let skippedFiles = 0;
  let truncated = false;

  const walk = (currentDir, depth) => {
    if (truncated) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      skippedDirs.push(path.relative(root, currentDir) || ".");
      return;
    }
    // 目录在前、文件在后，按名字排序：保证每次扫描顺序稳定，续跑的索引不会错位
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "zh"));

    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".")) {
        if (entry.isDirectory()) skippedFiles += 1;
        continue;
      }
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (depth >= MAX_DEPTH || SKIP_DIRS.has(entry.name)) {
          skippedDirs.push(path.relative(root, full));
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!IMAGE_EXT.has(ext)) {
        skippedFiles += 1;
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const rel = path.relative(root, full).split(path.sep).join("/");
      const group = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      let size = 0;
      let mtime = 0;
      try {
        const fst = fs.statSync(full);
        size = fst.size;
        mtime = fst.mtimeMs;
      } catch {
        continue;
      }
      files.push({ rel, name: entry.name, size, mtime: Math.round(mtime), ext, group });
    }
  };

  walk(root, 0);

  const groupMap = new Map();
  for (const f of files) {
    const key = f.group || "（根目录）";
    groupMap.set(key, (groupMap.get(key) || 0) + 1);
  }
  const groups = [...groupMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));

  return {
    ok: true,
    root,
    total: files.length,
    files,
    groups,
    skippedFiles,
    skippedDirs: skippedDirs.slice(0, 20),
    truncated,
    limits: { maxFiles: MAX_FILES, maxDepth: MAX_DEPTH }
  };
}

/** 图片 MIME（只用于本地预览） */
export function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

/** 把命名模板里的变量替换掉（name 允许缺省，避免调用方只想要 {序号} 时崩掉） */
export function renderName(template, { name, index, group } = {}) {
  const base = String(name || "").replace(/\.[^.]+$/, "");
  const tpl = String(template || "{原名}_{序号}").trim() || "{原名}_{序号}";
  const out = tpl
    .replace(/\{原名\}|\{filename\}/g, base)
    .replace(/\{序号\}|\{index\}/g, String(index == null ? 1 : index).padStart(3, "0"))
    .replace(/\{子文件夹\}|\{group\}/g, String(group || ""))
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  return out || base || "image";
}

/** 把提示词模板里的变量替换掉 */
export function renderPrompt(template, { name, index, group, refName } = {}) {
  const base = String(name || "").replace(/\.[^.]+$/, "");
  return String(template || "")
    .replace(/\{文件名\}|\{filename\}/g, base)
    .replace(/\{序号\}|\{index\}/g, String(index == null ? 1 : index))
    .replace(/\{子文件夹\}|\{group\}/g, String(group || ""))
    .replace(/\{模特\}|\{model\}/g, String(refName || ""))
    .replace(/\{场景\}|\{scene\}/g, "")
    .trim();
}

/**
 * 把「分辨率档位 + 比例」换算成像素尺寸。
 *
 * 为什么服务端也要做这件事：前端各页各算一套，历史上有传 "2K" 的情况，
 * /api/generate 只认 WxH，于是整批 8 张全部报「尺寸不合法：2K」——
 * 用户看到的是"批量功能坏了"，其实只是单位不对。入口处兜一层，两边都省事。
 */
const LONG_EDGE = { "1K": 1024, "2K": 2048, "4K": 4096, "720P": 1280, "1080P": 1920 };
export function normalizeSize(size, ratio) {
  const raw = String(size || "").trim();
  if (/^\d{2,4}x\d{2,4}$/.test(raw)) return raw;
  const long = LONG_EDGE[raw.toUpperCase()] || 2048;
  const [w, h] = String(ratio || "1:1").split(":").map(Number);
  if (!w || !h) return `${long}x${long}`;
  return w >= h ? `${long}x${Math.round((long * h) / w)}` : `${Math.round((long * w) / h)}x${long}`;
}
function uniquePath(dir, name, ext = ".png") {
  let candidate = path.join(dir, name + ext);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${name}-${n}` + ext);
    n += 1;
  }
  return candidate;
}

/** SSE 单块解析：把 /api/generate 的事件流转成 images / error */
function parseSseChunk(state, block) {
  const ev = /^event:\s*(\S+)/m.exec(block);
  if (!ev) return;
  const dataMatch = /^data:\s*(.+)$/m.exec(block);
  let data = null;
  if (dataMatch) {
    try {
      data = JSON.parse(dataMatch[1]);
    } catch {
      data = null;
    }
  }
  const type = ev[1];
  if (type === "progress") {
    if (state.onProgress && data?.text) state.onProgress(String(data.text));
    return;
  }
  if (type === "error") {
    state.error = String(data?.message || data?.error || "生成失败");
    return;
  }
  if (type === "done") {
    state.images = Array.isArray(data?.images) ? data.images.filter((i) => i?.url) : [];
    state.cost = Number(data?.cost) || 0;
  }
}

async function callGenerate({ selfBase, auth, body, signal, onProgress }) {
  const res = await fetch(`${selfBase}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth.token ? { "X-AI-Canvas-Token": auth.token } : {}),
      ...(auth.cookie ? { Cookie: auth.cookie } : {}),
      ...(auth.mutation ? { "X-AI-Canvas-Mutation-Token": auth.mutation } : {}),
      Accept: "text/event-stream"
    },
    body: JSON.stringify(body),
    signal
  });

  const state = { images: [], error: "", cost: 0, onProgress };
  if (!res.ok) {
    let msg = `生成接口返回 ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* 非 JSON 用状态码 */
    }
    throw new Error(msg);
  }
  if (!res.body) throw new Error("服务端没有返回事件流");

  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      parseSseChunk(state, block);
      if (state.error || state.images.length) return state;
      idx = buffer.indexOf("\n\n");
    }
  }
  if (!state.images.length && !state.error) throw new Error("生成连接中断（若已扣费会自动退回）");
  return state;
}

function snapshotOf(job) {
  if (!job) return null;
  const items = job.items;
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "error").length;
  const running = items.filter((i) => i.status === "running").length;
  const pending = items.length - done - failed - running;
  return {
    id: job.id,
    state: job.state,
    total: items.length,
    done,
    failed,
    running,
    pending,
    current: job.current || "",
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    outputDir: job.outputDir,
    params: {
      promptTemplate: job.params.promptTemplate,
      model: job.params.model,
      provider: job.params.provider || "",
      ratio: job.params.ratio || "",
      size: job.params.size || "",
      count: job.params.count || 1,
      naming: job.params.naming || "",
      keepStructure: Boolean(job.params.keepStructure),
      refImages: job.params.refImages || []
    },
    cost: job.cost,
    items: items.map((i) => ({
      rel: i.rel,
      group: i.group,
      status: i.status,
      ms: i.ms || 0,
      progress: i.progress || "",
      error: i.error || "",
      outputs: i.outputs || []
    }))
  };
}

export function state() {
  return { ok: true, job: snapshotOf(current) };
}

/** 持久化到输出目录，便于"续跑"和事后查账 */
function persist(job) {
  try {
    fs.mkdirSync(job.outputDir, { recursive: true });
    fs.writeFileSync(path.join(job.outputDir, "batch.json"), JSON.stringify(snapshotOf(job), null, 2), "utf8");
  } catch {
    /* 落盘失败不影响出图，进度内存里还有 */
  }
}

async function runLoop(job, { selfBase, auth }) {
  job.state = "running";
  const width = Math.max(1, Math.min(2, Number(job.params.concurrency) || 1));
  let cursor = 0;

  const worker = async () => {
    while (job.state === "running") {
      if (job.pauseRequested) return;
      const index = cursor;
      cursor += 1;
      if (index >= job.items.length) return;
      const item = job.items[index];
      if (item.status === "done") continue;

      item.status = "running";
      item.startedAt = Date.now();
      job.current = item.rel;
      persist(job);

      try {
        const refName = job.params.refImages?.length
          ? path.basename(job.params.refImages[index % job.params.refImages.length]).replace(/\.[^.]+$/, "")
          : "";
        const prompt = renderPrompt(job.params.promptTemplate, {
          name: item.name,
          index: index + 1,
          group: item.group,
          refName
        });
        if (!prompt) throw new Error("提示词为空（检查模板里的变量是否都被替换掉了）");

        const body = {
          provider: job.params.provider || "",
          model: job.params.model || "",
          prompt,
          negativePrompt: job.params.negativePrompt || "",
          ratio: job.params.ratio || "",
          size: normalizeSize(job.params.size, job.params.ratio),
          n: Number(job.params.count) || 1,
          referenceImages: job.params.refImages || [],
          taskId: `${job.id}-${index}`
        };

        const result = await callGenerate({
          selfBase,
          auth,
          body,
          signal: job.controller.signal,
          onProgress: (text) => {
            item.progress = text;
          }
        });

        if (result.error) throw new Error(result.error);
        if (!result.images.length) throw new Error("没有返回图片");

        // 结果已由 /api/generate 落到 outputs/，这里按命名规则复制到批次目录
        const outputs = [];
        for (let k = 0; k < result.images.length; k++) {
          const url = result.images[k].url;
          const fileName = renderName(job.params.naming, {
            name: item.name,
            index: index + 1,
            group: item.group
          });
          const targetDir = job.params.keepStructure && item.group
            ? path.join(job.outputDir, item.group)
            : job.outputDir;
          fs.mkdirSync(targetDir, { recursive: true });

          let named = "";
          if (url.startsWith("/outputs/")) {
            const srcPath = path.join(job.outputsRoot, url.slice("/outputs/".length));
            const suffix = result.images.length > 1 ? `_${k + 1}` : "";
            const target = uniquePath(targetDir, fileName + suffix);
            try {
              fs.copyFileSync(srcPath, target);
              named = target;
            } catch {
              named = "";
            }
          }
          outputs.push({ url, named });
        }

        item.status = "done";
        item.outputs = outputs;
        item.cost = result.cost || 0;
        job.cost += item.cost;
      } catch (err) {
        item.status = "error";
        item.error = String(err?.message || err);
      } finally {
        item.ms = Date.now() - (item.startedAt || Date.now());
        job.current = "";
        persist(job);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: width }, worker));
    if (job.state === "running") {
      job.state = "done";
      job.endedAt = Date.now();
      persist(job);
    }
  } catch (err) {
    job.state = "error";
    job.error = String(err?.message || err);
    job.endedAt = Date.now();
    persist(job);
  }
}

/**
 * 启动批次。
 * @param {{dir:string, files:string[], params:object, selfBase:string, auth:object, outputsRoot:string}} input
 */
export function start({ dir, files, params = {}, selfBase, auth = {}, outputsRoot }) {
  if (current && (current.state === "running" || current.state === "paused")) {
    throw fail("BUSY", "已有一个批次在跑，先暂停或取消它");
  }
  const root = path.resolve(String(dir || ""));
  const list = Array.isArray(files) && files.length ? files : [];
  if (!list.length) throw fail("NO_FILES", "没有可处理的图片");
  if (list.length > MAX_FILES) throw fail("TOO_MANY", `一次最多 ${MAX_FILES} 个文件`);

  // provider 没填就按注册表反查：界面上用户只选"模型"，没必要再让他选"提供方"。
  // 不做这一步，/api/generate 会回一句「未知提供方 」——对用户毫无信息量。
  const providerOfModel = params.provider || getModel(params.model)?.provider || "";

  const id = `fb-${crypto.randomUUID().slice(0, 8)}`;
  const outputDir = params.outputDir
    ? path.resolve(String(params.outputDir))
    : path.join(outputsRoot, `batch-${id}`);

  const items = [];
  for (const rel of list) {
    const clean = String(rel || "");
    const abs = resolveInside(root, clean); // 越界直接抛
    if (!fs.existsSync(abs)) continue;
    const name = path.basename(clean);
    const group = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
    items.push({ rel: clean.replace(/\\/g, "/"), name, group, status: "pending", outputs: [], ms: 0, error: "" });
  }
  if (!items.length) throw fail("NO_FILES", "选中的文件都不存在了");

  // 续跑：同目录已有 batch.json 时把已完成的标成 done（skipDone）
  let skipped = 0;
  if (params.skipDone) {
    try {
      const prev = JSON.parse(fs.readFileSync(path.join(outputDir, "batch.json"), "utf8"));
      const prevItems = new Map((prev?.items || []).map((i) => [i.rel, i]));
      for (const item of items) {
        const old = prevItems.get(item.rel);
        if (old && old.status === "done") {
          item.status = "done";
          item.outputs = old.outputs || [];
          skipped += 1;
        }
      }
    } catch {
      /* 没有上一批就正常跑 */
    }
  }

  current = {
    id,
    root,
    items,
    params: { ...params, provider: providerOfModel, concurrency: Math.max(1, Math.min(2, Number(params.concurrency) || 1)) },
    outputDir,
    outputsRoot,
    state: "running",
    current: "",
    startedAt: Date.now(),
    endedAt: 0,
    cost: 0,
    pauseRequested: false,
    controller: new AbortController(),
    error: ""
  };
  persist(current);
  runLoop(current, { selfBase, auth }).catch(() => {
    /* runLoop 内部已兜底 */
  });
  return { ok: true, job: { id, total: items.length, state: current.state, skipped, outputDir } };
}

export function pause() {
  if (!current || current.state !== "running") throw fail("NOT_RUNNING", "当前没有运行中的批次");
  current.pauseRequested = true;
  current.state = "paused";
  persist(current);
  return { ok: true, job: snapshotOf(current) };
}

export function resume({ selfBase, auth } = {}) {
  if (!current || current.state !== "paused") throw fail("NOT_PAUSED", "当前没有暂停的批次");
  current.pauseRequested = false;
  const hasPending = current.items.some((i) => i.status === "pending" || i.status === "running");
  if (!hasPending) {
    current.state = "done";
    current.endedAt = Date.now();
    persist(current);
    return { ok: true, job: snapshotOf(current) };
  }
  for (const item of current.items) if (item.status === "running") item.status = "pending";
  runLoop(current, { selfBase, auth }).catch(() => {});
  return { ok: true, job: snapshotOf(current) };
}

export function cancel() {
  if (!current) throw fail("NO_JOB", "当前没有批次");
  current.controller.abort();
  current.state = "cancelled";
  current.endedAt = Date.now();
  for (const item of current.items) {
    if (item.status === "running" || item.status === "pending") {
      item.status = "error";
      item.error = item.error || "已取消";
    }
  }
  persist(current);
  return { ok: true, job: snapshotOf(current) };
}

/** 测试用：清空当前批次状态 */
export function reset() {
  current = null;
}

export const LIMITS = { MAX_FILES, MAX_DEPTH, IMAGE_EXT: [...IMAGE_EXT] };
