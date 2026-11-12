// 打包产物回归检查：客户端「打得开、页面能加载」
//
// 为什么需要这个脚本（2026-10-18 真实事故）：
//   打包版客户端一打开，窗口标题是 "Error"、页面全白、所有静态资源 404。
//   server 日志里只有一行：
//     [server] Error: ENOENT, dist\index.html not found in ...\app.asar
//   根因不是路径写错，而是 **Electron 33 在 ELECTRON_RUN_AS_NODE 模式下
//   fs.createReadStream 读 asar 内部路径会抛 ENOENT**（existsSync/readFileSync 都正常）。
//   内置服务是 fork 出来的子进程，正好跑在这个模式里，而 express.static 和 SPA 回退
//   全是流式读 —— 于是整个前台读不出来。
//
// 这个脚本用**打包好的 exe 自己**（run-as-node 模式）去实测 createReadStream，
// 不靠"看配置对不对"来推断。任何一条失败，都说明这个包发出去用户会打不开。
//
// 用法：node scripts/__verify-packaged-app.mjs [portable目录]
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as asar from "@electron/asar";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT_DIR = process.argv[2] || path.join(ROOT, "release", "ai-canvas-portable");
const RES = path.join(PORT_DIR, "resources");
const ASAR = path.join(RES, "app.asar");
const UNPACKED = path.join(RES, "app.asar.unpacked");

let bad = 0;
function ok(name, cond, detail = "") {
  console.log(`${cond ? "  OK   " : "  FAIL "} ${name}${!cond && detail ? ` —— ${detail}` : ""}`);
  if (!cond) bad += 1;
}

console.log(`产物目录：${PORT_DIR}`);
ok("app.asar 存在", fs.existsSync(ASAR));

// 1) asar 里 dist/index.html 必须被标成 unpacked
const header = asar.getRawHeader(ASAR).header;
const entries = [];
(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (v.files) walk(v.files, p);
    else entries.push({ p, unpacked: Boolean(v.unpacked) });
  }
})(header.files, "");
const idx = entries.find((e) => e.p === "dist/index.html");
ok("asar 里有 dist/index.html", Boolean(idx));
ok("dist/index.html 已解包（asarUnpack）", idx?.unpacked === true, "仍是打包状态 → 打包版页面会 404");
const brand = entries.find((e) => e.p.startsWith("config/brand-assets/"));
ok("config/brand-assets 已解包（托盘图标要用真实文件）", brand ? brand.unpacked === true : true);

// 2) 解包后的真实文件真的落盘了
const realIndex = path.join(UNPACKED, "dist", "index.html");
ok("app.asar.unpacked/dist/index.html 落盘", fs.existsSync(realIndex), realIndex);
const assetsDir = path.join(UNPACKED, "dist", "assets");
const assetCount = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).length : 0;
ok("解包的 assets 非空", assetCount > 0, `assets 文件数=${assetCount}`);

// 3) 服务端确实做了路径改写
const serverSrc = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
ok(
  "server 里有 asar→unpacked 路径改写",
  /function realPath\(/.test(serverSrc) && /app\\?\.asar\.unpacked|\.unpacked/.test(serverSrc)
);

// 4) 决定性实测：用打包好的 exe（run-as-node）去 createReadStream 解包后的首页
const exe = fs.readdirSync(PORT_DIR).find((f) => f.toLowerCase().endsWith(".exe"));
if (!exe) {
  ok("找到主程序 exe", false);
} else {
  const probe = path.join(ROOT, ".tmp-probe-asar.cjs");
  fs.writeFileSync(
    probe,
    `const fs=require("fs");
// 注意：Electron 以 node 模式跑脚本时，process.argv = [exe, script, ...args]，
// 目标路径在 argv[2]（用 argv[1] 会读到脚本自己，导致"永远通过"的假绿灯）。
const p=process.argv[2]||process.argv[1];
let out={target:p,exists:false,readFile:0,stream:"none",stat:0};
try{ out.exists=fs.existsSync(p); }catch(e){ out.exists="err:"+e.code; }
try{ out.readFile=fs.readFileSync(p).length; }catch(e){ out.readFile="err:"+e.code; }
try{ out.stat=fs.statSync(p).size; }catch(e){ out.stat="err:"+e.code; }
const s=fs.createReadStream(p);
s.once("data",(d)=>{ out.stream="ok:"+d.length; console.log(JSON.stringify(out)); process.exit(0); });
s.once("error",(e)=>{ out.stream="err:"+e.code; console.log(JSON.stringify(out)); process.exit(0); });
setTimeout(()=>{ console.log(JSON.stringify(out)); process.exit(0); },5000);
`,
    "utf8"
  );
  const r = spawnSync(path.join(PORT_DIR, exe), [probe, realIndex], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: 20000
  });
  let parsed = null;
  try {
    parsed = JSON.parse((r.stdout || "").trim().split("\n").pop());
  } catch {
    /* 保持 null */
  }
  ok(
    "打包 exe 用流式方式能读到首页（这是当初崩掉的地方）",
    String(parsed?.stream || "").startsWith("ok:"),
    `stdout=${(r.stdout || "").trim()} stderr=${(r.stderr || "").trim().slice(0, 120)}`
  );
  ok("同一文件 existsSync / readFileSync 也正常", parsed?.exists === true && typeof parsed?.readFile === "number");
  fs.rmSync(probe, { force: true });
}

console.log(bad === 0 ? "\n结论：这个包打开后能正常加载页面 ✅" : `\n结论：${bad} 项不达标，这个包发出去打不开 ❌`);
process.exit(bad === 0 ? 0 : 1);
