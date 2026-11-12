/**
 * 性能与清理验收（2026-10-15）—— 静态一致性 + 纯逻辑
 *
 * 覆盖：
 *   O1 代码分割：vite.config.js 必须有 manualChunks，且切分边界覆盖 Vue / Element Plus / Vue Flow
 *   O2 生成源图：public/ 里不得再出现那 7 张 12MB 的 PNG 源图（否则每次构建白拷一遍）
 *   O3 危险文件：__probe.mjs 不得存在（它会覆写真实账本 ~/.ai-canvas/credits-ledger.json）
 *   O4 死代码：src/components/_deprecated/ 不得存在（全仓库零引用）
 *   O5 HTTP 缓存：dist 静态托管必须给带 hash 的 /assets/ 长缓存、给 index.html no-cache
 *
 * 运行：node src/__perf.test.mjs
 * 不需要服务端、不需要浏览器。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`);
  }
}

// ============================================================
console.log("\n[O1] 代码分割");
// ============================================================
{
  const cfg = read("vite.config.js");
  check("vite.config.js 配置了 manualChunks", /manualChunks/.test(cfg), "");
  check("切出 element-plus 独立包", /vendor-element/.test(cfg), "");
  check("切出 vue-flow 独立包", /vendor-flow/.test(cfg), "");
  check("切出 vue 独立包", /vendor-vue/.test(cfg), "");
  check(
    "分包只对 node_modules 生效（业务代码留在主包，便于按需更新）",
    /if \(!id\.includes\("node_modules"\)\) return undefined/.test(cfg),
    ""
  );

  // 构建产物必须真的分成多个 js 包（不是单个大包）
  const assetsDir = path.join(ROOT, "dist", "assets");
  if (fs.existsSync(assetsDir)) {
    const jsFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
    check("dist 里确实存在多个 js 包", jsFiles.length >= 3, `${jsFiles.length} 个：${jsFiles.join(", ")}`);
    const vendors = jsFiles.filter((f) => f.startsWith("vendor-"));
    check("vendor 分包已产出", vendors.length >= 3, vendors.join(", "));

    // 主包必须是「小」的那个：业务代码包明显小于 vendor-element
    const size = (f) => fs.statSync(path.join(assetsDir, f)).size;
    const appChunk = jsFiles.find((f) => f.startsWith("index-"));
    const elementChunk = jsFiles.find((f) => f.startsWith("vendor-element"));
    if (appChunk && elementChunk) {
      check(
        "业务代码包体积明显小于 element 包（不再是一个 1.6MB 大包）",
        size(appChunk) < size(elementChunk),
        `app=${(size(appChunk) / 1024).toFixed(0)}KB element=${(size(elementChunk) / 1024).toFixed(0)}KB`
      );
      check(
        "业务代码包 < 400KB（优化前含全部依赖是 1615KB）",
        size(appChunk) < 400 * 1024,
        `${(size(appChunk) / 1024).toFixed(0)}KB`
      );
    }
  } else {
    check("dist 存在（需先跑一次 build）", false, "dist/assets 不存在，跳过产物断言");
  }
}

// ============================================================
console.log("\n[O2] 生成源图不得留在 public/");
// ============================================================
{
  const tplDir = path.join(ROOT, "public", "templates");
  const pngs = fs.existsSync(tplDir)
    ? fs.readdirSync(tplDir).filter((f) => f.startsWith("A_clean_modern_marketing_illus_") && f.endsWith(".png"))
    : [];
  check("public/templates 不再有生成源 PNG", pngs.length === 0, pngs.length ? pngs.join(", ") : "");
  const webps = fs.existsSync(tplDir) ? fs.readdirSync(tplDir).filter((f) => f.endsWith(".webp")) : [];
  check("11 张模板示意图仍在", webps.length === 11, `${webps.length} 张`);

  // 源图应已归档到 _template-src/（保留可重新生成）
  check("源图已归档到 _template-src/", exists("_template-src"), "");

  // dist 里也不该有
  const distTpl = path.join(ROOT, "dist", "templates");
  const distPngs = fs.existsSync(distTpl)
    ? fs.readdirSync(distTpl).filter((f) => f.endsWith(".png"))
    : [];
  check("dist/templates 里没有 PNG 残留", distPngs.length === 0, distPngs.join(", "));
}

// ============================================================
console.log("\n[O3] 危险文件 __probe.mjs");
// ============================================================
{
  check("__probe.mjs 已删除", !exists("__probe.mjs"), "");
  // 确认它确实干过危险事：备份文件里应该能看到覆写真实账本的代码
  const bak = path.join(ROOT, "scripts", "_removed-probe.mjs.bak");
  if (fs.existsSync(bak)) {
    const src = fs.readFileSync(bak, "utf8");
    check("删除理由可追溯（备份里确有覆写真实账本的代码）", /credits-ledger\.json/.test(src) && /writeFileSync/.test(src), "");
  } else {
    check("备份文件存在（便于追溯删除理由）", false, "scripts/_removed-probe.mjs.bak 不存在");
  }
}

// ============================================================
console.log("\n[O4] 死代码清理");
// ============================================================
{
  check("src/components/_deprecated/ 已删除", !exists("src/components/_deprecated"), "");
  // 只检查**代码文件**：文档/历史报告里提到 _deprecated 是正常的（那是在记录"已删除"这件事），
  // 本测试文件自身也会提到关键字，一并排除。
  const SELF = path.join(ROOT, "src", "__perf.test.mjs");
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (/\.(js|mjs|vue)$/.test(e.name) && full !== SELF) {
        const t = fs.readFileSync(full, "utf8");
        if (/_deprecated|InfiniteCanvas|PromptPanel/.test(t)) hits.push(path.relative(ROOT, full));
      }
    }
  };
  walk(ROOT);
  check("没有代码再引用 _deprecated / InfiniteCanvas / PromptPanel", hits.length === 0, hits.join(", "));
  check("临时脚本 test_gen.py 已删除", !exists("test_gen.py"), "");
}

// ============================================================
console.log("\n[O5] 静态资源 HTTP 缓存策略");
// ============================================================
{
  const srv = read("server/index.js");
  check("dist 静态托管设置了 setHeaders", /express\.static\(dist,\s*\{[\s\S]*setHeaders/.test(srv), "");
  check(
    "带 hash 的 /assets/ 给长缓存 + immutable",
    /immutable/.test(srv) && /max-age=31536000/.test(srv),
    ""
  );
  check("index.html 给 no-cache（否则用户一直加载旧 bundle）", /"no-cache"/.test(srv), "");
  check(
    "无 hash 的图给中间档缓存（含 stale-while-revalidate）",
    /stale-while-revalidate/.test(srv),
    ""
  );
}

console.log("\n════════ 汇总 ════════");
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log("");
process.exit(fail === 0 ? 0 : 1);
