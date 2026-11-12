// 按品牌派生监听端口
//
// 为什么要有这个模块：
//   白标能力允许同一份代码跑出多个品牌（`BRAND=oem-a/oem-b`，以及 jingling/xmulo 形态）。
//   如果所有品牌都抢 5181，第二个实例要么启动失败，要么被 security.js 的 Host 白名单
//   直接拒掉 —— 现象是「Electron 一直等不到服务就绪」，排查起来非常费劲。
//
// 规则（确定性，可预测，便于运维放行防火墙/杀软白名单）：
//   aichange → 5181 / 5281   （保持现网默认端口，老用户完全无感）
//   jingling → 5182 / 5282
//   xmulo    → 5183 / 5283
//   其它品牌 → 5191 + hash%40 / 5291 + hash%40（避开已知区段，同品牌永远同端口）
//
// 媒体端口当前尚未启用（素材/产物走同一个 Express 的静态路由），
// 这里先把它派生出来并纳入 Host 白名单，将来拆独立媒体服务时端口已就位。
import os from "node:os";

export const BRAND_PORT_OFFSETS = { aichange: 0, jingling: 1, xmulo: 2 };
export const BACKEND_PORT_BASE = 5181;
export const MEDIA_PORT_BASE = 5281;
const BACKEND_PORT_FALLBACK = 5191;
const MEDIA_PORT_FALLBACK = 5291;

export function normalizeBrandKey(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return s || "aichange";
}

/** 稳定散列：同一品牌名永远得到同一偏移 */
function stableHash(key) {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) % 40;
  return hash;
}

/**
 * 派生某个品牌的后端/媒体端口。
 * @param {string} [brandKey] 默认取 process.env.BRAND
 */
export function derivePorts(brandKey = process.env.BRAND) {
  const brand = normalizeBrandKey(brandKey);
  if (Object.hasOwn(BRAND_PORT_OFFSETS, brand)) {
    const offset = BRAND_PORT_OFFSETS[brand];
    return { brand, backend: BACKEND_PORT_BASE + offset, media: MEDIA_PORT_BASE + offset };
  }
  const hash = stableHash(brand);
  return { brand, backend: BACKEND_PORT_FALLBACK + hash, media: MEDIA_PORT_FALLBACK + hash };
}

/**
 * 允许的本机端口集合（security.js 的 Host 校验用）。
 *
 * 必须把「本次运行实际会监听的端口」算进来：
 *   · PORT 环境变量 —— Electron 动态选到的空闲端口、测试进程分配的随机端口
 *   · 派生端口      —— 品牌默认端口（桌面端未显式指定 PORT 的情况）
 * 否则服务会把自己的请求当成 BAD_HOST 拦掉。
 */
export function allowedLocalPorts() {
  const explicit = String(process.env.AI_CANVAS_ALLOWED_PORTS || "5180,5181")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const { backend, media } = derivePorts();
  const extra = [process.env.PORT, process.env.AI_CANVAS_MEDIA_PORT, backend, media]
    .filter((v) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(String);
  return new Set([...explicit, ...extra]);
}

/**
 * 本机的私有网段 IPv4 地址（手机端联调要填的就是这些）。
 *
 * 为什么不只返回 127.0.0.1：手机连 127.0.0.1 指的是手机自己，必然失败。
 * 用户又不可能自己去 ipconfig 里挑（还有一堆虚拟网卡：VMware / Docker / VPN），
 * 所以这里直接过滤出 RFC1918 地址给他，按"最像真实局域网"的顺序排前面。
 */
export function lanAddresses() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const it of list || []) {
        if (it.family !== "IPv4" || it.internal) continue;
        if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(it.address)) continue;
        out.push(it.address);
      }
    }
  } catch {
    /* 取不到就返回空数组，调用方降级处理 */
  }
  // 192.168.x.x 最常见，排前面；10.x 其次
  const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}
