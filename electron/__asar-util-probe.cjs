/**
 * 探针 2：utilityProcess.fork 能否直接跑 app.asar 内的 ESM 服务端模块。
 * utilityProcess 是 Electron 官方的「不需要 ELECTRON_RUN_AS_NODE 的子进程」，
 * 因此关掉 RunAsNode fuse 之后它仍然可用 —— 这是 fork 的替代方案首选。
 * 用法：electron electron/__asar-util-probe.cjs <asar路径>
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, utilityProcess } = require("electron");

const asarPath = process.argv[2];
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  if (!asarPath) {
    console.log("PROBE_RESULT=no-asar-path");
    app.exit(2);
    return;
  }
  const entry = path.join(asarPath, "server", "ports.js");
  console.log("PROBE_TARGET=" + entry);
  console.log("PROBE_MAIN_FS_EXISTS=" + fs.existsSync(entry));

  let child;
  try {
    child = utilityProcess.fork(entry, [], { serviceName: "canvas-probe", stdio: "pipe" });
  } catch (e) {
    console.log("PROBE_FORK_THROW=" + String((e && e.message) || e));
    app.exit(3);
    return;
  }

  let out = "";
  child.stdout?.on("data", (d) => { out += String(d); });
  child.stderr?.on("data", (d) => { out += "[err] " + String(d); });
  child.on("exit", (code) => {
    console.log("PROBE_RESULT=" + JSON.stringify({ code, out: out.slice(0, 2000) }));
    app.exit(0);
  });
  child.postMessage?.({ hello: 1 });

  setTimeout(() => {
    console.log("PROBE_RESULT=" + JSON.stringify({ timeout: true, out: out.slice(0, 2000) }));
    try { child.kill(); } catch { /* ignore */ }
    app.exit(4);
  }, 15000);
});
