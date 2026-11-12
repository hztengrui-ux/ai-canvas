<script setup>
/**
 * 影像审阅视图 / 系列策展视图（补齐差距 D2 / D3）
 *
 * 现状：结果只存在于画布上的 ResultNode 小图里，既不能跨节点对比，也不能成套导出。
 * 方案 §4 要求两种视图：
 *   - 影像审阅：单张大图 + 参数回看
 *   - 系列策展：成套网格 + 排序 + 批量导出
 *
 * 这里合并成一个页面，用「网格 / 对比」两个模式切换，避免维护两套几乎一样的列表逻辑。
 * 数据源是 store.assets（每次生成完成由 project.addAsset 落库，持久化到 localStorage）。
 */
import { ref, computed, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { store, bridge } from "../store.js";
import { loadAssets, removeAsset } from "../project.js";
import { downloadMany, downloadZip, downloadUrl, assetName } from "../exportkit.js";

const mode = ref("grid"); // grid | compare
const keyword = ref("");
const kindFilter = ref("all"); // all | image | video
const modelFilter = ref("all");
const picked = ref([]); // 选中的 asset id
const lightbox = ref(null);
const exporting = ref(false);

const assets = computed(() => store.assets || []);

const models = computed(() => {
  const s = new Set(assets.value.map((a) => a.model).filter(Boolean));
  return [...s];
});

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return assets.value.filter((a) => {
    if (kindFilter.value !== "all" && a.kind !== kindFilter.value) return false;
    if (modelFilter.value !== "all" && a.model !== modelFilter.value) return false;
    if (kw && !String(a.prompt || "").toLowerCase().includes(kw) && !String(a.model || "").toLowerCase().includes(kw)) return false;
    return true;
  });
});

const compareList = computed(() =>
  picked.value
    .map((id) => assets.value.find((a) => a.id === id))
    .filter(Boolean)
    .slice(0, 4)
);

const allPicked = computed(() => filtered.value.length > 0 && picked.value.length === filtered.value.length);

function togglePick(id) {
  const i = picked.value.indexOf(id);
  if (i >= 0) picked.value.splice(i, 1);
  else if (picked.value.length >= 4) {
    ElMessage.warning("对比最多 4 张，导出请先取消部分选择");
    return;
  } else picked.value.push(id);
}

function toggleAll() {
  picked.value = allPicked.value ? [] : filtered.value.slice(0, 4).map((a) => a.id);
}

function openLightbox(a) {
  lightbox.value = a;
}

function closeLightbox() {
  lightbox.value = null;
}

function stepLightbox(dir) {
  const list = filtered.value;
  const i = list.findIndex((a) => a.id === lightbox.value?.id);
  if (i < 0) return;
  const next = (i + dir + list.length) % list.length;
  lightbox.value = list[next];
}

async function exportPicked() {
  const items = picked.value.length
    ? picked.value.map((id) => assets.value.find((a) => a.id === id)).filter(Boolean)
    : filtered.value;
  if (!items.length) return ElMessage.warning("没有可导出的内容");

  exporting.value = true;
  try {
    const n = await downloadMany(items.map((a) => ({ url: a.url })), { prefix: store.projectName });
    ElMessage.success(`已开始下载 ${n} 个文件`);
  } catch (e) {
    ElMessage.error(e?.message || "导出失败");
  } finally {
    exporting.value = false;
  }
}

async function exportZip() {
  const items = picked.value.length
    ? picked.value.map((id) => assets.value.find((a) => a.id === id)).filter(Boolean)
    : filtered.value;
  if (!items.length) return ElMessage.warning("没有可打包的内容");

  exporting.value = true;
  try {
    const n = await downloadZip(items.map((a) => ({ url: a.url })), { prefix: store.projectName });
    ElMessage.success(`已打包 ${n} 个文件`);
  } catch (e) {
    ElMessage.error(e?.message || "打包失败");
  } finally {
    exporting.value = false;
  }
}

async function dropAsset(id) {
  try {
    await ElMessageBox.confirm("从作品库中移除这条记录？不会删除服务器上的原文件。", "移除", {
      confirmButtonText: "移除",
      cancelButtonText: "取消"
    });
  } catch {
    return;
  }
  removeAsset(id);
  picked.value = picked.value.filter((x) => x !== id);
  if (lightbox.value?.id === id) lightbox.value = null;
}

function focusInCanvas(a) {
  if (!a.nodeId) return ElMessage.info("这条结果没有关联画布节点");
  bridge.focusNode?.(a.nodeId);
  store.route = "studio";
}

function dateText(ts) {
  const d = new Date(ts || Date.now());
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

onMounted(() => {
  loadAssets();
});
</script>

<template>
  <div class="review">
    <header class="review-head">
      <div>
        <h2 class="review-title">作品库</h2>
        <div class="review-sub">共 {{ assets.length }} 条结果 · 本次筛选出 {{ filtered.length }} 条</div>
      </div>
      <div class="review-modes">
        <button class="rm-btn" :class="{ on: mode === 'grid' }" @click="mode = 'grid'">网格</button>
        <button class="rm-btn" :class="{ on: mode === 'compare' }" @click="mode = 'compare'">对比</button>
      </div>
    </header>

    <div class="review-bar">
      <input v-model="keyword" class="rv-input" placeholder="搜索提示词或模型" />
      <select v-model="kindFilter" class="rv-select">
        <option value="all">全部类型</option>
        <option value="image">图片</option>
        <option value="video">视频</option>
      </select>
      <select v-model="modelFilter" class="rv-select">
        <option value="all">全部模型</option>
        <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
      </select>
      <div class="rv-spacer" />
      <button class="rv-btn" :disabled="!filtered.length" @click="toggleAll">
        {{ allPicked ? "取消全选" : "选择前 4 张" }}
      </button>
      <button class="rv-btn" :disabled="!filtered.length || exporting" @click="exportPicked">下载</button>
      <button class="rv-btn primary" :disabled="!filtered.length || exporting" @click="exportZip">打包 ZIP</button>
    </div>

    <!-- 网格：系列策展 -->
    <div v-if="mode === 'grid'" class="review-grid">
      <div
        v-for="a in filtered"
        :key="a.id"
        class="rv-card"
        :class="{ picked: picked.includes(a.id) }"
        @click="togglePick(a.id)"
      >
        <div class="rv-thumb">
          <img v-if="a.kind === 'video'" :src="a.url" alt="" />
          <img v-else :src="a.url" alt="" loading="lazy" />
          <span class="rv-kind">{{ a.kind === 'video' ? '视频' : '图片' }}</span>
          <span v-if="picked.includes(a.id)" class="rv-check">✓</span>
        </div>
        <div class="rv-meta">
          <div class="rv-model">{{ a.model || "未记录模型" }}</div>
          <div class="rv-prompt">{{ a.prompt || "—" }}</div>
          <div class="rv-foot">
            <span>{{ dateText(a.ts) }}</span>
            <span v-if="a.cost">{{ a.cost }} 点</span>
          </div>
        </div>
        <div class="rv-ops">
          <button @click.stop="openLightbox(a)">查看</button>
          <button @click.stop="() => downloadUrl(a.url, assetName(1, 'png', store.projectName))">下载</button>
          <button v-if="a.nodeId" @click.stop="focusInCanvas(a)">定位</button>
          <button class="danger" @click.stop="dropAsset(a.id)">移除</button>
        </div>
      </div>

      <div v-if="!filtered.length" class="review-empty">
        <div class="re-title">还没有作品</div>
        <div class="re-sub">去创作台跑一次生成，结果会自动进这里</div>
        <button class="rv-btn primary" @click="store.route = 'studio'">进入创作台</button>
      </div>
    </div>

    <!-- 对比：影像审阅 -->
    <div v-else class="review-compare">
      <div v-if="compareList.length" class="rc-row">
        <div v-for="a in compareList" :key="a.id" class="rc-item">
          <img :src="a.url" alt="" />
          <div class="rc-cap">
            <b>{{ a.model || "—" }}</b>
            <span>{{ a.prompt || "—" }}</span>
          </div>
        </div>
      </div>
      <div v-else class="review-empty">
        <div class="re-title">先选几张来对比</div>
        <div class="re-sub">在网格里点选 2–4 张，这里会并排显示</div>
        <button class="rv-btn" @click="mode = 'grid'">回到网格</button>
      </div>
    </div>

    <!-- 大图查看 -->
    <div v-if="lightbox" class="rv-lightbox" @click.self="closeLightbox">
      <button class="rv-lb-close" @click="closeLightbox">×</button>
      <button class="rv-lb-nav prev" @click.stop="stepLightbox(-1)">‹</button>
      <img :src="lightbox.url" alt="" />
      <button class="rv-lb-nav next" @click.stop="stepLightbox(1)">›</button>
      <div class="rv-lb-cap">
        <b>{{ lightbox.model || "—" }}</b>
        <span>{{ lightbox.prompt || "—" }}</span>
      </div>
    </div>
  </div>
</template>
