// 新手引导内容：分章节，每章若干步，每步可高亮一个 UI 元素
// target 为 CSS 选择器；route 表示该步需要先切换到哪个页面

export const ONBOARDING = [
  {
    id: "welcome",
    title: "欢迎与工作台",
    route: "home",
    steps: [
      {
        title: "欢迎使用跨多多 AI 创作台",
        desc: "从商品素材到成套图片、详情页和视频，都可以在同一个项目里完成。接下来跟着几步，认识主要入口。",
        target: ".wk-hero-title",
        placement: "bottom"
      },
      {
        title: "一句话描述你的需求",
        desc: "直接在输入框里说想做什么，比如「把图中的衣服设计一个合适的欧美模特」。AI 会为你搭好完整的工作流。",
        target: ".wk-composer",
        placement: "bottom"
      },
      {
        title: "常用工具一键开始",
        desc: "这里是最高频的五个功能。点任意一个，会自动创建对应的画布和节点，不需要手动搭。",
        target: ".wk-quick",
        placement: "bottom"
      },
      {
        title: "最近项目：接着上次继续",
        desc: "项目会记录你的画布和素材。点缩略图回到原画布，点「新建项目」开一张空白的。",
        target: ".wk-projects",
        placement: "top"
      },
      {
        title: "灵感场景：不知道做什么时来这",
        desc: "按用途浏览内置模板——模特、商品、场景、详情页、视频。点进去就能直接用。",
        target: ".wk-inspiration",
        placement: "top"
      },
      {
        title: "左侧导航集中了主要入口",
        desc: "工作台、我的项目，以及下方的模板库、作品库和安全记录，都从这里进。",
        target: ".sidebar",
        placement: "right"
      }
    ]
  },
  {
    id: "canvas",
    title: "画布与工作流",
    route: "studio",
    workflow: "clothes-model",
    steps: [
      {
        title: "第一步：上传素材",
        desc: "把服装图、模特图拖进来，也可以点击上传。带「可选」标记的节点不传也能跑。",
        target: ".nf-product",
        placement: "bottom"
      },
      {
        title: "第二步：描述画面并选参数",
        desc: "写清楚想要的画面。旁边可以切换生成模型、生成张数和画幅比例。",
        target: ".nf-prompt",
        placement: "top"
      },
      {
        title: "第三步：点击执行",
        desc: "输入齐了圆环会亮起，点中间的箭头开始生成。生成过程会显示进度。",
        target: ".nf-exec",
        placement: "top"
      },
      {
        title: "第四步：结果就在这里",
        desc: "生成完成后图片出现在这个节点里。选中任意一张，可以下载、放大、出白底图或做姿势裂变。",
        target: ".nf-result",
        placement: "left"
      }
    ]
  },
  {
    id: "account",
    title: "账号与算力",
    route: "home",
    steps: [
      {
        title: "算力余额与充值",
        desc: "右上角显示当前算力。余额不足时点「充值」，支持微信和支付宝扫码。",
        target: ".topbar-right",
        placement: "bottom"
      },
      {
        title: "账号菜单",
        desc: "点头像可以查看使用记录、管理团队成员、重新打开新手指引，或者退出登录。",
        target: ".account-trigger",
        placement: "bottom"
      }
    ]
  }
];

// 拍平成步骤列表，便于用统一索引前后翻页
export const ONBOARDING_STEPS = ONBOARDING.flatMap((chapter, ci) =>
  chapter.steps.map((step, si) => ({
    ...step,
    chapterIndex: ci,
    chapterTitle: chapter.title,
    chapterNo: ci + 1,
    route: chapter.route,
    workflow: chapter.workflow || "",
    isChapterStart: si === 0,
    isChapterEnd: si === chapter.steps.length - 1
  }))
);

export const CHAPTER_COUNT = ONBOARDING.length;
export const STEP_COUNT = ONBOARDING_STEPS.length;
