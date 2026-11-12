<script setup>
/**
 * 左侧图标导航栏（2026-10-31 按用户给的 loom42 布局改版）
 *
 * 结构：顶部 logo → 主导航（图标 + 10px 小字）→ 底部帮助。
 * 当前项用「荧光绿方块 + 墨黑图标」，和参考稿的白色激活块同一套逻辑，只是换成我们的品牌色。
 * 图标一律 17px，文字 10px，垂直节奏 10px —— 参考稿就是这么排的，图标大了会显得挤。
 */
import { ElMessage } from "element-plus";
import { ref } from "vue";
import { store, TOOLS } from "../store.js";

const emit = defineEmits(["open-help"]);

const items = [
  { route: "home", label: "首页", icon: "HomeFilled" },
  { route: "studio", label: "工作台", icon: "Monitor" },
  { route: "batch", label: "批量", icon: "Files" },
  { route: "templates", label: "模板", icon: "Grid" },
  { route: "projects", label: "项目", icon: "Folder" },
  { route: "review", label: "作品", icon: "PictureFilled" }
];

/**
 * 选一个画布工具。
 * 之前这段逻辑在 StudioView（要拿到 canvasRef 才能铺图），现在工具搬到图标栏，
 * 走 store.pendingWorkflow —— 画布监听到就自己铺，不依赖父子引用。
 */
// 当前展开的是哪个工具的变体菜单（受控，选完能手动收起）
const openMenu = ref("");

function applyTool(tool, opt) {
  openMenu.value = "";
  const id = opt?.id || tool.direct;
  if (!id) return;
  store.route = "studio";
  store.activeTool = tool.id;
  store.activeSubTool = id;
  store.pendingWorkflow = id;
  // 画布是"监听 pendingWorkflow → 异步铺图"，没有这句用户会以为按钮没生效
  ElMessage.success(`${tool.label}${opt ? " · " + opt.label : ""}：已铺好画布`);
}

function go(it) {
  store.route = it.route;
}
</script>

<template>
  <nav class="app-rail" aria-label="主导航">
    <button class="rail-logo" title="跨多多 AI 创作台" @click="store.route = 'home'">
      <img src="/brand/logo-mark.png" alt="跨多多" />
    </button>

    <div class="rail-items">
      <button
        v-for="it in items"
        :key="it.route"
        class="rail-item"
        :class="{ on: store.route === it.route }"
        :title="it.label"
        @click="go(it)"
      >
        <el-icon><component :is="it.icon" /></el-icon>
        <span>{{ it.label }}</span>
      </button>
    </div>

    <!-- 画布工具：只在工作台出现；原来是一颗浮动球 + 抽屉，现在并进导航栏 -->
    <template v-if="store.route === 'studio'">
      <div class="rail-divider" />
      <div class="rail-tools">
        <div v-for="(tool, i) in TOOLS" :key="tool.id" class="rail-tool-wrap">
          <el-popover
            v-if="tool.options && tool.options.length"
            :visible="openMenu === tool.id"
            placement="right-start"
            :width="228"
            trigger="click"
            popper-class="rail-tool-pop"
            :show-arrow="false"
            :offset="10"
            @update:visible="(v) => (openMenu = v ? tool.id : '')"
          >
            <template #reference>
              <button
                class="rail-item rail-tool"
                :class="{ on: store.activeTool === tool.id }"
                :title="tool.label + ' (' + (i + 1) + ')'"
              >
                <el-icon><component :is="tool.icon" /></el-icon>
                <span>{{ tool.label }}</span>
                <i class="rail-tool-more" />
              </button>
            </template>
            <div class="rail-tool-menu">
              <div class="rail-tool-menu-head">{{ tool.label }}</div>
              <button
                v-for="opt in tool.options"
                :key="opt.id"
                class="rail-tool-menu-row"
                @click="applyTool(tool, opt)"
              >
                {{ opt.label }}
              </button>
            </div>
          </el-popover>

          <button
            v-else
            class="rail-item rail-tool"
            :class="{ on: store.activeTool === tool.id }"
            :title="tool.label + ' (' + (i + 1) + ')'"
            @click="applyTool(tool)"
          >
            <el-icon><component :is="tool.icon" /></el-icon>
            <span>{{ tool.label }}</span>
          </button>
        </div>
      </div>
    </template>

    <div class="rail-foot">
      <button class="rail-item" title="帮助" @click="emit('open-help')">
        <el-icon><QuestionFilled /></el-icon>
        <span>帮助</span>
      </button>
    </div>
  </nav>
</template>
