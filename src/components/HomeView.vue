<script setup>
// 首页（工作台）
// 信息架构：① 品牌 ② 描述输入 ③ 快捷工具（怎么用）④ 最近项目 ⑤ 灵感场景（做什么）
// 刻意避免重复：快捷工具按「工具」维度，灵感按「场景」维度，两者不重叠
import { ref, computed } from "vue";
import { ElMessage } from "element-plus";
import { store, TOOLS } from "../store.js";
import * as project from "../project.js";
import { semanticTask } from "../api.js";

const input = ref("");
const scene = ref("全部");

// —— 「AI 优化」：把口语需求交给豆包 2.1（或任意 LLM）扩写成结构化提示词 ——
// 失败不覆盖用户原文；未配置 Key 时明确告诉他去哪儿配，而不是弹个看不懂的报错。
const optimizing = ref(false);
async function optimizePrompt() {
  const text = input.value.trim();
  if (!text) return;
  if (optimizing.value) return;
  optimizing.value = true;
  try {
    const r = await semanticTask({ task: "optimize-prompt", text });
    if (r?.result) {
      input.value = r.result;
      ElMessage.success("已用 AI 优化提示词，可继续手改");
    }
  } catch (err) {
    const notConfigured = err?.code === "LLM_NOT_CONFIGURED";
    ElMessage({
      type: notConfigured ? "warning" : "error",
      duration: 6000,
      message: notConfigured
        ? "还没配语义模型：设置 → 语义处理（豆包 2.1），填 API 地址 / 模型名 / Key 后即可用"
        : `AI 优化失败：${err?.message || err}`
    });
  } finally {
    optimizing.value = false;
  }
}

// 快捷工具：只保留最高频的 5 个，避免与侧边栏技能组重复堆砌
const QUICK_IDS = ["ai-clothes", "product-design", "image-generate", "detail-page", "ai-video"];
const quickTools = computed(() => TOOLS.filter((t) => QUICK_IDS.includes(t.id)));

// 灵感场景：按「用途」组织，与工具维度区分开。
// V1003.05：原来全是纯文字白卡片（像后台管理表格，用户反馈"好土"）。
// 现在每个场景配一张真实案例图 —— 图当主角，文字退成一行标题（对齐 AI Change 案例墙）。
// 案例图来自 AI Change 案例库（用户 2026-10-03 授权导入），落在 public/cases/。
const INSPIRATION = [
  { id: "clothes-model", title: "模特换装", cat: "模特", hot: true, img: "/cases/outfit-transfer.webp" },
  { id: "pose-split", title: "姿势裂变", cat: "模特", img: "/cases/pose-series.webp" },
  { id: "style-reference", title: "风格迁移", cat: "模特", img: "/cases/style-campaign.webp" },
  { id: "custom-scene", title: "场景合成", cat: "场景", img: "/cases/smart-campaign.webp" },
  { id: "image-replica", title: "同款复刻", cat: "商品", img: "/cases/image-edit.webp" },
  { id: "smart-generation", title: "白底商品图", cat: "商品", img: "/cases/product-studio.webp" },
  { id: "detail-page", title: "详情页套图", cat: "详情页", img: "/cases/detail-layout.webp" },
  { id: "ai-video", title: "商品短视频", cat: "视频", img: "/cases/product-video.webp" }
];

const scenes = ["全部", "模特", "商品", "场景", "详情页", "视频"];

const filteredInspiration = computed(() =>
  scene.value === "全部" ? INSPIRATION : INSPIRATION.filter((i) => i.cat === scene.value)
);

const recentProjects = computed(() => store.projects.slice(0, 5));

/**
 * 首页指标卡（2026-10-16 参考稿改版）。
 *
 * 参考稿最抓眼的是顶部那一排"大数字卡"：一个小标签 + 一个巨大数字 + 一行小字。
 * 首页原本只有标题和输入框，整页缺少"这是一台在工作的工作台"的量感 ——
 * 这一排卡把真实数据摆出来（不编造）：生成量、省下的算力、项目数、余额。
 *
 * 数据全部取自既有 store，不新增请求。口径必须诚实：
 *   · 最近生成 = store.history，但它只有 toLocaleTimeString() 没有日期，
 *     所以只能叫"本次会话"，绝不能写成"本月"（编出来的数字比空着更糟）
 *   · 已省算力 = 任务上累计的 savedCost（缓存命中省下的）
 *   · 项目数 = store.projects
 *   · 算力余额 = store.balance（服务端账本）
 */
const recentGenCount = computed(() => (store.history || []).length);
const savedCredits = computed(() =>
  (store.tasks || []).reduce((s, t) => s + (Number(t.savedCost) || 0), 0)
);
const projectCount = computed(() => (store.projects || []).length);
const balanceNum = computed(() => Number(store.balance) || 0);
/** 最近 7 次生成的成败，用来画迷你柱图（没有真实数据就是空的，不造假） */
const sparkBars = computed(() => {
  const rows = (store.history || []).slice(0, 7).map((h) => (h.status === "done" ? 1 : 0));
  const base = rows.length ? rows : [0, 0, 0, 0, 0, 0, 0];
  return base.map((v, i) => ({ v, on: v > 0 && i === base.length - 1 }));
});

// 底部署名墙：展示真实接入的模型来源（不编造合作方）
// 快捷工具的副标题（一句话说明用途）
const TOOL_DESC = {
  "ai-clothes": "换模特 · 换场景",
  "image-generate": "文字描述出图",
  "product-design": "商品图精修",
  "detail-page": "卖点 → 整套详情页",
  "ai-video": "图片转短视频"
};

// 首页底部的"能力来源"说明。
// 2026-10-23：通义万相与本地 ComfyUI 已从模型选择器下线，这里同步去掉，
// 否则会出现"首页宣传了一个选不到的模型"这种自相矛盾。
const POWERED_BY = [
  { name: "即梦 Seedream", sub: "字节" },
  { name: "豆包 Seedream 5", sub: "字节" },
  { name: "Nano Banana", sub: "Google" },
  { name: "GPT Image", sub: "OpenAI" }
];

function launch(workflowId, prompt = "") {
  if (!workflowId) return;
  store.pendingWorkflow = workflowId;
  store.pendingPrompt = prompt;
  store.route = "studio";
}

function onSend() {
  const text = input.value.trim();
  if (!text) return;
  launch("custom-scene", text);
  input.value = "";
}

function onKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
}

/**
 * 打开最近项目。
 *
 * ⚠️ 2026-10-14 修复（首页项目操作绕过持久化）：
 * 原来只 `store.projectName = p.name; store.route = "studio"` ——
 * **不切 currentProjectId**，于是后续保存仍然写回上一个项目的条目，
 * 用户看到的「打开项目」其实什么也没打开。
 * 现在改走 project.js 的真接口（与项目页 ProjectsView 同一套约定）。
 *
 * 另：clearPendingRestore 是必须的 —— App.vue 在启动时会把「上次没关掉的画布」
 * 放进 store.pendingRestore，NodeCanvas 挂载时会用它还原。若不清掉，
 * 切项目后画布会被上一次的图覆盖回来。
 */
function clearPendingRestore() {
  store.pendingRestore = null;
}

function openProject(p) {
  clearPendingRestore();
  const row = project.openProject(p.id);
  if (!row) {
    ElMessage.error("项目不存在，可能已被删除");
    return;
  }
  store.pendingWorkflow = "";
  store.pendingPrompt = "";
  store.route = "studio";
}

function newProject() {
  clearPendingRestore();
  project.createProject("未命名项目");
  store.pendingWorkflow = "";
  store.pendingPrompt = "";
  store.route = "studio";
  ElMessage.success("已新建项目，可在顶栏重命名");
}

// V1003.08 · 功能上新公告（参考 AI Change 的"品牌知识库"弹窗）
// 首次进工作台弹一次，关掉后写 localStorage 永不再弹；版本号变了才会再弹。
const WHATS_NEW_KEY = "ai-canvas.whats-new.v1";
const whatsNewOpen = ref(false);
// 截图/自动化预览（?screenshot=1）下不弹公告：否则无头浏览器每次都拍到这个遮罩层，
// 界面回归对比就全成了同一张弹窗图。正常用户 URL 无此参数，行为不变。
// 2026-11-03：打包版同样关掉（与 App.vue 的 PREVIEW_MODE 口径一致，开发态才认这个参数）。
const PREVIEW_MODE =
  !import.meta.env.PROD &&
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("screenshot") === "1";
try {
  whatsNewOpen.value = !PREVIEW_MODE && !localStorage.getItem(WHATS_NEW_KEY);
} catch {
  whatsNewOpen.value = false;
}
function dismissWhatsNew() {
  whatsNewOpen.value = false;
  try {
    localStorage.setItem(WHATS_NEW_KEY, new Date().toISOString().slice(0, 10));
  } catch {
    /* 存不下就下次再提醒一次，无伤大雅 */
  }
}
</script>

<template>
  <div class="wk">
    <!-- 功能上新公告：只弹一次，米白卡 + 右侧真实案例图 -->
    <transition name="wn-fade">
      <div v-if="whatsNewOpen" class="wn-mask" @click.self="dismissWhatsNew">
        <div class="wn-card">
          <button class="wn-close" title="关闭" @click="dismissWhatsNew">✕</button>
          <div class="wn-body">
            <div class="wn-copy">
              <span class="wn-tag">功能上新</span>
              <h2 class="wn-title">灵感案例墙</h2>
              <p class="wn-sub">真实电商案例，点一下就能开做</p>
              <ul class="wn-points">
                <li>模特换装、白底图、详情页套图 12 个场景</li>
                <li>案例即模板，选中心意直接套用</li>
                <li>换装 / 图生图 / 文生图 / 详情页 / 视频</li>
              </ul>
              <div class="wn-foot">
                <span class="wn-ver">2026.10</span>
                <button class="wn-ok" @click="dismissWhatsNew">知道了</button>
              </div>
            </div>
            <div class="wn-visual">
              <img src="/cases/outfit-transfer.webp" alt="灵感案例墙预览" />
            </div>
          </div>
        </div>
      </div>
    </transition>

    <div class="wk-inner">
      <!-- ① 主视觉横幅（2026-10-31 按参考站结构：横幅 → 垂类 Agent 输入 → 技能卡） -->
      <section class="loom-hero">
        <span class="loom-hero-media"><img src="/templates/scene-shot.webp" alt="" /></span>
        <span class="loom-hero-tag">
          <el-icon><Lightning /></el-icon>
          Seedream 5.0 Pro · Nano Banana 2.1 已接入
        </span>
        <h1>电商视觉领域首个<em>垂类 Agent</em></h1>
        <p>有记忆、能理解、会规划 —— 描述一句需求，自动搭好整套工作流</p>
        <button class="loom-hero-cta" @click="launch('clothes-model')">
          开始创作
          <el-icon><Right /></el-icon>
        </button>
        <span class="loom-hero-dots"><i class="on" /><i /><i /></span>
      </section>

      <!-- ② 垂类 Agent 输入：整条胶囊，回车即发 -->
      <section class="loom-agent">
        <h2>电商行业首个垂类 Agent</h2>
        <div class="loom-agent-bar">
          <button class="loom-plus" title="从示例开始" @click="launch('clothes-model')">
            <el-icon><Plus /></el-icon>
          </button>
          <input
            v-model="input"
            placeholder="描述你想要的画面，例如：把图中毛衣穿到欧美模特身上，柔和自然光…"
            @keydown.enter.prevent="onSend"
          />
          <button
            class="loom-plus"
            :disabled="!input.trim() || optimizing"
            :title="optimizing ? '正在优化…' : 'AI 优化提示词'"
            @click="optimizePrompt"
          >
            <el-icon v-if="optimizing" class="is-loading"><Loading /></el-icon>
            <el-icon v-else><MagicStick /></el-icon>
          </button>
          <button class="loom-agent-send" :disabled="!input.trim()" title="开始创作（Enter）" @click="onSend">
            <el-icon><Top /></el-icon>
          </button>
        </div>
      </section>

      <!-- ③ 技能卡：4 个主力工作流，点卡片直接铺画布 -->
      <section class="loom-skills">
        <div class="loom-skills-head">
          <h3>技能</h3>
          <em>Skill</em>
        </div>
        <div class="loom-skill-grid">
          <button class="loom-skill" @click="launch('clothes-model')">
            <span class="loom-skill-thumb">
              <img src="/templates/ai-studio.webp" alt="AI 虚拟影棚" loading="lazy" />
              <span class="loom-skill-badge"><el-icon><Camera /></el-icon></span>
            </span>
            <span class="loom-skill-body">
              <b>AI 虚拟影棚</b>
              <span>组合产品、模特与场景，生成商业影棚图。</span>
            </span>
          </button>

          <button class="loom-skill" @click="launch('image-replica')">
            <span class="loom-skill-thumb">
              <img src="/templates/hot-replicate.webp" alt="爆款复刻" loading="lazy" />
              <span class="loom-skill-badge"><el-icon><TrendCharts /></el-icon></span>
            </span>
            <span class="loom-skill-body">
              <b>爆款复刻</b>
              <span>复刻爆款风格，批量生成同款新图。</span>
            </span>
          </button>

          <button class="loom-skill" @click="launch('detail-page')">
            <span class="loom-skill-thumb">
              <img src="/templates/detail-page.webp" alt="详情页 / 主图" loading="lazy" />
              <span class="loom-skill-badge"><el-icon><Document /></el-icon></span>
            </span>
            <span class="loom-skill-body">
              <b>详情页 / 主图</b>
              <span>提炼卖点生成详情页，一套图直接上架。</span>
            </span>
          </button>

          <button class="loom-skill" @click="store.route = 'templates'">
            <span class="loom-skill-thumb">
              <img src="/templates/text-to-image.webp" alt="使用模板" loading="lazy" />
              <span class="loom-skill-badge"><el-icon><Grid /></el-icon></span>
            </span>
            <span class="loom-skill-body">
              <b>使用模板</b>
              <span>复用成熟版式，同一产品快速产出成套图片。</span>
            </span>
          </button>
        </div>

        <!-- 次级技能：一行 chip，点开也是铺画布 -->
        <div class="loom-chipso">
          <button v-for="t in quickTools" :key="t.id" @click="launch(t.options?.[0]?.id || t.direct)">
            {{ t.label }}
          </button>
        </div>
      </section>


      <!-- ② 指标条（参考稿的大数字卡）：把真实数据摆出来，页面立刻有"在工作"的量感 -->
      <section class="wk-metrics rd-metrics">
        <div class="rd-card rd-metric">
          <span class="rd-metric-label">最近生成</span>
          <span class="rd-metric-num">{{ recentGenCount }}</span>
          <!-- 没有记录就不画图：一排高度 0 的柱子看着像条虚线，是噪音不是信息 -->
          <div v-if="recentGenCount" class="rd-spark">
            <i v-for="(b, i) in sparkBars" :key="i" :class="{ on: b.on }" :style="{ height: b.v ? '100%' : '22%' }" />
          </div>
          <div v-else class="rd-metric-foot"><span>还没有生成记录</span></div>
        </div>

        <div class="rd-card rd-metric">
          <span class="rd-metric-label">已省算力</span>
          <span class="rd-metric-num">{{ savedCredits }}</span>
          <div class="rd-metric-foot">
            <span class="rd-delta">缓存命中</span>
            <span>重复请求不再扣费</span>
          </div>
        </div>

        <div class="rd-card rd-metric">
          <span class="rd-metric-label">项目</span>
          <span class="rd-metric-num">{{ projectCount }}</span>
          <div class="rd-metric-foot">
            <span>本地保存，可随时继续</span>
          </div>
        </div>

        <!-- 反色卡做强调：余额是用户最关心的数字 -->
        <div class="rd-card rd-metric dark">
          <span class="rd-metric-label">算力余额</span>
          <span class="rd-metric-num">{{ balanceNum }}</span>
          <div class="rd-metric-foot">
            <span>生成按次扣费，失败自动退回</span>
          </div>
        </div>
      </section>

      <!-- ④ 最近项目 -->
      <section class="wk-section">
        <div class="wk-section-head">
          <span class="wk-sec-icon"><el-icon><Folder /></el-icon></span>
          <h2 class="wk-section-title">最近项目</h2>
          <span class="wk-sec-sub">接着上次继续</span>
          <button class="wk-section-more" @click="store.route = 'projects'">
            全部项目
            <el-icon><ArrowRight /></el-icon>
          </button>
        </div>

        <div class="wk-projects">
          <button class="wk-project wk-project-new" @click="newProject">
            <span class="wk-project-plus"><el-icon><Plus /></el-icon></span>
            <span class="wk-project-new-text">新建项目</span>
          </button>

          <button
            v-for="p in recentProjects"
            :key="p.id"
            class="wk-project"
            @click="openProject(p)"
          >
            <span class="wk-project-thumb">
              <template v-if="p.thumbs?.length">
                <img v-for="(t, i) in p.thumbs.slice(0, 4)" :key="i" :src="t" alt="" />
              </template>
              <span v-else class="wk-project-letter">{{ (p.name[0] || "U").toUpperCase() }}</span>
            </span>
            <span class="wk-project-meta">
              <span class="wk-project-name">{{ p.name }}</span>
              <span class="wk-project-date">{{ p.updatedAt }}</span>
            </span>
          </button>
        </div>
      </section>

      <!-- ⑤ 灵感场景 -->
      <section class="wk-section">
        <div class="wk-section-head">
          <span class="wk-sec-icon"><el-icon><Opportunity /></el-icon></span>
          <h2 class="wk-section-title">灵感场景</h2>
          <div class="wk-scenes">
            <button
              v-for="s in scenes"
              :key="s"
              class="wk-scene"
              :class="{ on: scene === s }"
              @click="scene = s"
            >
              {{ s }}
            </button>
          </div>
        </div>

        <div v-if="!filteredInspiration.length" class="wk-empty">该场景下暂无模板</div>

        <div v-else class="wk-inspiration">
          <button
            v-for="i in filteredInspiration"
            :key="i.id"
            class="wk-insp"
            @click="launch(i.id)"
          >
            <span class="wk-insp-cover">
              <img :src="i.img" :alt="i.title" loading="lazy" />
              <span class="wk-insp-cat">{{ i.cat }}</span>
              <span v-if="i.hot" class="wk-insp-hot">热门</span>
              <span class="wk-insp-go">
                <el-icon><Right /></el-icon>
              </span>
            </span>
            <span class="wk-insp-title">{{ i.title }}</span>
          </button>
        </div>
      </section>

      <!-- 模型来源（真实接入，非合作方署名墙） -->
      <footer class="wk-powered">
        <span class="wk-powered-intro">已接入</span>
        <span v-for="p in POWERED_BY" :key="p.name" class="wk-powered-item">
          <b>{{ p.name }}</b><i>{{ p.sub }}</i>
        </span>
        <span class="wk-powered-note">模型可随时切换，密钥仅存本机</span>
      </footer>
    </div>
  </div>
</template>
