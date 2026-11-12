// 批量编排（P1-5）
//
// 服务端一次最多出 4 张，但毛衫印花这类场景要 10 个变体。
// 方案（抄 SynMew，不做服务端编排器）：
//   客户端把 10 拆成 4+4+2 三批，串行调用 /api/generate，
//   每批成功就把结果写进磁盘进度文件（/api/batch）。
//   中途关掉应用 → 下次用同一个 batchId 读回进度，只补跑没完成的批次。
//
// 为什么不用服务端编排：
//   服务端要维护任务队列、推送进度、处理断连重放 —— 这些工作量换不来
//   用户可感知的价值；而进度落盘照样能断点续跑，还少一整个子系统。
import { generateStream, batchCreate, batchUpdate, batchGet } from "./api.js";

/** 单批上限，必须与服务端 MAX_PER_BATCH 一致 */
export const MAX_PER_BATCH = 4;

/** 把 total 张拆成若干批，返回每批的张数数组：[4,4,2] */
export function planBatches(total, perBatch = MAX_PER_BATCH) {
  const t = Math.max(1, Math.round(Number(total) || 1));
  const p = Math.max(1, Math.round(Number(perBatch) || MAX_PER_BATCH));
  const out = [];
  for (let left = t; left > 0; left -= p) out.push(Math.min(p, left));
  return out;
}

export function newBatchId(prefix = "b") {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 编排一次批量生成。
 *
 * @param {object} o
 * @param {object} o.payload   /api/generate 的参数（prompt/provider/size/steps…），不含 n
 * @param {number} o.total     目标总张数
 * @param {string} [o.batchId] 指定 id 即进入「续跑」模式
 * @param {string} [o.label]   任务名，进度列表里展示
 * @param {(info:{done:number,total:number,text:string})=>void} [o.onProgress]
 * @param {boolean} [o.stopOnError=true] 某批失败是否中止后续批次
 * @returns {Promise<{images:Array, done:number, failed:number, batchId:string, resumed:boolean, savedCost:number}>}
 */
export async function runBatches({
  payload = {},
  total = 1,
  batchId = "",
  label = "",
  perBatch = MAX_PER_BATCH,
  onProgress = () => {},
  stopOnError = true,
  signal = null, // AbortSignal：底部任务条点「取消」时中断后续批次
  onBatchDone = null // (images, index) => void，让调用方能逐批落资产库
}) {
  const id = batchId || newBatchId();
  const plans = planBatches(total, perBatch);

  // 续跑：先看看磁盘上有没有进度
  let existing = null;
  try {
    existing = (await batchGet(id))?.batch || null;
  } catch {
    existing = null;
  }
  const resumed = Boolean(existing);

  if (!existing) {
    await batchCreate({ id, total, perBatch, label, payload });
  }

  const images = [];
  let doneUnits = 0; // 已完成批次数
  let failed = 0;
  let savedCost = 0; // 命中上游签名而免掉的算力点

  for (let i = 0; i < plans.length; i++) {
    if (signal?.aborted) break;
    const prev = existing?.items?.[i];
    if (prev?.status === "ok" && Array.isArray(prev.images) && prev.images.length) {
      // 断点续跑：已成功的批次直接复用，不重新扣费
      images.push(...prev.images);
      doneUnits += 1;
      onProgress({ done: images.length, total, text: `第 ${i + 1}/${plans.length} 批（已完成，直接复用）` });
      continue;
    }

    const n = plans[i];
    let batchError = "";
    const got = [];

    await generateStream(
      { ...payload, n, batchId: id, batchIndex: i },
      (evt) => {
        if (evt.type === "progress") {
          onProgress({ done: images.length, total, text: `第 ${i + 1}/${plans.length} 批：${evt.text}` });
        }
        if (evt.type === "error") batchError = evt.error || "生成失败";
        if (evt.type === "done") {
          got.push(...(evt.images || []));
          savedCost += Number(evt.savedCost) || 0;
        }
      },
      { signal }
    );

    if (batchError) {
      failed += 1;
      try {
        await batchUpdate(id, { index: i, status: "failed", error: batchError });
      } catch { /* 进度写失败不影响主流程 */ }
      onProgress({ done: images.length, total, text: `第 ${i + 1}/${plans.length} 批失败：${batchError}` });
      if (stopOnError) break;
      continue;
    }

    images.push(...got);
    doneUnits += 1;
    onBatchDone?.(got, i);
    try {
      await batchUpdate(id, { index: i, status: "ok", images: got });
    } catch { /* ignore */ }
    onProgress({ done: images.length, total, text: `第 ${i + 1}/${plans.length} 批完成（${images.length}/${total}）` });
  }

  return { images, done: doneUnits, failed, batchId: id, resumed, savedCost };
}
