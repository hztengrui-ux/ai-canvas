<script setup>
/**
 * 素材库（2026-09-25 补强：标签 + 删除）
 * --------------------------------------------------------------------------
 * 之前这里只能上传和拖拽，素材只增不减 —— 用久了全是没用的旧图，
 * 而且几百张图只能靠文件名找，文件名还是服务端生成的随机串（`k3f9a2.png`）。
 *
 * 现在补两件事：
 *   1. **打标签**：颜色 / 品类 / 季节 / SKU，前三项下拉（防打错字），SKU 自由文本
 *   2. **能删除**：文件与标签一起清，带二次确认
 *
 * 拖拽进画布的老用法保持不变 —— 点一下是选中编辑，拖出去才是用。
 */
import { computed, onMounted, ref } from "vue";
import { ElMessageBox } from "element-plus";
import { store } from "../store.js";
import { fetchMaterials, uploadMaterial, setMaterialTags, deleteMaterial } from "../api.js";

const keyword = computed({
  get: () => store.materialSearch,
  set: (v) => (store.materialSearch = v)
});

/** 标签口径由服务端下发，前端不硬编码，改口径只改服务端一处 */
const tagGroups = computed(() => store.materials.tagGroups || []);

/** 标签筛选：空字符串代表不限 */
const tagFilter = ref({});

const categories = computed(() =>
  store.materials.categories.map((c) => ({
    ...c,
    files: c.files.filter((f) => {
      if (keyword.value && !f.name.toLowerCase().includes(keyword.value.toLowerCase())) return false;
      // 每个维度内部是「或」，维度之间是「且」
      for (const g of tagGroups.value) {
        const want = tagFilter.value[g.key];
        if (!want) continue;
        const got = String(f.tags?.[g.key] || "");
        if (g.input === "text") {
          if (!got.toLowerCase().includes(String(want).toLowerCase())) return false;
        } else if (got !== want) return false;
      }
      return true;
    })
  }))
);

const activeFilterCount = computed(
  () => Object.values(tagFilter.value).filter((v) => String(v || "").trim()).length
);

const openCats = ref(["clothing"]);
/** 当前选中（用于编辑标签）的素材 */
const selected = ref(null);
/** 编辑中的标签草稿 */
const draft = ref({});
const saving = ref(false);

function toggleCat(id) {
  const i = openCats.value.indexOf(id);
  if (i >= 0) openCats.value.splice(i, 1);
  else openCats.value.push(id);
}

async function refresh() {
  store.materials = await fetchMaterials();
}

onMounted(refresh);
defineExpose({ refresh });

function onDragStart(evt, file) {
  evt.dataTransfer.setData("application/json", JSON.stringify({ material: file }));
  evt.dataTransfer.effectAllowed = "copy";
}

function selectFile(f) {
  selected.value = f;
  draft.value = { ...(f.tags || {}) };
}

function clearFilter() {
  tagFilter.value = {};
}

async function saveTags() {
  if (!selected.value) return;
  saving.value = true;
  try {
    const r = await setMaterialTags(selected.value.url, draft.value);
    // 就地更新，避免整列表刷新导致展开态和滚动位置丢失
    const updated = r.tags || draft.value;
    for (const cat of store.materials.categories) {
      const hit = cat.files.find((f) => f.url === selected.value.url);
      if (hit) hit.tags = { ...updated };
    }
    selected.value = { ...selected.value, tags: { ...updated } };
  } catch (e) {
    ElMessageBox.alert(e.message || "标签保存失败", "保存失败", { type: "error" }).catch(() => {});
  } finally {
    saving.value = false;
  }
}

async function onDelete(f) {
  try {
    await ElMessageBox.confirm(
      `确定删除这个素材吗？文件会从磁盘移除，无法恢复。\n${f.name}`,
      "删除素材",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    await deleteMaterial(f.url);
    if (selected.value?.url === f.url) selected.value = null;
    await refresh();
  } catch (e) {
    ElMessageBox.alert(e.message || "删除失败", "删除失败", { type: "error" }).catch(() => {});
  }
}

async function onUpload(evt, categoryId) {
  const files = [...(evt.target.files || [])];
  evt.target.value = "";
  for (const f of files) {
    try {
      await uploadMaterial(f, categoryId);
    } catch (e) {
      ElMessageBox.alert(e.message, "上传失败", { type: "error" }).catch(() => {});
    }
  }
  refresh();
}

async function onUploadRoot(evt) {
  const first = store.materials.categories[0]?.id || "clothing";
  await onUpload(evt, first);
}
</script>

<template>
  <div class="ml-panel">
    <div class="ml-head">
      <div class="ml-head-text">
        <div class="ml-title">素材库</div>
        <div class="ml-sub">跨项目复用的本地图片和视频</div>
      </div>
      <div class="ml-head-actions">
        <label class="ml-add-btn" title="上传素材">
          <el-icon><Plus /></el-icon>
          <input type="file" hidden multiple accept="image/*,video/*" @change="onUploadRoot" />
        </label>
        <button class="ml-close" title="关闭素材库" @click="store.materialPanelOpen = false">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>

    <div class="ml-search">
      <el-icon class="ml-search-icon"><Search /></el-icon>
      <input v-model="keyword" placeholder="搜索素材文件名" />
    </div>

    <!-- 标签筛选：维度之间是「且」，同一维度内是「或」（单选即精确匹配） -->
    <div v-if="tagGroups.length" class="ml-tags-bar">
      <select
        v-for="g in tagGroups"
        :key="g.key"
        v-model="tagFilter[g.key]"
        class="ml-tag-select"
        :title="`按${g.label}筛选`"
      >
        <option value="">{{ g.label }}：全部</option>
        <option v-for="o in g.options || []" :key="o" :value="o">{{ o }}</option>
      </select>
      <button v-if="activeFilterCount" class="ml-tag-clear" @click="clearFilter">
        清空筛选（{{ activeFilterCount }}）
      </button>
    </div>

    <div class="ml-list" :class="{ 'with-editor': selected }">
      <div v-for="cat in categories" :key="cat.id" class="ml-cat">
        <button class="ml-cat-head" @click="toggleCat(cat.id)">
          <el-icon class="ml-arrow">
            <component :is="openCats.includes(cat.id) ? 'ArrowDown' : 'ArrowRight'" />
          </el-icon>
          <el-icon class="ml-folder"><Folder /></el-icon>
          <span class="ml-cat-name">{{ cat.label }}</span>
          <span v-if="cat.files.length" class="ml-cat-count">{{ cat.files.length }}</span>
        </button>

        <div v-if="openCats.includes(cat.id)" class="ml-cat-body">
          <div v-if="!cat.files.length" class="ml-empty">
            {{ activeFilterCount || keyword ? "当前筛选下没有素材" : "空文件夹，可拖入素材或点击 + 添加" }}
          </div>
          <div v-else class="ml-grid">
            <div
              v-for="f in cat.files"
              :key="f.url"
              class="ml-item"
              :class="{ selected: selected?.url === f.url }"
              draggable="true"
              :title="f.name"
              @click="selectFile(f)"
              @dragstart="onDragStart($event, f)"
            >
              <img v-if="f.kind === 'image'" :src="f.url" :alt="f.name" />
              <div v-else class="ml-item-file">{{ f.name.split('.').pop() }}</div>
              <!-- 有标签就在右下角露出来，找图时不用逐个点开 -->
              <span v-if="f.tags?.color || f.tags?.category" class="ml-item-tag">
                {{ [f.tags.category, f.tags.color].filter(Boolean).join(" · ") }}
              </span>
            </div>
          </div>
          <label class="ml-add-inline">
            <el-icon><Plus /></el-icon>
            <span>添加素材</span>
            <input type="file" hidden multiple accept="image/*,video/*,audio/*" @change="onUpload($event, cat.id)" />
          </label>
        </div>
      </div>
    </div>

    <!-- 标签编辑面板：选中素材后出现 -->
    <div v-if="selected" class="ml-editor">
      <div class="ml-editor-head">
        <span class="ml-editor-title" :title="selected.name">{{ selected.name }}</span>
        <button class="ml-editor-close" title="收起" @click="selected = null">
          <el-icon><Close /></el-icon>
        </button>
      </div>

      <div class="ml-editor-fields">
        <label v-for="g in tagGroups" :key="g.key" class="ml-field">
          <span class="ml-field-label">{{ g.label }}</span>
          <select v-if="g.input === 'select'" v-model="draft[g.key]" class="ml-field-input">
            <option value="">未设置</option>
            <option v-for="o in g.options || []" :key="o" :value="o">{{ o }}</option>
          </select>
          <input
            v-else
            v-model="draft[g.key]"
            class="ml-field-input"
            :placeholder="g.placeholder || ''"
          />
        </label>
      </div>

      <div class="ml-editor-ops">
        <button class="ml-btn" :disabled="saving" @click="saveTags">
          {{ saving ? "保存中…" : "保存标签" }}
        </button>
        <button class="ml-btn danger" @click="onDelete(selected)">删除素材</button>
      </div>
    </div>
  </div>
</template>
