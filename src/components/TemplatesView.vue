<script setup>
// 模板库
// 布局参考 LOOM42：居中搜索 Hero + 模板大卡网格 + 能力小卡 + 「一键生款」式分类横滑行
// 数据全部来自项目内真实的 TOOLS / WORKFLOWS，不是占位内容
import { ref, computed, onMounted } from "vue";
import { store, TOOLS } from "../store.js";
import { fetchTemplates } from "../api.js";

// 从顶栏搜索带过来的关键词
const keyword = ref(store.searchKeyword || "");

const loading = ref(true);

// 模板改由服务端下发：改模板不用重新构建，运营可自助
const rows = computed(() => store.templates || []);
const categories = computed(() => store.templateCategories || []);

// 主推卡：排序前 4 个
const FEATURED = computed(() =>
  rows.value.slice(0, 4).map((t) => ({
    id: t.id,
    wf: t.workflow,
    title: t.name,
    desc: t.desc,
    preview: t.preview,
    badge: t.badge
  }))
);

// 能力小卡：仍从工具清单派生
const CAPABILITIES = computed(() =>
  TOOLS.flatMap((t) =>
    t.options?.length
      ? t.options.slice(0, 2).map((o) => ({ id: o.id, label: o.label, tool: t.label, icon: t.icon }))
      : [{ id: t.direct || t.id, label: t.label, tool: t.label, icon: t.icon }]
  ).slice(0, 8)
);

// 「一键生款」式分类行：按服务端给的分类归组
const CATEGORY_ROWS = computed(() => {
  const map = new Map();
  for (const t of rows.value) {
    if (!map.has(t.category)) map.set(t.category, []);
    map.get(t.category).push(t);
  }
  const label = new Map(categories.value.map((c) => [c.key, c.label]));
  return [...map.entries()].map(([key, items]) => ({
    id: key,
    name: label.get(key) || key,
    icon: "Grid",
    items: items.map((t, i) => ({
      id: t.id,
      label: t.name,
      preview: t.preview,
      // 图缺失时的渐变兜底色相
      hue: (String(key).length * 37 + i * 47) % 360
    }))
  }));
});

const filteredRows = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return CATEGORY_ROWS.value;
  return CATEGORY_ROWS.value
    .map((r) => ({
      ...r,
      items: r.items.filter(
        (i) => i.label.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw)
      )
    }))
    .filter((r) => r.items.length);
});

async function load() {
  try {
    const res = await fetchTemplates();
    store.templates = res.rows || [];
    store.templateCategories = res.categories || [];
  } catch {
    store.templates = [];
  } finally {
    loading.value = false;
  }
}

/**
 * 模板 id → 绑定的工作流。
 * 两种情况：
 *   1) 官方模板：有 workflow 字段，走内置工作流铺开；
 *   2) 用户从画布存的模板（source=project）：带 graph 节点图，
 *      走 pendingTemplateId，进入工作台后由画布拉取节点图铺开。
 */
function launch(id) {
  const t = rows.value.find((x) => x.id === id);
  if (!t) return;
  store.pendingPrompt = "";

  if (t.graph && Array.isArray(t.graph.nodes) && t.graph.nodes.length) {
    store.pendingWorkflow = "";
    store.pendingTemplateId = id;
    store.pendingTemplateName = t.name || "模板";
    store.route = "studio";
    return;
  }

  const workflow = t?.workflow || id;
  if (!workflow) return;
  store.pendingTemplateId = "";
  store.pendingWorkflow = workflow;
  store.route = "studio";
}

function onSearch() {
  if (!filteredRows.value.length) return;
  document.querySelector(".tpl-rows")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

onMounted(load);
</script>

<template>
  <div class="tpl">
    <!-- Hero + 搜索 -->
    <header class="tpl-hero">
      <h1 class="tpl-hero-title">电商图片与视频，一句话开始</h1>
      <p class="tpl-hero-sub">选一个模板，AI 会把画布和节点都铺好</p>

      <div class="tpl-search">
        <input
          v-model="keyword"
          placeholder="搜索模板，例如：模特换装、白底图、详情页…"
          @keyup.enter="onSearch"
        />
        <button class="tpl-search-btn" @click="onSearch">
          <el-icon><Search /></el-icon>
        </button>
      </div>
    </header>

    <!-- 主推模板 -->
    <section class="tpl-section">
      <div class="tpl-sec-head">
        <span class="tpl-sec-icon"><el-icon><Grid /></el-icon></span>
        <h2>热门模板</h2>
        <span class="tpl-sec-sub">最常用的四种玩法</span>
      </div>

      <div class="tpl-featured">
        <button
          v-for="f in FEATURED"
          :key="f.id"
          class="tpl-card"
          @click="launch(f.id)"
        >
          <!-- 有示意图就显示图（对应 LOOM42 那种 16:9 整图），没有则回退渐变 -->
          <span class="tpl-card-art" :class="`art-${f.wf}`">
            <img
              v-if="f.preview"
              class="tpl-card-img"
              :src="f.preview"
              :alt="`${f.title}功能预览`"
              loading="lazy"
              @error="$event.target.style.display = 'none'"
            />
            <span class="tpl-card-art-inner" />
          </span>
          <span class="tpl-card-body">
            <span class="tpl-card-title">
              {{ f.title }}
              <em v-if="f.badge" class="tpl-badge" :class="{ hot: f.badge === '热门' }">{{ f.badge }}</em>
            </span>
            <span class="tpl-card-desc">{{ f.desc }}</span>
          </span>
        </button>
      </div>

      <!-- 能力小卡 -->
      <div class="tpl-caps">
        <button
          v-for="c in CAPABILITIES"
          :key="c.id"
          class="tpl-cap"
          @click="launch(c.id)"
        >
          <span class="tpl-cap-icon"><el-icon><component :is="c.icon" /></el-icon></span>
          <span class="tpl-cap-text">
            <span class="tpl-cap-title">{{ c.label }}</span>
            <span class="tpl-cap-sub">{{ c.tool }}</span>
          </span>
        </button>
      </div>
    </section>

    <!-- 分类横滑行 -->
    <section class="tpl-section tpl-rows">
      <div class="tpl-sec-head">
        <span class="tpl-sec-icon"><el-icon><MagicStick /></el-icon></span>
        <h2>按品类挑选</h2>
        <span class="tpl-sec-sub">点任意一张，直接进画布</span>
      </div>

      <!-- 加载中：骨架。
           之前 loading 期间 filteredRows 为空，会先闪一句「没有匹配的模板」——
           用户以为模板库是空的，其实是还没拉回来。 -->
      <div v-if="loading" class="sk-rows">
        <div v-for="i in 3" :key="i" class="sk-row">
          <div class="sk sk-block" style="width: 150px; height: 76px"></div>
          <div style="flex: 1; display: flex; flex-direction: column; gap: 8px">
            <div class="sk sk-line m"></div>
            <div class="sk sk-line s"></div>
          </div>
          <div class="sk sk-thumb" style="width: 88px"></div>
          <div class="sk sk-thumb" style="width: 88px"></div>
          <div class="sk sk-thumb" style="width: 88px"></div>
        </div>
      </div>

      <div v-else-if="!filteredRows.length" class="tpl-empty">没有匹配的模板</div>

      <div v-for="row in filteredRows" :key="row.id" class="tpl-row">
        <!-- 左侧信息面板 -->
        <div class="tpl-row-panel">
          <div class="tpl-row-name">
            <el-icon><component :is="row.icon" /></el-icon>
            <span>{{ row.name }}</span>
          </div>
          <div class="tpl-row-chips">
            <span v-for="i in row.items.slice(0, 3)" :key="i.id" class="tpl-row-chip">
              {{ i.label }}
            </span>
          </div>
          <button class="tpl-row-btn" @click="launch(row.items[0]?.id)">
            <el-icon><MagicStick /></el-icon>
            <span>一键开始</span>
          </button>
        </div>

        <!-- 右侧横向缩略图流 -->
        <div class="tpl-strip">
          <button
            v-for="i in row.items"
            :key="i.id"
            class="tpl-thumb"
            :style="{ '--h': i.hue }"
            :title="i.label"
            @click="launch(i.id)"
          >
            <img
              v-if="i.preview"
              class="tpl-thumb-img"
              :src="i.preview"
              :alt="i.label"
              loading="lazy"
              @error="$event.target.style.display = 'none'"
            />
            <span class="tpl-thumb-art" />
            <span class="tpl-thumb-label">{{ i.label }}</span>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
