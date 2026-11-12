<script setup>
/**
 * 我的项目（2026-09-25 补强）
 * --------------------------------------------------------------------------
 * 原来这个页面只有 77 行，是 8 个主视图里最薄的，三个真问题：
 *   1. **没有空态** —— 新用户第一次打开，中间一大片空白，不知道该干嘛
 *   2. **新建和删除只改内存** —— 刷新页面项目就回来了，用户以为删掉了其实还在
 *   3. 没有重命名 / 复制 / 排序，项目一多就只能靠肉眼找
 *
 * 现在所有写操作一律走 project.js 落盘，列表与 localStorage 保持同一份真源。
 */
import { computed, ref, nextTick, onMounted } from "vue";
import { ElMessageBox } from "element-plus";
import { store } from "../store.js";
import {
  createProject, removeProject, renameProject, duplicateProject, openProject,
  sortProjects, PROJECT_SORTS
} from "../project.js";

const keyword = ref("");
const sortBy = ref("updated");
// 项目列表要等 App 的 bootstrap 从 localStorage 读回来，
// 首帧先给骨架，别让用户看一眼空白再突然冒出卡片
const ready = ref(false);
onMounted(() => requestAnimationFrame(() => { ready.value = true; }));
const editingId = ref("");
const editingName = ref("");
const nameInput = ref(null);
// v-for 里的 ref 会被收集成数组，用函数式 ref 只留当前这一个
const setInput = (el) => {
  if (el) nameInput.value = el;
};

const list = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const filtered = kw
    ? store.projects.filter((p) => String(p.name).toLowerCase().includes(kw))
    : store.projects;
  return sortProjects(filtered, sortBy.value);
});

/** 空态要区分两种：真没项目（引导开工）vs 搜索没结果（换个词） */
const isSearchEmpty = computed(() => list.value.length === 0 && keyword.value.trim().length > 0);
const isTotalEmpty = computed(() => store.projects.length === 0);

function goStudio() {
  store.route = "studio";
}

function onCreate() {
  const row = createProject("未命名项目");
  store.pendingWorkflow = "";
  goStudio();
  // 新建后直接进入重命名，省得留下一堆「未命名项目」
  startRename(row);
}

function onOpen(p) {
  openProject(p.id);
  goStudio();
}

async function onRemove(p, e) {
  e?.stopPropagation?.();
  try {
    await ElMessageBox.confirm(
      `删除后无法恢复，确定删除「${p.name}」吗？`,
      "删除项目",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
  } catch {
    return; // 用户取消
  }
  removeProject(p.id);
}

async function onDuplicate(p, e) {
  e?.stopPropagation?.();
  const r = duplicateProject(p.id);
  if (!r) return;
  // 只有复制当前打开的项目时才连画布一起复制，别的不假装
  if (!r.withGraph) {
    await ElMessageBox.alert(
      `已创建「${r.row.name}」。\n注意：只有当前打开的项目能连画布一起复制，其他项目复制的是条目信息（名称与缩略图）。`,
      "已复制",
      { confirmButtonText: "知道了" }
    ).catch(() => {});
  }
}

function startRename(p, e) {
  e?.stopPropagation?.();
  editingId.value = p.id;
  editingName.value = p.name;
  nextTick(() => nameInput.value?.focus());
}

function commitRename() {
  if (!editingId.value) return;
  const id = editingId.value;
  const name = editingName.value;
  editingId.value = "";
  if (name && name !== store.projects.find((p) => p.id === id)?.name) {
    renameProject(id, name);
  }
}

function cancelRename() {
  editingId.value = "";
}
</script>

<template>
  <div class="projects-page">
    <div class="projects-inner">
      <div class="projects-head">
        <div>
          <h1 class="projects-title">
            <el-icon><Folder /></el-icon>
            <span>我的项目</span>
          </h1>
          <p class="projects-sub">管理你的所有设计项目</p>
        </div>
        <div class="projects-tools">
          <div class="projects-search">
            <el-icon><Search /></el-icon>
            <input v-model="keyword" placeholder="搜索项目名称" />
          </div>
          <div class="pj-sort">
            <span class="pj-sort-label">排序</span>
            <button
              v-for="s in PROJECT_SORTS"
              :key="s.key"
              class="pj-sort-btn"
              :class="{ on: sortBy === s.key }"
              @click="sortBy = s.key"
            >
              {{ s.label }}
            </button>
          </div>
        </div>
      </div>

      <!-- 首帧骨架：列表还没从 localStorage 读回来 -->
      <div v-if="!ready && isTotalEmpty" class="sk-grid">
        <div v-for="i in 6" :key="i" class="sk-card">
          <div class="sk sk-thumb"></div>
          <div class="sk sk-line m"></div>
          <div class="sk sk-line s"></div>
        </div>
      </div>

      <!-- 空态一：一个项目都没有 —— 引导开工，不是留白 -->
      <div v-else-if="isTotalEmpty" class="pj-empty">
        <div class="pj-empty-icon"><el-icon><FolderOpened /></el-icon></div>
        <div class="pj-empty-title">还没有项目</div>
        <div class="pj-empty-sub">
          新建一个项目，把毛衫图、提示词和生成结果都摆在一张画布上
        </div>
        <button class="pj-empty-btn" @click="onCreate">
          <el-icon><Plus /></el-icon>
          <span>创建第一个项目</span>
        </button>
        <div class="pj-empty-hint">也可以直接进创作台，画布会自动归到新项目里</div>
      </div>

      <!-- 空态二：有项目但搜索没命中 -->
      <div v-else-if="isSearchEmpty" class="pj-empty">
        <div class="pj-empty-icon"><el-icon><Search /></el-icon></div>
        <div class="pj-empty-title">没有匹配的项目</div>
        <div class="pj-empty-sub">换个关键词试试，或者清空搜索看全部 {{ store.projects.length }} 个项目</div>
        <button class="pj-empty-btn ghost" @click="keyword = ''">清空搜索</button>
      </div>

      <div v-else class="projects-grid">
        <button class="project-card new" @click="onCreate">
          <span class="project-new-icon"><el-icon><Plus /></el-icon></span>
          <span class="project-new-text">新建项目</span>
        </button>

        <div v-for="p in list" :key="p.id" class="project-card" @click="onOpen(p)">
          <div class="project-thumb">
            <template v-if="p.thumbs?.length">
              <img v-for="(t, i) in p.thumbs.slice(0, 4)" :key="i" :src="t" />
            </template>
            <span v-else class="project-letter">{{ (p.name?.[0] || "U").toUpperCase() }}</span>
          </div>

          <div class="project-meta">
            <!-- 双击名称就地重命名，回车保存、Esc 放弃 -->
            <input
              v-if="editingId === p.id"
              :ref="setInput"
              v-model="editingName"
              class="pj-name-input"
              @click.stop
              @keyup.enter="commitRename"
              @keyup.esc="cancelRename"
              @blur="commitRename"
            />
            <span v-else class="project-name" :title="p.name + '（双击重命名）'" @dblclick.stop="startRename(p)">
              {{ p.name }}
            </span>
            <span class="project-date">{{ p.updatedAt }}</span>
          </div>

          <div class="pj-ops">
            <button class="pj-op" title="重命名" @click.stop="startRename(p)">
              <el-icon><EditPen /></el-icon>
            </button>
            <button class="pj-op" title="复制副本" @click.stop="onDuplicate(p, $event)">
              <el-icon><CopyDocument /></el-icon>
            </button>
            <button class="pj-op danger" title="删除" @click.stop="onRemove(p, $event)">
              <el-icon><Delete /></el-icon>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
