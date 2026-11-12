/**
 * 托盘与系统通知自测（Sprint 2 · 纯逻辑侧）
 * --------------------------------------------------------------------------
 * 为什么这样测：
 *   electron/tray.cjs 的真身要 Tray / Notification / Menu 才能跑，而这些东西只有
 *   真实 Electron 进程里才有。所以模块本身**不 require("electron")**，全靠注入；
 *   于是这里可以塞十行假对象，在纯 node 下把「幂等」「失败不抛」「菜单结构」
 *   「前台不打扰」这些边界全部钉死 —— 不需要起 Electron，也不用装依赖。
 *
 * 本文件是 ESM（package.json 里 type=module），被测文件是 .cjs：
 *   用 createRequire 拿 CJS require。注意 Windows 上不能用绝对路径当 ESM 说明符
 *   （file:// 才是合法 URL），createRequire 恰好绕开这个坑。
 *
 * 运行：node electron/__tray.test.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tray = require("./tray.cjs");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 假的 Electron：够用的 10 行 stub。
// 关键点是能**计数**（trayConstructions），这样幂等才能被证明而不是靠感觉。
// ---------------------------------------------------------------------------
function makeFakeElectron({ throwOnTray = false, notifySupported = true } = {}) {
  const state = {
    trayConstructions: 0,
    setContextMenuCalls: 0,
    setToolTipCalls: 0,
    destroyCalls: 0,
    notifications: [], // {title, body, silent}
    lastMenuTemplate: null
  };

  class FakeTray {
    constructor(image) {
      state.trayConstructions += 1;
      if (throwOnTray) throw new Error("图标读取失败：ENOENT");
      this.image = image;
    }
    setToolTip(t) {
      state.setToolTipCalls += 1;
      this.tooltip = t;
    }
    setContextMenu(m) {
      state.setContextMenuCalls += 1;
      this.menu = m;
    }
    destroy() {
      state.destroyCalls += 1;
    }
  }

  const fakeMenu = {
    buildFromTemplate(template) {
      state.lastMenuTemplate = template;
      return { items: template };
    }
  };

  const fakeNativeImage = {
    createFromPath(p) {
      return { path: p, isEmpty: () => false };
    }
  };

  class FakeNotification {
    constructor(opts) {
      this.opts = opts;
      state.notifications.push(opts);
    }
    show() {
      this.shown = true;
    }
    static isSupported() {
      return notifySupported;
    }
  }

  return { state, Tray: FakeTray, Menu: fakeMenu, nativeImage: fakeNativeImage, Notification: FakeNotification, shell: {} };
}

const ICON = "E:\\DSH项目\\ai-canvas\\build\\icon.ico";

function makeController(overrides = {}) {
  const env = makeFakeElectron(overrides.env || {});
  const calls = { show: 0, hide: 0, quit: 0, devtools: 0, checkUpdate: 0 };
  const logs = [];
  const ctl = tray.createTrayController({
    Tray: env.Tray,
    Menu: env.Menu,
    nativeImage: env.nativeImage,
    Notification: env.Notification,
    shell: env.shell,
    iconPath: ICON,
    appName: "AI 创作台",
    isDev: false,
    onShow: () => {
      calls.show += 1;
    },
    onHide: () => {
      calls.hide += 1;
    },
    onQuit: () => {
      calls.quit += 1;
    },
    onToggleDevTools: () => {
      calls.devtools += 1;
    },
    log: (m) => logs.push(m),
    ...(overrides.controller || {})
  });
  return { ctl, env, calls, logs };
}

// ===========================================================================
console.log("\n[1] create() 成功 + 幂等（底层 new Tray 只调一次）");
{
  const { ctl, env, logs } = makeController();

  const r1 = ctl.create();
  check("首次 create 返回 ok", r1.ok === true, JSON.stringify(r1));
  check("isCreated() === true", ctl.isCreated() === true);
  check("底层 new Tray 被调用 1 次", env.state.trayConstructions === 1, `got ${env.state.trayConstructions}`);
  check("已写过一行日志", logs.length >= 1, logs.join(" | "));

  const r2 = ctl.create();
  const r3 = ctl.create();
  check("重复 create 仍返回 ok", r2.ok === true && r3.ok === true);
  check(
    "重复 create 不会重复 new Tray（幂等）",
    env.state.trayConstructions === 1,
    `got ${env.state.trayConstructions}`
  );
  check("create 时挂了 tooltip", env.state.setToolTipCalls >= 1);
  check("create 时挂了右键菜单", env.state.setContextMenuCalls >= 1);
}

// ===========================================================================
console.log("\n[2] new Tray 抛错（图标不存在）→ ok:false 且不抛，可重试");
{
  const { ctl, env, logs } = makeController({ env: { throwOnTray: true } });

  let threw = false;
  let res = null;
  try {
    res = ctl.create();
  } catch {
    threw = true;
  }
  check("create 抛错时不向外抛异常", threw === false);
  check("返回 {ok:false}", res && res.ok === false, JSON.stringify(res));
  check("error 是字符串且非空", typeof res?.error === "string" && res.error.length > 0, String(res?.error));
  check("isCreated() 仍为 false（允许重试）", ctl.isCreated() === false);
  check("失败也写了日志", logs.some((l) => String(l).includes("创建失败")), logs.join(" | "));
  check("失败时底层确实尝试过 new Tray", env.state.trayConstructions >= 1);

  // 重试：同一控制器再 create 一次仍然只是"再试一次"，不会因为上一次失败而卡死
  const again = ctl.create();
  check("失败后可再次重试（仍不抛）", again.ok === false && ctl.isCreated() === false);
}

// ===========================================================================
console.log("\n[3] menuTemplate() 结构 + isDev 门控");
{
  const { ctl } = makeController({ controller: { isDev: false } });
  const t = ctl.menuTemplate();

  const labels = t.map((i) => i.label).filter(Boolean);
  const separators = t.filter((i) => i.type === "separator");

  check("模板是非空数组", Array.isArray(t) && t.length > 0);
  check("首项是状态行（disabled 的 label）", t[0].enabled === false && typeof t[0].label === "string", JSON.stringify(t[0]));
  check("含「显示主窗口」", labels.includes("显示主窗口"), labels.join(","));
  check("含「隐藏到托盘」", labels.includes("隐藏到托盘"), labels.join(","));
  check("含「退出」", labels.includes("退出"), labels.join(","));
  check("含分隔线", separators.length >= 1, `got ${separators.length}`);
  check("有「检查更新」项", labels.includes("检查更新"), labels.join(","));

  check("isDev:false 时没有「开发者工具」", !labels.includes("开发者工具"), labels.join(","));

  // 退出项真的接着 onQuit
  const quitItem = t.find((i) => i.label === "退出");
  let quitThrew = false;
  try {
    quitItem.click();
  } catch {
    quitThrew = true;
  }
  check("退出项 click 不抛", quitThrew === false);

  // 显示 / 隐藏 也接到回调
  const showItem = t.find((i) => i.label === "显示主窗口");
  const hideItem = t.find((i) => i.label === "隐藏到托盘");
  check("显示/隐藏项都有 click 函数", typeof showItem.click === "function" && typeof hideItem.click === "function");

  const devEnv = makeController({ controller: { isDev: true } });
  const devLabels = devEnv.ctl.menuTemplate().map((i) => i.label).filter(Boolean);
  check("isDev:true 时出现「开发者工具」", devLabels.includes("开发者工具"), devLabels.join(","));
  check("isDev:true 时开发者工具在退出之前", devLabels.indexOf("开发者工具") < devLabels.indexOf("退出"));
}

/** 菜单点击是否按预期打到注入的回调上（用独立控制器，避免污染上面的计数） */
function makeControllerQuitCheck() {
  const { ctl, calls } = makeController();
  ctl.menuTemplate().find((i) => i.label === "退出").click();
  return calls.quit === 1;
}

// ===========================================================================
console.log("\n[4] onCheckUpdate 决定「检查更新」是否 enabled");
{
  const without = makeController();
  const itemWithout = without.ctl.menuTemplate().find((i) => i.label === "检查更新");
  check("未提供 onCheckUpdate → enabled === false", itemWithout.enabled === false, JSON.stringify(itemWithout));
  check("未提供时 click 为 null（不放假回调误导用户）", itemWithout.click === null, String(itemWithout.click));

  let withCbCalls = 0;
  const withCb = makeController({
    controller: {
      onCheckUpdate: () => {
        withCbCalls += 1;
      }
    }
  });
  const itemWith = withCb.ctl.menuTemplate().find((i) => i.label === "检查更新");
  check("提供 onCheckUpdate → enabled === true", itemWith.enabled === true, JSON.stringify(itemWith));
  check("提供时 click 是函数", typeof itemWith.click === "function");
  itemWith.click();
  check("click 真的调到 onCheckUpdate", withCbCalls === 1, `got ${withCbCalls}`);

  // 显示/隐藏/退出在同一个控制器上确实打到各自回调
  const wired = makeController();
  const t = wired.ctl.menuTemplate();
  t.find((i) => i.label === "显示主窗口").click();
  t.find((i) => i.label === "隐藏到托盘").click();
  t.find((i) => i.label === "退出").click();
  check(
    "显示/隐藏/退出分别打到 onShow/onHide/onQuit",
    wired.calls.show === 1 && wired.calls.hide === 1 && wired.calls.quit === 1,
    JSON.stringify(wired.calls)
  );
}

// ===========================================================================
console.log("\n[5] setStatus / statusText / refreshMenu");
{
  const { ctl, env } = makeController();
  ctl.create();
  const before = env.state.setContextMenuCalls;

  ctl.setStatus({ text: "正在生成 2 个任务", running: 2, credits: 500 });
  const s = ctl.statusText();
  check("statusText 含任务数 2", s.includes("2"), s);
  check("statusText 含算力 500", s.includes("500"), s);
  check("statusText 是中文可读文案", /[\u4e00-\u9fa5]/.test(s), s);
  check(
    "setStatus 真的调用了 tray.setContextMenu（刷新菜单）",
    env.state.setContextMenuCalls > before,
    `${before} → ${env.state.setContextMenuCalls}`
  );

  // 菜单顶部状态行跟着变
  const top = ctl.menuTemplate()[0];
  check("菜单首行跟着状态更新", top.label === s, `top=${top.label} status=${s}`);

  // 部分更新：只改 running 不应把算力抹掉
  ctl.setStatus({ running: 0 });
  check("部分更新保留 credits", ctl.statusText().includes("500"), ctl.statusText());

  // 脏数据不崩
  let dirtyThrew = false;
  try {
    ctl.setStatus({ running: "abc", credits: null });
    ctl.setStatus(undefined);
    ctl.setStatus(null);
  } catch {
    dirtyThrew = true;
  }
  check("脏状态输入不抛", dirtyThrew === false);
  check("脏 running 归零而不显示 NaN", !ctl.statusText().includes("NaN"), ctl.statusText());
}

// ===========================================================================
console.log("\n[6] shouldNotify 策略：前台不打扰");
{
  check("窗口在前台 → false（不打扰正在看的用户）", tray.shouldNotify({ focused: true }) === false);
  check("enabled:false → false（用户关了通知）", tray.shouldNotify({ focused: false, enabled: false }) === false);
  check("quiet:true → false（勿扰模式）", tray.shouldNotify({ focused: false, quiet: true }) === false);
  check("后台且正常 → true", tray.shouldNotify({ focused: false }) === true);
  check("后台且有任务 → true", tray.shouldNotify({ focused: false, running: 3 }) === true);
  check("前台 + enabled:false 同时命中仍 false", tray.shouldNotify({ focused: true, enabled: false }) === false);
  check("enabled:false 优先级最高（即使后台）", tray.shouldNotify({ focused: false, enabled: false, quiet: false }) === false);
  check("focused 缺省按不打扰处理（保守）", tray.shouldNotify({}) === false);
}

// ===========================================================================
console.log("\n[7] buildNotification：成功 / 失败文案与紧急度不同");
{
  const ok = tray.buildNotification({ kind: "done", appName: "AI 创作台", count: 2 });
  const bad = tray.buildNotification({ kind: "fail", appName: "AI 创作台", count: 2, ok: false });

  check("成功标题与失败标题不同", ok.title !== bad.title, `${ok.title} vs ${bad.title}`);
  check("成功正文与失败正文不同", ok.body !== bad.body, `${ok.body} vs ${bad.body}`);
  check("失败 urgency === critical", bad.urgency === "critical", bad.urgency);
  check("成功 urgency === normal", ok.urgency === "normal", ok.urgency);
  check("成功不静音（生成完该被听见）", ok.silent === false, String(ok.silent));
  check("失败静音（批量失败不连续响）", bad.silent === true, String(bad.silent));
  check("成功正文含任务数", ok.body.includes("2"), ok.body);
  check("失败正文含品牌名，便于用户知道切回哪个应用", bad.body.includes("AI 创作台"), bad.body);
  check("标题都是非空字符串", typeof ok.title === "string" && ok.title.length > 0 && typeof bad.title === "string" && bad.title.length > 0);

  // ok:false 压过错误的 kind
  const forced = tray.buildNotification({ kind: "done", ok: false });
  check("ok:false 压过 kind:\"done\" → 按失败渲染", forced.urgency === "critical", forced.urgency);

  // 进度类静音
  const prog = tray.buildNotification({ kind: "progress", count: 1 });
  check("progress 静音", prog.silent === true && prog.urgency === "normal");

  // 显式 title/body 优先
  const custom = tray.buildNotification({ kind: "done", title: "T", body: "B" });
  check("显式 title/body 优先", custom.title === "T" && custom.body === "B");
}

// ===========================================================================
console.log("\n[8] buildTooltip：三种输入互不相同且都含 appName");
{
  const idle = tray.buildTooltip({ appName: "AI 创作台" });
  const busy = tray.buildTooltip({ appName: "AI 创作台", running: 2 });
  const rich = tray.buildTooltip({ appName: "AI 创作台", running: 2, credits: 500 });

  console.log(`      idle = ${idle}`);
  console.log(`      busy = ${busy}`);
  console.log(`      rich = ${rich}`);

  check("三种输出互不相同", idle !== busy && busy !== rich && idle !== rich);
  check("三种输出都含 appName", [idle, busy, rich].every((t) => t.includes("AI 创作台")));
  check("有任务时含任务数 2", busy.includes("2"), busy);
  check("带算力时含 500", rich.includes("500"), rich);
  check("无任务无算力时含「空闲」", idle.includes("空闲"), idle);
  check("无任务但有算力也报算力", tray.buildTooltip({ appName: "X", credits: 9 }).includes("9"));
  check("自定义 status 文案被采用", tray.buildTooltip({ appName: "X", status: "已暂停" }).includes("已暂停"));
}

// ===========================================================================
console.log("\n[9] notify()：宿主策略 + 不支持通知 + 注入对象被真正使用");
{
  const { ctl, env } = makeController();
  ctl.create();

  const skipped = ctl.notify({ focused: true, kind: "done" });
  check("前台 → 跳过且不构造 Notification", skipped.ok === true && env.state.notifications.length === 0, JSON.stringify(skipped));

  const shown = ctl.notify({ focused: false, kind: "done", count: 1 });
  check("后台 → ok:true", shown.ok === true, JSON.stringify(shown));
  check("真的调用了注入的 Notification", env.state.notifications.length === 1, `got ${env.state.notifications.length}`);
  const n0 = env.state.notifications[0];
  check("通知带 title/body/silent", typeof n0.title === "string" && typeof n0.body === "string" && typeof n0.silent === "boolean", JSON.stringify(n0));
  check("成功通知 silent=false", n0.silent === false, String(n0.silent));

  ctl.notify({ focused: false, kind: "fail", ok: false });
  check("失败通知进到 Notification", env.state.notifications.length === 2);
  check("失败通知 silent=true", env.state.notifications[1].silent === true);

  const unsupported = makeController({ env: { notifySupported: false } });
  unsupported.ctl.create();
  const r = unsupported.ctl.notify({ focused: false, kind: "done" });
  check("Notification.isSupported() === false → ok:false", r.ok === false, JSON.stringify(r));
  check("error 文案为「不支持系统通知」", r.error === "不支持系统通知", String(r.error));
  check("不支持时不构造 Notification", unsupported.env.state.notifications.length === 0);

  // 没注入 Notification 也不能崩
  const noNotif = makeController({ controller: { Notification: undefined } });
  noNotif.ctl.create();
  let noNotifThrew = false;
  let r2 = null;
  try {
    r2 = noNotif.ctl.notify({ focused: false });
  } catch {
    noNotifThrew = true;
  }
  check("未注入 Notification 时不抛，返回 ok:false", noNotifThrew === false && r2.ok === false, JSON.stringify(r2));
}

// ===========================================================================
console.log("\n[10] destroy()：状态复位、可重复调用、回调抛错被吞掉");
{
  const { ctl, env } = makeController();
  ctl.create();
  ctl.destroy();
  check("destroy 后 isCreated() === false", ctl.isCreated() === false);
  check("底层 tray.destroy() 被调用", env.state.destroyCalls === 1, `got ${env.state.destroyCalls}`);

  let twiceThrew = false;
  try {
    ctl.destroy();
    ctl.destroy();
  } catch {
    twiceThrew = true;
  }
  check("重复 destroy 不抛", twiceThrew === false);
  check("重复 destroy 不会重复销毁底层对象", env.state.destroyCalls === 1, `got ${env.state.destroyCalls}`);

  // destroy 之后 setStatus / refreshMenu 不能崩（托盘已没了）
  let afterThrew = false;
  try {
    ctl.setStatus({ running: 1 });
    ctl.refreshMenu();
    ctl.menuTemplate();
  } catch {
    afterThrew = true;
  }
  check("destroy 后 setStatus/refreshMenu 不抛", afterThrew === false);

  // destroy 后可以重建（登出→登录场景）
  const r = ctl.create();
  check("destroy 后可重新 create", r.ok === true && ctl.isCreated() === true);
  check("重建后底层经历 2 次 new Tray", env.state.trayConstructions === 2, `got ${env.state.trayConstructions}`);

  // 回调抛错：菜单点击不能把主进程带崩
  const boom = tray.createTrayController({
    Tray: makeFakeElectron().Tray,
    Menu: makeFakeElectron().Menu,
    iconPath: ICON,
    onShow: () => {
      throw new Error("窗口已销毁");
    },
    log: () => {}
  });
  boom.create();
  let cbThrew = false;
  try {
    boom.menuTemplate().find((i) => i.label === "显示主窗口").click();
  } catch {
    cbThrew = true;
  }
  check("回调抛错被吞掉（不冒泡到主进程）", cbThrew === false);
}

// ===========================================================================
console.log("\n[11] 缺方法/缺构造器的降级：静默跳过而不是崩");
{
  // 注入的 Menu 没有 buildFromTemplate
  const envNoMenu = makeFakeElectron();
  const ctlNoMenu = tray.createTrayController({
    Tray: envNoMenu.Tray,
    Menu: {},
    iconPath: ICON,
    log: () => {}
  });
  let noMenuThrew = false;
  let created = null;
  try {
    created = ctlNoMenu.create();
    ctlNoMenu.setStatus({ running: 1 });
  } catch {
    noMenuThrew = true;
  }
  check("Menu 缺 buildFromTemplate 时 create 仍 ok", created?.ok === true, JSON.stringify(created));
  check("Menu 缺方法时刷新不抛", noMenuThrew === false);

  // 完全没有 Tray
  const ctlNoTray = tray.createTrayController({ Tray: undefined, log: () => {} });
  const r = ctlNoTray.create();
  check("未注入 Tray → ok:false 且不抛", r.ok === false, JSON.stringify(r));
  check("未注入 Tray 时 isCreated() === false", ctlNoTray.isCreated() === false);

  // 完全不传参数（最恶劣情况）
  let bareThrew = false;
  try {
    const bare = tray.createTrayController();
    bare.create();
    bare.setStatus({ running: 2 });
    bare.statusText();
    bare.menuTemplate();
    bare.notify({ focused: false });
    bare.refreshMenu();
    bare.destroy();
  } catch {
    bareThrew = true;
  }
  check("零参数调用全流程不抛", bareThrew === false);
}

console.log(`\n托盘与通知：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
