/**
 * 技能库（Sprint 2 · 服务端权威）
 * ==========================================================================
 * 背景：前端 src/store.js 的 SKILLS 只是「左侧栏入口」——它决定按钮长什么样、点一下铺哪套
 * Vue Flow 模板。但「技能要哪些参数、参数怎么变成提示词、用哪个模型、花多少算力」以前散在
 * 前端各处，加一个技能要两边改，且服务端被直接调用（HTTP / 批量 / 一键成片）时无法判断入参。
 * 所以这里建服务端权威技能库，只做三件事，正好对应三组导出：
 *   ① 定义 —— SKILLS：分类 + 入口元信息 + 参数表 + 提示词链 + 默认画幅
 *   ② 校验 —— validateSkillInput：把脏参数收敛成确定性的归一化参数
 *   ③ 装配 —— buildSkillPrompt / skillPlan：提示词交给 compiler，铺图交给前端
 *
 * 三条「为什么这么设计」：
 *
 * ① 为什么提示词链是结构化的 chain，而不是一段拼接模板？
 *    提示词的正确性由 server/prompt/compiler.js 负责：角色锚点（图N 是什么）、不变量
 *    （不得改色 / 不得虚构）、图内文字防注入、4000 字硬上限、按优先级裁剪。技能库若自己拼
 *    最终文案，就等于在 compiler 之外又开第二个真相 —— 注入防御被绕过，硬上限也不再成立。
 *    所以技能只声明「这段字是什么角色、哪个字段放到哪」，正文一律由 compilePrompt 产出；
 *    本文件里不出现任何最终提示词字符串。
 *
 * ② 为什么 chain 区分 system / user / slot，而 compiler 只认 { raw, references, ratio, slots }？
 *    技能库的职责就是「把结构化技能翻译成那个形状」：
 *      · system / user —— 技能自带文案（我们是作者，可信），按声明顺序并入 raw；
 *      · slot          —— 用户填的字段，展开成「字段名：值」并入 raw；放 raw 是因为在 compiler
 *                        的裁决链里「用户明确意图」高于槽位标签；
 *      · 图片参数       —— 不进 chain，进 references（角色锚点区）。在正文里用文字描述
 *                        「图1 是产品」既啰嗦又会被忽略，编号锚点才是模型认到的结构。
 *    区分 system/user 不是为了 compiler（它不区分），而是为了界面按角色折叠审阅，
 *    以及将来接 chat 型模型时能直接映射成 messages、不必再拆一次。
 *
 * ③ 为什么模型 id 必须来自 models/registry.js，且技能的 cost 恒为 null？
 *    价格与能力只能有一个真源。技能里写死价格，等于把「界面显示多少」和「实际扣多少」重新拆成
 *    两份 —— 这两者一旦漂移，是最伤用户信任的故障。所以技能只声明可用模型（必须能通过
 *    getModel 查到），effectiveCost 一律现算：有模型取该模型的 effectiveCost，没有模型
 *    （models: [] = 不限）就回落到计费表基价，绝不编造数字。
 *
 * 约束：零依赖、纯函数、不读网络、不写磁盘、不读环境变量。
 */

import { COMPILE_MAX_CHARS, compilePrompt } from "./prompt/compiler.js";
import { ACTION_OF_KIND, KIND_IMAGE, KIND_VIDEO, getModel, listModels } from "./models/registry.js";
import { COST_TABLE } from "./credits.js";

/** 分类白名单。数组顺序即界面分组顺序。 */
export const SKILL_CATEGORIES = ["换装", "商品图", "人像", "视频", "批量", "工具"];

/** 参数类型白名单。新增类型必须同时补 validateSkillInput 里的分支。 */
export const INPUT_TYPES = ["image", "text", "number", "select"];

/** 铺图节点类型白名单：必须是画布已有类型（src/store.js 的 WORKFLOWS），铺出渲染不出来的
 *  节点比不铺更糟 —— 用户会以为程序坏了。 */
export const NODE_TYPES = ["reference", "product", "style", "prompt", "executor", "result", "group"];

/** 单个文本字段进正文前的截断长度。compiler 已有 4000 字总上限，这里再截一次是因为它裁剪的
 *  单位是「分区」：一段两万字的口水话会先把不变量区和角色锚点区挤出预算，而那两块正是防注入
 *  与防角色错位的防线。逐字段收口保证「填得再多也只挤占任务区」。 */
const TEXT_MAX_CHARS = 1200;

/** 兜底计费动作：技能没声明模型、注册表也查不到时用图片生成基价。 */
const FALLBACK_ACTION = "image.generate";

// ---------------------------------------------------------------------------
// 参数构造小工具
// ---------------------------------------------------------------------------
// 参数对象上的扩展字段（前端只读它认识的键，不会被打断）：
//   role      参考图角色，进 compiler 的角色锚点区（如「主体 / 主参考」）
//   protected true = 该参考图内容不得改写（产品图必须真、模特图必须假 —— 否则衣服永远换不掉）
//   node      铺图用哪种节点类型（默认 product = 上传/参考图节点）
//   options   select 的候选值（校验越界的依据）
//   runtime   true = 生成参数（张数 / 时长 / 强度…），只影响执行，不进提示词正文
// 默认值集中在这里：required / protected / runtime 一旦散落到十几个技能里早晚会写反一个，
// 而写反的表现是「功能静默失效」，不是报错。

const productImg = (key, label, role, extra = {}) => ({ key, type: "image", required: true, label, role, protected: true, node: "product", ...extra });
const sourceImg = (key, label, role, extra = {}) => ({ key, type: "image", required: true, label, role, protected: false, node: "product", ...extra });
const styleImg = (key, label, role, extra = {}) => ({ key, type: "image", required: false, label, role, protected: false, node: "style", ...extra });
const refImg = (key, label, role, extra = {}) => ({ key, type: "image", required: true, label, role, protected: true, node: "reference", ...extra });
const text = (key, label, extra = {}) => ({ key, type: "text", required: false, label, ...extra });
const reqText = (key, label, extra = {}) => ({ key, type: "text", required: true, label, ...extra });
const num = (key, label, min, max, extra = {}) => ({ key, type: "number", required: false, label, min, max, runtime: true, ...extra });
const sel = (key, label, options, extra = {}) => ({ key, type: "select", required: false, label, options, ...extra });
const reqSel = (key, label, options, extra = {}) => ({ key, type: "select", required: true, label, options, ...extra });
const system = (value) => ({ role: "system", text: value });
const user = (value) => ({ role: "user", text: value });
const slot = (key) => ({ role: "slot", key });

// ---------------------------------------------------------------------------
// 计费解析（唯一真源：models/registry.js → credits.COST_TABLE）
// ---------------------------------------------------------------------------

/** 注册表里的模型单价；null 表示「不知道」，不是 0。 */
function modelCostOf(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return null;
  const found = listModels().find((m) => m.id === id);
  return found ? found.effectiveCost : null;
}

/** 计费表兜底：先按类别（视频贵得多），取不到再退回图片基价。 */
function fallbackCost(kind) {
  const action = ACTION_OF_KIND[kind] || FALLBACK_ACTION;
  const cost = COST_TABLE[action]?.cost;
  if (typeof cost === "number" && Number.isFinite(cost)) return cost;
  return COST_TABLE[FALLBACK_ACTION]?.cost ?? 0;
}

/** 技能默认成本 = 默认模型跑一次的预估：显式 cost > models[0] 的注册表单价 > 计费表基价。 */
function defaultCostOf(skill) {
  if (typeof skill.cost === "number" && Number.isFinite(skill.cost) && skill.cost >= 0) return skill.cost;
  const fromModel = modelCostOf(Array.isArray(skill.models) ? skill.models[0] : "");
  return fromModel === null ? fallbackCost(skill.kind) : fromModel;
}

/** 递归冻结：技能库是权威定义，调用方就地改它会造成「界面与扣费两套真相」。 */
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 技能定义
// ---------------------------------------------------------------------------
// workflow：前端模板 id（src/store.js 的 WORKFLOWS 键）。能对上的照实填，前端点击即可直接铺
// 模板；对不上的填 ""，此时由 skillPlan 的 nodes/edges 铺图 —— 技能库不新建模板，免得同一套
// 画布逻辑出现两份。ratio：默认画幅，可为 ""（本次不写画幅约束，由 compiler 给降级说明）。

const SKILL_DEFS = [
  // ------------------------------ 换装 ------------------------------
  {
    id: "outfit-swap", label: "模特换装", desc: "把产品图穿到模特身上，保持产品细节不变",
    category: "换装", icon: "User", workflow: "clothes-model", kind: KIND_IMAGE, models: ["nano-banana-pro", "jiemeng"],
    inputs: [
      productImg("productImage", "产品图", "主体 / 主参考", { hint: "建议白底或实拍" }),
      sourceImg("modelImage", "模特图", "来源 / 待编辑目标", { hint: "全身或半身，光线均匀" }),
      text("scene", "场景", { hint: "留空则由模特图背景决定" }),
      num("count", "张数", 1, 10, { defaultValue: 4 })
    ],
    promptChain: [
      system("你是服装换装合成助手：以产品图的服装为唯一款式依据，把服装自然穿到模特图的人物身上，输出可直接上架的成片。"),
      user("保留模特图人物的面部、发型、肤色、体态与姿势；服装的版型、面料纹理、配色、图案、纽扣与走线必须与产品图一致，不得自行改款、换色或加上不存在的标识。"),
      slot("scene")
    ],
    ratio: "3:4", cost: null
  },
  {
    id: "outfit-style", label: "风格换装", desc: "保留服装款式，只迁移参考图的影调与版式气质",
    category: "换装", icon: "MagicStick", workflow: "style-reference", kind: KIND_IMAGE, models: ["nano-banana-pro", "gpt-image-2"],
    inputs: [
      productImg("outfitImage", "服装图", "主体 / 主参考"),
      styleImg("styleImage", "风格参考图", "风格 / 版式参考", { required: true }),
      text("styleNote", "风格补充", { hint: "如「暖光、胶片颗粒」" }),
      num("count", "张数", 1, 10, { defaultValue: 4 })
    ],
    promptChain: [
      system("你是商业摄影的风格迁移助手：让成片的影调与版式向参考风格靠拢，但不改变被拍摄的服装本身。"),
      user("只迁移风格参考图的整体影调、光线走向、背景质感与版式气质；不复制其中的具体款式、品牌标识与人物身份；服装款式与细节仍以服装图为准。"),
      slot("styleNote")
    ],
    ratio: "3:4", cost: null
  },
  {
    id: "outfit-pose", label: "换装裂变", desc: "一次换装同时裂变多组姿势，用于凑齐成套素材",
    category: "换装", icon: "Grid", workflow: "clothes-model-pose", kind: KIND_IMAGE, models: ["jiemeng", "nano-banana-pro"],
    inputs: [
      productImg("productImage", "产品图", "主体 / 主参考"),
      sourceImg("modelImage", "模特图", "来源 / 待编辑目标"),
      text("scene", "场景", { hint: "留空则沿用模特图场景" }),
      num("count", "张数", 1, 12, { defaultValue: 6 })
    ],
    promptChain: [
      system("你是电商服装换装与姿势裂变助手：同一套服装要在多张成片里保持完全一致的外观。"),
      user("以产品图的服装为准换装；每一张使用不同但自然的站姿或坐姿，人物面部、发型与体型保持一致；不同张之间只有姿势、机位与构图变化，服装不得出现色差或走形。"),
      slot("scene")
    ],
    ratio: "3:4", cost: null, multiOutput: true
  },

  // ------------------------------ 商品图 ------------------------------
  {
    id: "txt2img", label: "文生图", desc: "只有文字描述，直接生成可用的商品图",
    category: "商品图", icon: "MagicStick", workflow: "image-generate", kind: KIND_IMAGE, models: ["nano-banana-2", "seedream-5-pro"],
    inputs: [
      reqText("subject", "主体描述", { hint: "如「白色陶瓷马克杯，杯口金色描边」" }),
      text("style", "风格", { hint: "如「极简、留白」" }),
      text("background", "背景", { hint: "如「浅木色桌面」" }),
      num("count", "张数", 1, 10, { defaultValue: 4 })
    ],
    promptChain: [
      system("你是电商主图摄影师：按文字描述合成一张主体清晰、结构合理、可直接用于商品主图或详情页的成图。"),
      user("严格按下面的字段描述生成，不要添加描述里没有出现过的品牌、文字与配件；主体占比适中，四周留出可排版的余白。"),
      slot("subject"), slot("style"), slot("background")
    ],
    ratio: "1:1", cost: null
  },
  {
    id: "img2img", label: "图生图", desc: "拿一张图当起点，只做你写明的改动",
    category: "商品图", icon: "Picture", workflow: "custom-scene", kind: KIND_IMAGE, models: ["nano-banana-pro", "gpt-image-2"],
    inputs: [
      productImg("refImage", "参考图", "主体 / 主参考"),
      reqText("instruction", "改动要求", { hint: "如「换成暖色调背景，保留产品造型」" }),
      text("keep", "需要保留的", { hint: "如「标签文字与瓶身比例」" }),
      num("count", "张数", 1, 10, { defaultValue: 4 })
    ],
    promptChain: [
      system("你是图片编辑助手：以参考图为起点做定向修改，未要求改动的部分保持原样。"),
      user("只执行「改动要求」里写明的改动，其余内容严格保持与参考图一致，不得顺手美化、重绘或替换主体。"),
      slot("instruction"), slot("keep")
    ],
    ratio: "1:1", cost: null
  },
  {
    id: "white-bg", label: "白底图", desc: "去除杂乱背景，产出符合平台规范的纯底商品图",
    category: "商品图", icon: "PictureFilled", workflow: "", kind: KIND_IMAGE, models: ["seedream-5-pro", "nano-banana-pro"],
    inputs: [
      productImg("productImage", "产品图", "主体 / 主参考"),
      sel("background", "背景色", ["纯白 #FFFFFF", "浅灰 #F5F5F5"], { defaultValue: "纯白 #FFFFFF" }),
      sel("shadow", "投影", ["保留自然投影", "不保留投影"], { defaultValue: "保留自然投影" }),
      num("count", "张数", 1, 10, { defaultValue: 4 })
    ],
    promptChain: [
      system("你是商品图背景处理助手：把产品从原背景中干净地分离出来，放到纯色底上。"),
      user("只保留产品本体，去掉原背景里的一切元素；产品边缘必须干净，不得残留原背景颜色，也不得把产品自身的半透明、毛绒或反光边缘切掉；产品的位置、比例与朝向保持与参考图一致。"),
      slot("background"), slot("shadow")
    ],
    ratio: "1:1", cost: null
  },
  {
    id: "detail-page", label: "详情页", desc: "按卖点生成一套分模块的商品详情页图",
    category: "商品图", icon: "Document", workflow: "detail-page", kind: KIND_IMAGE, models: ["gpt-image-2.5", "nano-banana-pro"],
    inputs: [
      productImg("productImage", "产品图", "主体 / 主参考"),
      reqText("sellingPoints", "卖点", { hint: "一行一个卖点，按顺序分配模块" }),
      num("sectionCount", "模块数", 3, 8, { defaultValue: 4, runtime: false }),
      sel("tone", "语气", ["讲解风", "种草风", "高端风"], { defaultValue: "讲解风" })
    ],
    promptChain: [
      system("你是电商详情页策划与设计助手：把卖点拆成按顺序阅读的若干模块，每个模块一个主题。"),
      user("每个模块只讲一个卖点，模块之间不重复；所有模块的产品外观必须与产品图完全一致；图内文字只用「卖点」里给出的信息，不得自行编造参数、认证与销量。"),
      slot("sellingPoints"), slot("sectionCount"), slot("tone")
    ],
    ratio: "3:4", cost: null, multiOutput: true
  },

  // ------------------------------ 人像 ------------------------------
  {
    id: "model-gen", label: "模特生成", desc: "按人物描述生成可用于电商展示的模特形象",
    category: "人像", icon: "UserFilled", workflow: "", kind: KIND_IMAGE, models: ["jiemeng", "nano-banana-pro"],
    inputs: [
      reqText("persona", "人物描述", { hint: "如「25 岁女性，亚洲面孔，通勤风」" }),
      text("scene", "场景", { hint: "如「落地窗边的自然光」" }),
      sel("framing", "景别", ["半身", "全身", "特写"], { defaultValue: "半身" }),
      num("count", "张数", 1, 10, { defaultValue: 4 })
    ],
    promptChain: [
      system("你是电商人像摄影助手：按人物描述生成自然的商业模特形象，用于服装与配饰展示。"),
      user("面部结构自然、五官对称、手指数量与关节正确；光线为柔和自然的商业布光，皮肤保留真实质感；不生成任何文字、水印与品牌标识，也不要虚构人物的职业资质。"),
      slot("persona"), slot("scene"), slot("framing")
    ],
    ratio: "3:4", cost: null
  },
  {
    id: "pose-split", label: "姿势裂变", desc: "同一人物裂变多组姿势，面部保持一致",
    category: "人像", icon: "CopyDocument", workflow: "pose-split", kind: KIND_IMAGE, models: ["jiemeng", "nano-banana-pro"],
    inputs: [
      sourceImg("modelImage", "模特图", "主体 / 主参考"),
      styleImg("poseRef", "姿势参考图", "姿势参考"),
      num("count", "姿势数量", 2, 12, { defaultValue: 4 }),
      sel("keepFace", "面部一致性", ["保持面部一致", "允许面部变化"], { defaultValue: "保持面部一致" })
    ],
    promptChain: [
      system("你是人像姿势裂变助手：同一个人物要在多张成片里保持可辨认的一致性。"),
      user("以模特图的人物为唯一身份来源，逐张更换自然、可落地的站姿或坐姿；机位与构图可以变化，但发型、体型与面部特征保持一致；不要出现多余的手臂、扭曲的关节或重复的人脸。"),
      slot("keepFace")
    ],
    ratio: "3:4", cost: null, multiOutput: true
  },

  // ------------------------------ 视频 ------------------------------
  {
    id: "img2video", label: "图生视频", desc: "把一张商品图变成一段可发布的短视频",
    category: "视频", icon: "VideoCamera", workflow: "ai-video", kind: KIND_VIDEO, models: ["wanx2.1-t2v-turbo"],
    inputs: [
      refImg("startImage", "首帧图", "首帧 / 主参考"),
      reqText("motion", "运动描述", { hint: "如「镜头缓慢推近，裙摆轻微摆动」" }),
      num("duration", "时长（秒）", 3, 10, { defaultValue: 5 })
    ],
    promptChain: [
      system("你是商品短视频拍摄助手：把首帧图延续成一段连贯、稳定的短片。"),
      user("画面以首帧图为起点，主体外观、配色与结构在整段视频里保持一致；只做描述里写明的镜头运动与物体运动，幅度克制、节奏平稳；不出现字幕、水印、镜头跳切与主体形变。"),
      slot("motion")
    ],
    ratio: "16:9", cost: null
  },

  // ------------------------------ 批量 ------------------------------
  {
    id: "batch-variation", label: "批量裂变", desc: "同一产品沿一个维度批量产出差异化成片",
    category: "批量", icon: "Files", workflow: "", kind: KIND_IMAGE, models: ["seedream-5-pro", "nano-banana-pro"],
    inputs: [
      productImg("productImage", "产品图", "主体 / 主参考"),
      reqSel("axis", "裂变维度", ["背景", "配色", "场景", "构图"]),
      num("batchSize", "批量张数", 2, 24, { defaultValue: 8 }),
      sel("keepProduct", "产品一致性", ["产品完全一致", "允许轻微变化"], { defaultValue: "产品完全一致" })
    ],
    promptChain: [
      system("你是电商素材批量生产助手：一次产出多条可并排比较的差异化成片。"),
      user("所有成片使用同一个产品，只沿「裂变维度」指定的方向做差异化；产品的外观、比例与结构保持一致，不同张之间不得出现相同的背景或构图。"),
      slot("axis"), slot("keepProduct")
    ],
    ratio: "1:1", cost: null, multiOutput: true
  },

  // ------------------------------ 工具 ------------------------------
  {
    id: "cutout", label: "抠图 / 去背", desc: "分离主体与背景，可输出透明底或纯色底",
    category: "工具", icon: "Scissors", workflow: "", kind: KIND_IMAGE, models: ["nano-banana-pro", "jiemeng"],
    inputs: [
      productImg("sourceImage", "原图", "主体 / 主参考"),
      reqSel("target", "目标背景", ["透明背景", "纯白背景", "纯黑背景"]),
      sel("keepShadow", "投影", ["保留", "去除"], { defaultValue: "保留" })
    ],
    promptChain: [
      system("你是图像抠图助手：把主体从背景中完整分离，边缘处理干净。"),
      user("只保留主体本身，背景按目标背景处理；主体的边缘（毛发、纱质、镂空、半透明部分）必须完整保留，不得被啃掉或糊成一团；主体的位置、比例与角度不变。"),
      slot("target"), slot("keepShadow")
    ],
    ratio: "", cost: null
  },
  {
    id: "upscale", label: "高清放大", desc: "放大分辨率并补回细节，用于印刷与大屏展示",
    category: "工具", icon: "ZoomIn", workflow: "", kind: KIND_IMAGE, models: ["nano-banana-pro", "gpt-image-2.5"],
    inputs: [
      productImg("sourceImage", "原图", "主体 / 主参考"),
      num("factor", "放大倍数", 2, 4, { defaultValue: 2 }),
      sel("detail", "细节强度", ["轻度", "标准", "极致"], { defaultValue: "标准" })
    ],
    promptChain: [
      system("你是图像超分助手：在放大分辨率的同时补回细节，而不是重新画一张图。"),
      user("保持原图的构图、比例、色彩与全部内容不变；只让边缘更锐利、纹理更清晰、噪点与压缩痕迹更少；不得新增原图没有的元素，也不得改变产品上的文字与图案。"),
      slot("detail")
    ],
    ratio: "", cost: null
  },
  {
    id: "inpaint", label: "局部重绘", desc: "只重画涂抹区域，其余部分原样保留",
    category: "工具", icon: "Brush", workflow: "", kind: KIND_IMAGE, models: ["nano-banana-pro", "jiemeng"],
    inputs: [
      productImg("sourceImage", "原图", "主体 / 主参考"),
      productImg("maskImage", "蒙版图", "蒙版 / 替换区域", { hint: "白色区域将被重绘" }),
      reqText("instruction", "重绘内容", { hint: "如「把背景换成浅木色台面」" }),
      num("strength", "强度", 1, 100, { defaultValue: 60 }),
      num("count", "张数", 1, 6, { defaultValue: 1 })
    ],
    promptChain: [
      system("你是局部重绘助手：只在蒙版指定的区域内作画。"),
      user("只重绘蒙版覆盖的区域，区域外的一切内容（包括产品、文字与光影关系）必须与参考图逐像素一致；重绘内容与周围的光线方向、色温、景深保持一致，接缝处不得出现明显边界。"),
      slot("instruction")
    ],
    ratio: "1:1", cost: null
  },
  {
    id: "prompt-preset", label: "提示词预设", desc: "把结构化字段整理成可直接投喂绘图模型的提示词",
    category: "工具", icon: "EditPen", workflow: "", kind: KIND_IMAGE,
    // models: [] = 不限模型。预设本身不绑定模型，用哪家由生成那一步决定；
    // 所以 effectiveCost 回落到计费表基价（= 用这套预设生成一张的预估）。
    models: [],
    inputs: [
      reqSel("preset", "预设类型", ["电商主图", "人像写真", "场景合成", "详情页文案"]),
      reqText("subject", "主体"),
      text("extra", "补充说明")
    ],
    promptChain: [
      system("你是提示词整理助手：把结构化字段整理成一段可直接投喂绘图模型的画面描述，不生成解释与客套话。"),
      user("按下述字段整合描述，字段之间不得互相矛盾；没有给出的信息保持开放，不要编造具体品牌、文字与水印。"),
      slot("preset"), slot("subject"), slot("extra")
    ],
    ratio: "", cost: null
  }
];

/**
 * 对外技能清单：冻结 + 预置 effectiveCost。
 * 冻结让「技能库是唯一真源」可执行：调用方就地改 SKILLS[0].models 会直接抛错，而不是悄悄让
 * 界面和扣费走向两套真相。effectiveCost 在这里一次算好（注册表是静态数据、无 I/O），
 * 于是 listSkills / getSkill / skillPlan 三处的成本天然一致。
 */
export const SKILLS = Object.freeze(SKILL_DEFS.map((def) => deepFreeze({ ...def, effectiveCost: defaultCostOf(def) })));

const BY_ID = new Map(SKILLS.map((skill) => [skill.id, skill]));

/** 取某个技能声明的参数定义；未知 key 返回 null 而不是抛错。 */
function inputOf(skill, key) {
  return (skill.inputs || []).find((input) => input.key === key) || null;
}

// ---------------------------------------------------------------------------
// ① 查询
// ---------------------------------------------------------------------------

/** 技能列表（浅拷贝 + 现算 effectiveCost）。浅拷贝是为了让调用方随意挂界面字段（选中态、
 *  排序权重），但绝不能顺着改到真源 —— 真正的防线是上面那层 deepFreeze。
 *  未知的 category / kind 返回空数组：过滤语义 fail-closed，宁可显示 0 个技能，
 *  也不要因为分类名拼错就把全部技能倒出去。 */
export function listSkills({ category, kind } = {}) {
  return SKILLS.filter((skill) => (!category || skill.category === category) && (!kind || skill.kind === kind)).map(
    (skill) => ({ ...skill, effectiveCost: defaultCostOf(skill) })
  );
}

export function getSkill(id) {
  return BY_ID.get(String(id || "")) || null;
}

// ---------------------------------------------------------------------------
// ② 参数校验
// ---------------------------------------------------------------------------

/** 类型错误里给出「收到什么」，比只说「类型不对」省一轮来回。 */
function describe(value) {
  if (Array.isArray(value)) return "数组";
  if (value === null) return "null";
  const type = typeof value;
  if (type === "object") return "对象";
  if (type === "string") return `字符串(${value.length} 字)`;
  return `${type}(${String(value)})`;
}

const isMissing = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const numberDefault = (input) => (typeof input.defaultValue === "number" ? input.defaultValue : null);
const stringDefault = (input) => (typeof input.defaultValue === "string" ? input.defaultValue : "");

/**
 * 校验并归一化技能参数，返回 { ok, code?, message?, params, missing }。
 * 两个刻意取舍：
 * 1. 错误优先级「缺失 > 类型 > 范围 > 模型」：「没填」比「填错了」更该先说 —— 用户面对空表单时，
 *    告诉他「张数必须是数字」毫无意义。missing 一次给全（不是只报第一个），界面可一次性标红。
 * 2. 失败时 params 仍是尽力而为的完整参数（非法值回落到 defaultValue）：校验失败的响应往往是
 *    「回填表单 + 标红」，params 若为空或带 undefined，界面就得自己再兜一次默认值 —— 那正是
 *    两套真相的开始。
 * 刻意「不管」文本长度：由 buildSkillPrompt 收口（它才有 diagnostics 通道说明「已截断」），
 * 否则用户写长了会被直接拒绝，而正确做法是截断后照样出图。
 */
export function validateSkillInput(skillId, params) {
  const skill = getSkill(skillId);
  if (!skill) {
    return { ok: false, code: "UNKNOWN_SKILL", message: `未知技能：${String(skillId ?? "") || "(空)"}`, params: {}, missing: [] };
  }

  const src = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  const out = {};
  const missing = [];
  let typeError = "";
  let rangeError = "";
  let modelError = "";

  for (const input of skill.inputs) {
    const raw = src[input.key];
    const filled = !isMissing(raw);
    if (!filled && input.required) missing.push(input.key);

    if (input.type === "image") {
      if (filled && typeof raw !== "string") typeError ||= `「${input.label}」需要图片路径或地址，收到 ${describe(raw)}`;
      out[input.key] = filled && typeof raw === "string" ? raw.trim() : "";
      continue;
    }

    if (input.type === "number") {
      // 数字字符串 "4" 也认，并转成 number：provider 与账本都按数字用，字符串会一路传成脏数据。
      const value = filled && typeof raw === "number" ? raw : filled && typeof raw === "string" ? Number(raw.trim()) : NaN;
      const ok = filled && Number.isFinite(value) && value >= input.min && value <= input.max;
      if (filled && !Number.isFinite(value)) typeError ||= `「${input.label}」需要数字，收到 ${describe(raw)}`;
      else if (filled && !ok) rangeError ||= `「${input.label}」需在 ${input.min}~${input.max} 之间，收到 ${value}`;
      out[input.key] = ok ? value : numberDefault(input);
      continue;
    }

    if (input.type === "select") {
      const options = Array.isArray(input.options) ? input.options : [];
      const value = filled && typeof raw === "string" ? raw.trim() : "";
      const ok = filled && typeof raw === "string" && (!options.length || options.includes(value));
      if (filled && typeof raw !== "string") typeError ||= `「${input.label}」需要选项文本，收到 ${describe(raw)}`;
      else if (filled && !ok) rangeError ||= `「${input.label}」只能是 ${options.join(" / ")}，收到 ${value}`;
      out[input.key] = ok ? value : stringDefault(input);
      continue;
    }

    // text（默认分支）
    if (filled && typeof raw !== "string") typeError ||= `「${input.label}」需要文本，收到 ${describe(raw)}`;
    out[input.key] = filled && typeof raw === "string" ? raw.trim() : stringDefault(input);
  }

  // model / ratio 不是「界面参数」，但技能库必须认这两个（选模型、覆盖画幅），所以它们不参与
  // 必填判断，只做类型与白名单校验。
  if (isMissing(src.model)) {
    out.model = "";
  } else if (typeof src.model !== "string") {
    typeError ||= `model 需要字符串 id，收到 ${describe(src.model)}`;
    out.model = "";
  } else {
    const id = src.model.trim();
    out.model = id;
    if (!getModel(id)) {
      // 未注册模型一律拒绝：放行一个不存在的模型只会把错误推迟到真正扣费那一刻，
      // 那时用户已经等了几十秒。
      modelError = `模型 ${id} 不在模型注册表中`;
    } else if (skill.models.length && !skill.models.includes(id)) {
      // 注册表里有但技能声明不支持：同样归 UNKNOWN_MODEL —— 契约的错误码集合是封闭的，
      // 这里不新造码，靠 message 区分两种情形。
      modelError = `技能「${skill.label}」不支持模型 ${id}（可选：${skill.models.join(" / ")}）`;
    }
  }
  // 画幅不在技能层判白名单：那是 compiler 的职责（它还负责降级说明），在这里再写一份就会出现
  // 「两处判断、早晚漂移」的老问题。
  out.ratio = isMissing(src.ratio) ? "" : String(src.ratio).trim();

  let code = "";
  let message = "";
  if (missing.length) {
    code = "MISSING_REQUIRED";
    message = `缺少必填项：${missing.map((key) => inputOf(skill, key)?.label || key).join("、")}`;
  } else if (typeError) {
    code = "BAD_TYPE";
    message = typeError;
  } else if (rangeError) {
    code = "OUT_OF_RANGE";
    message = rangeError;
  } else if (modelError) {
    code = "UNKNOWN_MODEL";
    message = modelError;
  }
  return { ok: !code, code: code || undefined, message: message || undefined, params: out, missing };
}

// ---------------------------------------------------------------------------
// ③ 提示词装配
// ---------------------------------------------------------------------------

/** 展开提示词链：system / user 是技能自带文案（可信），空串丢弃（空行进 raw 只浪费预算）；
 *  slot 取值后拼成「字段名：值」，把「用户明确意图」这一最高优先级交给 compiler。
 *  空的可选槽位不生成空文本，而是把字段名登记进 compiler 的 slots —— 那正是「低置信度
 *  缺省参考」的用途，compiler 会把它写进槽位提示区。 */
function expandChain(skill, params, diagnostics) {
  const chain = [];
  const slots = [];
  for (const step of skill.promptChain || []) {
    if (step.role !== "slot") {
      const text = typeof step.text === "string" ? step.text.trim() : "";
      if (text) chain.push({ role: step.role, text });
      continue;
    }
    const def = inputOf(skill, step.key);
    const value = params[step.key];
    const text = value === undefined || value === null ? "" : String(value).trim();
    if (!text) {
      if (def?.label) slots.push(def.label);
      chain.push({ role: "slot", key: step.key, text: "" });
      continue;
    }
    let clipped = text;
    if (clipped.length > TEXT_MAX_CHARS) {
      clipped = clipped.slice(0, TEXT_MAX_CHARS);
      diagnostics.push(`字段「${def?.label || step.key}」超过 ${TEXT_MAX_CHARS} 字，已截断后再编译。`);
    }
    chain.push({ role: "slot", key: step.key, text: `${def?.label || step.key}：${clipped}` });
  }
  return { chain, slots };
}

/** 图片参数 → compiler 的 references（角色锚点区）。顺序即声明顺序，编号由 compiler 生成。 */
function collectReferences(skill, params) {
  const references = [];
  for (const input of skill.inputs || []) {
    if (input.type !== "image" || !params[input.key]) continue;
    references.push({ role: input.role || "", label: input.label, protected: input.protected === true });
  }
  return references;
}

const emptyBlocks = () => ({ raw: "", references: [], ratio: "", slots: [] });

/**
 * 编译技能提示词。返回契约字段 { ok, code?, message?, prompt, blocks, chain, diagnostics }，
 * 另附两个便于集成的字段：params（归一化参数，界面可直接回填）、compiled（compiler 完整输出，
 * 排障时不必重跑）。blocks 就是「直接交给 compilePrompt 的入参」{ raw, references, ratio, slots }；
 * 想核对「提示词真的走了 compiler」，把 blocks 再喂一次 compilePrompt，得到的 text 必须与
 * prompt 逐字节相同（测试里就是这么钉的）。
 */
export function buildSkillPrompt(skillId, params, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const checked = validateSkillInput(skillId, params);
  if (!checked.ok) {
    return {
      ok: false,
      code: checked.code,
      message: checked.message,
      prompt: "",
      blocks: emptyBlocks(),
      chain: [],
      params: checked.params,
      compiled: null,
      diagnostics: [checked.message || checked.code || "技能参数不合法"]
    };
  }

  const skill = getSkill(skillId);
  const diagnostics = [];
  const { chain, slots } = expandChain(skill, checked.params, diagnostics);
  const references = collectReferences(skill, checked.params);
  // 画幅优先级：调用方显式指定 > 参数里的 ratio > 技能默认画幅。空串是合法结果：
  // 表示这一次不写画幅约束，由 compiler 给出降级说明。
  const ratio =
    String(opts.ratio ?? "").trim() || String(checked.params.ratio || "").trim() || String(skill.ratio || "").trim();
  const raw = chain.filter((step) => step.text).map((step) => step.text).join("\n");
  const blocks = { raw, references, ratio, slots };

  const compiled = compilePrompt(blocks);
  diagnostics.push(...compiled.diagnostics);

  let prompt = compiled.text;
  // 兜底护栏：正文上限由 compiler 保证。这里只是 fail-closed —— 万一将来 compiler 的不变量被
  // 改坏，也不能把超限正文发给上游（那会直接 400）。
  if (prompt.length > COMPILE_MAX_CHARS) {
    prompt = prompt.slice(0, COMPILE_MAX_CHARS);
    diagnostics.push(`正文超出硬上限 ${COMPILE_MAX_CHARS} 字，已按上限截断。`);
  }

  return {
    ok: true,
    prompt,
    blocks,
    chain,
    params: checked.params,
    compiled,
    diagnostics,
    characters: prompt.length,
    truncated: compiled.truncated === true
  };
}

// ---------------------------------------------------------------------------
// ④ 执行计划（铺图）
// ---------------------------------------------------------------------------

/** 建议节点：图片参数 → 上传/参考节点，然后提示词 → 执行器 →（作品组）→ 结果。 */
function planNodes(skill) {
  const nodes = [];
  for (const input of skill.inputs || []) {
    if (input.type === "image") nodes.push({ type: input.node || "product", key: input.key });
  }
  nodes.push({ type: "prompt", key: "prompt" }, { type: "executor", key: "executor" });
  if (skill.multiOutput) nodes.push({ type: "group", key: "group" });
  nodes.push({ type: "result", key: "result" });
  return nodes;
}

/** 建议连线：用 key 表达，前端据此建图；多图输出时先汇进作品组，便于整组查看。 */
function planEdges(skill) {
  const edges = [];
  for (const input of skill.inputs || []) {
    if (input.type === "image") edges.push([input.key, "executor"]);
  }
  edges.push(["prompt", "executor"]);
  if (skill.multiOutput) edges.push(["executor", "group"], ["group", "result"]);
  else edges.push(["executor", "result"]);
  return edges;
}

/** 一次执行的算力：技能单价 → 选定模型单价 → 计费表基价。绝不编造数字。 */
function costOf(skill, modelId) {
  if (typeof skill.cost === "number" && Number.isFinite(skill.cost) && skill.cost >= 0) return skill.cost;
  const fromModel = modelCostOf(modelId);
  return fromModel === null ? fallbackCost(skill.kind) : fromModel;
}

const failPlan = (code, message, skill) => ({
  ok: false, code, message, skill: skill || null, prompt: "", kind: skill ? skill.kind : "",
  model: "", cost: 0, nodes: [], edges: []
});

/** 出一个「铺图 + 提示词 + 模型 + 算力」的执行计划，供「一键成片」直接消费。
 *  失败时仍返回全部键（值为安全默认），调用方不必写 `plan.nodes && ...` 这种防御式代码。 */
export function skillPlan(skillId, params) {
  const skill = getSkill(skillId);
  if (!skill) return failPlan("UNKNOWN_SKILL", `未知技能：${String(skillId ?? "") || "(空)"}`, null);

  const built = buildSkillPrompt(skillId, params);
  if (!built.ok) return failPlan(built.code, built.message, skill);

  // 模型选择：参数显式指定 > 技能声明的第一个可用模型 > ""（不限模型）。
  // "" 是合法结果（如提示词预设），此时成本回落到计费表基价。
  const model = String(built.params.model || "").trim() || String(skill.models[0] || "");

  return {
    ok: true,
    skill,
    prompt: built.prompt,
    kind: skill.kind,
    model,
    cost: costOf(skill, model),
    nodes: planNodes(skill),
    edges: planEdges(skill)
  };
}

/** 别名：skillPlan。契约里叫 skillPlan，任务书正文里写作 planSkill，两处都出现过；与其让集成方
 *  猜，不如把两者指向同一个函数（纯函数、无状态，别名零成本）。 */
export const planSkill = skillPlan;
