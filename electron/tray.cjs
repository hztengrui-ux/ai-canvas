// 托盘与系统通知（纯逻辑侧，Sprint 2）
// ---------------------------------------------------------------------------
// 为什么整个模块「不 require("electron")」、所有 Electron 对象都靠参数注入：
//   1. 托盘与通知的**策略**（什么时候打扰用户、菜单长什么样、状态文案怎么拼）
//      是纯逻辑，值得被单测钉死；而 Tray / Notification 只有真实 Electron 里才有。
//      一旦在模块顶层写 require("electron")，`node electron/__tray.test.mjs`
//      就直接抛 "Cannot find module 'electron'"，纯 node 下根本无法回归。
//   2. 注入之后，测试可以塞 10 行假对象，把「幂等」「失败不抛」「菜单结构」
//      「静默跳过缺失方法」这些边界全部覆盖，不需要起一个真的 Electron 进程。
//   3. 同一个模块因此能在 main.cjs（真实 Electron）和测试（假对象）里跑同一份代码，
//      不存在「测的和跑的不是一套」的问题。
//
// 接线（create/destroy 时机、IPC、onCheckUpdate 的真实行为）由 electron/main.cjs 负责，
// 本模块只保证契约稳定、永不对调用方抛异常。
//
// 设计原则：**所有对外函数都不抛异常**。托盘图标缺失、系统不支持通知、
// 菜单构建失败都只降级为「返回值里带 error / 静默跳过」，绝不把主进程带崩 ——
// 托盘只是便捷入口，它挂掉不该影响用户正在跑的生成任务。

"use strict";

/** 默认品牌名。真实调用方会传 BRAND.appName（白标后跟着品牌走）。 */
const DEFAULT_APP_NAME = "AI 创作台";

/**
 * 把任意输入安全地变成字符串。
 * 托盘文案来自运行期状态（可能 undefined / 数字 / 异常对象），
 * 这里统一兜底，避免模板里出现 "undefined 个任务" 这种丢人输出。
 */
function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

/** 安全取非负整数。用于 running / credits，脏数据一律按 0 处理。 */
function safeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * 托盘提示文案（纯函数）。
 *
 * 三种输入刻意给出三种不同文案，便于单测断言「无任务 / 有任务 / 带算力」互不相同：
 *   - 无任务：只报算力（或"空闲"）
 *   - 有任务：报"正在生成 N 个任务"，并带上算力
 *   - 带算力：尾部拼"· 算力 N"
 *
 * @param {{appName?: string, status?: string, running?: number, credits?: number}} input
 * @returns {string}
 */
function buildTooltip({ appName, status, running, credits } = {}) {
  try {
    const name = safeString(appName, "").trim() || DEFAULT_APP_NAME;
    const n = safeCount(running);
    const hasCredits = credits !== null && credits !== undefined && Number.isFinite(Number(credits));
    const creditText = hasCredits ? ` · 算力 ${safeCount(credits)}` : "";
    const custom = safeString(status, "").trim();

    let tail;
    if (n > 0) {
      // 有任务时优先报任务数（这是用户最关心的"还在不在跑"）
      tail = `正在生成 ${n} 个任务${creditText}`;
    } else if (custom) {
      // 没任务但有自定义状态文案，如实展示
      tail = custom + creditText;
    } else if (hasCredits) {
      tail = `空闲${creditText}`;
    } else {
      tail = "空闲";
    }
    return `${name} — ${tail}`;
  } catch {
    // 纯函数同样不抛：文案拼不出来时给一个永远可用的兜底，绝不让调用方崩在托盘上
    return DEFAULT_APP_NAME;
  }
}

/**
 * 是否应该弹系统通知（纯函数，本任务重点测试对象）。
 *
 * 判定顺序即优先级：
 *   enabled=false  —— 用户关掉了通知，永远不打扰（最高优先级，其他条件不用再看）
 *   quiet=true     —— 「专注 / 勿扰」模式：不弹通知，但任务照跑，只是不打断
 *   focused=true   —— **窗口就在用户眼前，弹通知是纯噪音**：用户已经能直接看到
 *                     进度条和结果，再弹一个系统级气泡只会遮住他正在看的内容。
 *                     这是"前台不打扰"的全部理由。
 *   running>0      —— 有任务在跑本身不构成打扰理由；这里保留参数是为了让调用方
 *                     能表达"批量生成时压制通知"的意图，默认不影响结果。
 * @param {{focused?: boolean, enabled?: boolean, running?: number, quiet?: boolean}} input
 * @returns {boolean}
 */
function shouldNotify({ focused, enabled = true, running = 0, quiet = false } = {}) {
  try {
    if (enabled === false) return false;
    if (quiet === true) return false;
    // 只有在窗口**明确**失焦时才值得弹；focused 缺省（undefined）按"不确定"处理，
    // 保守地不打扰 —— 宁可少弹一个，也不要在用户盯着屏幕时冒出来。
    if (focused !== false) return false;
    return true;
  } catch {
    // 判定本身出错时选择"不打扰"：漏一条通知的代价远小于弹错一条
    return false;
  }
}

/** 通知类型 → 中文标题 */
const NOTIFY_TITLE_BY_KIND = {
  done: "生成完成",
  success: "生成完成",
  fail: "生成失败",
  failed: "生成失败",
  error: "生成失败",
  info: "提示",
  progress: "生成进度"
};

/** 通知类型 → 正文兜底模板（调用方没给 body 时用） */
const NOTIFY_BODY_BY_KIND = {
  done: (name, count) => (count > 0 ? `${count} 个任务已完成` : "任务已完成"),
  success: (name, count) => (count > 0 ? `${count} 个任务已完成` : "任务已完成"),
  fail: (name, count) => (count > 0 ? `${count} 个任务失败，请回到${name}查看` : `任务失败，请回到${name}查看`),
  failed: (name, count) => (count > 0 ? `${count} 个任务失败，请回到${name}查看` : `任务失败，请回到${name}查看`),
  error: (name, count) => (count > 0 ? `${count} 个任务失败，请回到${name}查看` : `任务失败，请回到${name}查看`),
  info: (name) => name,
  progress: (name, count) => (count > 0 ? `已完成 ${count} 个任务` : "任务进行中")
};

/** 失败语义的种类集合（决定 urgency 与 silent） */
const FAILURE_KINDS = new Set(["fail", "failed", "error"]);
/** 进度类：绝对静音，它只是状态同步，不值一声提示音 */
const PROGRESS_KINDS = new Set(["progress"]);

/**
 * 通知内容组装（纯函数）。
 *
 * 策略：
 *   - 成功类：urgency=normal、**不静音**（silent=false）。理由：用户此刻很可能已经
 *     切走干别的了，生成完成正是他希望被提醒的事；一声轻提示音是有信息量的。
 *     只有在同批任务里已经报过进度时（progress）才静音，避免连环响。
 *   - 失败类：urgency=critical + 静音。理由：失败需要"更硬的可见性"（部分平台会
 *     让 critical 通知常驻/置顶），但不该用声音连续惩罚用户 —— 批处理失败可能一次
 *     弹好几条，响成一片比不弹更烦。
 *
 * @param {{kind?: string, title?: string, body?: string, ok?: boolean, count?: number, appName?: string}} input
 * @returns {{title: string, body: string, silent: boolean, urgency: "normal"|"critical"}}
 */
function buildNotification({ kind, title, body, ok = true, count = 0, appName } = {}) {
  try {
    const name = safeString(appName, "").trim() || DEFAULT_APP_NAME;
    const n = safeCount(count);
    const rawKind = safeString(kind, "").trim().toLowerCase();
    // ok=false 是更强的信号：即使调用方把 kind 写成 "done"，失败也要按失败渲染
    const isFailure = ok === false || FAILURE_KINDS.has(rawKind);
    const isProgress = PROGRESS_KINDS.has(rawKind);

    // 标题：调用方显式传的优先；否则按 kind 查表；再否则按 ok 兜底。
    let resolvedTitle = safeString(title, "").trim();
    if (!resolvedTitle) {
      if (isFailure) resolvedTitle = NOTIFY_TITLE_BY_KIND.fail;
      else resolvedTitle = NOTIFY_TITLE_BY_KIND[rawKind] || (ok === false ? "生成失败" : "生成完成");
    }

    // 正文：调用方显式传的优先；否则按 kind 查表生成，失败时把品牌名写进去，
    // 让用户知道该切回哪个应用（白标下同时开多个品牌时这点很重要）。
    let resolvedBody = safeString(body, "").trim();
    if (!resolvedBody) {
      const tpl = NOTIFY_BODY_BY_KIND[rawKind];
      if (tpl) resolvedBody = tpl(name, n);
      else resolvedBody = isFailure ? `任务失败，请回到${name}查看` : n > 0 ? `${n} 个任务已完成` : "任务已完成";
    }

    return {
      title: resolvedTitle,
      body: resolvedBody,
      silent: isProgress ? true : isFailure, // 见上方策略说明
      urgency: isFailure ? "critical" : "normal"
    };
  } catch {
    // 组装失败也返回一个完整可用的通知描述，而不是抛给调用方
    return { title: "提示", body: "", silent: true, urgency: "normal" };
  }
}

/**
 * 创建托盘控制器。
 *
 * @param {object} deps 全部由调用方注入，本模块不 require("electron")
 * @param {Function} deps.Tray          Electron Tray 构造器
 * @param {object}   deps.Menu          Electron Menu 模块（需要 buildFromTemplate）
 * @param {object}   deps.nativeImage   Electron nativeImage（可选，用于加载图标）
 * @param {Function} deps.Notification  Electron Notification 构造器（可选，仅 notify 用）
 * @param {object}   deps.shell         Electron shell（当前未直接使用；保留在契约里，
 *                                      便于调用方在本模块之外扩展"打开日志目录"等菜单项）
 * @param {string}   deps.iconPath      托盘图标绝对路径（Windows 一般传 build/icon.ico）
 * @param {string}   deps.appName       品牌名，用于提示与通知文案
 * @param {string}   deps.tooltip       初始提示文案（留空则由 buildTooltip 生成）
 * @param {boolean}  deps.isDev         是否开发模式（决定"开发者工具"菜单项出现与否）
 * @param {Function} deps.onShow / onHide / onQuit / onToggleDevTools / onCheckUpdate
 * @param {Function} deps.log           日志函数，签名同 main.cjs 的 logLine(msg)
 */
function createTrayController({
  Tray,
  Menu,
  nativeImage,
  Notification,
  shell,
  iconPath,
  appName = DEFAULT_APP_NAME,
  tooltip = "",
  isDev = false,
  onShow,
  onHide,
  onQuit,
  onToggleDevTools,
  onCheckUpdate,
  log = () => {}
} = {}) {
  // 统一的日志出口：log 本身也可能抛（比如被传了奇怪的东西），这里再包一层。
  function logSafe(msg) {
    try {
      if (typeof log === "function") log(msg);
    } catch {
      /* 日志失败绝不能影响主流程 */
    }
  }

  /** 安全调用外部回调：菜单点击 / 通知点击都可能指向已销毁的窗口 */
  function invoke(fn, label) {
    try {
      if (typeof fn === "function") fn();
    } catch (e) {
      logSafe(`托盘：${label} 回调异常 ${e && e.message ? e.message : e}`);
    }
  }

  let tray = null;
  let created = false;
  // 状态快照。默认给一个"空闲"起点，保证 statusText() 任何时候都有话说。
  let status = { text: "空闲", running: 0, credits: undefined };

  /** 当前状态的可读中文文案 */
  function statusText() {
    try {
      const n = safeCount(status.running);
      const hasCredits =
        status.credits !== null && status.credits !== undefined && Number.isFinite(Number(status.credits));
      const parts = [safeString(status.text, "").trim() || "空闲"];
      if (n > 0) parts.push(`生成中 ${n} 个任务`);
      if (hasCredits) parts.push(`算力 ${safeCount(status.credits)}`);
      return parts.join(" · ");
    } catch {
      return "空闲";
    }
  }

  /** 当前提示文案（调用方显式给的 tooltip 优先，否则按状态拼） */
  function tooltipText() {
    const custom = safeString(tooltip, "").trim();
    if (custom) return custom;
    return buildTooltip({ appName, status: status.text, running: status.running, credits: status.credits });
  }

  /**
   * 菜单模板（纯数据，可断言）。
   *
   * 结构约定：
   *   状态行(disabled) → 显示主窗口 → 隐藏到托盘 → —— → 检查更新
   *   → —— → [开发者工具（仅 isDev）] → 退出
   *
   * 「检查更新」的 enabled 取决于调用方有没有传 onCheckUpdate：
   *   没接线的菜单项点下去毫无反应，比 disabled 更让人困惑（用户会以为程序卡了），
   *   所以宁可灰掉 —— 灰掉本身就是"此功能当前不可用"的准确表达。
   *   注意：不需要时 click 直接给 null，而不是塞一个假回调（假回调会让测试和用户
   *   都误以为功能已接通）。
   */
  function menuTemplate() {
    const items = [];

    // 一行状态（不可点）。托盘菜单最上面显示"在不在跑"，用户扫一眼就知道。
    items.push({ label: statusText(), enabled: false });

    items.push({
      label: "显示主窗口",
      click: () => invoke(onShow, "显示主窗口")
    });
    items.push({
      label: "隐藏到托盘",
      click: () => invoke(onHide, "隐藏到托盘")
    });

    items.push({ type: "separator" });

    items.push({
      label: "检查更新",
      enabled: typeof onCheckUpdate === "function",
      click: typeof onCheckUpdate === "function" ? () => invoke(onCheckUpdate, "检查更新") : null
    });

    items.push({ type: "separator" });

    // 开发模式才出现，和 main.cjs 应用菜单里的 IS_DEV 门控保持一致：
    // 正式包里给用户一个「开发者工具」入口只会带来误操作和困惑。
    if (isDev) {
      items.push({
        label: "开发者工具",
        click: () => invoke(onToggleDevTools, "开发者工具")
      });
    }

    items.push({
      label: "退出",
      click: () => invoke(onQuit, "退出")
    });

    return items;
  }

  /**
   * 重建并挂上右键菜单。
   * 缺 Menu.buildFromTemplate 或 tray.setContextMenu 时静默跳过（不崩）：
   * 测试用的假对象、以及某些平台的降级场景都可能没有这两个方法，
   * 而"菜单没刷新"远好过"整个托盘控制器炸掉"。
   */
  function refreshMenu() {
    try {
      if (!created || !tray) return;
      if (!Menu || typeof Menu.buildFromTemplate !== "function") return;
      if (typeof tray.setContextMenu !== "function") return;
      tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
      if (typeof tray.setToolTip === "function") tray.setToolTip(tooltipText());
    } catch (e) {
      logSafe(`托盘：刷新菜单失败 ${e && e.message ? e.message : e}`);
    }
  }

  /**
   * 创建托盘。**幂等**：重复调用不会重复 new Tray。
   *
   * 为什么必须幂等：create() 会被放在 app.whenReady 里，而主窗口在
   * 「登出 → 登录」流程中会重建；如果每次建窗都 new 一个 Tray，系统托盘区
   * 会堆出好几个图标（Windows 上表现为几个一模一样的图标叠着），
   * 而且旧的那些没有人再持有引用，想销毁都找不到。
   *
   * 失败（图标不存在 / 平台不支持托盘）时 catch 并返回 {ok:false,error}，
   * 同时 isCreated() 仍为 false，允许调用方后续重试 —— 不抛异常是硬要求。
   */
  function create() {
    if (created && tray) return { ok: true };
    if (typeof Tray !== "function") {
      const error = "Tray 构造器未注入";
      logSafe(`托盘：创建失败 ${error}`);
      return { ok: false, error };
    }
    try {
      // 图标由调用方给绝对路径。路径不对时 nativeImage 会返回空图，
      // 我们把它当作"能建但没图"的降级情况，不因此放弃创建托盘。
      let image = undefined;
      try {
        if (nativeImage && typeof nativeImage.createFromPath === "function" && iconPath) {
          image = nativeImage.createFromPath(iconPath);
          if (image && typeof image.isEmpty === "function" && image.isEmpty()) {
            logSafe(`托盘：图标为空（路径可能不存在）${iconPath}`);
          }
        }
      } catch (e) {
        logSafe(`托盘：图标加载失败 ${e && e.message ? e.message : e}`);
      }

      tray = image ? new Tray(image) : new Tray(iconPath);

      if (typeof tray.setToolTip === "function") tray.setToolTip(tooltipText());
      created = true;
      // 挂菜单（依赖 created=true，内部会检查）
      refreshMenu();
      logSafe("托盘：已创建");
      return { ok: true };
    } catch (e) {
      const error = e && e.message ? e.message : String(e);
      tray = null;
      created = false;
      logSafe(`托盘：创建失败 ${error}`);
      return { ok: false, error };
    }
  }

  /** 销毁托盘。重复调用安全（tray 为 null 时直接返回）。 */
  function destroy() {
    try {
      if (tray && typeof tray.destroy === "function") tray.destroy();
    } catch (e) {
      logSafe(`托盘：销毁失败 ${e && e.message ? e.message : e}`);
    } finally {
      tray = null;
      created = false;
    }
  }

  function isCreated() {
    return created === true && !!tray;
  }

  /**
   * 更新状态并刷新菜单/提示。
   * 传 undefined 的字段保持原值（部分更新），避免调用方只改 running 就把算力清掉。
   */
  function setStatus(next) {
    try {
      if (next && typeof next === "object") {
        status = {
          text: next.text === undefined ? status.text : safeString(next.text, "").trim() || "空闲",
          running: next.running === undefined ? status.running : safeCount(next.running),
          credits: next.credits === undefined ? status.credits : next.credits
        };
      }
    } catch (e) {
      logSafe(`托盘：状态更新失败 ${e && e.message ? e.message : e}`);
    }
    refreshMenu();
  }

  /**
   * 弹系统通知。
   * 策略判定在 shouldNotify / buildNotification 里（纯函数，已单测），
   * 这里只负责"挂上去"这件事。
   */
  function notify(payload) {
    try {
      const p = payload && typeof payload === "object" ? payload : {};
      const focused = p.focused === true;
      if (!shouldNotify({ focused, enabled: p.enabled, running: p.running, quiet: p.quiet })) {
        return { ok: true, skipped: true };
      }
      if (typeof Notification !== "function") {
        return { ok: false, error: "通知不可用" };
      }
      // 平台能力探测：部分 Linux 桌面 / 精简 Windows 环境没有通知服务。
      // 用 ?. 是因为 isSupported 并非所有 Electron 版本都存在。
      if (typeof Notification.isSupported === "function" && Notification.isSupported() === false) {
        return { ok: false, error: "不支持系统通知" };
      }
      const content = buildNotification({
        kind: p.kind,
        title: p.title,
        body: p.body,
        ok: p.ok,
        count: p.count,
        appName
      });
      const n = new Notification({ title: content.title, body: content.body, silent: content.silent });
      if (typeof n.show !== "function") return { ok: false, error: "通知对象缺少 show()" };
      n.show();
      logSafe(`托盘：已通知「${content.title}」`);
      return { ok: true };
    } catch (e) {
      const error = e && e.message ? e.message : String(e);
      logSafe(`托盘：通知失败 ${error}`);
      return { ok: false, error };
    }
  }

  return {
    create,
    destroy,
    isCreated,
    menuTemplate,
    setStatus,
    statusText,
    notify,
    refreshMenu
  };
}

module.exports = { createTrayController, shouldNotify, buildNotification, buildTooltip };
