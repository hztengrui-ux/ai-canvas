<script setup>
// 组织架构
import { ref, reactive, computed, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { fetchDepts, saveDept, removeDept } from "../../api.js";

const props = defineProps({ perms: { type: Array, default: () => [] } });
const can = (c) => props.perms.includes(c);

const loading = ref(false);
const rows = ref([]);

const dialogOpen = ref(false);
const editing = ref(null);
const form = reactive({ name: "", parentId: "", sort: 0 });

// 把扁平列表拼成树
const tree = computed(() => {
  const map = new Map(rows.value.map((d) => [d.id, { ...d, children: [] }]));
  const roots = [];
  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) map.get(node.parentId).children.push(node);
    else roots.push(node);
  }
  const sortFn = (a, b) => (a.sort || 0) - (b.sort || 0);
  const walk = (list) => {
    list.sort(sortFn);
    for (const n of list) walk(n.children);
  };
  walk(roots);
  return roots;
});

const total = computed(() => rows.value.length);

async function load() {
  loading.value = true;
  try {
    const d = await fetchDepts();
    rows.value = d.rows || [];
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}

function openCreate(parentId = "") {
  editing.value = null;
  Object.assign(form, { name: "", parentId, sort: rows.value.length });
  dialogOpen.value = true;
}

function openEdit(dept) {
  editing.value = dept;
  Object.assign(form, { name: dept.name, parentId: dept.parentId, sort: dept.sort || 0 });
  dialogOpen.value = true;
}

async function submit() {
  if (!form.name.trim()) return ElMessage.warning("请填写部门名称");
  try {
    await saveDept({ id: editing.value?.id, ...form });
    ElMessage.success("已保存");
    dialogOpen.value = false;
    load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

async function doRemove(dept) {
  try {
    await ElMessageBox.confirm(`确认删除部门「${dept.name}」？`, "删除部门", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消"
    });
    await removeDept(dept.id);
    ElMessage.success("已删除");
    load();
  } catch (err) {
    if (err !== "cancel") ElMessage.error(err.message || "删除失败");
  }
}

onMounted(load);
</script>

<template>
  <div class="ad2-page">
    <div class="ac-bar">
      <span class="ac-total">共 {{ total }} 个部门</span>
      <span class="ac-spacer" />
      <button v-if="can('admin:dept:edit')" class="ac-btn-primary" @click="openCreate('')">
        + 新建一级部门
      </button>
    </div>

    <div v-if="loading" class="ad-empty">加载中…</div>

    <div v-else class="dt-tree">
      <template v-for="root in tree" :key="root.id">
        <!-- 一级 -->
        <div class="dt-node lv1">
          <div class="dt-node-main">
            <el-icon class="dt-icon"><OfficeBuilding /></el-icon>
            <span class="dt-name">{{ root.name }}</span>
            <span class="ac-tag">{{ root.memberCount }} 人</span>
          </div>
          <div class="dt-actions">
            <button v-if="can('admin:dept:edit')" class="ac-act" @click="openCreate(root.id)">加子部门</button>
            <button v-if="can('admin:dept:edit')" class="ac-act" @click="openEdit(root)">编辑</button>
            <button v-if="can('admin:dept:edit')" class="ac-act danger" @click="doRemove(root)">删除</button>
          </div>
        </div>

        <!-- 二级 -->
        <div v-for="child in root.children" :key="child.id" class="dt-node lv2">
          <div class="dt-node-main">
            <span class="dt-branch">└</span>
            <el-icon class="dt-icon sub"><Collection /></el-icon>
            <span class="dt-name">{{ child.name }}</span>
            <span class="ac-tag">{{ child.memberCount }} 人</span>
          </div>
          <div class="dt-actions">
            <button v-if="can('admin:dept:edit')" class="ac-act" @click="openCreate(child.id)">加子部门</button>
            <button v-if="can('admin:dept:edit')" class="ac-act" @click="openEdit(child)">编辑</button>
            <button v-if="can('admin:dept:edit')" class="ac-act danger" @click="doRemove(child)">删除</button>
          </div>
        </div>
      </template>
    </div>

    <el-dialog
      v-model="dialogOpen"
      :title="editing ? '编辑部门' : '新建部门'"
      width="460px"
      class="ac-dialog-box"
      append-to-body
    >
      <div class="ac-form">
        <label class="ac-field">
          <span>部门名称 <i>*</i></span>
          <input v-model="form.name" placeholder="如：AI 创作中心" maxlength="20" />
        </label>
        <label class="ac-field">
          <span>上级部门</span>
          <select v-model="form.parentId">
            <option value="">无（作为一级部门）</option>
            <option v-for="d in rows" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
        </label>
        <label class="ac-field">
          <span>排序</span>
          <input v-model.number="form.sort" type="number" min="0" />
        </label>
      </div>
      <template #footer>
        <button class="ac-btn-ghost" @click="dialogOpen = false">取消</button>
        <button class="ac-btn-primary" @click="submit">保存</button>
      </template>
    </el-dialog>
  </div>
</template>
