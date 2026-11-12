// 一键跑批：起一个干净的服务端实例 → 跑账本测试 + 支付安全测试 → 收尾。
//
// 为什么要包装一层：
//  1. 测试会写账本，直接跑会污染 ~/.ai-canvas 里的真实数据；这里用临时数据目录隔离
//  2. 支付测试要验签，服务端和测试进程必须指向同一份沙箱密钥，
//     靠人手工 export 环境变量迟早会漏，脚本统一注入就不会错
//  3. 结果要能被 CI 读到：任一失败就以非 0 退出码结束
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/**
 * 测试数据目录：放在**项目盘**下的 .tmp 里，而不是 os.tmpdir()。
 *
 * 2026-10-16 调整（用户要求："以后任务不要放在 C 盘，一定要放在 E 盘"）：
 * os.tmpdir() 在 Windows 上等于 C:\Users\<用户>\AppData\Local\Temp ——
 * 每跑一次全量测试，账本、产物、素材、服务端日志全落在 C 盘，
 * 33 个套件跑下来会攒出可观的一堆；而且 C 盘一旦吃紧就直接 ENOSPC 挂测试。
 * 现在固定放进项目下的 .tmp（项目在 E 盘 → 测试全程不碰 C 盘）。
 */
const TMP_ROOT = path.join(ROOT, ".tmp");
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DATA_DIR = fs.mkdtempSync(path.join(TMP_ROOT, "test-"));

/**
 * 顺带把子进程的 TEMP/TMP 也指向项目盘。
 *
 * 有 13 个套件用 `fs.mkdtempSync(path.join(os.tmpdir(), ...))` 自建临时目录，
 * 而 Node 在 Windows 上的 os.tmpdir() 就是读 TEMP/TMP —— 在这里覆盖一次，
 * 13 个套件连同它们 spawn 的服务端全部落到项目盘，
 * 比挨个改 13 个文件更不容易漏（漏一个就又是一堆 C 盘垃圾）。
 * 子进程要的是「父进程已经改过」的这份 env，所以必须在 spawn 之前设置。
 */
const TMP_CHILD = path.join(TMP_ROOT, "tmp");
fs.mkdirSync(TMP_CHILD, { recursive: true });
process.env.TEMP = TMP_CHILD;
process.env.TMP = TMP_CHILD;

function pickPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/session`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function run(name, file, env) {
  return new Promise((resolve) => {
    console.log(`\n──────── ${name} ────────`);
    const p = spawn(process.execPath, [file], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, ...env }
    });
    p.on("exit", (code) => resolve(code === 0));
  });
}

const port = await pickPort();
const base = `http://127.0.0.1:${port}`;

console.log(`临时数据目录：${DATA_DIR}`);
console.log(`测试服务端：${base}`);

// 服务端日志不再走 pipe，而是写文件：
//   受限沙箱里带管道 stdio 的 spawn 会直接 EPERM（spawn EPERM），整个 run-tests 起不来。
//   文件句柄不涉及管道，所以把 stdout/stderr 重定向到一个日志文件，
//   bootLog 的语义（启动失败时把服务端输出打出来）完全保留。
const SERVER_LOG = path.join(DATA_DIR, "server.log");
const serverLogFd = fs.openSync(SERVER_LOG, "w");

const server = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  stdio: ["ignore", serverLogFd, serverLogFd],
  // AI_CANVAS_OUTPUTS 必须与测试进程一致，否则「测试播种的产物文件」
  // 服务端根本找不到 → 缓存永远不命中 → 每请求都真去调 provider，
  // 并发槽一路泄漏，后面的断言全线崩。改环境变量时两边要一起改。
  env: {
    ...process.env,
    AI_CANVAS_HOME: DATA_DIR,
    AI_CANVAS_OUTPUTS: path.join(DATA_DIR, "outputs"),
    AI_CANVAS_MATERIALS: path.join(DATA_DIR, "materials"),
    PORT: String(port)
  }
});

function readBootLog() {
  try {
    return fs.readFileSync(SERVER_LOG, "utf8");
  } catch {
    return "";
  }
}

const up = await waitForServer(base);
if (!up) {
  console.error("服务端启动失败：\n" + readBootLog());
  server.kill("SIGKILL");
  process.exit(1);
}

// AI_CANVAS_OUTPUTS：让测试产物落进临时目录，别往项目 outputs/ 里写。
// 那里既会被 git 看到，又常被运行环境的删除保护钩子拦住。
// AI_CANVAS_MATERIALS：同理隔离素材目录 —— 它以前硬编码在用户目录下，
// 受限环境里上传素材会 EPERM。
const env = {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_OUTPUTS: path.join(DATA_DIR, "outputs"),
  AI_CANVAS_MATERIALS: path.join(DATA_DIR, "materials"),
  BASE: base
};

const r1 = await run("算力账本自测", "server/__credits.test.mjs", env);
const r2 = await run("支付回调查验 · 安全测试", "server/__payments.test.mjs", env);
const r3 = await run("SynMew 吸收项自测（签名 / 批量 / 模板反哺 / 保险箱）", "server/__sync.test.mjs", env);
const r4 = await run("吸收项 HTTP 端到端（批量接口 / 模板反哺接口）", "server/__sync-http.test.mjs", env);
const r5 = await run("P1-8 上游签名自测（签名规则 / 缓存隔离 / 账本协同）", "server/__p18.test.mjs", env);
const r6 = await run("P1-8 HTTP 端到端（改备注重跑不重复扣费 / 视频幂等）", "server/__p18-http.test.mjs", env);
// 前端纯逻辑层：导出 / 持久化 / 缩放分档。不依赖服务端，也不需要浏览器。
const r7 = await run("新界面层自测（ZIP 打包 / 项目持久化 / 资产库 / 语义缩放）", "src/__ui.test.mjs", {
  UI_TEST_OUT: path.join(DATA_DIR, "ui-export"),
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_OUTPUTS: path.join(DATA_DIR, "outputs")
});
// 云端四家 provider 的图生图入参。密钥走「本地加密文件」后端，不碰系统凭据管理器。
const r8 = await run("图生图入参自测（万相 / 即梦 / OpenAI / Gemini 真的把图发出去了吗）", "server/__i2i.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_OUTPUTS: path.join(DATA_DIR, "outputs"),
  AI_CANVAS_VAULT: "file"
});
// 主题切换 + 批量节点模式：纯前端，读 CSS 与纯函数，不依赖服务端
const r9 = await run("主题与批量模式自测（三套主题 token 齐全 / 批量拆分与排布）", "src/__theme.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});

// 健壮性补齐：错误边界分级 / 服务端真取消 / 素材路径校验 / 排序
// （纯逻辑，但要 import vue 的 reactive，放在前端组里跑）
const r10 = await run("健壮性补齐自测（错误分级 / 任务真取消 / 素材路径 / 排序）", "src/__robust.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});

// 取消端到端：自带假 ComfyUI，证明 /interrupt 真的被请求（不只是钩子被调用）
const r11 = await run("取消端到端（假 ComfyUI：/interrupt 真的被请求）", "server/__cancel.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file"
});

// ComfyUI 多参考图融合：喂假的 /object_info，断言 N 张图真的都进去了（不能只有第一张生效）
const r12 = await run("IPAdapter 多图融合（静态多图真的都参与生成）", "server/__ipadapter.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file",
  AI_CANVAS_OUTPUTS: path.join(DATA_DIR, "outputs")
});

// E6 资产血缘：能不能回答「这张图当初是怎么跑出来的」
const r13 = await run("资产血缘（ prompt / model / 参考图 / 花费 真的落盘可复现）", "server/__lineage.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file",
  AI_CANVAS_OUTPUTS: path.join(DATA_DIR, "outputs")
});

// 2026-10-14 修复验收：并发槽泄漏(全局 DoS) / 运营越权提权 / 充值伪支付 / 账本幂等与裁旧吞余额
// 这套是「防回归」用的：上面 13 套在修复前后都是绿的，抓不到这四类缺陷，所以单独补一套。
const r14 = await run("修复验收（槽位泄漏 / 越权提权 / 伪支付 / 账本资损）", "server/__fixes.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file",
  AI_CANVAS_OUTPUTS: path.join(DATA_DIR, "outputs")
});

// 第三轮修复验收：语义缩放幽灵选择器 / 画布 id 重复 / 作品组结构字段 / 技能入口空转 /
// 模型选择器分栏 / 单价与服务端一致。纯静态+纯函数，不依赖服务端。
const r15 = await run("第三轮验收（语义缩放 / 画布 id / 作品组 / 技能入口 / 模型选择器）", "src/__round3.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});

// 2026-10-14 第三轮：白标打包配置。纯本地（读配置 + 读源码做防回归），不需要服务端。
// 锁住三件事：BRAND 真的改变 appId/productName/artifactName/shortcutName、
// 品牌固化字段进得了包、UpdateToast 不再出现 Math.random 假进度。
const r16 = await run("白标打包配置（品牌解析 / 打包身份 / 品牌固化 / 假进度条防回归）", "scripts/__brand.config.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});

// 2026-10-15 性能与清理：代码分割 / 生成源图不得留在 public / __probe.mjs 已删 /
// 死代码已清 / 静态资源 HTTP 缓存策略。纯静态断言（产物相关断言需先 build 过）。
const r17 = await run("性能与清理（代码分割 / 体积 / 危险文件 / 缓存策略）", "src/__perf.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});

// 2026-10-16 Sprint 0：外壳信任模型。这三套是「防回归」——
// 之前 17 套全绿也抓不到「写接口谁都能调」「端口派生算错导致自己把自己拦掉」这类问题。
// ① 端口派生：品牌 → 端口映射、确定性、与 Host 白名单一致（纯逻辑）
const r18 = await run("端口派生（品牌映射 / 确定性 / Host 白名单一致性）", "server/__ports.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});
// ② 变更令牌门：读放行、写默认拒绝、回调豁免、端口归属回显（中间件 + 真服务端两段）
const r19 = await run("变更令牌门与端口归属（默认拒绝未授权写 / 令牌回显）", "server/__guard-token.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file"
});
// ③ 批量续跑：幂等键 / 只重试失败项 / 中断恢复（纯逻辑，临时数据目录）
const r20 = await run("批量续跑（幂等键 / 只重试失败项 / 中断恢复）", "server/__batch-resume.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file"
});

// 2026-10-16 Sprint 1：模型网关 + 提示词编译管线。
// ④ 模型网关（单元）：注册表完整性 / 与前端模型清单跨端一致 / 路由 / 能力校验 / 额度三段式
const r21 = await run("模型网关（注册表 / 跨端单价一致 / 路由 / 能力校验 / 额度三段式）", "server/__gateway.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file"
});
// ⑤ 模型网关与提示词编译（接口）：/api/models、/api/prompt/compile、
//    生成接口的结构化校验错误，以及「校验失败不得占用并发槽」这条防 DoS 断言
const r22 = await run("模型网关接口（模型目录 / 提示词编译 / 校验不占槽）", "server/__models-http.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file",
  BASE: base
});
// ⑥ 提示词编译管线（单元）：4000 硬上限 / 角色锚点 / 注入防御 / 画幅 / 确定性 / 脏输入
const r23 = await run("提示词编译（角色锚点 / 不变量 / 注入防御 / 硬上限）", "server/__prompt-compiler.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});

// 2026-10-16 Sprint 2：托盘/通知 + 画布剪贴板（都是纯逻辑，注入假 Electron / 零依赖）
const r24 = await run("托盘与通知（幂等 / 菜单门控 / 前台不打扰 / 失败不抛）", "electron/__tray.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});
const r25 = await run("画布剪贴板（复制粘贴 / 丢边 / 分组重映射 / 限流）", "src/__clipboard.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});
// 界面精修层防回归：加载顺序 / 旧变量别名（49 处静默失效）/ 空态定位 / 各处接线
const r26 = await run("界面精修与接线（加载顺序 / 变量别名 / 空态定位 / 托盘剪贴板接线）", "src/__redesign.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});
// 技能库骨架：12+ 技能定义 / 参数校验 / 技能参数 → 提示词链 → 编译 / 执行计划
const r27 = await run("技能库（技能定义 / 参数校验 / 提示词链 / 执行计划）", "server/__skills.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file"
});
// 技能 → 画布：铺图转换（分层布局 / 丢悬空边）+ 接线只有一条路径 + 跨端模板键校验
const r28 = await run("技能铺图接线（转换 / 悬空边 / 单一路径 / 跨端模板键）", "src/__skills-ui.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});
// 任务条清除：只清失败 / 清已完成 / 单条移除 / 进行中不可误删 / 文案与行为一致
const r29 = await run("任务条清除（清失败 / 清已完成 / 单条移除 / 文案一致）", "src/__taskbar.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});
// 退费：refId 复用不再吞退费 / 重复提交不重复扣 / 悬空预扣回收（真实事故回归）
const r30 = await run("算力退费与悬空回收（refId 复用 / 重复提交 / 进程被杀）", "server/__credits-refund.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});
// 存储位置：数据/产物/素材/临时文件都必须在项目盘，不许再写 C 盘
const r31 = await run("存储位置（数据根 / 产物 / 素材 / 临时目录都在项目盘）", "server/__storage-location.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR
});

// 2026-10-18 手机端（微信小程序）：第二种令牌 + 局域网入口 + 出图代理层。
// 必须传 PORT：security.js 的 Host 白名单是按 PORT 算的，不给就会把自己的请求拦成 BAD_HOST。
const r34 = await run("文件批量引擎（扫描 / 越界防护 / 命名与提示词变量）", "server/__filebatch.test.mjs", { ...env });
// 2026-11-05：第三方模型 API 自检接口（假上游；验证 Key 错 / 地址错 / 模型错 / 连不上分别有独立 code，
// 且自检绝不发起图片生成、不扣算力）
const r35 = await run("模型 API 自检（Key 错 / 地址错 / 模型错 / 连不上 + 不扣算力）", "server/__probe.test.mjs", { ...env });

// 2026-11-05 运营后台：客户中心 / 充值后台（自动管理）/ 第三方聚合支付。
// 这四套自带临时 AI_CANVAS_HOME 与独立端口（不依赖上面这个服务端实例），跑完自己清理。
const r36 = await run(
  "第三方聚合支付（epay / 虎皮椒 / 自建：签名 / 下单 / 验签 / 查单 / 密钥不回显）",
  "server/__aggregator.test.mjs",
  { ...env }
);
const r37 = await run("客户中心（列表 / 档案 / 数据范围 / 人工调账 / 越权隔离）", "server/__customers.test.mjs", { ...env });
const r38 = await run("充值后台与自动管理（补单 / 退款 / 套餐改价 / 定时查单 / 审计）", "server/__recharge.test.mjs", { ...env });
const r39 = await run(
  "运营后台端到端（客户 → 充值 → 沙箱支付 → 聚合回调 → 自动管理 → 权限矩阵）",
  "server/__ops.test.mjs",
  { ...env }
);
const r33 = await run("语义处理（豆包 2.1 / 上游模型名解析）", "server/__semantic.test.mjs", { ...env });
const r32 = await run("手机端小程序（令牌形状 / 回环边界 / 鉴权接线 / 越权隔离 / 真接口）", "server/__mobile.test.mjs", {
  AI_CANVAS_HOME: DATA_DIR,
  AI_CANVAS_VAULT: "file",
  AI_CANVAS_OUTPUTS: path.join(DATA_DIR, "outputs"),
  PORT: String(port),
  BASE: base
});

server.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 300));
// 先关掉服务端日志的文件句柄，否则 Windows 上删不掉还占着文件的目录
try {
  fs.closeSync(serverLogFd);
} catch {
  /* ignore */
}
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("\n════════ 汇总 ════════");
console.log(`  算力账本      ${r1 ? "通过" : "失败"}`);
console.log(`  支付回调      ${r2 ? "通过" : "失败"}`);
console.log(`  吸收项（单元）  ${r3 ? "通过" : "失败"}`);
console.log(`  吸收项（接口）  ${r4 ? "通过" : "失败"}`);
console.log(`  P1-8 签名（单元）${r5 ? "通过" : "失败"}`);
console.log(`  P1-8 签名（接口）${r6 ? "通过" : "失败"}`);
console.log(`  新界面层        ${r7 ? "通过" : "失败"}`);
console.log(`  图生图入参      ${r8 ? "通过" : "失败"}`);
console.log(`  主题与批量模式    ${r9 ? "通过" : "失败"}`);
console.log(`  健壮性补齐      ${r10 ? "通过" : "失败"}`);
console.log(`  取消端到端      ${r11 ? "通过" : "失败"}`);
console.log(`  多图融合        ${r12 ? "通过" : "失败"}`);
console.log(`  资产血缘        ${r13 ? "通过" : "失败"}`);
console.log(`  修复验收        ${r14 ? "通过" : "失败"}`);
console.log(`  第三轮验收      ${r15 ? "通过" : "失败"}`);
console.log(`  白标打包配置      ${r16 ? "通过" : "失败"}`);
console.log(`  性能与清理      ${r17 ? "通过" : "失败"}`);
console.log(`  端口派生        ${r18 ? "通过" : "失败"}`);
console.log(`  变更令牌门      ${r19 ? "通过" : "失败"}`);
console.log(`  批量续跑        ${r20 ? "通过" : "失败"}`);
console.log(`  模型网关        ${r21 ? "通过" : "失败"}`);
console.log(`  模型网关接口    ${r22 ? "通过" : "失败"}`);
console.log(`  提示词编译      ${r23 ? "通过" : "失败"}`);
console.log(`  托盘与通知      ${r24 ? "通过" : "失败"}`);
console.log(`  画布剪贴板      ${r25 ? "通过" : "失败"}`);
console.log(`  界面精修        ${r26 ? "通过" : "失败"}`);
console.log(`  技能库          ${r27 ? "通过" : "失败"}`);
console.log(`  技能铺图接线    ${r28 ? "通过" : "失败"}`);
console.log(`  任务条清除      ${r29 ? "通过" : "失败"}`);
console.log(`  算力退费回收    ${r30 ? "通过" : "失败"}`);
console.log(`  存储位置        ${r31 ? "通过" : "失败"}`);
console.log(`  手机端小程序    ${r32 ? "通过" : "失败"}`);
console.log(`  语义处理        ${r33 ? "通过" : "失败"}`);
console.log(`  文件批量        ${r34 ? "通过" : "失败"}`);
console.log(`  模型 API 自检   ${r35 ? "通过" : "失败"}`);
console.log(`  聚合支付        ${r36 ? "通过" : "失败"}`);
console.log(`  客户中心        ${r37 ? "通过" : "失败"}`);
console.log(`  充值后台        ${r38 ? "通过" : "失败"}`);
console.log(`  运营后台端到端  ${r39 ? "通过" : "失败"}`);
console.log("");

process.exit(
  r1 && r2 && r3 && r4 && r5 && r6 && r7 && r8 && r9 && r10 && r11 && r12 && r13 && r14 && r15 && r16 && r17 && r18 && r19 && r20 && r21 && r22 && r23 && r24 && r25 && r26 && r27 && r28 && r29 && r30 && r31 && r32 && r33 && r34 && r35 && r36 && r37 && r38 && r39 ? 0 : 1
);
