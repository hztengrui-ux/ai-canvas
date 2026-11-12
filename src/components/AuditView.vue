<script setup>
import { ref, computed, onMounted } from "vue";
import { fetchAudit, fetchAuditStats } from "../api.js";

const loading = ref(true);
const events = ref([]);
const stats = ref({ total: 0, byLevel: {}, byType: {} });
const level = ref("");
const days = ref(7);

const LEVEL_LABEL = { info: "正常", warn: "注意", danger: "风险" };

const filtered = computed(() =>
  level.value ? events.value.filter((e) => e.level === level.value) : events.value
);

async function load() {
  loading.value = true;
  try {
    const [a, s] = await Promise.all([
      fetchAudit({ limit: 200, days: days.value }),
      fetchAuditStats(days.value)
    ]);
    events.value = a.events || [];
    stats.value = s || stats.value;
  } catch {
    events.value = [];
  } finally {
    loading.value = false;
  }
}

function fmtTime(ts) {
  try {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return ts;
  }
}

function detailText(e) {
  const d = e.detail || {};
  const parts = [];
  if (d.reason) parts.push(d.reason);
  if (d.path) parts.push(d.path);
  if (d.provider) parts.push(d.provider);
  if (d.model) parts.push(d.model);
  if (d.count != null) parts.push(`${d.count} 项`);
  if (d.size) parts.push(d.size);
  if (d.providers?.length) parts.push(d.providers.join("/"));
  return parts.join(" · ");
}

onMounted(load);
</script>

<template>
  <div class="audit-page">
    <div class="audit-inner">
      <div class="audit-head">
        <div>
          <h1 class="audit-title">安全记录</h1>
          <p class="audit-sub">登录登出、账号变更与生成操作留痕，保留最近 30 天</p>
        </div>
        <div class="audit-actions">
          <select v-model.number="days" class="audit-select" @change="load">
            <option :value="1">今天</option>
            <option :value="7">近 7 天</option>
            <option :value="30">近 30 天</option>
          </select>
          <button class="audit-refresh" @click="load">刷新</button>
        </div>
      </div>

      <div class="audit-stats">
        <div class="audit-stat">
          <span class="audit-stat-num">{{ stats.total }}</span>
          <span class="audit-stat-label">全部事件</span>
        </div>
        <div class="audit-stat">
          <span class="audit-stat-num">{{ stats.byLevel?.info || 0 }}</span>
          <span class="audit-stat-label">正常</span>
        </div>
        <div class="audit-stat">
          <span class="audit-stat-num warn">{{ stats.byLevel?.warn || 0 }}</span>
          <span class="audit-stat-label">注意</span>
        </div>
        <div class="audit-stat">
          <span class="audit-stat-num danger">{{ stats.byLevel?.danger || 0 }}</span>
          <span class="audit-stat-label">风险</span>
        </div>
      </div>

      <div class="audit-filters">
        <button :class="{ on: level === '' }" @click="level = ''">全部</button>
        <button :class="{ on: level === 'info' }" @click="level = 'info'">正常</button>
        <button :class="{ on: level === 'warn' }" @click="level = 'warn'">注意</button>
        <button :class="{ on: level === 'danger' }" @click="level = 'danger'">风险</button>
      </div>

      <div class="audit-list">
        <div v-if="loading" class="sk-rows">
          <div v-for="i in 6" :key="i" class="sk-row">
            <div class="sk sk-dot"></div>
            <div class="sk sk-line" style="width: 120px"></div>
            <div class="sk sk-line" style="flex: 1"></div>
            <div class="sk sk-line" style="width: 70px"></div>
          </div>
        </div>
        <div v-else-if="!filtered.length" class="audit-empty">暂无记录</div>
        <div v-for="(e, i) in filtered" :key="i" class="audit-row" :class="e.level">
          <span class="audit-badge">{{ LEVEL_LABEL[e.level] || e.level }}</span>
          <span class="audit-label">{{ e.label }}</span>
          <span class="audit-detail">{{ detailText(e) }}</span>
          <span class="audit-user">{{ e.user }}</span>
          <span class="audit-time">{{ fmtTime(e.ts) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
