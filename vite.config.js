import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import fs from "node:fs";
import path from "node:path";

/**
 * 剔除生成图的源文件（防御性保留）。
 *
 * 背景：public/templates/ 里除了要发布的 .webp，曾经还留着生成时的原始 PNG
 * （A_clean_modern_marketing_illus_*.png，7 张共 12.11MB）。
 * Vite 会把 public/ 整个拷进 dist，把它们一起打进安装包纯属浪费。
 *
 * ⚠️ 2026-10-15：那些 PNG 已经**移到仓库根目录的 `_template-src/` 备份**（不在 public/ 里了），
 * 所以正常情况下这个插件已经无事可做（dist 不会再出现它们）。
 * 之前的注释说"带只读属性、移不走也删不掉"——实测**并不成立**（都是普通 Archive 属性），
 * 已更正。保留这个插件是为了：万一有人把 _template-src 里的图又拷回 public/，
 * 构建仍然不会把它们打进 dist。
 */
function stripGeneratedSources() {
  return {
    name: "strip-generated-sources",
    closeBundle() {
      const dir = path.join(process.cwd(), "dist", "templates");
      if (!fs.existsSync(dir)) return;
      let removed = 0;
      let freed = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith("A_clean_modern_marketing_illus_") || !f.endsWith(".png")) continue;
        const p = path.join(dir, f);
        try {
          freed += fs.statSync(p).size;
          fs.rmSync(p, { force: true });
          removed++;
        } catch {
          /* 删不掉就算了，不影响功能 */
        }
      }
      if (removed) {
        console.log(
          `  [strip] 已剔除 ${removed} 个生成源文件，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`
        );
      }
    }
  };
}

export default defineConfig({
  plugins: [vue(), stripGeneratedSources()],
  build: {
    outDir: "dist",
    // ✅ 必须为 true：设成 false 会让 dist 累积历史产物，
    //    index.html 可能引用到旧 bundle，导致「改了代码但页面没变」。
    //    这个坑之前在排查画布快捷键时真实踩过。
    emptyOutDir: true,
    // ⚠️ 2026-10-15 新增：之前的产物是**单个 1615KB 的 index-*.js**，
    // 意味着改任意一行代码，用户都要重下 1.6MB；且首屏必须等这一个包下完。
    // 按依赖边界手动分包后：改业务代码只影响 app 包，vendor 包命中浏览器缓存。
    // 注意：Electron 是本地 file/http 加载，分包不会带来额外的网络往返成本。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("element-plus") || id.includes("@element-plus")) return "vendor-element";
          if (id.includes("@vue-flow")) return "vendor-flow";
          if (id.includes("d3-")) return "vendor-d3";
          if (id.includes("/vue/") || id.includes("@vue/")) return "vendor-vue";
          return "vendor";
        }
      }
    },
    // 单个包超过 600KB 才告警：分包后 vendor-element 本来就不小，
    // 保留 500KB 默认值会一直刷屏，反而让真正的体积回归被淹没。
    chunkSizeWarningLimit: 600
  },
  server: {
    port: 5180,
    proxy: {
      "/api": "http://127.0.0.1:5181",
      "/outputs": "http://127.0.0.1:5181",
      // 素材静态目录。server/index.js 里 app.use("/materials", express.static(...))，
      // 少了这条代理，npm run dev 下素材图全部 404（画布上的参考图直接裂开）。
      "/materials": "http://127.0.0.1:5181"
    }
  }
});
