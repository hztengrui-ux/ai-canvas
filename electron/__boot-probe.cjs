const fs = require("node:fs");
const F = "E:\\DSH项目\\.tmp\\probe-boot.txt";
fs.writeFileSync(F, "boot " + new Date().toISOString() + "\n");
const { app } = require("electron");
fs.appendFileSync(F, "electron loaded, isPackaged=" + app.isPackaged + "\n");
app.whenReady().then(() => {
  fs.appendFileSync(F, "ready\n");
  app.exit(0);
});
setTimeout(() => { fs.appendFileSync(F, "timeout\n"); app.exit(9); }, 10000);
