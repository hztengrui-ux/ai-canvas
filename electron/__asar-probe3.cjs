/**
 * 探针 3（结果写文件，Windows 下 Electron GUI 的 stdout 抓不到）
 * 依次测：
 *   1) 主进程能否 fs 读 app.asar 内文件
 *   2) worker_threads 能否 import asar 内的 ESM
 *   3) utilityProcess.fork 能否跑 asar 内的 ESM
 * 结果写到 RESULT_FILE。
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, utilityProcess } = require("electron");
const { Worker } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");

const asarPath = (process.argv.find((a) => /\.asar$/i.test(a)) || "").replace(/[\\/]+$/, "");
const RESULT_FILE = "E:\\DSH项目\\.tmp\\probe-result.json";
const result = { asarPath, steps: {} };

function save() {
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), "utf8");
  } catch { /* ignore */ }
}

app.disableHardwareAcceleration();

async function testWorker(target) {
  return new Promise((resolve) => {
    const src = `
      const { parentPort, workerData } = require("node:worker_threads");
      const { pathToFileURL } = require("node:url");
      (async () => {
        const out = { ok: false };
        try {
          out.exists = require("node:fs").existsSync(workerData.target);
          const mod = await import(pathToFileURL(workerData.target).href);
          out.ok = true;
          out.keys = Object.keys(mod).slice(0, 5);
        } catch (e) { out.error = String((e && e.message) || e); }
        parentPort.postMessage(out);
      })();
    `;
    let done = false;
    const w = new Worker(src, { eval: true, workerData: { target } });
    w.on("message", (m) => { if (!done) { done = true; resolve(m); } try { w.terminate(); } catch { /* ignore */ } });
    w.on("error", (e) => { if (!done) { done = true; resolve({ ok: false, error: String((e && e.message) || e) }); } });
    setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: "timeout-8s" }); try { w.terminate(); } catch { /* ignore */ } } }, 8000);
  });
}

function testUtility(entry) {
  return new Promise((resolve) => {
    let child;
    const finish = (v) => resolve(v);
    try {
      child = utilityProcess.fork(entry, [], { serviceName: "canvas-probe", stdio: "pipe" });
    } catch (e) {
      finish({ ok: false, error: "fork-throw: " + String((e && e.message) || e) });
      return;
    }
    let out = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { out += "[err] " + String(d); });
    child.on("exit", (code) => finish({ ok: code === 0, code, out: out.slice(0, 800) }));
    setTimeout(() => { finish({ ok: false, error: "timeout-10s", out: out.slice(0, 800) }); try { child.kill(); } catch { /* ignore */ } }, 10000);
  });
}

app.whenReady().then(async () => {
  const entry = asarPath ? path.join(asarPath, "server", "ports.js") : "";
  result.steps.mainFsExists = asarPath ? fs.existsSync(entry) : false;
  result.steps.mainFsReadable = false;
  if (result.steps.mainFsExists) {
    try { result.steps.mainFsReadable = fs.readFileSync(entry, "utf8").length > 0; } catch { /* ignore */ }
  }
  save();

  result.steps.worker = await testWorker(entry);
  save();

  result.steps.utility = await testUtility(entry);
  save();

  app.exit(0);
});
