<script setup>
// 客户端密钥（桌面端 API Key）
import { ref, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { fetchApiKeys, rotateApiKey } from "../../api.js";

const props = defineProps({ perms: { type: Array, default: () => [] } });
const can = (c) => props.perms.includes(c);

const loading = ref(false);
const rows = ref([]);
const plain = ref("");

async function load() {
  loading.value = true;
  try {
    const r = await fetchApiKeys();
    rows.value = r.rows || [];
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}

async function doRotate(row) {
  try {
    await ElMessageBox.confirm(
      "轮换后旧密钥立即失效，所有桌面端需重新配置新密钥才能连接。",
      "轮换密钥",
      { type: "warning", confirmButtonText: "确认轮换", cancelButtonText: "取消" }
    );
    const r = await rotateApiKey(row.id);
    plain.value = r.plain;
    ElMessage.success("已生成新密钥，请立即复制保存");
    load();
  } catch (err) {
    if (err !== "cancel") ElMessage.error(err.message || "轮换失败");
  }
}

function copy() {
  navigator.clipboard?.writeText(plain.value);
  ElMessage.success("已复制到剪贴板");
}

function fmt(ts) {
  return ts ? ts.slice(0, 16).replace("T", " ") : "—";
}

onMounted(load);
</script>

<template>
  <div class="ad2-page">
    <div class="ak-intro">
      <strong>客户端密钥用于识别合法的桌面端程序</strong>
      <p>
        密钥只以 SHA-256 哈希形式存储，<b>明文仅在生成时展示一次</b>。
        轮换后旧密钥立即失效，可用于应对密钥泄露。
      </p>
    </div>

    <div v-if="plain" class="ak-plain">
      <div class="ak-plain-head">
        <span>新密钥（仅此一次展示）</span>
        <button class="ac-act" @click="copy">复制</button>
      </div>
      <code>{{ plain }}</code>
    </div>

    <div class="ac-table-wrap">
      <table class="ad-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>前缀</th>
            <th>状态</th>
            <th>最近使用</th>
            <th>上次轮换</th>
            <th class="ta-r">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="6" class="ad-empty">加载中…</td>
          </tr>
          <tr v-for="row in rows" v-else :key="row.id">
            <td>{{ row.name }}</td>
            <td class="ac-mono">{{ row.prefix }}</td>
            <td>
              <span class="ac-status" :class="row.status === 'active' ? 'active' : 'disabled'">
                {{ row.status === "active" ? "启用" : "停用" }}
              </span>
            </td>
            <td class="ac-dim ac-mono">{{ fmt(row.lastUsedAt) }}</td>
            <td class="ac-dim ac-mono">{{ fmt(row.rotatedAt) }}</td>
            <td class="ta-r">
              <button v-if="can('admin:apikey:rotate')" class="ac-act" @click="doRotate(row)">
                轮换密钥
              </button>
              <span v-else class="ac-dim">无权限</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
