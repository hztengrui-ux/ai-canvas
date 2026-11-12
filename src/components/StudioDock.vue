<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { ElMessage } from "element-plus";
import { store, SKILLS, IMAGE_MODELS, RESOLUTIONS, costLabelOf, modelById } from "../store.js";
import { fetchSkills } from "../api.js";
import { applySkill } from "../skill-apply.js";
import AgentChat from "./AgentChat.vue";
import InspectorPanel from "./InspectorPanel.vue";

// 画幅比例：store 里的 RATIOS_5 没有导出（内部常量），这里按同一口径列一遍
const RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

// open-chat：画布上原来的「对话」浮钮已删除，统一由这里的 Agent Tab 打开
const emit = defineEmits(["close", "open-all", "open-chat"]);

const tab = ref("skill"); // skill | agent | inspector
// 属性页只在画布里有选中时出现；没选中时自动退回技能页，避免一个空 Tab 白占位置
const hasSelection = computed(() => store.selection.length > 0);
watch(
  () => store.selection.length,
  (n, prev) => {
    if (n > 0 && !prev) tab.value = "inspector";
    else if (n === 0 && tab.value === "inspector") tab.value = "skill";
  }
);
const skills = ref([]);
const skillId = ref("");
const skillOpen = ref(false);
const modelId = ref("seedream-5-pro");
const ratio = ref("3:4");
const resolution = ref("2K");
const note = ref("");
const agentText = ref("");
const refs = ref([null, null, null]);

const skill = computed(() => skills.value.find((s) => s.id === skillId.value) || skills.value[0] || {});
// 分类 → 图标：服务端技能没有 icon 字段，全用 MagicStick 会让每一行长得一样
const CATEGORY_ICON = {
  换装: "Avatar",
  商品图: "Picture",
  人像: "User",
  视频: "VideoCamera",
  批量: "Files",
  工具: "Tools",
  本地: "MagicStick"
};
function iconOf(s) {
  return s.icon || CATEGORY_ICON[s.category] || "MagicStick";
}

// 按分类分组（参考站的下拉就是分组 + 图标 + 勾选，不是一列纯文字）
const groupedSkills = computed(() => {
  const order = [];
  const map = new Map();
  for (const s of skills.value) {
    const key = s.category || "全部技能";
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key).push(s);
  }
  return order.map((name) => ({ name, items: map.get(name) }));
});

// 服务端拉不到时的本地降级（和技能库抽屉同一策略：入口不能整块消失）
function localSkills() {
  return SKILLS.map((s) => ({
    id: s.id,
    label: s.label,
    desc: s.desc || "",
    icon: s.icon || "MagicStick",
    workflow: s.workflow || "",
    inputs: [],
    models: [],
    effectiveCost: null
  }));
}
onMounted(async () => {
  try {
    const data = await fetchSkills();
    const rows = Array.isArray(data?.skills) ? data.skills : [];
    skills.value = rows.length ? rows : localSkills();
  } catch {
    skills.value = localSkills();
  }
  if (!skillId.value) skillId.value = skills.value[0]?.id || "";
});
const modelOptions = computed(() =>
  (IMAGE_MODELS || []).filter((m) => !m.hidden).map((m) => ({ id: m.id, label: m.label, group: m.group }))
);
const cost = computed(() => costLabelOf(modelId.value) || `${modelById(modelId.value)?.cost ?? 10} 算力/次`);

// 参考稿的「使用模板 / 品类」是同一行两个下拉；我们这两项各自对应已有入口
const CATEGORIES = ["不限", "模特", "服装", "商品", "场景", "详情页"];
const category = ref("不限");
const templatePick = ref("从模板库选择…");

function pickRef(i) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = false;
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      refs.value[i] = { name: file.name, url: String(reader.result || "") };
      ElMessage.success(`已载入 ${file.name}；把它拖进画布即可作为参考图`);
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

function clearRef(i) {
  refs.value[i] = null;
}

const QUICK = [
  { key: "model", label: "换模特", icon: "Avatar", option: "clothes-model" },
  { key: "scene", label: "换场景", icon: "Picture", option: "custom-scene" },
  { key: "layout", label: "换构图", icon: "Grid", option: "pose-split" }
];

function quick(k) {
  const opt = k.key === "model" ? "clothes-model" : k.key === "scene" ? "custom-scene" : "pose-split";
  launchSkill(opt);
  ElMessage.success(`${k.label}：已把对应工作流铺到画布`);
}

async function generate() {
  if (tab.value === "agent") {
    if (!agentText.value.trim()) {
      ElMessage.warning("先描述一下你想做什么");
      return;
    }
    const fallback = skills.value.find((s) => /文生图|图生图|影棚/.test(s.label)) || skills.value[0];
    if (!fallback) {
      ElMessage.warning("技能清单还没加载好，稍后再试");
      return;
    }
    const r = await applySkill(fallback);
    if (r.ok) ElMessage.success("已按你的描述铺好工作流");
    return;
  }
  const r = await applySkill(skill.value);
  if (!r.ok) {
    ElMessage.warning(r.reason || "这个技能暂时铺不出来");
    return;
  }
  ElMessage.success(`${skill.value.label || "技能"}：已铺好节点${note.value.trim() ? "，补充说明已记录" : ""}`);
}

// 外层（快捷键/顶栏）要打开对话时调它，避免再引一套弹层
defineExpose({
  showAgent() {
    tab.value = "agent";
  }
});

function chooseSkill(s) {
  skillId.value = s.id;
  if (s.model) modelId.value = s.model;
  skillOpen.value = false;
}

// 切技能时跟随它的默认模型（有就跟着走，没有就保持用户选择）
// 服务端技能带 models 列表时，默认选第一个可用模型
watch(skill, (s) => {
  const first = Array.isArray(s?.models) ? s.models[0] : "";
  if (first && IMAGE_MODELS.some((m) => m.id === first)) modelId.value = first;
});
</script>

<template>
  <aside class="studio-dock">
    <!-- 顶部：Agent | 技能 -->
    <header class="dock-tabs">
      <button class="dock-tab" :class="{ on: tab === 'agent' }" @click="tab = 'agent'; emit('open-chat')">
        <el-icon><ChatDotRound /></el-icon>
        <span>Agent</span>
      </button>
      <button class="dock-tab" :class="{ on: tab === 'skill' }" @click="tab = 'skill'">
        <el-icon><Operation /></el-icon>
        <span>技能</span>
      </button>
      <button v-if="hasSelection" class="dock-tab" :class="{ on: tab === 'inspector' }" @click="tab = 'inspector'">
        <el-icon><Setting /></el-icon>
        <span>属性</span>
      </button>
      <button class="dock-close" title="收起面板" @click="emit('close')">✕</button>
    </header>

    <div class="dock-body">
      <!-- ---------- 技能页 ---------- -->
      <template v-if="tab === 'skill'">
        <!-- 当前技能 -->
<el-popover
          v-model:visible="skillOpen"
          placement="bottom-start"
          :width="308"
          trigger="click"
          popper-class="dock-skill-pop"
          :show-arrow="false"
          :offset="8"
        >
          <template #reference>
            <button class="dock-skill-head">
              <span class="dock-skill-icon"><el-icon><component :is="skill.icon || 'MagicStick'" /></el-icon></span>
              <b>{{ skill.label || "选择技能" }}</b>
              <el-icon class="dock-caret"><ArrowDown /></el-icon>
            </button>
          </template>

          <div class="skill-menu">
            <div class="skill-menu-scroll">
              <template v-for="group in groupedSkills" :key="group.name">
                <div class="skill-menu-group">{{ group.name }}</div>
                <button
                  v-for="s in group.items"
                  :key="s.id"
                  class="skill-menu-row"
                  :class="{ on: s.id === skillId }"
                  @click="chooseSkill(s)"
                >
                  <span class="skill-menu-ic"><el-icon><component :is="iconOf(s)" /></el-icon></span>
                  <span class="skill-menu-text">
                    <b>{{ s.label }}</b>
                    <em>{{ s.desc || s.category || "" }}</em>
                  </span>
                  <el-icon v-if="s.id === skillId" class="skill-menu-check"><Check /></el-icon>
                </button>
              </template>
            </div>
            <button class="skill-menu-all" @click="emit('open-all')">
              <el-icon><Grid /></el-icon>
              <span>查看全部技能（含模型与输入项）</span>
            </button>
          </div>
        </el-popover>

        <!-- 使用模板 / 品类选择 -->
        <div class="dock-two">
          <button class="dock-chip-btn" @click="store.route = 'templates'">
            <el-icon><FolderOpened /></el-icon>
            <span>使用模板</span>
          </button>
          <el-select v-model="category" class="dock-mini" size="small" placeholder="品类选择">
            <el-option v-for="c in CATEGORIES" :key="c" :label="c" :value="c" />
          </el-select>
        </div>

        <!-- 产品图片 -->
        <section class="dock-sec">
          <h4>产品图片</h4>
          <div class="dock-uploads">
            <button class="dock-upload" :class="{ filled: refs[0] }" @click="pickRef(0)">
              <template v-if="refs[0]">
                <img :src="refs[0].url" alt="" />
                <i class="dock-upload-x" @click.stop="clearRef(0)">✕</i>
              </template>
              <template v-else>
                <span class="dock-upload-plus"><el-icon><Upload /></el-icon></span>
                <em>主视角</em>
                <i class="dock-req">*</i>
              </template>
            </button>
            <button v-for="i in [1, 2]" :key="i" class="dock-upload" :class="{ filled: refs[i] }" @click="pickRef(i)">
              <template v-if="refs[i]">
                <img :src="refs[i].url" alt="" />
                <i class="dock-upload-x" @click.stop="clearRef(i)">✕</i>
              </template>
              <template v-else>
                <span class="dock-upload-plus"><el-icon><Upload /></el-icon></span>
                <em>补充(选填)</em>
              </template>
            </button>
          </div>
        </section>

        <!-- 素材选择 -->
        <section class="dock-sec">
          <div class="dock-sec-head">
            <h4>素材选择</h4>
            <button class="dock-link" @click="emit('open-all')">我的方案</button>
          </div>
          <div class="dock-quick">
            <button v-for="q in QUICK" :key="q.key" class="dock-quick-btn" @click="quick(q)">
              <span class="dock-quick-ic"><el-icon><component :is="q.icon" /></el-icon></span>
              <em>{{ q.label }}</em>
            </button>
          </div>
        </section>

        <!-- 补充说明 -->
        <section class="dock-sec">
          <h4>补充说明（选填）</h4>
          <el-input v-model="note" type="textarea" :rows="2" resize="none" placeholder="请输入补充说明" />
        </section>

        <!-- 模型 -->
        <section class="dock-sec">
          <h4>图片模型</h4>
          <el-select v-model="modelId" class="dock-select">
            <el-option v-for="m in modelOptions" :key="m.id" :label="m.label" :value="m.id" />
          </el-select>
        </section>

        <!-- 比例 / 分辨率 -->
        <div class="dock-two dock-two-sec">
          <label class="dock-field">
            <span>图片比例</span>
            <el-select v-model="ratio" size="small">
              <el-option v-for="r in RATIOS" :key="r" :label="r" :value="r" />
            </el-select>
          </label>
          <label class="dock-field">
            <span>分辨率</span>
            <el-select v-model="resolution" size="small">
              <el-option v-for="r in RESOLUTIONS" :key="r" :label="r" :value="r" />
            </el-select>
          </label>
        </div>
      </template>

      <!-- ---------- Agent 页：直接内联对话（不再弹抽屉） ---------- -->
      <AgentChat v-if="tab === 'agent'" />

      <!-- ---------- 属性页：原独立属性栏，合并进同一面板 ---------- -->
      <InspectorPanel v-else-if="tab === 'inspector'" embedded />
    </div>

    <!-- 底部：消耗 + 生成（属性页不需要） -->
    <footer v-if="tab !== 'inspector'" class="dock-foot">
      <div class="dock-cost">
        <span>消耗积分</span>
        <b>{{ cost }}</b>
      </div>
      <button v-if="tab === 'skill'" class="dock-generate" @click="generate">立即生成</button>
    </footer>
  </aside>
</template>
