// 校验交付产物里真的带上了手机端：server 模块 + 前端设置页调用 + 联调 bat
import * as asar from "@electron/asar";
import fs from "node:fs";
import path from "node:path";

const PORT = "release/ai-canvas-portable";
const asarPath = path.join(PORT, "resources", "app.asar");
const out = path.resolve(".tmp-asar-mobile");

fs.rmSync(out, { recursive: true, force: true });
asar.extractAll(asarPath, out);

const must = [
  "server/mobile.js",
  "server/mobile-jobs.js",
  "server/mobile-routes.js"
];
let bad = 0;
for (const rel of must) {
  const ok = fs.existsSync(path.join(out, rel));
  console.log((ok ? "  OK   " : "  MISS ") + rel);
  if (!ok) bad += 1;
}

// 服务端骨架里必须接上额外令牌校验器与 mountMobile
const idx = fs.readFileSync(path.join(out, "server", "index.js"), "utf8");
const idxChecks = {
  "setExtraTokenVerifier 已接线": idx.includes("setExtraTokenVerifier("),
  "mountMobile 已挂载": idx.includes("mountMobile(app"),
  "手机端登录加入免登录白名单": idx.includes("/api/m/auth/login"),
  "启动日志打印局域网地址": idx.includes("小程序里填下面任一地址")
};
for (const k of Object.keys(idxChecks)) {
  console.log((idxChecks[k] ? "  OK   " : "  MISS ") + k);
  if (!idxChecks[k]) bad += 1;
}

// 手机端路由：充值 + 筛选 + 自调带变更令牌
const routesSrc = fs.readFileSync(path.join(out, "server", "mobile-routes.js"), "utf8");
const routeChecks = {
  "充值页接口 /api/m/recharge": routesSrc.includes('"/api/m/recharge"'),
  "充值下单接口": routesSrc.includes("/api/m/recharge/orders"),
  "沙箱模拟支付": routesSrc.includes("simulate-paid"),
  "真实支付明确拒付（不假装能付）": routesSrc.includes("PAY_IN_MINIAPP_UNSUPPORTED"),
  "看图筛选（project=__none）": routesSrc.includes("__none"),
  "自调补变更令牌": routesSrc.includes("X-AI-Canvas-Mutation-Token")
};
for (const k of Object.keys(routeChecks)) {
  console.log((routeChecks[k] ? "  OK   " : "  MISS ") + k);
  if (!routeChecks[k]) bad += 1;
}

// 出图代理的自调也必须带变更令牌（桌面版里 /api/generate 受保护）
const jobsSrc = fs.readFileSync(path.join(out, "server", "mobile-jobs.js"), "utf8");
const jobsOk = jobsSrc.includes("X-AI-Canvas-Mutation-Token");
console.log((jobsOk ? "  OK   " : "  MISS ") + "出图自调携带变更令牌");
if (!jobsOk) bad += 1;

// 血缘要能记住项目名（手机端按项目筛选显示人名靠它）
const lineageSrc = fs.readFileSync(path.join(out, "server", "lineage.js"), "utf8");
const lineageOk = lineageSrc.includes("projectName");
console.log((lineageOk ? "  OK   " : "  MISS ") + "血缘记录 projectName");
if (!lineageOk) bad += 1;

// 前端产物里要能搜到 /api/m/info（设置页的联调地址）
const assets = path.join(out, "dist", "assets");
const jsFiles = fs.readdirSync(assets).filter((f) => f.endsWith(".js"));
let found = false;
for (const f of jsFiles) {
  if (fs.readFileSync(path.join(assets, f), "utf8").includes("/api/m/info")) found = true;
}
console.log((found ? "  OK   " : "  MISS ") + "前端产物含 /api/m/info（设置页联调地址）");
if (!found) bad += 1;

// 免安装目录里要带联调 bat
const bat = path.join(PORT, "启动-手机联调.bat");
const hasBat = fs.existsSync(bat);
console.log((hasBat ? "  OK   " : "  MISS ") + "免安装目录含「启动-手机联调.bat」");
if (!hasBat) bad += 1;

fs.rmSync(out, { recursive: true, force: true });
console.log(bad === 0 ? "结论：产物已包含手机端全部组件 ✅" : `结论：${bad} 项缺失 ❌`);
process.exit(bad === 0 ? 0 : 1);
