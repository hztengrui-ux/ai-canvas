/**
 * 给打包产物的 exe 写 Electron fuses（安全加固，2026-11-03）
 *
 * 为什么自己写而不用 electron-builder 的配置项：当前锁定的 electron-builder 25.1.8
 * 把「改写 exe」绑在代码签名开关（signAndEditExecutable）上，而本机默认关掉它
 * （winCodeSign 需要管理员权限解符号链接，见 electron-builder.config.cjs 顶部注释）。
 * 所以这一步放在打包之后单独做，只改熔断位，不碰签名与图标。
 *
 * 用法：node scripts/apply-fuses.mjs <exe 路径>
 * 退出码：0 成功 / 1 失败（打包脚本应据此中断）
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } from "@electron/fuses";

const target = process.argv[2];
if (!target) {
  console.error("[fuses] 用法：node scripts/apply-fuses.mjs <exe 路径>");
  process.exit(1);
}
if (!existsSync(target)) {
  console.error(`[fuses] 找不到 ${target}`);
  process.exit(1);
}

/**
 * 目标状态。每一条都在关掉一个「拿去逆向很方便」的入口：
 *   RunAsNode                            关：不能再用 ELECTRON_RUN_AS_NODE 把 asar 当脚本执行
 *   EnableNodeOptionsEnvironmentVariable 关：NODE_OPTIONS 注入 --inspect 的路子封死
 *   EnableNodeCliInspectArguments        关：命令行 --inspect / --inspect-brk 失效
 *   EnableEmbeddedAsarIntegrityValidation 开：app.asar 被改动后拒绝启动（防二次打包植入）
 *   OnlyLoadAppFromAsar                  开：只能从 app.asar 加载，不能被替换成外部目录
 *
 * ⚠️ 前提：内置服务已从 child_process.fork（依赖 RunAsNode）改成 worker_threads，
 *    否则关掉 RunAsNode 会直接白屏 —— 见 electron/main.cjs 的 startServer()。
 *
 * ⚠️ 每次打包都会重建 exe，熔断位会回到 Electron 默认值（RunAsNode 开），
 *    所以 make-portable.mjs 每次打包后都会重新跑一次本脚本（不是一次性操作）。
 */
const DESIRED = {
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true
};

const STATE_ON = 0x31; // '1'
const STATE_OFF = 0x30; // '0'

const NAME_OF = Object.fromEntries(
  Object.entries(FuseV1Options)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => [v, k])
);

// getCurrentFuseWire 返回形如 { 0: 48, 1: 48, ..., version: "1" }
function describe(wire) {
  if (!wire) return "(读不到熔断位)";
  const idx = Object.keys(wire)
    .filter((k) => k !== "version")
    .map(Number)
    .sort((a, b) => a - b);
  return idx
    .map((i) => `${NAME_OF[i] || `fuse#${i}`}=${wire[i] === STATE_ON ? "on" : wire[i] === STATE_OFF ? "off" : "?"}`)
    .join("  ");
}

const before = await getCurrentFuseWire(target).catch((e) => {
  console.error(`[fuses] 读取熔断位失败：${e?.message || e}`);
  return null;
});
console.log(`[fuses] 改前：${describe(before)}`);

try {
  await flipFuses(target, { version: FuseVersion.V1, ...DESIRED, resetAdHocDarwinSignature: true });
} catch (e) {
  console.error(`[fuses] ✗ 写入失败：${e?.message || e}`);
  process.exit(1);
}

const after = await getCurrentFuseWire(target).catch(() => null);
console.log(`[fuses] 改后：${describe(after)}`);

// 逐项校验，别只看日志：写进去了才算数
const problems = Object.entries(DESIRED)
  .filter(([idx, want]) => after?.[Number(idx)] !== (want ? STATE_ON : STATE_OFF))
  .map(([idx]) => NAME_OF[Number(idx)] || `fuse#${idx}`);

if (problems.length) {
  console.error(`[fuses] ✗ 校验不通过：${problems.join(", ")}`);
  process.exit(1);
}

console.log(`[fuses] ✓ ${path.basename(target)} 熔断位已按安全策略写入`);
