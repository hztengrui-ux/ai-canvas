/**
 * 界面精修层与接线防回归（Sprint 2）
 * --------------------------------------------------------------------------
 * 为什么需要这套：这一轮修的三个问题都属于「**静默失效**」——
 * 不报错、不崩溃，只是界面变丑，而且改的人完全无感：
 *   1. newui.css 里 49 处样式引用了早已不存在的旧变量（--bg-1/--border-1/--bg-2/--bg-3），
 *      浏览器把整条声明当无效值丢掉 → 面板没底没边，文字像裸奔
 *   2. `.canvas-empty.rich` 没有清掉旧规则继承下来的 transform:translate(-50%,-50%)，
 *      整屏容器被平移出半屏 → 空态内容挤在左上角还被裁掉
 *   3. 精修层的加载顺序：必须排在 themes.css 之后（才能盖住主题）、
 *      responsive.css 之前（否则会把窄窗适配规则盖掉）
 * 这三件事都没有任何测试会失败 —— 所以补上静态断言钉死它们。
 *
 * 纯静态检查：读源码，不起服务端、不需要浏览器。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** 递归收集 src 下的 .vue 文件（运行时可能用 :style 注入 CSS 变量） */
function walkVue(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkVue(p, out);
    else if (entry.name.endsWith(".vue")) out.push(p);
  }
  return out;
}

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

console.log("\n[1] 精修层加载顺序");
{
  const main = read("src/main.js");
  const iTheme = main.indexOf('import "./themes.css"');
  const iRedesign = main.indexOf('import "./redesign.css"');
  const iResponsive = main.indexOf('import "./responsive.css"');
  check("main.js 里三处导入都存在", iTheme >= 0 && iRedesign >= 0 && iResponsive >= 0);
  check("精修层排在主题层之后（否则盖不住主题变量）", iRedesign > iTheme, `themes=${iTheme} redesign=${iRedesign}`);
  check(
    "精修层排在窄窗适配之前（否则会盖掉小屏收缩规则）",
    iRedesign < iResponsive,
    `redesign=${iRedesign} responsive=${iResponsive}`
  );
}

console.log("\n[2] 旧变量兼容别名（修 49 处静默失效）");
{
  const css = read("src/redesign.css");
  for (const name of ["--bg-1", "--bg-2", "--bg-3", "--border-1", "--fill-color", "--shadow-sm"]) {
    check(`别名补齐 ${name}`, new RegExp(`${name}\\s*:`).test(css));
  }
  check("别名指向当前 token（--surface）而不是写死颜色", /--bg-1:\s*var\(--surface\)/.test(css));

  // 反向断言：整个 src 里不应再出现「被引用但从未定义」的变量
  const files = fs.readdirSync(path.join(ROOT, "src")).filter((f) => f.endsWith(".css"));
  const defined = new Set();
  const used = new Map();
  for (const f of [...files, "redesign.css"]) {
    const text = read(`src/${f}`);
    for (const m of text.matchAll(/(?:^|[\s;{])--([a-z0-9-]+)\s*:/gi)) defined.add(m[1]);
    for (const m of text.matchAll(/var\(\s*--([a-z0-9-]+)\s*(?:,[^)]*)?\)/gi)) used.set(m[1], true);
  }
  // 运行时注入的变量也算已定义：例如模板卡片用 :style="{ '--h': i.hue }" 传色相
  for (const f of walkVue(path.join(ROOT, "src"))) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/['"]--([a-z0-9-]+)['"]\s*:/gi)) defined.add(m[1]);
  }
  const missing = [...used.keys()].filter((n) => !defined.has(n));
  check("src 里没有「被引用但未定义」的变量（含运行时注入）", missing.length === 0, missing.join(", "));
}

console.log("\n[3] 空画态定位修复");
{
  const css = read("src/redesign.css");
  check(
    "显式清掉 .canvas-empty.rich 的 transform（根因是旧规则遗留的 translate）",
    /\.canvas-empty\.rich\s*\{[^}]*transform:\s*none/s.test(css)
  );
  const newui = read("src/newui.css");
  check("newui 里 .rich 仍是 inset:0 全屏居中（修改没走偏）", /\.canvas-empty\.rich\s*\{[^}]*inset:\s*0/s.test(newui));
}

console.log("\n[4] 画布剪贴板接线");
{
  const canvas = read("src/components/NodeCanvas.vue");
  check("引入了剪贴板模块", /from "\.\.\/canvas-clipboard\.js"/.test(canvas));
  check("绑定了 Ctrl/Cmd + C", /meta && \(e\.key === "c"/.test(canvas));
  check("绑定了 Ctrl/Cmd + V", /meta && \(e\.key === "v"/.test(canvas));
  check("绑定了 Ctrl/Cmd + D", /meta && \(e\.key === "d"/.test(canvas));
  check("粘贴优先用内存信封（不因剪贴板权限就不可用）", /clipEnvelope && pasteFromText\(clipEnvelope\)/.test(canvas));
  check("粘贴后清理旧选中（否则新旧混选像没粘上）", /applySelection\(\[\]\);\s*\n\s*addNodes/.test(canvas));
  check("id 复用 store 的 newFlowId（与画布其余 id 同源）", /idFactory: \(\) => newFlowId\("n"\)/.test(canvas));
}

console.log("\n[5] 托盘与通知接线（主进程侧）");
{
  const main = read("electron/main.cjs");
  check("引入托盘控制器", /require\("\.\/tray\.cjs"\)/.test(main));
  check("创建了托盘并在日志里如实报告成败", /trayCtl\.create\(\)/.test(main) && /托盘：/.test(main));
  check("关闭窗口收进托盘（而不是退进程）", /mainWin\.on\("close"/.test(main));
  check(
    "托盘创建失败时不拦截关闭（否则窗口消失、进程还在跑）",
    /!trayCtl \|\| !trayCtl\.isCreated\(\)\) return;/.test(main)
  );
  check("退出前销毁托盘（否则 Windows 上图标残留）", /trayCtl\?\.destroy\(\)/.test(main));
  check("通知 IPC 传入了窗口前台状态（策略依赖它）", /focused:\s*win\.isFocused\(\)/.test(main));
  const preload = read("electron/preload.cjs");
  check("preload 暴露 notifyTask", /notifyTask:/.test(preload));
  const api = read("src/api.js");
  check("SSE 结束时上报通知（只上报事实，策略在主进程）", /window\.desktop\.notifyTask\(\{/.test(api));
  check("渲染进程不自己判断该不该弹（无 shouldNotify 逻辑）", !/shouldNotify/.test(api));
}

console.log("\n[6] 截图/预览开关（只读，不影响正常用户）");
{
  const app = read("src/App.vue");
  const home = read("src/components/HomeView.vue");
  check("App.vue 支持 ?screenshot=1 跳过新手引导", /PREVIEW_MODE/.test(app));
  check("HomeView 的公告同样受该开关控制", /PREVIEW_MODE/.test(home));
  check("开关默认关闭（参数缺失时行为与之前一致）", /get\("screenshot"\) === "1"/.test(app));
  check(
    "正常路径仍会记录「已看过公告」（开关没破坏原功能）",
    /function dismissWhatsNew[\s\S]{0,240}localStorage\.setItem/.test(home)
  );
}

console.log("\n[7] 首页与顶栏改版（2026-10-16，对齐用户给的参考稿）");
{
  const shell = read("src/components/AppShell.vue");
  const home = read("src/components/HomeView.vue");
  const css = read("src/redesign.css");

  check("顶栏有分段胶囊导航", /class="topnav"/.test(shell) && /class="topnav-item"/.test(shell));
  check(
    "导航覆盖原来侧栏的入口（首页/模板库/我的项目/作品库）",
    ["工作台", "模板库", "我的项目", "作品库"].every((t) => shell.includes(t))
  );
  check("技能收进下拉（15 个放不进顶栏）", /技能[\s\S]{0,400}SKILLS/.test(shell));
  check("侧栏整块移除（不是 display:none 的假移除）", !/<aside\s+class="sidebar"/.test(shell));
  check("页面内容区拿整幅宽度", /html\[data-theme\] \.app-main\s*\{[\s\S]{0,80}flex: 1/.test(css));
  // 用户 V1003.06 明确要求过「左边 AI 创作台去掉字」，别在改版里又加回来
  check("顶栏左侧仍然只有品牌标记、没有文字块", !/topbar-appname/.test(shell));
  check("顶栏右侧控件高度统一（原来参差不齐）", /\.topbar-right \.btn-icon-light[\s\S]{0,200}height: 32px/.test(css));

  check("首页有指标条", /rd-metrics/.test(home) && /rd-metric-num/.test(home));
  check("有一张反色强调卡（余额）", /rd-metric dark/.test(home));
  check("反色卡在深色主题下自动翻转（不写两套硬编码色）", /body\.dark\s*\{[\s\S]{0,200}--rd-inv-bg/.test(css));
  // 口径诚实：history 只有时间没有日期，不能写成"本月生成"
  check("指标口径不编造（没有「本月生成」这种假口径）", !/本月生成/.test(home));
  check("没有数据时不画迷你柱图，改提示空态", /v-if="recentGenCount"[\s\S]{0,120}rd-spark/.test(home) && /还没有生成记录/.test(home));
}

console.log(`\n界面精修与接线：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
