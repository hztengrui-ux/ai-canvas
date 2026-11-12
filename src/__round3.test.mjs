/**
 * 第三轮修复验收（2026-10-14）—— 纯前端逻辑 + 静态一致性
 *
 * 覆盖：
 *   S1 语义缩放：newui.css 的 zoom-* 选择器必须命中**真实存在**的类名
 *      （这正是原来的 bug：规则写的 5 个类名在任何组件里都不存在 → 整段空转）
 *   S2 画布 id：bumpFlowId 必须把 nextId 抬到已有 id 最大序号 + 1
 *   S3 作品组：serialize/restore 必须带着 parentNode/extent/hidden/zIndex/style
 *   S4 技能入口：能对上的技能必须有可用 workflow；对不上的必须 available:false 且有原因
 *   S5 模型选择器：供应商分栏覆盖全部模型，且不重不漏
 *   S6 单价：界面显示的单价必须与服务端计费表一致（不许编假价）
 *
 * 运行：node src/__round3.test.mjs
 * 不需要服务端、不需要浏览器。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SKILLS,
  launchSkill,
  WORKFLOWS,
  newFlowId,
  bumpFlowId,
  IMAGE_MODELS,
  MODEL_PROVIDER_TABS,
  providerOf,
  modelsOfProvider,
  taglineOf,
  costLabelOf,
  COST_PER_GENERATION,
  store
} from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

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

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ============================================================
console.log("\n[S1] 语义缩放：CSS 选择器必须命中真实类名");
// ============================================================
{
  const css = read("src/newui.css");
  const nodeDir = path.join(ROOT, "src", "components", "nodes");
  const componentSource =
    fs
      .readdirSync(nodeDir)
      .filter((f) => f.endsWith(".vue"))
      .map((f) => fs.readFileSync(path.join(nodeDir, f), "utf8"))
      .join("\n") + read("src/components/NodeCanvas.vue");

  // 只取 zoom-* 规则块里被隐藏的那些 nf-* 类名（它们是「必须存在」的）
  const zoomBlocks = css.match(/\.node-canvas-wrap\.zoom-(?:far|mid|near)[^{]*\{[^}]*\}/g) || [];
  check("找到 zoom-* 规则块", zoomBlocks.length >= 3, `blocks=${zoomBlocks.length}`);

  const hiddenClasses = new Set();
  for (const block of zoomBlocks) {
    for (const m of block.matchAll(/\.(nf-[a-z0-9-]+)/g)) hiddenClasses.add(m[1]);
  }
  // 排除注释里提到的历史类名（不是选择器）
  const commented = new Set(["nf-node-body", "nf-thumb", "nf-field", "nf-media-grid", "nf-node-title"]);

  const ghosts = [];
  for (const cls of hiddenClasses) {
    if (commented.has(cls)) continue;
    if (!componentSource.includes(cls)) ghosts.push(cls);
  }
  check(
    "zoom-* 规则里没有幽灵类名（每个都被组件模板用到）",
    ghosts.length === 0,
    ghosts.length ? `幽灵：${ghosts.map((c) => "." + c).join(", ")}` : `检查了 ${hiddenClasses.size} 个 nf-* 类`
  );

  // 反向：far 档必须真的藏掉「内容区」，不能只藏 textarea
  const farBlock = zoomBlocks.filter((b) => b.includes("zoom-far")).join("\n");
  const mustHide = ["nf-product-body", "nf-style-body", "nf-ref-body", "nf-result-grid", "nf-prompt-input"];
  const missingHide = mustHide.filter((c) => !farBlock.includes(c));
  check(
    "far 档确实隐藏了各节点的内容区（不只是 textarea）",
    missingHide.length === 0,
    missingHide.length ? `漏了：${missingHide.join(", ")}` : "5/5 已覆盖"
  );

  // NodeCanvas 必须真的按 zoom 分档挂类
  const nc = read("src/components/NodeCanvas.vue");
  check("NodeCanvas 挂载了 zoom-<tier> 类", /`zoom-\$\{zoomTier\}`/.test(nc), "");
  check(
    "zoomTier 的分档阈值与 CSS 注释一致（0.5 / 1.1）",
    /z < 0\.5/.test(nc) && /z > 1\.1/.test(nc),
    ""
  );
}

// ============================================================
console.log("\n[S2] 画布 id：bumpFlowId 防重复");
// ============================================================
{
  // 先把计数器推到某个已知位置
  const first = newFlowId("p");
  const n = Number(first.replace(/\D/g, ""));

  // 模拟「恢复了一张带更大 id 的图」
  const got = bumpFlowId(["p1", "e2", "r3", "pd99", "ref150"]);
  check("bumpFlowId 抬到最大序号 + 1", got === 151, `nextId=${got}`);

  const next = newFlowId("p");
  check("抬升后新建的 id 不会与已有 id 撞车", Number(next.replace(/\D/g, "")) === 151, next);

  // 各种输入形态。注意 bumpFlowId 是**单调**的：只抬高、绝不降低
  // （降低会让新 id 撞上旧 id，那正是要修的 bug），所以断言用「不小于」而不是「等于」。
  const bumped = bumpFlowId([{ id: "g10" }, { id: "p20" }]);
  check("接受节点对象数组", bumped >= 21, `nextId=${bumped}`);

  const ignored = bumpFlowId(["uuid-aaaa-bbbb", "no-digits-here"]);
  check("解析不出序号的 id 被忽略（不把计数器打乱）", ignored === bumped, `nextId=${ignored}（保持 ${bumped}）`);
  check("传空数组不改变计数器", bumpFlowId([]) === ignored, "");
  check("传 undefined 不抛异常", bumpFlowId() === ignored, "");

  // 关键不变式：单调不降
  let floor = bumpFlowId(["p5"]);
  const lower = bumpFlowId(["p2"]);
  check("喂更小的 id 不会把计数器降回去（单调不降）", lower === floor, `floor=${floor} after=${lower}`);
  floor = lower;
  check("再喂一个更大的 id 会继续抬高", bumpFlowId(["p9000"]) === 9001, "");

  // 回归：source 里必须真的调用了它
  const nc = read("src/components/NodeCanvas.vue");
  check("restoreGraph 调用了 bumpFlowId", /bumpFlowId\(graph\.nodes\)/.test(nc), "");
  check("restoreSnapshot 也调用了 bumpFlowId", /bumpFlowId\(getNodes\.value\)/.test(nc), "");
}

// ============================================================
console.log("\n[S3] 作品组：快照必须带上结构字段");
// ============================================================
{
  const nc = read("src/components/NodeCanvas.vue");
  const fields = ["parentNode", "extent", "hidden", "zIndex"];
  const missing = fields.filter((f) => !new RegExp(`\\b${f}:\\s*n\\.`).test(nc));
  check(
    "serialize() 导出了 parentNode/extent/hidden/zIndex",
    missing.length === 0,
    missing.length ? `漏了：${missing.join(", ")}` : "4/4"
  );
  check("serialize() 导出了组节点的 style（组框尺寸）", /style:\s*n\.style/.test(nc), "");
  check(
    "restoreSnapshot 不再只挑 4 个字段（直接展开快照节点）",
    /addNodes\(JSON\.parse\(JSON\.stringify\(snap\.nodes\)\)\)/.test(nc),
    ""
  );
  check(
    "restoreGraph 展开全部结构字段",
    /addNodes\(graph\.nodes\.map\(\(n\) => \(\{ \.\.\.n, selected: false \}\)\)\)/.test(nc),
    ""
  );
}

// ============================================================
console.log("\n[S4] 技能入口：能对上的真铺流程，对不上的如实标注");
// ============================================================
{
  check("SKILLS 仍然是 8 个", SKILLS.length === 8, `count=${SKILLS.length}`);

  const available = SKILLS.filter((s) => s.available !== false);
  const unavailable = SKILLS.filter((s) => s.available === false);

  const badWorkflow = available.filter((s) => !s.workflow || !WORKFLOWS[s.workflow]);
  check(
    "所有可用技能的 workflow 都真实存在于 WORKFLOWS",
    badWorkflow.length === 0,
    badWorkflow.length ? `无效：${badWorkflow.map((s) => `${s.id}→${s.workflow}`).join(", ")}` : `${available.length} 个可用技能`
  );

  const noReason = unavailable.filter((s) => !s.reason);
  check(
    "不可用技能都写明了原因（不许静默空转）",
    noReason.length === 0,
    noReason.length ? `缺原因：${noReason.map((s) => s.id).join(", ")}` : `${unavailable.length} 个待接入`
  );

  // launchSkill 的行为
  const okSkill = available[0];
  store.pendingWorkflow = "";
  const r1 = launchSkill(okSkill.id);
  check(`launchSkill(${okSkill.id}) 成功并写入 pendingWorkflow`, r1.ok === true && store.pendingWorkflow === okSkill.workflow, JSON.stringify(r1));

  if (unavailable.length) {
    store.pendingWorkflow = "";
    // 先把路由摆到 home：否则上一个断言已经把它设成 studio，
    // "失败不导航"就变成一句永远成立的空话。
    store.route = "home";
    const r2 = launchSkill(unavailable[0].id);
    check(
      `launchSkill(${unavailable[0].id}) 返回 ok:false 且有原因`,
      r2.ok === false && Boolean(r2.reason),
      JSON.stringify(r2)
    );
    check("不可用技能不会写入 pendingWorkflow（不假装成功）", store.pendingWorkflow === "", `pendingWorkflow="${store.pendingWorkflow}"`);
    // 2026-10-18 修：以前是先切到创作台再返回失败，用户看到"跳走了但什么都没有"
    check(
      "点不可用技能不会把界面跳走（失败就不导航）",
      store.route === "home",
      `route 被改成了 ${store.route}（应为 home）`
    );
    check("返回里带 unavailable 标记，调用方好区分", r2.unavailable === true, JSON.stringify(r2));
  }

  // 每个不可用技能都要给"现在能怎么办"，光说不行等于没说
  const noAlternative = unavailable.filter((s) => !s.alternative);
  check(
    "不可用技能都给了替代做法（不只是说'不行'）",
    noAlternative.length === 0,
    noAlternative.length ? `缺替代：${noAlternative.map((s) => s.id).join(", ")}` : `${unavailable.length} 个`
  );

  const r3 = launchSkill("nonexistent-skill");
  check("未知技能返回 ok:false", r3.ok === false, JSON.stringify(r3));

  // 侧栏必须真的用了 launchSkill
  const shell = read("src/components/AppShell.vue");
  check("AppShell 调用 launchSkill 而非旧的 startSkill", /launchSkill\(/.test(shell) && !/startSkill\(/.test(shell), "");

  // ⚠️ 2026-10-18「点了没反应」的根因回归：下拉项一旦 disabled，click 根本不触发
  check(
    "技能下拉项不能是 disabled（否则点击事件永远不触发）",
    !/:disabled="skill\.available === false"/.test(shell),
    "仍存在 :disabled 绑定 —— 用户点了不会有任何反馈"
  );
  check(
    "不可用技能点击后走弹窗说明原因 + 替代做法",
    /ElMessageBox\.alert/.test(shell) && /r\.alternative/.test(shell),
    "缺少 ElMessageBox.alert 或未展示 alternative"
  );
  check("AppShell 引入了 ElMessageBox", /import \{[^}]*ElMessageBox[^}]*\} from "element-plus"/.test(shell));
  check(
    "标签文案是「即将上线」而不是「待接入」",
    /即将上线/.test(shell) && !/>待接入</.test(shell),
    "文案没统一"
  );
}

// ============================================================
console.log("\n[S5] 模型选择器：供应商分栏不重不漏");
// ============================================================
{
  check("有 3 个供应商分栏", MODEL_PROVIDER_TABS.length === 3, MODEL_PROVIDER_TABS.map((t) => t.label).join(" / "));

  const covered = [];
  for (const t of MODEL_PROVIDER_TABS) {
    for (const m of modelsOfProvider(t.id)) covered.push(m.id);
  }
  check("每个模型都被某个分栏覆盖（不漏）", covered.length === IMAGE_MODELS.length, `covered=${covered.length} total=${IMAGE_MODELS.length}`);
  check("没有模型出现在两个分栏里（不重）", new Set(covered).size === covered.length, "");

  const tabIds = new Set(MODEL_PROVIDER_TABS.map((t) => t.id));
  const badProvider = IMAGE_MODELS.filter((m) => !tabIds.has(providerOf(m.id)));
  check("providerOf 结果都在分栏集合内", badProvider.length === 0, "");

  // 参考设计里点名的模型必须三家都能对上
  check("GPT Image 归 OpenAI", providerOf("gpt-image-2") === "openai", "");
  check("Nano Banana 归 Google", providerOf("nano-banana-pro") === "google", "");
  check("通义/即梦/ComfyUI 归 aichange", ["wanxiang", "jiemeng", "comfyui"].every((id) => providerOf(id) === "aichange"), "");

  // 每张模型卡都要有说明文案
  const noTag = IMAGE_MODELS.filter((m) => !taglineOf(m.id));
  check("每个模型都有能力说明文案", noTag.length === 0, noTag.length ? `缺：${noTag.map((m) => m.id).join(", ")}` : "");

  // StudioView 必须用新的分栏结构渲染
  const studio = read("src/components/StudioView.vue");
  check("StudioView 有供应商分栏", /model-picker-tab/.test(studio) && /MODEL_PROVIDER_TABS/.test(studio), "");
  check("StudioView 模型卡带单价", /model-card-price/.test(studio), "");
  check("StudioView 已不再是旧的按组平铺", !/modelsByGroup/.test(studio), "");
}

// ============================================================
console.log("\n[S6] 单价：界面文案必须与服务端计费表一致");
// ============================================================
{
  // 直接读服务端计费表，避免两处各写一个数
  const creditsSrc = read("server/credits.js");
  const m = /"image\.generate":\s*\{\s*cost:\s*(\d+)/.exec(creditsSrc);
  check("能从 server/credits.js 解析出图片生成单价", Boolean(m), m ? `cost=${m[1]}` : "解析失败");
  if (m) {
    check(
      "前端 COST_PER_GENERATION 与服务端一致",
      COST_PER_GENERATION === Number(m[1]),
      `frontend=${COST_PER_GENERATION} server=${m[1]}`
    );
  }
  check("单价文案是「算力/次」（按次计费，不是按张）", costLabelOf() === `${COST_PER_GENERATION} 算力/次`, costLabelOf());
  check("单价文案里没有 /张 这种会误导的写法", !costLabelOf().includes("/张"), costLabelOf());
}

console.log("\n[S7] 首页项目操作：必须走 project.js 真接口");
// ============================================================
{
  const home = read("src/components/HomeView.vue");

  check("HomeView 引入了 project.js", /from "\.\.\/project\.js"/.test(home), "");
  check("openProject 走 project.openProject(真接口)", /project\.openProject\(p\.id\)/.test(home), "");
  check("newProject 走 project.createProject(真接口)", /project\.createProject\(/.test(home), "");
  check(
    "不再直接 unshift store.projects（绕过持久化）",
    !/store\.projects\.unshift/.test(home),
    ""
  );
  check(
    "打开/新建都会清掉 pendingRestore（否则画布被上次的图覆盖回来）",
    /store\.pendingRestore = null/.test(home),
    ""
  );
  check("打开不存在的项目会提示而不是静默", /ElMessage\.error\("项目不存在/.test(home), "");

  // project.js 必须真的导出这些接口
  const proj = read("src/project.js");
  for (const fn of ["createProject", "openProject", "loadList"]) {
    check(`project.js 导出 ${fn}`, new RegExp(`export function ${fn}\\b`).test(proj), "");
  }
}

// ============================================================
console.log("\n[S8] 幽灵端口：端口表声明的每个 handle 都要在组件里渲染");
// ============================================================
{
  const nodeDir = path.join(ROOT, "src", "components", "nodes");
  const fileOf = {
    product: "ProductNode.vue",
    style: "StyleNode.vue",
    prompt: "PromptNode.vue",
    reference: "ReferenceNode.vue",
    executor: "ExecutorNode.vue",
    result: "ResultNode.vue"
  };

  const ports = await import("./ports.js");
  const missing = [];
  for (const [type, def] of Object.entries(ports.NODE_PORTS)) {
    const file = fileOf[type];
    if (!file) continue;
    const src = fs.readFileSync(path.join(nodeDir, file), "utf8");
    const declared = [...(def.inputs || []), ...(def.outputs || [])].map((p) => p.id);
    for (const id of new Set(declared)) {
      // 组件里必须存在 id="<id>" 的 Handle
      if (!new RegExp(`<Handle[^>]*id="${id}"`, "s").test(src)) {
        missing.push(`${type}.${id} (${file})`);
      }
    }
  }
  check(
    "端口表里每个 handle id 都在对应组件中渲染了 <Handle>",
    missing.length === 0,
    missing.length ? `幽灵端口：${missing.join(", ")}` : "全部对齐"
  );

  const refSrc = fs.readFileSync(path.join(nodeDir, fileOf.reference), "utf8");
  check("ReferenceNode 已经渲染出 result 输出口", /<Handle[^>]*id="result"/s.test(refSrc), "");
  check("该口的 data-port 是 video", /data-port="video"/.test(refSrc), "");
}

// ============================================================
console.log("\n[S9] 素材分类：前端只能产生合法分类");
// ============================================================
{
  const mat = await import("./materials.js");

  // 与服务端白名单交叉断言
  const serverConfig = read("server/config.js");
  const serverIds = [...serverConfig.matchAll(/\{\s*id:\s*"(\w+)",\s*label:/g)].map((m) => m[1]);
  check(
    "前端分类集合与服务端 MATERIAL_CATEGORIES 完全一致",
    serverIds.length > 0 && mat.MATERIAL_CATEGORY_IDS.join(",") === serverIds.join(","),
    `frontend=[${mat.MATERIAL_CATEGORY_IDS.join(",")}] server=[${serverIds.join(",")}]`
  );

  check("非法分类回退到 other", mat.normalizeMaterialCategory("uploads") === "other", mat.normalizeMaterialCategory("uploads"));
  check("空值回退到 other", mat.normalizeMaterialCategory("") === "other", "");
  check("undefined 回退到 other", mat.normalizeMaterialCategory(undefined) === "other", "");
  check("合法分类原样返回", mat.normalizeMaterialCategory("clothing") === "clothing", "");
  check("isValidMaterialCategory 判定正确", mat.isValidMaterialCategory("props") === true && mat.isValidMaterialCategory("uploads") === false, "");

  // 所有节点上传点都不得再出现字面量 "other" / "uploads"
  const nodeFiles = fs.readdirSync(path.join(ROOT, "src", "components", "nodes")).filter((f) => f.endsWith(".vue"));
  const literalCats = [];
  for (const f of nodeFiles) {
    const src = fs.readFileSync(path.join(ROOT, "src", "components", "nodes", f), "utf8");
    for (const m of src.matchAll(/uploadMaterial\([^)]*?,\s*"([^"]+)"\s*\)/g)) {
      literalCats.push(`${f}: "${m[1]}"`);
    }
  }
  check(
    "节点里不再有写死的分类字面量（统一走 NODE_UPLOAD_CATEGORY）",
    literalCats.length === 0,
    literalCats.length ? literalCats.join(", ") : ""
  );

  const nc = read("src/components/NodeCanvas.vue");
  check("画布拖入不再用非法的 uploads 分类", !/"uploads"/.test(nc), "");
  check("画布拖入走了 normalizeMaterialCategory", /normalizeMaterialCategory\(opts\.category/.test(nc), "");

  const api = read("src/api.js");
  check("uploadMaterial 入口做了归一化（坏分类从源头堵住）", /const cat = normalizeMaterialCategory\(category\)/.test(api), "");

  const home = read("src/components/HomeView.vue");
  check("HomeView 不再自行拼 project 对象", !/proj-\$\{Date\.now\(\)\}/.test(home), "");
}

console.log("\n════════ 汇总 ════════");
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log("");
process.exit(fail === 0 ? 0 : 1);
