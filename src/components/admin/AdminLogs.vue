<script setup>
// 日志审计
import { ref, reactive, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { fetchAdminLogs } from "../../api.js";

const loading = ref(false);
const events = ref([]);
const filters = reactive({ level: "", days: 7 });

const LEVEL_LABEL = { info: "正常", warn: "注意", danger: "风险" };

async function load() {
  loading.value = true;
  try {
    const r = await fetchAdminLogs({ limit: 300, ...filters });
    events.value = r.events || [];
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    loading.value = false;
  }
}

function detailText(e) {
  const d = e.detail || {};
  const parts = [];
  if (d.action) parts.push(d.action);
  if (d.target) parts.push(`目标 ${d.target}`);
  if (d.reason) parts.push(d.reason);
  if (d.path) parts.push(d.path);
  if (d.sessions != null) parts.push(`${d.sessions} 个会话`);
  return parts.join(" · ");
}

function fmt(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

onMounted(load);
</script>

<template>
  <div class="ad2-page">
    <div class="ac-bar">
      <select v-model="filters.level" class="ac-select" @change="load">
        <option value="">全部级别</option>
        <option value="info">正常</option>
        <option value="warn">注意</option>
        <option value="danger">风险</option>
      </select>
      <select v-model.number="filters.days" class="ac-select" @change="load">
        <option :value="1">今天</option>
        <option :value="7">近 7 天</option>
        <option :value="30">近 30 天</option>
      </select>
      <button class="ac-btn" @click="load">刷新</button>
      <span class="ac-spacer" />
      <span class="ac-total">{{ events.length }} 条记录</span>
    </div>

    <div class="ac-table-wrap">
      <table class="ad-table">
        <thead>
          <tr>
            <th style="width: 64px">级别</th>
            <th style="width: 96px">事件</th>
            <th>详情</th>
            <th style="width: 110px">操作人</th>
            <th style="width: 120px">来源 IP</th>
            <th style="width: 150px">时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="6" class="ad-empty">加载中…</td>
          </tr>
          <tr v-else-if="!events.length">
            <td colspan="6" class="ad-empty">该时间段暂无记录</td>
          </tr>
          <tr v-for="(e, i) in events" v-else :key="i">
            <td><span class="ac-status" :class="e.level === 'info' ? 'active' : e.level">{{ LEVEL_LABEL[e.level] || e.level }}</span></td>
            <td>{{ e.label }}</td>
            <td class="ac-dim">{{ detailText(e) || "-" }}</td>
            <td>{{ e.user }}</td>
            <td class="ac-mono ac-dim">{{ e.ip || "-" }}</td>
            <td class="ac-mono ac-dim">{{ fmt(e.ts) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
