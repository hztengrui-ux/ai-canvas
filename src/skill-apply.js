/**
 * 「把一个技能铺到画布」的统一入口（2026-10-31 抽出）
 *
 * 原来这段逻辑只在技能库抽屉里（SkillsPanel.vue）。现在右侧固定面板（StudioDock.vue）
 * 也要用同一条路径，所以抽成模块 —— 两处都调它，避免"抽屉能铺、面板铺不出来"这种分叉。
 *
 * 决策顺序（和原实现一致）：
 *   template   → 前端已有同名工作流模板（布局最好）
 *   plan       → 服务端编译好的节点图（提示词已填）
 *   definition → 按技能定义铺结构（等用户拖图进来）
 */
import { store, WORKFLOWS, launchSkillGraph } from "./store.js";
import { planSkill } from "./api.js";
import { resolveSkillGraph } from "./skill-graph.js";

/** 非图片输入的默认值；图片参数留空是设计内的（走定义铺图） */
function defaultParams(skill) {
  const out = {};
  for (const input of skill?.inputs || []) {
    if (!input || input.type === "image") continue;
    if (input.defaultValue !== undefined && input.defaultValue !== null && input.defaultValue !== "") {
      out[input.key] = input.defaultValue;
    }
  }
  return out;
}

/** 必填项没齐就不要打计划接口：一定 400，控制台红字会让用户以为坏了 */
function canPlan(skill, params) {
  const inputs = Array.isArray(skill?.inputs) ? skill.inputs : [];
  return inputs.every((i) => {
    if (!i?.required) return true;
    const v = params[i.key];
    return v !== undefined && v !== null && v !== "";
  });
}

/**
 * @param {object} skill 技能对象（服务端下发的或本地 SKILLS 归一化后的）
 * @returns {Promise<{ok:boolean, mode?:string, reason?:string}>}
 */
export async function applySkill(skill) {
  if (!skill || !skill.id) return { ok: false, reason: "技能不存在" };

  const params = defaultParams(skill);
  let plan = null;
  if (canPlan(skill, params)) {
    try {
      plan = await planSkill(skill.id, params);
    } catch {
      plan = null;
    }
  }

  const resolved = resolveSkillGraph(skill, plan, { workflows: WORKFLOWS });
  if (!resolved.ok) return { ok: false, reason: resolved.reason || "该技能暂时无法铺到画布" };

  if (resolved.mode === "template") {
    store.route = "studio";
    store.pendingWorkflow = resolved.workflow;
  } else {
    launchSkillGraph(resolved.template);
  }
  return { ok: true, mode: resolved.mode };
}
