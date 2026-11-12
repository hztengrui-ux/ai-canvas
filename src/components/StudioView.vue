<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { store, modelById, providerOf, modelsOfProvider, taglineOf, costLabelOf, MODEL_PROVIDER_TABS, RESOLUTIONS, TOOLS, seedDemoTasks } from "../store.js";
import NodeCanvas from "./NodeCanvas.vue";
import TaskBar from "./TaskBar.vue";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import WindowControls from "./WindowControls.vue";
import CanvasModeSwitch from "./CanvasModeSwitch.vue";
import BatchDock from "./BatchDock.vue";
import MaterialLibrary from "./MaterialLibrary.vue";
import SkillsPanel from "./SkillsPanel.vue";
import StudioDock from "./StudioDock.vue";
import { comfyStatus, saveTemplateFromProject, fetchTemplates } from "../api.js";
import { saveStateLabel } from "../project.js";
import { exportProject, importProject, downloadZip, downloadMany } from "../exportkit.js";

const emit = defineEmits(["open-settings", "open-recharge", "open-account"]);

// 顶栏头像：取昵称或账号首字
const userInitial = computed(() => {
  const name = store.user?.nickname || store.user?.username || "U";
  return String(name).trim()[0]?.toUpperCase() || "U";
});

const nodeCanvasRef = ref(null);
const minimapOn = ref(false);
const helpOpen = ref(false);
// 技能库面板开关（顶栏「技能」按钮）—— 点技能即铺出对应节点图
const skillsOpen = ref(false);
// 右侧固定技能面板（参考站结构）：默认展开，可从顶栏「技能」按钮再打开
const dockOpen = ref(true);
const dockRef = ref(null);
// 快捷键 / 顶栏入口：切到右侧面板的 Agent 页（对话已内联，不再有抽屉）
function openAgentChat() {
  dockOpen.value = true;
  dockRef.value?.showAgent?.();
}
// 截图/预览：?panel=skills 直接打开技能面板，便于界面回归对比（正常使用无此参数）
if (typeof location !== "undefined" && new URLSearchParams(location.search).get("panel") === "skills") {
  skillsOpen.value = true;
}
// 截图/预览：?demo=tasks 灌一批演示任务，用于检查「有任务时」的任务面板长什么样
if (typeof location !== "undefined" && new URLSearchParams(location.search).get("demo") === "tasks") {
  seedDemoTasks();
}
const comfyOk = computed(() => store.comfyStatus?.ok);

// 当前展开子菜单的工具 id
const openToolId = ref("");

// ---------- 模型设置面板 ----------
const currentModel = computed(() => modelById(store.imageModel));

// 顶部供应商分栏（对齐参考设计：OpenAI / Google / aichange）。
// 默认停在「当前模型所属的那一栏」，选中模型后自动跟随过去。
const providerTab = ref(providerOf(store.imageModel));
watch(
  () => store.imageModel,
  (id) => {
    providerTab.value = providerOf(id);
  }
);
const tabModels = computed(() => modelsOfProvider(providerTab.value));

function pickModel(id) {
  store.imageModel = id;
}

async function checkComfy() {
  store.comfyStatus = await comfyStatus();
}

const zoomPct = computed(() => nodeCanvasRef.value?.zoomPct || "100%");
const canUndo = computed(() => nodeCanvasRef.value?.canUndo ?? false);
const canRedo = computed(() => nodeCanvasRef.value?.canRedo ?? false);

function zoomOut() { nodeCanvasRef.value?.zoomOut?.({ duration: 150 }); }
function zoomIn() { nodeCanvasRef.value?.zoomIn?.({ duration: 150 }); }
function resetView() { nodeCanvasRef.value?.fitView?.({ padding: 0.05, duration: 300 }); }
function toggleMinimap() {
  minimapOn.value = !minimapOn.value;
  nodeCanvasRef.value?.toggleMinimap?.();
}
function undo() { nodeCanvasRef.value?.undo?.(); }
function redo() { nodeCanvasRef.value?.redo?.(); }

function onToolClick(tool) {
  if (tool.direct) {
    openToolId.value = "";
    store.activeTool = tool.id;
    store.activeSubTool = tool.direct;
    nodeCanvasRef.value?.applyWorkflow?.(tool.direct);
    return;
  }
  openToolId.value = openToolId.value === tool.id ? "" : tool.id;
}

function pickSubTool(tool, opt) {
  openToolId.value = "";
  store.activeTool = tool.id;
  store.activeSubTool = opt.id;
  nodeCanvasRef.value?.applyWorkflow?.(opt.id);
}

// 数字键 1-5 切换工具
function onToolShortcut(idx) {
  const tool = TOOLS[idx];
  if (!tool) return;
  onToolClick(tool);
}

const shortcuts = [
  { title: "基础操作", rows: ["撤销 Ctrl+Z", "重做 Ctrl+Shift+Z", "全选 Ctrl+A", "复制节点 Ctrl+D", "删除 Delete", "适配视图 Ctrl+0"] },
  { title: "作品组", rows: ["编为作品组 Ctrl+G", "解散作品组 Ctrl+Shift+G"] },
  { title: "画布模式", rows: ["无限画布：自由摆放节点与连线", "全自动批量：按文件夹整批出图（Ctrl+B）", "批量结果带原图/结果对比预览"] },
  { title: "工具与面板", rows: ["AI换衣 1", "图生图 2", "文生图 3", "详情页制作 4", "AI视频 5", "素材库 D", "小地图 M", "对话 F"] },
  { title: "画布", rows: ["空白处拖动 框选", "Shift 点击 加选", "方向键 微调位置", "Esc 取消选中", "滚轮 缩放"] }
];

// ---------- 模板反哺（P2）：把当前画布存成模板 ----------
async function saveAsTemplate() {
  const graph = nodeCanvasRef.value?.exportGraph?.();
  if (!graph || !graph.nodes?.length) {
    ElMessage.warning("画布还是空的，先铺一套工作流或加几个节点");
    return;
  }
  let name = "";
  try {
    const res = await ElMessageBox.prompt(
      `将保存 ${graph.nodes.length} 个节点、${graph.edges.length} 条连线。运行中的状态与已生成结果不会被保存。`,
      "存为模板",
      {
        inputValue: `${store.projectName} · 我的流程`,
        inputPlaceholder: "模板名称",
        inputValidator: (v) => (v && String(v).trim().length ? true : "请输入模板名称"),
        confirmButtonText: "保存",
        cancelButtonText: "取消"
      }
    );
    name = String(res.value || "").trim();
  } catch {
    return; // 用户取消
  }

  try {
    const r = await saveTemplateFromProject({
      name,
      desc: "",
      category: "product",
      graph
    });
    ElMessage.success(`已存为模板「${r.template.name}」，可在首页模板库中选用`);
    // 立刻刷新模板库缓存，回首页就能看到
    try {
      const fresh = await fetchTemplates();
      store.templates = fresh.rows || [];
    } catch { /* 刷新失败不影响保存结果 */ }
  } catch (e) {
    ElMessage.error(e?.message || "保存失败");
  }
}

function renameProject() {
  const name = window.prompt("项目名称", store.projectName);
  if (name && name.trim()) {
    store.projectName = name.trim();
    nodeCanvasRef.value?.requestSave?.();
  }
}

// ---------- 保存状态（F4） ----------
const saveLabel = computed(() => saveStateLabel());
const saveClass = computed(() => `is-${store.saveState}`);

// ---------- 导出（E8） ----------
const projectFileInput = ref(null);

function onExportJson() {
  const graph = nodeCanvasRef.value?.exportGraph?.();
  if (!graph?.nodes?.length) return ElMessage.warning("画布是空的，没有可导出的内容");
  exportProject(graph);
  ElMessage.success("项目文件已下载");
}

async function onExportAssets() {
  const items = collectAssets();
  if (!items.length) return ElMessage.warning("画布上还没有生成结果");
  try {
    const n = await downloadZip(items, { prefix: store.projectName });
    ElMessage.success(`已打包 ${n} 个文件`);
  } catch (e) {
    ElMessage.error(e?.message || "打包失败");
  }
}

async function onExportFlat() {
  const items = collectAssets();
  if (!items.length) return ElMessage.warning("画布上还没有生成结果");
  await downloadMany(items, { prefix: store.projectName });
  ElMessage.success(`已开始下载 ${items.length} 个文件`);
}

/** 从画布上的结果节点收集所有图片/视频 */
function collectAssets() {
  const graph = nodeCanvasRef.value?.exportGraph?.() || { nodes: [] };
  const out = [];
  for (const n of graph.nodes) {
    if (n.type !== "result") continue;
    for (const im of n.data?.images || []) if (im?.url) out.push({ url: im.url });
    for (const v of n.data?.videos || []) if (v?.url) out.push({ url: v.url });
  }
  return out;
}

async function onImportProject(file) {
  try {
    const data = await importProject(file);
    nodeCanvasRef.value?.restoreGraph?.(data.graph);
    store.projectName = data.name || store.projectName;
    ElMessage.success(`已导入项目「${data.name}」`);
  } catch (e) {
    ElMessage.error(e?.message || "导入失败");
  }
}

function onProjectPicked(e) {
  const f = e.target.files?.[0];
  if (f) onImportProject(f);
  e.target.value = "";
}

function onExportCmd(cmd) {
  if (cmd === "zip") onExportAssets();
  else if (cmd === "flat") onExportFlat();
  else if (cmd === "json") onExportJson();
  else if (cmd === "import") projectFileInput.value?.click();
}
</script>

<template>
  <div class="studio-clean" :class="{ dark: store.darkMode }">
    <input ref="projectFileInput" type="file" accept="application/json,.json" hidden @change="onProjectPicked" />

    <!-- 顶部栏 -->
    <header class="clean-topbar">
      <div class="clean-left">
        <div class="clean-brand">
          <el-dropdown>
            <button class="clean-project">
              <span>{{ store.projectName }}</span>
              <el-icon><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="store.projectName = '未命名项目'">新建项目</el-dropdown-item>
                <el-dropdown-item @click="renameProject">重命名</el-dropdown-item>
                <el-dropdown-item @click="store.route = 'home'" divided>返回首页</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <!-- 技能库入口（Sprint 2）：选场景 → 一键铺出整套节点图
             2026-10-23：图标从 Grid（九宫格）换成 Tools（工具箱）。
             Grid 混在顶栏一排线性图标里像"仪表盘"按钮，和画布/批量语义打架；
             Tools 一眼就是工具，符合"技能库 = 一堆现成做法"。 -->
        <button class="skill-entry" :class="{ on: dockOpen }" title="技能面板（展开/收起）" @click="dockOpen = !dockOpen">
          <el-icon><Tools /></el-icon>
          <span>技能</span>
        </button>

        <el-popover placement="bottom-start" :width="286" trigger="click" popper-class="model-setting-popover">
          <template #reference>
            <button class="model-trigger">
              <span class="model-trigger-name">{{ currentModel.label }}</span>
              <span class="model-trigger-res">{{ store.imageResolution }}</span>
              <el-icon><ArrowUp /></el-icon>
            </button>
          </template>          <div class="model-picker">
            <div class="model-picker-title">图像生成模型</div>

            <!-- 顶部供应商分栏（对齐参考设计：OpenAI / Google / aichange） -->
            <div class="model-picker-tabs" role="tablist">
              <button
                v-for="t in MODEL_PROVIDER_TABS"
                :key="t.id"
                class="model-picker-tab"
                :class="{ on: providerTab === t.id }"
                role="tab"
                :aria-selected="providerTab === t.id"
                @click="providerTab = t.id"
              >
                {{ t.label }}
              </button>
            </div>

            <!-- 当前分栏下的模型卡：名称 + 能力说明 + 单价 -->
            <div class="model-picker-list">
              <button
                v-for="m in tabModels"
                :key="m.id"
                class="model-card"
                :class="{ on: store.imageModel === m.id }"
                @click="pickModel(m.id)"
              >
                <span class="model-card-main">
                  <span class="model-card-name">{{ m.label }}</span>
                  <span class="model-card-tag">{{ taglineOf(m.id) }}</span>
                </span>
                <span class="model-card-side">
                  <span class="model-card-price">{{ costLabelOf(m.id) }}</span>
                  <el-icon v-if="store.imageModel === m.id" class="model-card-check"><Check /></el-icon>
                </span>
              </button>
              <p v-if="!tabModels.length" class="model-picker-empty">该通道暂无可用模型</p>
            </div>

            <div class="model-picker-divider" />

            <div class="model-picker-res">
              <span class="model-picker-res-label">分辨率</span>
              <div class="model-picker-seg">
                <button
                  v-for="r in RESOLUTIONS"
                  :key="r"
                  :class="{ on: store.imageResolution === r }"
                  @click="store.imageResolution = r"
                >
                  {{ r }}
                </button>
              </div>
            </div>
          </div>
        </el-popover>
      </div>

      <div class="clean-center">
        <!-- 画布模式开关：无限画布自由创作 / 批量节点批量操作 -->
        <CanvasModeSwitch />
        <span class="clean-sep" />
        <button class="clean-ctl" :disabled="!canUndo" title="撤销 (Ctrl+Z)" @click="undo">
          <el-icon><RefreshLeft /></el-icon>
        </button>
        <button class="clean-ctl" :disabled="!canRedo" title="重做 (Ctrl+Shift+Z)" @click="redo">
          <el-icon><RefreshRight /></el-icon>
        </button>
        <span class="clean-sep" />
        <button class="clean-ctl" title="缩小画布" @click="zoomOut"><el-icon><Minus /></el-icon></button>
        <span class="clean-zoom">{{ zoomPct }}</span>
        <button class="clean-ctl" title="放大画布" @click="zoomIn"><el-icon><Plus /></el-icon></button>
        <button class="clean-ctl" title="恢复视图 (Ctrl+0)" @click="resetView"><el-icon><Aim /></el-icon></button>
        <span class="clean-sep" />
        <!-- 保存状态三态（F4）：之前顶栏完全没有，用户不知道改完存没存 -->
        <span class="clean-save" :class="saveClass" :title="`上次保存：${store.lastSavedAt ? new Date(store.lastSavedAt).toLocaleString() : '尚未保存'}`">
          <span class="save-dot" />
          {{ saveLabel }}
        </span>
        <span class="clean-sep" />
        <el-dropdown trigger="click" @command="onExportCmd">
          <button class="clean-ctl" title="导出">
            <el-icon><Download /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="zip">结果打包 ZIP</el-dropdown-item>
              <el-dropdown-item command="flat">结果逐张下载</el-dropdown-item>
              <el-dropdown-item command="json" divided>导出项目文件</el-dropdown-item>
              <el-dropdown-item command="import">导入项目文件</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <button class="clean-ctl" title="把当前画布存为模板" @click="saveAsTemplate">
          <el-icon><Collection /></el-icon>
        </button>
      </div>

      <div class="clean-right">
        <!-- 任务中心：以前是常驻底部的横条（用户明确不要），现在挪到顶栏，
             没有任务时入口本身不出现，点开才展开浮层面板。 -->
        <TaskBar />
        <!-- 主题切换：三套视觉方案 + 明暗，随切随看 -->
        <ThemeSwitcher />
        <span class="clean-credits" :title="`当前算力 ${store.balance ?? 0}`">
          <el-icon><Lightning /></el-icon>
          {{ store.balance ?? 0 }}
        </span>
        <button class="clean-recharge" @click="emit('open-recharge')">充值</button>
        <button class="clean-user" title="账号与设置" @click="emit('open-account')">
          {{ userInitial }}
        </button>
        <button class="clean-icon-btn" title="帮助" @click="helpOpen = true"><el-icon><QuestionFilled /></el-icon></button>
        <!-- 创作台顶栏之前没有窗口控制，进了画布就没法最小化/最大化/关闭 -->
        <WindowControls />
      </div>
    </header>

    <div class="clean-body">
      <div class="clean-canvas">
        <NodeCanvas
          ref="nodeCanvasRef"
          @tool-shortcut="onToolShortcut"
          @toggle-material="store.materialPanelOpen = !store.materialPanelOpen"
          @toggle-minimap="toggleMinimap"
          @toggle-chat="openAgentChat"
        />

        <!-- 画布顶部提示 + 导入（参考站有这两处，作用是告诉用户画布能怎么操作） -->
        <div class="canvas-hint">按住 Ctrl 多选 · 双击查看详情 · 拖拽框选</div>
        <button class="canvas-import" title="把本地图片导入画布" @click="store.materialPanelOpen = true">
          <el-icon><Upload /></el-icon>
          <span>导入到画布</span>
        </button>

        <!-- 工具抽屉：收起时是一颗圆球，点开滑出工具面板（2026-10-31 改版） -->
        <!-- 浮动左下按钮组 -->
        <div class="float-corner">
          <button
            class="float-corner-btn"
            :class="{ on: store.materialPanelOpen }"
            title="素材库 (D)"
            @click="store.materialPanelOpen = !store.materialPanelOpen"
          >
            <el-icon><FolderOpened /></el-icon>
          </button>
          <button class="float-corner-btn" :class="{ on: minimapOn }" title="小地图 (M)" @click="toggleMinimap">
            <el-icon><MapLocation /></el-icon>
          </button>
          <button class="float-corner-btn" title="帮助" @click="helpOpen = true">
            <el-icon><QuestionFilled /></el-icon>
          </button>
        </div>

        <!-- 提示词预设卡片 -->
        <div class="float-presets">
          <div class="float-presets-title">提示词预设</div>
          <div class="float-presets-sub">搜索并加载提示词预设</div>
        </div>

        <!-- 素材库浮层 -->
        <MaterialLibrary v-if="store.materialPanelOpen" class="float-material" />


        <!-- 批量面板：只在批量节点模式出现 -->
        <BatchDock v-if="store.canvasMode === 'batch' && store.batchDockOpen" />

              </div>

      <!-- 右侧固定「技能」面板（Agent / 技能 双 Tab，参考站 studio 右栏结构） -->
      <StudioDock
        ref="dockRef"
        v-if="dockOpen"
        @close="dockOpen = false"
        @open-all="skillsOpen = true"
      />

      <!-- 属性栏已合并进 StudioDock 的「属性」页：右侧只留一列，画布更宽 -->
    </div>

    <!-- 底部任务条已移除：任务入口在顶栏（TaskBar），底部不再占任何高度 -->

    <!-- 技能库面板（Sprint 2）：点技能 → 铺出对应节点图 -->
    <SkillsPanel v-model:open="skillsOpen" />

    <!-- 帮助 / 快捷键 -->
    <el-dialog v-model="helpOpen" title="快捷键" width="520" class="shortcut-dialog">
      <div v-for="g in shortcuts" :key="g.title" class="shortcut-group">
        <div class="shortcut-group-title">{{ g.title }}</div>
        <div class="shortcut-rows">
          <div v-for="r in g.rows" :key="r" class="shortcut-row">
            <span class="shortcut-action">{{ r.split(" ")[0] }}</span>
            <span class="shortcut-keys">
              <kbd v-for="k in r.split(' ').slice(1)" :key="k">{{ k }}</kbd>
            </span>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>
