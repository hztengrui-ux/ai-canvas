<script setup>
// 账号信息与管理
import { ref, reactive, computed, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  fetchAccounts, createAccount, updateAccount, removeAccount,
  setAccountStatus, resetAccountPassword, kickAccount,
  fetchRoles, fetchDepts
} from "../../api.js";

const props = defineProps({ perms: { type: Array, default: () => [] } });
const can = (c) => props.perms.includes(c);

const loading = ref(false);
const rows = ref([]);
const roles = ref([]);
const depts = ref([]);
const dataScopes = ref([]);
const total = ref(0);

const filters = reactive({ keyword: "", status: "", deptId: "", roleId: "" });

const dialogOpen = ref(false);
const editing = ref(null);
const form = reactive({
  username: "",
  password: "",
  nickname: "",
  email: "",
  phone: "",
  deptId: "",
  roleIds: [],
  dataScope: "all"
});
const saving = ref(false);

const title = computed(() => (editing.value ? "编辑账号" : "新建账号"));

async function load() {
  loading.value = true;
  try {
    const [a, r, d] = await Promise.all([fetchAccounts(filters), fetchRoles(), fetchDepts()]);
    rows.value = a.rows || [];
    total.value = a.total || 0;
    roles.value = r.rows || [];
    dataScopes.value = r.dataScopes || [];
    depts.value = d.rows || [];
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}

function reset() {
  Object.assign(filters, { keyword: "", status: "", deptId: "", roleId: "" });
  load();
}

function openCreate() {
  editing.value = null;
  Object.assign(form, {
    username: "",
    password: "",
    nickname: "",
    email: "",
    phone: "",
    deptId: depts.value[1]?.id || "",
    roleIds: roles.value.find((r) => r.code === "operator") ? ["r-operator"] : [],
    dataScope: "all"
  });
  dialogOpen.value = true;
}

function openEdit(row) {
  editing.value = row;
  Object.assign(form, {
    username: row.username,
    password: "",
    nickname: row.nickname,
    email: row.email,
    phone: row.phone,
    deptId: row.deptId,
    roleIds: [...(row.roleIds || [])],
    dataScope: row.dataScope || "all"
  });
  dialogOpen.value = true;
}

async function submit() {
  if (!form.username.trim()) return ElMessage.warning("请填写账号");
  if (!editing.value && form.password.length < 6) return ElMessage.warning("密码至少 6 位");
  saving.value = true;
  try {
    if (editing.value) {
      await updateAccount(editing.value.id, {
        nickname: form.nickname,
        email: form.email,
        phone: form.phone,
        deptId: form.deptId,
        roleIds: form.roleIds,
        dataScope: form.dataScope
      });
      // 超管降权时后端会拦住，这里只在有值时才改密
      ElMessage.success("已保存");
    } else {
      await createAccount({ ...form });
      ElMessage.success("账号已创建");
    }
    dialogOpen.value = false;
    load();
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(row) {
  const next = row.status === "active" ? "disabled" : "active";
  try {
    await ElMessageBox.confirm(
      next === "disabled"
        ? `停用后「${row.username}」将立即无法登录，且现有会话会被清除。`
        : `确认启用「${row.username}」？`,
      next === "disabled" ? "停用账号" : "启用账号",
      { type: "warning", confirmButtonText: "确认", cancelButtonText: "取消" }
    );
    await setAccountStatus(row.id, next);
    ElMessage.success(next === "disabled" ? "已停用" : "已启用");
    load();
  } catch (err) {
    if (err !== "cancel") ElMessage.error(err.message || "操作失败");
  }
}

async function doReset(row) {
  try {
    const { value } = await ElMessageBox.prompt(
      `为「${row.username}」设置新密码（至少 6 位）。重置后该账号会被强制下线。`,
      "重置密码",
      {
        inputType: "password",
        inputPlaceholder: "请输入新密码",
        inputValidator: (v) => (v && v.length >= 6) || "密码至少 6 位",
        confirmButtonText: "重置",
        cancelButtonText: "取消"
      }
    );
    await resetAccountPassword(row.id, value);
    ElMessage.success("密码已重置，该账号需重新登录");
    load();
  } catch (err) {
    if (err !== "cancel") ElMessage.error(err.message || "重置失败");
  }
}

async function doKick(row) {
  try {
    const r = await kickAccount(row.id);
    ElMessage.success(`已强制下线（清除 ${r.sessions} 个会话）`);
    load();
  } catch (err) {
    ElMessage.error(err.message);
  }
}

async function doRemove(row) {
  try {
    await ElMessageBox.confirm(
      `删除后不可恢复，「${row.username}」的全部会话与登录凭证将失效。`,
      "删除账号",
      { type: "warning", confirmButtonClass: "el-button--danger", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
    await removeAccount(row.id);
    ElMessage.success("已删除");
    load();
  } catch (err) {
    if (err !== "cancel") ElMessage.error(err.message || "删除失败");
  }
}

onMounted(load);
</script>

<template>
  <div class="ac-page">
    <!-- 筛选 -->
    <div class="ac-bar">
      <input
        v-model="filters.keyword"
        class="ac-input"
        placeholder="搜索账号 / 昵称 / 邮箱 / 手机号"
        @keyup.enter="load"
      />
      <select v-model="filters.status" class="ac-select" @change="load">
        <option value="">全部状态</option>
        <option value="active">启用</option>
        <option value="disabled">停用</option>
      </select>
      <select v-model="filters.deptId" class="ac-select" @change="load">
        <option value="">全部部门</option>
        <option v-for="d in depts" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <select v-model="filters.roleId" class="ac-select" @change="load">
        <option value="">全部角色</option>
        <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
      </select>
      <button class="ac-btn" @click="load">查询</button>
      <button class="ac-btn-ghost" @click="reset">重置</button>
      <span class="ac-spacer" />
      <span class="ac-total">共 {{ total }} 个账号</span>
      <button v-if="can('admin:account:create')" class="ac-btn-primary" @click="openCreate">
        + 新建账号
      </button>
    </div>

    <!-- 表格 -->
    <div class="ac-table-wrap">
      <table class="ad-table">
        <thead>
          <tr>
            <th>账号</th>
            <th>角色</th>
            <th>部门</th>
            <th>数据范围</th>
            <th>状态</th>
            <th>最后登录</th>
            <th class="ta-r">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="7" class="ad-empty">加载中…</td>
          </tr>
          <tr v-else-if="!rows.length">
            <td colspan="7" class="ad-empty">没有符合条件的账号</td>
          </tr>
          <tr v-for="row in rows" v-else :key="row.id">
            <td>
              <div class="ac-user">
                <span class="ac-avatar">{{ (row.nickname || row.username)[0]?.toUpperCase() }}</span>
                <div>
                  <div class="ac-user-name">{{ row.nickname || row.username }}</div>
                  <div class="ac-user-sub">{{ row.username }}<template v-if="row.email"> · {{ row.email }}</template></div>
                </div>
              </div>
            </td>
            <td>
              <span v-for="(rn, i) in row.roleNames" :key="i" class="ac-tag">{{ rn }}</span>
            </td>
            <td>{{ row.deptName || "-" }}</td>
            <td>
              {{ dataScopes.find((s) => s.value === row.dataScope)?.label || row.dataScope }}
            </td>
            <td>
              <span class="ac-status" :class="row.status">
                {{ row.status === "active" ? "启用" : "停用" }}
              </span>
              <span v-if="row.online" class="ac-online">在线</span>
            </td>
            <td class="ac-mono">{{ row.lastLoginAt ? row.lastLoginAt.slice(0, 16).replace("T", " ") : "从未登录" }}</td>
            <td class="ta-r">
              <div class="ac-actions">
                <button v-if="can('admin:account:edit')" class="ac-act" @click="openEdit(row)">编辑</button>
                <button v-if="can('admin:account:reset')" class="ac-act" @click="doReset(row)">重置密码</button>
                <button v-if="can('admin:account:kick')" class="ac-act" @click="doKick(row)">下线</button>
                <button v-if="can('admin:account:edit')" class="ac-act" @click="toggleStatus(row)">
                  {{ row.status === "active" ? "停用" : "启用" }}
                </button>
                <button v-if="can('admin:account:delete')" class="ac-act danger" @click="doRemove(row)">
                  删除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 新建 / 编辑 -->
    <el-dialog
      v-model="dialogOpen"
      :title="title"
      width="560px"
      class="ac-dialog-box"
      append-to-body
    >
      <div class="ac-form">
        <label class="ac-field">
          <span>账号 <i>*</i></span>
          <input v-model="form.username" :disabled="!!editing" placeholder="登录用户名，创建后不可改" />
        </label>

        <label v-if="!editing" class="ac-field">
          <span>初始密码 <i>*</i></span>
          <input v-model="form.password" type="password" placeholder="至少 6 位" />
        </label>

        <label class="ac-field">
          <span>昵称</span>
          <input v-model="form.nickname" placeholder="显示名称，最多 20 字" maxlength="20" />
        </label>

        <div class="ac-field-row">
          <label class="ac-field">
            <span>邮箱</span>
            <input v-model="form.email" placeholder="选填" />
          </label>
          <label class="ac-field">
            <span>手机号</span>
            <input v-model="form.phone" placeholder="选填，11 位" maxlength="11" />
          </label>
        </div>

        <div class="ac-field-row">
          <label class="ac-field">
            <span>部门</span>
            <select v-model="form.deptId">
              <option value="">未分配</option>
              <option v-for="d in depts" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
          </label>
          <label class="ac-field">
            <span>数据范围</span>
            <select v-model="form.dataScope">
              <option v-for="s in dataScopes" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </label>
        </div>

        <div class="ac-field">
          <span>角色</span>
          <div class="ac-roles">
            <label v-for="r in roles" :key="r.id" class="ac-role">
              <input v-model="form.roleIds" type="checkbox" :value="r.id" />
              <span>{{ r.name }}</span>
            </label>
          </div>
        </div>

        <p class="ac-note">
          数据范围决定该账号在运营系统里能看到哪些账号：全部 / 本部门及子部门 / 仅本人 / 自定义。
        </p>
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
