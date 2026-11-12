// 校验「打出来的免安装版」里到底有没有新主题 —— 不是看源码，是看 asar 里的产物。
//
// 为什么用 extractAll 而不是 extractFile：
// @electron/asar 在 Windows 上 listPackage() 返回 `\dist\assets\x.css`（反斜杠 + 前导反斜杠），
// 而 extractFile() 的内部查找键与之不一致，四种写法（正斜杠/前导斜杠/反斜杠/原样）全部 not found。
// 与其猜路径格式，不如整包解出来再从磁盘读 —— 慢几秒，但结果确定。
import * as asar from "@electron/asar";
import fs from "node:fs";
import path from "node:path";

const asarPath = "release/ai-canvas-portable/resources/app.asar";
const outDir = path.resolve(".tmp-asar-check");

fs.rmSync(outDir, { recursive: true, force: true });
asar.extractAll(asarPath, outDir);

const assetsDir = path.join(outDir, "dist", "assets");
const cssFiles = fs.readdirSync(assetsDir).filter((f) => /^index-.*\.css$/.test(f));
console.log("dist/assets index css:", cssFiles.join(" | "));

const text = fs.readFileSync(path.join(assetsDir, cssFiles[0]), "utf8");
// 产物是压缩过的 CSS，属性选择器里的引号会掉（[data-theme=prism]），
// 所以这里的正则一律允许引号可有可无 —— 之前写成带引号的字面量，误报了 3 项 MISS。
const sel = (v) => `\\[data-theme=["']?${v}["']?\\]`;
const checks = {
  "prism token block": new RegExp(sel("prism")).test(text),
  "lime token #d8fa34": /#d8fa34/i.test(text),
  "--page-grad 渐变": text.includes("--page-grad"),
  "柠檬绿导航药丸": text.includes("topnav-item.on") && text.includes("--lime"),
  "禁用态修复 .ce-go:disabled": text.includes(".ce-go:disabled"),
  "项目卡虚线卡修复": text.includes("project-card.new"),
  "暗色 prism 块": new RegExp(`\\.dark${sel("prism")}`).test(text),
  "暗色导航底": new RegExp(`\\.dark${sel("prism")}\\s*\\.topnav`).test(text),
  "排序胶囊选中态": new RegExp(`${sel("prism")}\\s*\\.pj-sort-btn\\.on`).test(text)
};
let bad = 0;
for (const k of Object.keys(checks)) {
  console.log((checks[k] ? "  OK    " : "  MISS  ") + k);
  if (!checks[k]) bad += 1;
}
console.log("css bytes:", text.length);

const html = fs.readFileSync(path.join(outDir, "dist", "index.html"), "utf8");
const ref = /assets\/(index-[A-Za-z0-9_-]+\.css)/.exec(html);
console.log("index.html -> css:", ref ? ref[1] : "(未找到)");
console.log("packaged css :", cssFiles[0]);

// 打包产物只有 dist + electron + server 等运行期文件；
// prism.css 作为源码已在构建时内联进 dist 的 css，不该单独出现在 asar 里。
const topLevel = fs.readdirSync(outDir);
console.log("asar 顶层:", topLevel.join(", "));

fs.rmSync(outDir, { recursive: true, force: true });
console.log(bad === 0 ? "结论：产物与新主题一致 ✅" : `结论：${bad} 项缺失 ❌`);
process.exit(bad === 0 ? 0 : 1);
