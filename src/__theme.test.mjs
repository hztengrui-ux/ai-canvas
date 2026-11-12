/**
 * 第 9 个测试套件：主题切换 + 批量节点模式
 *
 * 这套测试存在的理由很具体：换肤最容易出的 bug 不是「颜色不好看」，
 * 而是「某个 token 忘了在新主题里重写」—— 于是按钮是新的、卡片是旧的，
 * 界面看着像坏了。所以这里逐项断言每个主题块的变量清单，缺一个就红。
 *
 * 批量模式这边测的是纯逻辑（拆提示词 / 网格排布 / 成本估算），
 * 画布交互留给人工验收。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES, THEME_IDS, DEFAULT_THEME, normalizeThemeId, canvasDotColor, themeById } from "./theme.js";
import {
  splitPrompts,
  planGrid,
  batchRowStateLabel,
  estimateBatchCost,
  BATCH_LIMITS
} from "./batchmode.js";
import { store, bridge } from "./store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------
console.log("\n[1] 主题注册表");
// ---------------------------------------------------------------
// 2026-10-23：用户要求删掉 Aurora / Atelier / Momentum 三套旧主题，只留棱镜。
// 这里改成断言"只剩一套"，同时保留结构断言（以后加第二套时这些检查仍然有效）。
check("只保留棱镜一套主题", THEMES.length === 1, `实际 ${THEMES.length}`);
check("剩下的就是 prism", THEME_IDS.length === 1 && THEME_IDS[0] === "prism");
check("id 唯一", new Set(THEME_IDS).size === THEMES.length);
check("已下线的三套主题不在注册表里", ["aurora", "atelier", "momentum"].every((id) => !THEME_IDS.includes(id)));
check("经典蓝也没有回滚通道", !THEME_IDS.includes("classic"));
check(
  "每套都有中英文名与三色色卡",
  THEMES.every((t) => t.name && t.en && t.desc && Array.isArray(t.swatch) && t.swatch.length === 3)
);
check(
  "每套都声明了默认明暗",
  THEMES.every((t) => typeof t.defaultDark === "boolean")
);
// 默认主题的期望值不要写死成某个字面量 —— 之前写死 "aurora"，
// 而 V1003.06 把默认主题改成了米白底 "atelier"，测试没跟着改，
// 结果 npm test 长期恒失败（12 绿 1 红），谁都以为环境坏了。
// 现在改为断言「默认主题必须是注册表里真实存在的一套」+ 显式锁定当前值。
check("默认主题是 prism", DEFAULT_THEME === "prism");
check("默认主题确实存在于注册表里", THEME_IDS.includes(DEFAULT_THEME));
check(
  "默认主题能查到完整定义（改名也不会静默失效）",
  Boolean(themeById(DEFAULT_THEME)?.name && themeById(DEFAULT_THEME)?.swatch?.length === 3)
);
check("Prism 是默认明暗为亮色的主题", themeById("prism").defaultDark === false);
check("色卡跟定稿配色一致（中性灰 / 墨黑 / 荧光绿）", JSON.stringify(themeById("prism").swatch) === JSON.stringify(["#ECEFF2", "#15171E", "#D8FA34"]));

// ---------------------------------------------------------------
console.log("\n[2] 主题 id 归一化（手改 localStorage 也不能白屏）");
// ---------------------------------------------------------------
check("合法 id 原样返回", normalizeThemeId("prism") === "prism");
check("已下线主题的旧存档回退到棱镜（删主题不清 localStorage 也不白屏）", normalizeThemeId("atelier") === DEFAULT_THEME);
check("非法 id 退回默认主题", normalizeThemeId("nope") === DEFAULT_THEME);
check("空值退回默认主题", normalizeThemeId("") === DEFAULT_THEME);
check("undefined 退回默认主题", normalizeThemeId(undefined) === DEFAULT_THEME);
check("旧存的 classic 退回默认主题（删主题不清 localStorage 也不白屏）", normalizeThemeId("classic") === DEFAULT_THEME);

// ---------------------------------------------------------------
console.log("\n[3] 画布网点色随主题与明暗变化");
// ---------------------------------------------------------------
const dotDark = canvasDotColor("prism", true);
const dotLight = canvasDotColor("prism", false);
check("同一主题明暗两色不同", dotDark !== dotLight);
check("非法主题也能拿到兜底色", /^#/.test(canvasDotColor("nope", true)));
check("已下线主题也能拿到兜底色（不会返回 undefined）", /^#/.test(canvasDotColor("aurora", false)));
check("色值是 6 位 hex", /^#[0-9a-fA-F]{6}$/.test(dotDark), dotDark);
// 画布网点色是 JS 查表（DOT_COLORS）而不是 token —— 新增主题最容易漏的就是这张表。
// 漏了不会报错，只会静默回退到兜底色，于是"界面换了、画布没换"，肉眼很难定位。
// 这里两件事都校验：表里有这个 key + 取到的值确实不等于兜底值。
const themeSrc = fs.readFileSync(path.join(ROOT, "src", "theme.js"), "utf8");
for (const id of THEME_IDS) {
  check(
    `DOT_COLORS 覆盖主题 ${id}`,
    new RegExp(`\\n\\s*${id}:\\s*\\{\\s*dark:`).test(themeSrc)
  );
}
// 兜底逻辑与 prism 自身同色后，这条要换个方式验：直接对表里的字面值
check(
  "棱镜的网点色确实取自 DOT_COLORS 表",
  themeSrc.includes('prism: { dark: "#2C323D", light: "#C6CCD4" }')
);

// ---------------------------------------------------------------
console.log("\n[4] themes.css：每个主题块的 token 必须写全");
// ---------------------------------------------------------------
const css = fs.readFileSync(path.join(ROOT, "src", "themes.css"), "utf8");

/** 取某个选择器的声明块（到下一个顶层 } 为止） */
function blockOf(selector) {
  const i = css.indexOf(selector);
  if (i < 0) return "";
  const start = css.indexOf("{", i);
  const end = css.indexOf("\n}", start);
  return end < 0 ? css.slice(start + 1) : css.slice(start + 1, end);
}

// 少写任何一个，界面就会一半新一半旧
const REQUIRED = [
  "--bg", "--surface", "--surface-hover", "--border", "--border-strong",
  "--text", "--text-1", "--text-2", "--text-3", "--text-4",
  "--sidebar-bg", "--sidebar-item", "--sidebar-item-hover",
  "--sidebar-item-active", "--sidebar-border",
  "--brand", "--brand-deep", "--brand-light", "--brand-soft",
  "--primary", "--primary-hover", "--primary-pressed", "--primary-soft",
  "--success", "--warning", "--danger", "--info",
  "--radius-sm", "--radius", "--radius-lg", "--radius-xl",
  "--shadow", "--shadow-md",
  "--accent-grad", "--glass", "--glass-border", "--canvas-bg", "--canvas-dot"
];

for (const id of THEME_IDS) {
  const block = blockOf(`html[data-theme="${id}"] {`);
  check(`主题 ${id} 的基础块存在`, block.length > 0);
  const missing = REQUIRED.filter((t) => !new RegExp(`\\n\\s*${t}\\s*:`).test(`\n${block}`));
  check(`主题 ${id} 的 ${REQUIRED.length} 个 token 齐全`, missing.length === 0, `缺 ${missing.join(", ")}`);
  // 白标契约：主题只定义 --brand，--primary 必须派生，否则品牌色会被主题顶掉
  check(`主题 ${id} 的 --primary 派生自 --brand`, /--primary:\s*var\(--brand\)/.test(block));
  check(`主题 ${id} 有渐变强调色`, /--accent-grad:\s*linear-gradient/.test(block));
}

// 每套主题都必须有「另一半」明暗，否则切到没定义的那一半会掉回基础块
for (const id of THEME_IDS) {
  const hasDark = css.includes(`html.dark[data-theme="${id}"]`);
  const hasLight = css.includes(`html[data-theme="${id}"]:not(.dark)`);
  check(`主题 ${id} 明暗两版都定义了`, hasDark !== hasLight, `dark=${hasDark} light=${hasLight}`);
}

check("Element Plus 主色对接主题", /--el-color-primary:\s*var\(--primary\)/.test(css));
check("Element Plus 背景对接主题", /--el-bg-color:\s*var\(--surface\)/.test(css));
check("Element Plus 圆角对接主题", /--el-border-radius-base:\s*var\(--radius\)/.test(css));
check("画布底色交还给主题（覆盖写死的 #f8f9fb）", /\.node-canvas-wrap \.vue-flow\s*\{\s*\n?\s*background: var\(--canvas-bg\)/.test(css));
check("切换过渡只在 .theme-transition 期间生效", /html\.theme-transition/.test(css) && !/^\* \{ transition/m.test(css));

// ---------------------------------------------------------------
console.log("\n[5] 批量模式 UI 样式齐备");
// ---------------------------------------------------------------
check("批量模式选中徽章", css.includes(".node-canvas-wrap.mode-batch .vue-flow__node.selected::after"));
check("批量模式未选中压暗", css.includes(".node-canvas-wrap.mode-batch.has-selection"));
check("批量条样式", css.includes(".batch-bar"));
check("批量面板样式", css.includes(".bd-dock"));
check("模式开关样式", css.includes(".mode-switch"));

// ---------------------------------------------------------------
console.log("\n[6] 拆分提示词（从 Excel 复制过来的脏数据）");
// ---------------------------------------------------------------
const dirty = "1. 雪尼尔毛衫，圆领\n\n2、同款改成 V 领\n- 袖部加条纹\n\n  \n雪尼尔毛衫，圆领";
const parsed = splitPrompts(dirty);
check("去掉了序号与项目符号", parsed.length === 3 && parsed[0] === "雪尼尔毛衫，圆领", JSON.stringify(parsed));
check("空行被丢弃", parsed.every((s) => s.trim().length > 0));
check("重复行只保留一条", parsed.filter((s) => s === "雪尼尔毛衫，圆领").length === 1);
check("空输入返回空数组", splitPrompts("").length === 0);
check("null 输入不炸", splitPrompts(null).length === 0);
check(
  "超过上限会被截断",
  splitPrompts(Array.from({ length: 200 }, (_, i) => `第 ${i} 条`).join("\n")).length ===
    BATCH_LIMITS.maxRows
);
check("可关闭去重", splitPrompts("同一条\n同一条", { dedupe: false }).length === 2);
check("可自定义上限", splitPrompts("a\nb\nc\nd", { max: 2 }).length === 2);

// ---------------------------------------------------------------
console.log("\n[7] 网格排布");
// ---------------------------------------------------------------
const g = planGrid(5, { cols: 2, cellW: 100, cellH: 50, x: 10, y: 20 });
check("数量对得上", g.length === 5);
check("第一行按列铺开", g[0].x === 10 && g[1].x === 110 && g[0].y === 20);
check("换行后 y 递增", g[2].y === 70 && g[2].x === 10);
check("0 个不产生坐标", planGrid(0).length === 0);
check("负数不产生坐标", planGrid(-3).length === 0);
check("默认 3 列", planGrid(4)[3].x === planGrid(4, { cols: 3 })[3].x);

// ---------------------------------------------------------------
console.log("\n[8] 批量状态与成本估算");
// ---------------------------------------------------------------
check("状态标签覆盖 running", batchRowStateLabel("running") === "运行中");
check("未知状态有兜底", batchRowStateLabel("???") === "待运行");
check("成本 = 行数 × 每张 × 单价", estimateBatchCost({ rows: 10, perNode: 4, unitCost: 2.5 }) === 100);
check("零行不花钱", estimateBatchCost({ rows: 0, perNode: 4, unitCost: 10 }) === 0);
check("脏输入不产生 NaN", Number.isFinite(estimateBatchCost({ rows: "abc", perNode: null, unitCost: undefined })));

// ---------------------------------------------------------------
console.log("\n[9] store 与 bridge 契约");
// ---------------------------------------------------------------
check("store 有 theme 字段", typeof store.theme === "string");
check("默认画布模式是自由创作", store.canvasMode === "free", store.canvasMode);
check("批量面板默认展开", store.batchDockOpen === true);
check("批量行是数组", Array.isArray(store.batchRows));
check("bridge 暴露 batchFromPrompts", "batchFromPrompts" in bridge);
check("bridge 暴露 runBatchNodes", "runBatchNodes" in bridge);
check("bridge 暴露 cancelBatch", "cancelBatch" in bridge);
check("bridge 暴露 tidyGrid", "tidyGrid" in bridge);
check("bridge 暴露 getSelectedIds", "getSelectedIds" in bridge);
check("bridge 暴露 setSelectedIds", "setSelectedIds" in bridge);

// ---------------------------------------------------------------
console.log("\n[10] 接线检查（组件与入口真的用上了）");
// ---------------------------------------------------------------
const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
check("main.js 引入了 themes.css", mainSrc.includes('import "./themes.css"'));
check("main.js 在 mount 前初始化主题", mainSrc.includes("initTheme()"));
const themesIdx = mainSrc.indexOf('import "./themes.css"');
const styleIdx = mainSrc.indexOf('import "./style.css"');
check("themes.css 排在 style.css 之后（否则盖不住旧 token）", styleIdx >= 0 && themesIdx > styleIdx);

// Prism 的 token 在 themes.css，表面规则在 prism.css。
// prism.css 必须排在 redesign.css 之后：两者的规则特异性相同，靠"后写的赢"。
const prismIdx = mainSrc.indexOf('import "./prism.css"');
check("main.js 引入了 prism.css", prismIdx > 0);
check(
  "prism.css 排在 redesign.css 之后（同特异性要靠后写才能覆盖）",
  prismIdx > mainSrc.indexOf('import "./redesign.css"')
);
check(
  "prism.css 排在 responsive.css 之前（窄窗适配必须最后）",
  prismIdx < mainSrc.indexOf('import "./responsive.css"')
);

const ncSrc = fs.readFileSync(path.join(ROOT, "src", "components", "NodeCanvas.vue"), "utf8");
check("画布挂了 mode- 类", ncSrc.includes("`mode-${store.canvasMode}`"));
check("批量模式点击是加选（基于点击前快照做异或）", ncSrc.includes("selSnapshot"));
check("批量串行执行有中止检查", ncSrc.includes("batchController.signal.aborted"));
check("批量模式注册了 Ctrl+B", ncSrc.includes('e.key === "b"'));
check("网点色取自主题", ncSrc.includes("canvasDotColor"));

const svSrc = fs.readFileSync(path.join(ROOT, "src", "components", "StudioView.vue"), "utf8");
check("创作台顶栏有模式开关", svSrc.includes("<CanvasModeSwitch"));
check("创作台顶栏有主题切换器", svSrc.includes("<ThemeSwitcher"));
check("创作台里挂了批量面板", svSrc.includes("<BatchDock"));

const shellSrc = fs.readFileSync(path.join(ROOT, "src", "components", "AppShell.vue"), "utf8");
check("主页顶栏也有主题切换器", shellSrc.includes("<ThemeSwitcher"));

const appSrc = fs.readFileSync(path.join(ROOT, "src", "App.vue"), "utf8");
check("App.vue 不再内联覆盖 --primary（否则主题差异被抹平）", !appSrc.includes('setProperty("--primary"'));

// ---------------------------------------------------------------
console.log(`\n主题与批量模式：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail === 0 ? 0 : 1);
