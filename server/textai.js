// 语义处理任务（用 LLM 做"文字上的事"）
//
// 目前两个任务，都是电商出图链路上真会用到、且**不改变**生成结果的辅助动作：
//   1. optimize-prompt  —— 把用户口语需求扩写成结构化提示词（写进提示词框，用户可再改）
//   2. selling-points   —— 从商品描述/标题里提炼卖点（详情页、文案用）
//
// 设计取舍：
//   · 提示词模板写死在服务端，不让前端传 system 消息 —— 否则前端等于有了任意 LLM 代理，
//     被当成免费 API 转发出去，账单会失控。
//   · 返回纯文本、不做 JSON 强校验：不同中转站对 response_format 的支持参差不齐，
//     为了兼容性宁可前端做轻量解析（按行/按「·」切）。
import * as llm from "./providers/llm.js";

const COMMON_RULES = [
  "你是电商视觉团队的资深提示词工程师，服务对象是服装/箱包/家居类目。",
  "只输出最终结果本身：不要解释、不要寒暄、不要 markdown 标记、不要引号包裹。",
  "中文回答。"
].join("\n");

export const TASKS = {
  "optimize-prompt": {
    label: "优化提示词",
    build(text, ctx = {}) {
      const model = String(ctx.model || "").trim();
      const size = String(ctx.size || "").trim();
      const hint = [model ? `目标模型：${model}` : "", size ? `画幅：${size}` : ""].filter(Boolean).join("；");
      return [
        { role: "system", content: `${COMMON_RULES}\n你负责把用户一句口语需求，扩写成可直接用于文生图的中文提示词。` },
        {
          role: "user",
          content: [
            hint ? `（${hint}）` : "",
            "把下面这段需求扩写成一段 80-180 字的中文提示词，必须覆盖：主体与材质、颜色/印花、光线、构图与景别、整体风格。",
            "不要出现「高清」「4K」「大师作品」这类空话；不要写负面词（另有字段处理）。",
            "原始需求：",
            text
          ]
            .filter(Boolean)
            .join("\n")
        }
      ];
    }
  },
  // 强化画面细节：给已有的提示词补上"摄影可执行参数"（镜头/布光/材质/后期），
  // 和 optimize-prompt 的区别：优化是"把口语说清楚"，强化是"把画面拍出来"。
  "strengthen-prompt": {
    label: "强化画面细节",
    build(text, ctx = {}) {
      const model = String(ctx.model || "").trim();
      const size = String(ctx.size || "").trim();
      const hint = [model ? `目标模型：${model}` : "", size ? `画幅：${size}` : ""].filter(Boolean).join("；");
      return [
        {
          role: "system",
          content: `${COMMON_RULES}\n你负责给一段已有的商品图提示词补充摄影级的可执行细节，让它更容易出商业成片。`
        },
        {
          role: "user",
          content: [
            hint ? `（${hint}）` : "",
            "在**保留原意与主体不变**的前提下，补强以下维度（缺什么补什么，不要重复已有的）：",
            "1) 镜头与景别：焦段（如 50mm/85mm）、拍摄距离、主体占画面比例；",
            "2) 布光：主光方向与软硬（如左前 45° 大柔光箱）、补光、背景分离光；",
            "3) 材质与细节：面料纹理、走线、褶皱、反光/哑光；",
            "4) 环境与道具：背景材质、与主体呼应的小道具、地面/台面；",
            "5) 后期与色调：白平衡倾向、对比度、饱和度、是否留白。",
            "输出 100-200 字的中文提示词，一段话、不要分点、不要解释、不要负面词，也不要「高清」「4K」「大师作品」这类空话。",
            "原始提示词：",
            text
          ]
            .filter(Boolean)
            .join("\n")
        }
      ];
    }
  },
  "selling-points": {
    label: "提炼卖点",
    build(text) {
      return [
        { role: "system", content: `${COMMON_RULES}\n你负责从商品文案里提炼可上详情页的卖点。` },
        {
          role: "user",
          content: [
            "从下面的商品描述里提炼 3-5 条卖点，每条不超过 14 个字，从「· 」开头，每条单独一行。",
            "优先提炼：面料/工艺、版型修饰、场景适配、易打理。不要编造原文里没有的信息。",
            "商品描述：",
            text
          ].join("\n")
        }
      ];
    }
  },
  "translate-prompt": {
    label: "翻成英文提示词",
    build(text) {
      return [
        { role: "system", content: "你是电商视觉提示词翻译。只输出英文提示词本身，用逗号分隔的关键词，不要解释。" },
        { role: "user", content: `把这个中文需求翻成英文文生图提示词（保留商品细节，不要删减）：\n${text}` }
      ];
    }
  }
};

export const MAX_INPUT_CHARS = 4000;

/** 任务是否受支持 */
export function hasTask(task) {
  return Object.prototype.hasOwnProperty.call(TASKS, String(task || ""));
}

/**
 * 执行一个语义任务。
 * @returns {Promise<{text: string, model: string, usage: object, task: string}>}
 */
export async function run(task, text, { context = {}, signal, onProgress } = {}) {
  const def = TASKS[String(task || "")];
  if (!def) throw new Error(`不支持的任务：${task}`);
  const input = String(text || "").trim();
  if (!input) throw new Error("内容不能为空");
  if (input.length > MAX_INPUT_CHARS) throw new Error(`内容过长（上限 ${MAX_INPUT_CHARS} 字）`);

  const { loadConfig } = await import("./config.js");
  const cfg = loadConfig();
  const r = await llm.chat({
    messages: def.build(input, context),
    temperature: cfg.llm?.temperature,
    maxTokens: cfg.llm?.maxTokens,
    signal,
    onProgress
  });
  return { task, ...r };
}
