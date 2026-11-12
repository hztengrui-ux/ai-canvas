// 校验 dist 里"真正被 index.html 引用的那个 bundle"内容（排除旧文件干扰）
import fs from "node:fs";
import path from "node:path";

const dist = "dist";
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const js = (html.match(/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0];
const css = (html.match(/assets\/index-[A-Za-z0-9_-]+\.css/) || [])[0];
console.log("index.html 引用:", js, css);

const jt = js ? fs.readFileSync(path.join(dist, js), "utf8") : "";
const ct = css ? fs.readFileSync(path.join(dist, css), "utf8") : "";

const files = fs.readdirSync(path.join(dist, "assets")).filter((n) => n.startsWith("index-"));
console.log("dist/assets 下 index-* 文件数:", files.length, files);

const checks = [
  ["含「优质国产」供应商分栏", jt.includes('"优质国产"')],
  ["不含「通义万相」", !jt.includes("通义万相")],
  ["不含 FLUX-2-Klein", !jt.includes("Flux-2-Klein")],
  ["不含旧主题 id", !/aurora|atelier|momentum/.test(jt)],
  ["含 seedream-5-pro", jt.includes("seedream-5-pro")],
  ["含 AI 优化按钮", jt.includes("AI 优化")],
  ["CSS 只有 prism 主题块", ct.includes('data-theme=prism') && !/aurora|atelier|momentum/.test(ct)]
];
let bad = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) bad += 1;
}
process.exit(bad ? 1 : 0);
