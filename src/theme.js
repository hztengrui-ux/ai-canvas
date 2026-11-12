/**
 * 主题引擎（2026-10-17）
 *
 * 2026-10-23 起只保留一套视觉方案：棱镜 Prism（明暗两版）。
 * 默认 Prism · 亮色（用户给的运营分析参考稿配色：
 * 雾霭蓝紫底 + 柠檬绿行为色 + 墨黑反色 + 钴蓝信息色）。
 * （原「经典蓝」回滚主题已移除：若用户 localStorage 里还存着它，
 *   normalizeThemeId 会静默回退到 DEFAULT_THEME，不会白屏。）
 *
 * 设计要点：
 * 1. 主题只换 token，不换 DOM —— 业务代码零改动。
 *    data-theme 挂在 <html> 上，明暗挂在 <body>.dark 上，二者正交：
 *    1 套主题 × 明暗 = 2 套配色，全部在 themes.css 里；
 *    Prism 另有 prism.css 放它专属的表面规则（必须在 redesign.css 之后加载）。
 * 2. 品牌色（白标）优先于主题强调色：App.vue 只把品牌主色写进 --brand，
 *    --primary 由主题表一律写成 var(--brand)，于是有白标时按钮跟品牌走，
 *    没有白标时跟主题走。改一处即可，不用两边 if。
 * 3. 切主题时给 <html> 短暂挂 .theme-transition，让 300ms 内联过渡生效，
 *    避免常驻 * { transition } 拖慢画布拖拽。
 * 4. 本模块在 Node 环境（测试）里也能 import：所有 DOM 访问都做了守卫。
 */
import { store } from "./store.js";

/**
 * 主题注册表。
 *
 * 2026-10-23：只保留「棱镜 Prism」一套（用户要求"图 2 那三个主题去掉"）。
 * 仍保留数组结构：以后真要加第二套时，切换器 / 测试 / id 归一化都不用重写。
 */
export const THEMES = [
  {
    id: "prism",
    name: "棱镜",
    en: "Prism",
    desc: "中性灰 · 墨黑 · 荧光绿点睛",
    defaultDark: false,
    swatch: ["#ECEFF2", "#15171E", "#D8FA34"]
  }
];

export const THEME_IDS = THEMES.map((t) => t.id);
// 2026-10-17：默认主题改成「棱镜 Prism」。
// 用户给定参考稿（运营分析稿）后明确"UI 与风格做得不好看，按这个配色升级"，
// 取色量化自那张图：底色 #ECEFF9 / 柠檬绿 #D8FA34 / 墨黑 #15171E / 钴蓝 #4361EE。
// 原来默认是「画布工作室」（暖白底 #FAF8F5），偏暖偏灰、和冷色内容打架。
export const DEFAULT_THEME = "prism";

const KEY_THEME = "ai-canvas.theme.v2";
const KEY_DARK = "ai-canvas.dark.v2";

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || null;
}

/** 非法 id 一律退回默认主题 —— 手改 localStorage 也不至于白屏 */
export function normalizeThemeId(id) {
  return THEME_IDS.includes(id) ? id : DEFAULT_THEME;
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // 隐私模式 / Node 环境
  }
}

export function loadThemeId() {
  const s = storage();
  const saved = s ? s.getItem(KEY_THEME) : "";
  return normalizeThemeId(saved || DEFAULT_THEME);
}

function loadDark(themeId) {
  const s = storage();
  if (s) {
    const v = s.getItem(KEY_DARK);
    if (v === "1") return true;
    if (v === "0") return false;
  }
  return Boolean(themeById(themeId)?.defaultDark);
}

/** 把主题写到 <html data-theme>；Node 环境直接返回归一化后的 id */
export function applyTheme(id) {
  const t = normalizeThemeId(id);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.theme = t;
  }
  return t;
}

/**
 * 明暗同时写到 <html> 与 <body>。
 * body.dark 是历史约定（style.css 里有大量 body.dark 规则，不能动）；
 * html.dark 是新增的，因为主题 token 挂在 html[data-theme] 上，
 * 只有 html 自己带 .dark，themes.css 才能写出
 *   html[data-theme="prism"]:not(.dark) { …亮色… }
 * 这种一层搞定的明暗分支（否则 token 得下放到 body，EP 变量会取错值）。
 */
export function applyDark(dark) {
  const on = Boolean(dark);
  if (typeof document !== "undefined") {
    document.documentElement?.classList.toggle("dark", on);
    document.body?.classList.toggle("dark", on);
  }
  return on;
}

/** 切换时短暂开启全局过渡（300ms），避免常驻 * { transition } 拖慢画布 */
let transitionTimer = null;
function flashTransition() {
  if (typeof document === "undefined" || !document.documentElement) return;
  const el = document.documentElement;
  el.classList.add("theme-transition");
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => el.classList.remove("theme-transition"), 360);
}

/**
 * 切换主题（可同时指定明暗）。写 store + 落 localStorage + 挂 DOM。
 * @param {string} id  主题 id
 * @param {{dark?:boolean, silent?:boolean}} [opts]
 * @returns {{theme:string, dark:boolean}}
 */
export function setTheme(id, opts = {}) {
  const t = normalizeThemeId(id);
  // 没显式给 dark 时：沿用当前明暗，除非之前根本没初始化过（以主题默认值为准）
  const dark = typeof opts.dark === "boolean"
    ? opts.dark
    : (store.theme ? Boolean(store.darkMode) : Boolean(themeById(t)?.defaultDark));

  store.theme = t;
  store.darkMode = dark;

  if (!opts.silent) flashTransition();
  applyTheme(t);
  applyDark(dark);

  const s = storage();
  if (s) {
    try {
      s.setItem(KEY_THEME, t);
      s.setItem(KEY_DARK, dark ? "1" : "0");
    } catch {
      /* 配额满就算了，本次会话内仍然生效 */
    }
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("ai-canvas:theme", { detail: { theme: t, dark } }));
  }
  return { theme: t, dark };
}

/** 只切明暗，不动主题 */
export function toggleDark(next) {
  const dark = typeof next === "boolean" ? next : !store.darkMode;
  return setTheme(normalizeThemeId(store.theme || loadThemeId()), { dark });
}

/** 启动时调用：读出上次的主题与明暗并立即生效（放在 mount 之前，防闪白） */
export function initTheme() {
  const t = loadThemeId();
  const dark = loadDark(t);
  store.theme = t;
  store.darkMode = dark;
  applyTheme(t);
  applyDark(dark);
  return { theme: t, dark };
}

/**
 * 画布网点颜色。
 * Vue Flow 的 <Background> 只收具体色值，读不到 CSS 变量，
 * 所以这里按「主题 + 明暗」查表返回。
 */
const DOT_COLORS = {
  // 2026-10-23：主题只剩 prism，网点色跟着新的中性灰底调冷一档
  prism: { dark: "#2C323D", light: "#C6CCD4" }
};

export function canvasDotColor(themeId = store.theme, dark = store.darkMode) {
  const t = normalizeThemeId(themeId);
  const mode = dark ? "dark" : "light";
  // 兜底也要按明暗取色，否则暗色下会亮出一片浅色网点。
  // 暗色下查到不存在的主题会亮出一片浅色网点（白点铺在黑画布上）。
  return DOT_COLORS[t]?.[mode] || DOT_COLORS.prism[mode] || DOT_COLORS.prism.light;
}
