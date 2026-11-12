<script setup>
/**
 * 技能库面板（Sprint 2 最后一环：让 15 个技能真的能铺到画布上）
 *
 * 数据来自服务端 `/api/skills`（技能定义由服务端权威下发），点击时：
 *   1. 先尝试 `skillPlan`：用户还没来得及传产品图，缺必填参数是**正常的**，
 *      失败不当错误处理，只是拿不到编译后的提示词；
 *   2. `resolveSkillGraph` 决定怎么铺：
 *        template   → 前端已有同名工作流模板（布局最好）
 *        plan       → 用服务端计划的节点图（带编译后的提示词）
 *        definition → 按技能定义铺出结构（等用户拖图进来）
 *   3. 交给画布的**同一个**铺图入口（store.pendingWorkflow / pendingWorkflowGraph）
 *
 * 服务端拉不到时（离线/未登录）**降级到本地 SKILLS**，而不是给用户一个空面板 ——
 * 技能入口是主要导航路径，不能因为一个接口抖动就整块消失。
 */
import { ref, computed, watch } from "vue";
import { ElMessage } from "element-plus";
import { fetchSkills, planSkill } from "../api.js";
import { store, SKILLS, WORKFLOWS, launchSkillGraph } from "../store.js";
import { resolveSkillGraph } from "../skill-graph.js";

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(["update:open", "applied"]);

const loading = ref(false);
const skills = ref([]);
const activeCategory = ref("");
const fromServer = ref(true);
const applying = ref("");

const categories = computed(() => [...new Set(skills.value.map((s) => s.category).filter(Boolean))]);
const listed = computed(() =>
  activeCategory.value ? skills.value.filter((s) => s.category === activeCategory.value) : skills.value
);

/** 归一化本地 SKILLS，让两个来源在模板里长得一样 */
function localSkills() {
  return SKILLS.map((s) => ({
    id: s.id,
    label: s.label,
    desc: s.desc || "",
    category: "本地",
    icon: s.icon || "MagicStick",
    workflow: s.workflow || "",
    inputs: [],
    models: [],
    effectiveCost: null
  }));
}

async function load() {
  if (skills.value.length) return;
  loading.value = true;
  try {
    const data = await fetchSkills();
    const rows = Array.isArray(data?.skills) ? data.skills : [];
    if (!rows.length) throw new Error("技能清单为空");
    skills.value = rows;
    fromServer.value = true;
  } catch {
    // 降级：本地清单至少保证入口可用
    skills.value = localSkills();
    fromServer.value = false;
  } finally {
    loading.value = false;
  }
}

// immediate: true 是必须的 —— 面板可能在挂载前就已是打开状态
// （例如 ?panel=skills 预览、或父组件初始就 open），此时 watch 不 immediate 就永远不会加载，
// 用户看到的就是一个空面板（"全部 0"）。这个 bug 正是靠界面截图发现的。
watch(
  () => props.open,
  (v) => {
    if (v) load();
  },
  { immediate: true }
);

/** 非图片输入的默认值（图片参数留空 → 计划会失败 → 走定义铺图，这是设计内的） */
function defaultParams(skill) {
  const out = {};
  for (const input of skill.inputs || []) {
    if (!input || input.type === "image") continue;
    if (input.defaultValue !== undefined && input.defaultValue !== null && input.defaultValue !== "") {
      out[input.key] = input.defaultValue;
    }
  }
  return out;
}

/**
 * 现在能不能拿到「执行计划」。
 *
 * 必填项（尤其产品图/模特图这类图片）还空着时**不要发这个请求**：
 * 服务端一定会返回 400 MISSING_REQUIRED，于是浏览器控制台多一条红色报错 ——
 * 用户看到红字会以为功能坏了。明知会失败就不打这一枪，
 * 直接走「按技能定义铺图」，用户填完图再点生成时才需要计划。
 */
function canPlan(skill, params) {
  const inputs = Array.isArray(skill?.inputs) ? skill.inputs : [];
  return inputs.every((i) => {
    if (!i?.required) return true;
    const v = params[i.key];
    return v !== undefined && v !== null && v !== "";
  });
}

async function apply(skill) {
  applying.value = skill.id;
  try {
    const params = defaultParams(skill);
    let plan = null;
    if (canPlan(skill, params)) {
      try {
        plan = await planSkill(skill.id, params);
      } catch {
        plan = null; // 参数齐备但计划失败（罕见）→ 仍按定义铺图，不阻塞
      }
    }

    const resolved = resolveSkillGraph(skill, plan, { workflows: WORKFLOWS });
    if (!resolved.ok) {
      ElMessage.warning(resolved.reason || "该技能暂时无法铺到画布");
      return;
    }

    if (resolved.mode === "template") {
      store.route = "studio";
      store.pendingWorkflow = resolved.workflow;
    } else {
      launchSkillGraph(resolved.template);
    }

    emit("applied", { skill, mode: resolved.mode });
    emit("update:open", false);
    const hint =
      resolved.mode === "template"
        ? "已按内置模板铺好"
        : resolved.mode === "plan"
          ? "已铺好节点，提示词已自动编译填入"
          : "已铺好节点，把图拖进来即可开始";
    ElMessage.success(`${skill.label}：${hint}`);
  } finally {
    applying.value = "";
  }
}

function close() {
  emit("update:open", false);
}
</script>

<template>
  <el-drawer
    :model-value="open"
    direction="rtl"
    size="520px"
    :with-header="false"
    class="skills-drawer"
    @update:model-value="(v) => emit('update:open', v)"
    @close="close"
  >
    <div class="sk">
      <header class="sk-head">
        <div>
          <h3>技能库</h3>
          <p>
            选一个场景，直接铺出对应的节点图
            <span v-if="!fromServer" class="sk-degraded">· 服务端不可用，已用本地清单</span>
          </p>
        </div>
        <button class="sk-close" title="关闭" @click="close">✕</button>
      </header>

      <div v-if="loading" class="sk-loading">正在加载技能…</div>

      <template v-else>
        <div class="sk-cats">
          <button class="sk-cat" :class="{ on: !activeCategory }" @click="activeCategory = ''">
            全部 <i>{{ skills.length }}</i>
          </button>
          <button
            v-for="c in categories"
            :key="c"
            class="sk-cat"
            :class="{ on: activeCategory === c }"
            @click="activeCategory = c"
          >
            {{ c }}
          </button>
        </div>

        <div class="sk-list">
          <button
            v-for="s in listed"
            :key="s.id"
            class="sk-card"
            :disabled="applying === s.id"
            @click="apply(s)"
          >
            <span class="sk-card-top">
              <b>{{ s.label }}</b>
              <span v-if="s.effectiveCost != null" class="sk-cost">{{ s.effectiveCost }} 算力</span>
            </span>
            <span class="sk-desc">{{ s.desc }}</span>
            <span class="sk-meta">
              <span v-if="s.category" class="sk-tag">{{ s.category }}</span>
              <span v-if="s.inputs && s.inputs.length" class="sk-tag ghost">{{ s.inputs.length }} 项输入</span>
              <span v-if="s.models && s.models.length" class="sk-tag ghost">{{ s.models[0] }}</span>
              <span v-if="applying === s.id" class="sk-applying">铺图中…</span>
            </span>
          </button>
        </div>

        <p class="sk-foot">
          铺好后在画布上填参数再点生成；提示词会按「参考图角色 + 你的原话」自动编译。
        </p>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.sk {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 4px 2px;
}
.sk-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 4px 14px;
  border-bottom: 1px solid var(--border);
}
.sk-head h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--text);
}
.sk-head p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-3);
}
.sk-degraded {
  color: var(--warning);
}
.sk-close {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-3);
  cursor: pointer;
}
.sk-close:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.sk-loading {
  padding: 32px 4px;
  color: var(--text-3);
  font-size: 13px;
}
.sk-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 4px;
}
.sk-cat {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-3);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition: color 0.16s ease, border-color 0.16s ease;
}
.sk-cat i {
  font-style: normal;
  opacity: 0.6;
}
.sk-cat:hover {
  color: var(--text);
}
.sk-cat.on {
  color: var(--primary);
  border-color: color-mix(in srgb, var(--primary) 45%, transparent);
  background: var(--primary-soft);
}
.sk-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px;
}
.sk-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}
.sk-card:hover:not(:disabled) {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.sk-card:disabled {
  opacity: 0.6;
  cursor: progress;
}
.sk-card-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.sk-card-top b {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.sk-cost {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.sk-desc {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.5;
}
.sk-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.sk-tag {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 11px;
  font-weight: 550;
}
.sk-tag.ghost {
  background: var(--surface-hover);
  color: var(--text-3);
}
.sk-applying {
  font-size: 11px;
  color: var(--text-4);
}
.sk-foot {
  margin: 8px 4px 0;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-4);
}
</style>
