<script setup>
/**
 * 独立窗口页面（双屏 / 多屏模式）
 *
 * 通过 StudioView 属性栏的「弹出独立窗口」打开（Electron 里是真正的原生窗口，
 * 浏览器里是新标签页），可拖到第二块屏幕上大图查看生成结果。
 * 数据来自主窗口的 BroadcastChannel 广播（见 popoutBus.js），本页不直接调业务接口。
 */
import { ref, onMounted, onUnmounted } from "vue";
import { onPopout, sendPopout } from "../popoutBus.js";
import { applyDark } from "../theme.js";

const st = ref(null);
const connected = ref(false);

let off = () => {};
onMounted(() => {
  off = onPopout((msg) => {
    if (msg?.type !== "state") return;
    st.value = msg.payload;
    connected.value = true;
    // 跟随主窗口的明暗模式（独立窗口不共享 store）
    applyDark(Boolean(msg.payload?.dark));
  });
  // 告诉主窗口「我准备好了」，主窗口会补发一次当前状态
  sendPopout({ type: "ready" });
});
onUnmounted(() => off());

function openImage(url) {
  window.open(url, "_blank");
}
</script>

<template>
  <div class="pop-wrap">
    <header class="pop-head">
      <span class="pop-dot" :class="{ on: connected }" />
      <div class="pop-title">
        <div class="pop-name">{{ st?.title || "生成结果" }}</div>
        <div class="pop-sub">{{ connected ? "已连接主窗口 · 实时同步" : "等待主窗口连接…" }}</div>
      </div>
    </header>

    <!-- 空态：主窗口还没有选中结果节点 -->
    <div v-if="!st" class="pop-empty">
      <el-icon><Monitor /></el-icon>
      <p>在主窗口选中一个「生成结果」节点，<br />大图会同步到这里。</p>
    </div>

    <template v-else>
      <div v-if="st.images?.length" class="pop-grid">
        <figure v-for="(u, i) in st.images" :key="i" class="pop-img" @click="openImage(u)">
          <img :src="u" alt="" loading="lazy" />
          <figcaption>点击查看原图</figcaption>
        </figure>
      </div>
      <div v-else class="pop-empty small">
        <p>该节点暂无图片</p>
      </div>

      <video
        v-for="(v, i) in st.videos"
        :key="'v' + i"
        class="pop-video"
        :src="v.url || v"
        controls
        playsinline
      />

      <section v-if="st.lineage" class="pop-meta">
        <div class="pop-meta-title">来源信息</div>
        <div class="pop-prompt">{{ st.lineage.prompt || "（当时没有填写提示词）" }}</div>
        <dl class="pop-kv">
          <div v-if="st.lineage.model || st.lineage.provider"><dt>模型</dt><dd>{{ st.lineage.model || st.lineage.provider }}</dd></div>
          <div v-if="st.lineage.size"><dt>画幅</dt><dd>{{ st.lineage.size }}</dd></div>
          <div v-if="st.lineage.seed != null"><dt>种子</dt><dd>{{ st.lineage.seed }}</dd></div>
          <div v-if="st.lineage.createdAt"><dt>生成于</dt><dd>{{ st.when }}</dd></div>
        </dl>
      </section>
    </template>
  </div>
</template>
