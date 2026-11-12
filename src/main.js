import { createApp } from "vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
import * as ElementPlusIconsVue from "@element-plus/icons-vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import App from "./App.vue";
import "./style.css";
import "./account.css";
import "./admin.css";
import "./templates.css";
import "./rail.css";
import "./newui.css";
// 主题层放最后：它要盖住前面的 :root / body.dark 与 Element Plus 变量
import "./themes.css";
// 界面精修层：只改表面（圆角/阴影/字重/控件手感），必须排在 themes 之后、
// responsive 之前 —— 窄窗适配靠"后写的赢"，精修层不能在它后面。
import "./redesign.css";
// Prism 主题的专属表面层：必须在 redesign.css 之后（同特异性、后写的赢），
// 但要在 responsive.css 之前 —— 窄窗适配永远最后。
import "./prism.css";
// 2026-10-31 布局改版层（左侧图标栏 + 首页 loom 结构）
import "./loom.css";
// 无限画布视觉精修层（2026-10-23）：只覆盖 studio 相关选择器
// （顶栏分组 / 画布层次 / 左侧工具条 / 右下角浮层），不碰其他页面。
// 同样排在 responsive 之前，窄窗适配仍然最后。
import "./studio-polish.css";
// 窄窗适配放最后之后：它要在所有基础样式之上收缩（G8）
import "./responsive.css";
import { initEmbed } from "./embed.js";
import { initTheme } from "./theme.js";
import { reportFatal, installGlobalHandlers } from "./errorboundary.js";

// 必须在 mount 之前定好主题，否则会闪一下默认配色再跳过去
initTheme();

// 全局兜底：Vue 管不到的错误（第三方脚本、异步回调）也不能白屏
installGlobalHandlers();

const app = createApp(App);

// 组件渲染 / 生命周期 / 事件处理里的错误，一律进兜底页。
// 没有这一行，任意组件抛错都会让整棵组件树卸载，用户看到的就是白屏。
app.config.errorHandler = (err, vm, info) => {
  reportFatal(err, info || "组件渲染");
};

app.use(ElementPlus, { locale: zhCn, zIndex: 3000 });
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}
app.mount("#app");

// 桌面端：标记 body，让顶栏变成可拖拽的窗口标题栏
if (window.desktop?.isDesktop) {
  document.body.classList.add("is-desktop");
}

// 被宿主 iframe 嵌入时，启动通信桥
initEmbed();
