<script setup>
// 角色与权限矩阵
import { ref, reactive, computed, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { fetchRoles, saveRole, removeRole } from "../../api.js";

const props = defineProps({ perms: { type: Array, default: () => [] } });
const can = (c) => props.perms.includes(c);

const loading = ref(false);
const rows = ref([]);
const permissionDefs = ref([]);
const active = ref(null);

const dialogOpen = ref(false);
const editing = ref(null);
const form = reactive({ name: "", code: "", remark: "", perms: [] });
const saving = ref(false);

// 权限码按分组归拢，便于做矩阵
const grouped = computed(() => {
  const map = {};
  for (const p of permissionDefs.value) {
    (map[p.group] ||= []).push(p);
  }
  return Object.entries(map).map(([group, items]) => ({ group, items }));
});

const activePerms = computed(() => {
  const role = rows.value.find((r) => r.id === active.value);
  return new Set(role?.perms || []);
});

async function load() {
  loading.value = true;
  try {
    const r = await fetchRoles();
    rows.value = r.rows || [];
    permissionDefs.value = r.permissions || [];
    if (!active.value && rows.value.length) active.value = rows.value[0].id;
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.value = null;
  Object.assign(form, { name: "", code: "", remark: "", perms: [] });
  dialogOpen.value = true;
}

function openEdit(role) {
  editing.value = role;
  Object.assign(form, {
    name: role.name,
    code: role.code,
    remark: role.remark || "",
    perms: [...(role.perms || [])]
  });
  dialogOpen.value = true;
}

function toggleGroup(items, on) {
  const set = new Set(form.perms);
  for (const p of items) {
    if (on) set.add(p.code);
    else set.delete(p.code);
  }
  form.perms = [...set];
}

async function submit() {
  if (!form.name.trim()) return ElMessage.warning("请填写角色名称");
  saving.value = true;
  try {
    await saveRole({ id: editing.value?.id, ...form });
    ElMessage.success("已保存");
    dialogOpen.value = false;
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function doRemove(role) {
  try {
    await ElMessageBox.confirm(
      `删除角色「${role.name}」后，持有该角色的账号将失去对应权限。`,
      "删除角色",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
    await removeRole(role.id);
    ElMessage.success("已删除");
    if (active.value === role.id) active.value = null;
    load();
  } catch (err) {
    if (err !== "cancel") ElMessage.error(err.message || "删除失败");
  }
}

onMounted(load);
</script>

<template>
  <div class="ar-page">
    <aside class="ar-list">
      <div class="ar-list-head">
        <span>角色（{{ rows.length }}）</span>
        <button v-if="can('admin:role:edit')" class="ac-btn-primary sm" @click="openCreate">
          + 新建
        </button>
      </div>

      <button
        v-for="r in rows"
        :key="r.id"
        class="ar-item"
        :class="{ on: active === r.id }"
        @click="active = r.id"
      >
        <div class="ar-item-top">
          <span class="ar-item-name">{{ r.name }}</span>
          <span v-if="r.builtin" class="ac-tag">内置</span>
        </div>
        <div class="ar-item-sub">{{ r.code }} · {{ r.memberCount }} 人</div>
      </button>
    </aside>

    <section class="ar-detail">
      <template v-if="rows.find((r) => r.id === active)">
        <div class="ar-detail-head">
          <div>
            <h2>{{ rows.find((r) => r.id === active).name }}</h2>
            <p>{{ rows.find((r) => r.id === active).remark || "暂无描述" }}</p>
          </div>
          <div class="ar-detail-actions">
            <span class="ac-total">已授权 {{ activePerms.size }} 项</span>
            <button v-if="can('admin:role:edit')" class="ac-btn" @click="openEdit(rows.find((r) => r.id === active))">
              编辑权限
            </button>
            <button
              v-if="can('admin:role:edit') && !rows.find((r) => r.id === active).builtin"
              class="ac-btn-ghost danger"
              @click="doRemove(rows.find((r) => r.id === active))"
            >
              删除
            </button>
          </div>
        </div>

        <div class="ar-matrix">
          <div v-for="g in grouped" :key="g.group" class="ar-group">
            <div class="ar-group-name">{{ g.group }}</div>
            <div class="ar-group-perms">
              <span
                v-for="p in g.items"
                :key="p.code"
                class="ar-perm"
                :class="{ on: activePerms.has(p.code) }"
              >
                {{ p.label }}
              </span>
            </div>
          </div>
        </div>
      </template>

      <div v-else class="ad-empty">请选择左侧角色</div>
    </section>

    <el-dialog
      v-model="dialogOpen"
      :title="editing ? '编辑角色' : '新建角色'"
      width="640px"
      class="ac-dialog-box"
      append-to-body
    >
      <div class="ac-form">
        <div class="ac-field-row">
          <label class="ac-field">
            <span>角色名称 <i>*</i></span>
            <input v-model="form.name" placeholder="如：运营主管" maxlength="20" />
          </label>
          <label class="ac-field">
            <span>角色标识</span>
            <input v-model="form.code" :disabled="!!editing" placeholder="如：ops_lead" />
          </label>
        </div>
        <label class="ac-field">
          <span>描述</span>
          <input v-model="form.remark" placeholder="选填" maxlength="40" />
        </label>

        <div class="ac-field">
          <span>接口权限（后端强制校验）</span>
          <div class="ar-edit-groups">
            <div v-for="g in grouped" :key="g.group" class="ar-edit-group">
              <div class="ar-edit-group-head">
                <span>{{ g.group }}</span>
                <div>
                  <button class="ar-mini" @click="toggleGroup(g.items, true)">全选</button>
                  <button class="ar-mini" @click="toggleGroup(g.items, false)">清空</button>
                </div>
              </div>
              <label v-for="p in g.items" :key="p.code" class="ar-check">
                <input v-model="form.perms" type="checkbox" :value="p.code" />
                <span>{{ p.label }}</span>
                <code>{{ p.code }}</code>
              </label>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <button class="ac-btn-ghost" @click="dialogOpen = false">取消</button>
        <button class="ac-btn-primary" :disabled="saving" @click="submit">
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>
