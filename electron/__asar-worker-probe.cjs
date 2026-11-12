/**
 * 探针：Electron 主进程里 worker_threads 能否读到 app.asar 内的 ESM 模块。
 * 结论决定「服务端搬进 worker」是否需要把 server/** 一起 unpack。
 * 用法：npx electron electron/__asar-worker-probe.cjs <asar路径>
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Worker } = require("node:worker_threads");

const asarPath = process.argv[2];
if (!asarPath) {
  console.log("PROBE_RESULT=no-asar-path");
  process.exit(2);
}

const target = path.join(asarPath, "server", "ports.js");
console.log("PROBE_TARGET=" + target);
console.log("PROBE_EXISTS(main,fs)=" + require("node:fs").existsSync(target));

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
(async () => {
  const out = { ok: false };
  try {
    const fs = require("node:fs");
    out.exists = fs.existsSync(workerData.target);
    const mod = await import(pathToFileURL(workerData.target).href);
    out.ok = true;
    out.keys = Object.keys(mod).slice(0, 6);
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  parentPort.postMessage(out);
})();
`;

const w = new Worker(workerSource, {
  eval: true,
  workerData: { target },
  // 关键：CJS worker 里 import() ESM 需要解析到 package.json type=module；
  // 这里用绝对路径的 .js，Electron 会按 asar 内 package.json 判定为 ESM。
  type: "commonjs"
});

w.on("message", (m) => {
  console.log("PROBE_RESULT=" + JSON.stringify(m));
  w.terminate();
  setTimeout(() => process.exit(0), 200);
});
w.on("error", (e) => {
  console.log("PROBE_WORKER_ERROR=" + String(e && e.message || e));
  process.exit(1);
});
setTimeout(() => {
  console.log("PROBE_RESULT=timeout");
  process.exit(3);
}, 20000);
