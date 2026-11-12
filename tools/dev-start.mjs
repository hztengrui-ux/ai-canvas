#!/usr/bin/env node
/**
 * ai-canvas 开发模式一键启动器（2026-11-03 恢复开发状态时新增）
 *
 * 作用：一条命令拉起「Vite 开发服务器 + Electron 桌面端（dev 模式）」，并落到
 *      DSH 工作区内的 profile 目录，保证在 DSH 会话环境里也能稳定启动。
 *
 * 用法：
 *   node tools/dev-start.mjs                 # 后台启动（默认）
 *   node tools/dev-start.mjs --status        # 查看当前状态
 *   node tools/dev-start.mjs --stop          # 停止 vite + electron
 *   node tools/dev-start.mjs --restart       # 先停再起
 *   node tools/dev-start.mjs --foreground    # 前台运行 electron（Ctrl+C 结束，便于看日志）
 *   node tools/dev-start.mjs --cdp=9222      # 额外打开 Chrome DevTools 调试端口（仅 dev）
 *   node tools/dev-start.mjs --api-port=5181 # 后端端口（默认 5181）
 *   node tools/dev-start.mjs --vite-port=5180
 *   node tools/dev-start.mjs --profile=E:\DSH项目\ai-canvas\.devprofile
 *
 * 关键约束（2026-11-03 实测，写入此文件以免后人重复踩坑）：
 *   1. Electron 的 --user-data-dir 必须位于 DSH 工作区（E:\DSH项目）之内，否则
 *      `process_singleton_win.cc(465) Lock file can not be created! Error code: 5`
 *      进程秒退。默认 profile 因此放在项目内 .devprofile/。
 *   2. 在 DSH 的 shell 里 spawn 时环境变量 ELECTRON_RUN_AS_NODE=1 会让 electron.exe
 *      退化成 node，必须删除；同时传 --no-sandbox 才能绕过 Chromium 沙箱初始化失败
 *      （0x80000003 STATUS_BREAKPOINT）。
 *   3. dev 模式以设置 AI_CANVAS_DEV_URL 为标志（electron/main.cjs 的 IS_DEV），
 *      dev 模式下不启用生产锁定、保留 DevTools 菜单、跳过自动更新。
 *   4. 页面数据仍写 AI_CANVAS_HOME（默认 E:\ai-canvas-data）；若该目录不可写可
 *      用 --home=... 指定到项目内 .rundata。
 *   5. **dev 模式下 Electron 主进程不会启动后端**（electron/main.cjs:229
 *      `if (IS_DEV) return DEV_URL;`），所以必须另起 `node server/index.js`，
 *      否则页面报「无法建立本地会话」。本启动器已经把后端一起拉起（默认 5181，
 *      与 vite.config.js 的 /api 代理目标一致）。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp');
const PID_FILE = path.join(TMP, 'ai-canvas-dev.json');
const VITE_LOG = path.join(TMP, 'vite-dev.log');
const SERVER_LOG = path.join(TMP, 'server-dev.log');
const ELECTRON_LOG = path.join(TMP, 'electron-dev.log');

const argv = process.argv.slice(2);
function opt(name, def) {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const i = hit.indexOf('=');
  return i < 0 ? true : hit.slice(i + 1);
}

const VITE_PORT = Number(opt('vite-port', process.env.AI_CANVAS_DEV_PORT || 5180));
const API_PORT = Number(opt('api-port', process.env.PORT || 5181));
const PROFILE = path.resolve(ROOT, String(opt('profile', path.join(ROOT, '.devprofile'))));
const CDP = opt('cdp', '');
const HOME = path.resolve(String(opt('home', process.env.AI_CANVAS_HOME || 'E:\\ai-canvas-data')));
const VITE_URL = `http://127.0.0.1:${VITE_PORT}`;

const mode = argv.includes('--stop') ? 'stop'
  : argv.includes('--status') ? 'status'
  : argv.includes('--restart') ? 'restart'
  : argv.includes('--foreground') ? 'foreground'
  : 'start';

const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) { console.log(...a); }
function warn(...a) { console.warn(...a); }

function ensureTmp() { fs.mkdirSync(TMP, { recursive: true }); }

function readPids() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return null; }
}
function writePids(obj) { ensureTmp(); fs.writeFileSync(PID_FILE, JSON.stringify(obj, null, 2)); }
function clearPids() { try { fs.unlinkSync(PID_FILE); } catch {} }

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(1200);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function waitHttp(url, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

function tail(file, n = 12) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
    return lines.slice(-n).join('\n');
  } catch { return '(无日志)'; }
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

/** 找出命令行里带指定关键字的进程（用于 stop 时兜底回收） */
function findProcesses(keyword) {
  const ps = [
    '-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${keyword.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId`,
  ];
  const r = spawnSync('powershell', ps, { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => n > 0);
}

function envForChild() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.AI_CANVAS_DEV_URL = VITE_URL;
  env.AI_CANVAS_HOME = HOME;
  env.AI_CANVAS_MATERIALS = path.join(HOME, 'materials');
  env.AI_CANVAS_OUTPUTS = path.join(HOME, 'outputs');
  env.PORT = String(API_PORT);
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  return env;
}

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.join(HOME, 'materials'), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'outputs'), { recursive: true });
}

async function startBackend() {
  const url = `http://127.0.0.1:${API_PORT}/api/session`;
  if (await portOpen(API_PORT)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { log(`- 后端已在 http://127.0.0.1:${API_PORT} 运行，复用`); return { reused: true }; }
    } catch {}
    warn(`- 端口 ${API_PORT} 被占用但不是本项目的后端，未启动后端（请先 --stop 或换 --api-port）`);
    return { reused: true };
  }
  const entry = path.join(ROOT, 'server', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`找不到后端入口: ${entry}`);
  ensureTmp();
  const out = fs.openSync(SERVER_LOG, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT, env: envForChild(), detached: true, windowsHide: true, stdio: ['ignore', out, out],
  });
  child.unref();
  const ok = await waitHttp(url, 30000);
  if (!ok) throw new Error(`后端启动失败，最后日志：\n${tail(SERVER_LOG, 25)}`);
  log(`- 后端已启动 http://127.0.0.1:${API_PORT}（pid ${child.pid}，日志 .tmp/server-dev.log）`);
  return { pid: child.pid };
}

async function startVite() {
  if (await portOpen(VITE_PORT)) {
    if (await waitHttp(VITE_URL, 4000)) { log(`- Vite 已在 ${VITE_URL} 运行，复用`); return { reused: true }; }
    warn(`- 端口 ${VITE_PORT} 被占用但 HTTP 不响应，未启动 Vite（请先 --stop 或换 --vite-port）`);
    return { reused: true };
  }
  if (!fs.existsSync(VITE_BIN)) throw new Error(`找不到 vite: ${VITE_BIN}`);
  ensureTmp();
  const out = fs.openSync(VITE_LOG, 'a');
  const child = spawn(process.execPath, [VITE_BIN, '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
    cwd: ROOT, env: envForChild(), detached: true, windowsHide: true, stdio: ['ignore', out, out],
  });
  child.unref();
  const ok = await waitHttp(VITE_URL);
  if (!ok) throw new Error(`Vite 启动失败，最后日志：\n${tail(VITE_LOG, 25)}`);
  log(`- Vite 已启动 ${VITE_URL}（pid ${child.pid}，日志 .tmp/vite-dev.log）`);
  return { pid: child.pid };
}

function electronArgs() {
  const args = ['.', '--no-sandbox', `--user-data-dir=${PROFILE}`];
  if (CDP) args.push(`--remote-debugging-port=${CDP}`);
  return args;
}

async function startElectron({ foreground = false } = {}) {
  if (!fs.existsSync(ELECTRON_EXE)) throw new Error(`找不到 electron: ${ELECTRON_EXE}（先 npm install --ignore-scripts）`);
  fs.mkdirSync(PROFILE, { recursive: true });
  const env = envForChild();
  if (foreground) {
    log('- Electron 前台运行，Ctrl+C 结束');
    const child = spawn(ELECTRON_EXE, electronArgs(), { cwd: ROOT, env, stdio: 'inherit' });
    const code = await new Promise((r) => child.on('exit', r));
    process.exit(code || 0);
  }
  ensureTmp();
  const out = fs.openSync(ELECTRON_LOG, 'a');
  const child = spawn(ELECTRON_EXE, electronArgs(), {
    cwd: ROOT, env, detached: true, windowsHide: false, stdio: ['ignore', out, out],
  });
  child.unref();
  // 等待主进程 ready（boot.log 里出现「启动完成」，或日志里出现登录页加载完成）
  const bootLog = path.join(PROFILE, 'boot.log');
  const end = Date.now() + 45000;
  let ready = false;
  while (Date.now() < end) {
    if (!pidAlive(child.pid)) break;
    const boot = fs.existsSync(bootLog) ? fs.readFileSync(bootLog, 'utf8') : '';
    const elog = fs.existsSync(ELECTRON_LOG) ? fs.readFileSync(ELECTRON_LOG, 'utf8') : '';
    if (boot.includes('启动完成') || elog.includes('启动完成') || elog.includes('页面加载完成')) { ready = true; break; }
    await sleep(500);
  }
  if (!ready) {
    if (!pidAlive(child.pid)) {
      throw new Error(`Electron 已退出，最后日志：\n${tail(ELECTRON_LOG, 30)}`);
    }
    warn('- 45s 内未看到就绪日志，窗口可能仍在加载，请查看 .tmp/electron-dev.log');
  } else {
    log(`- Electron 已启动（pid ${child.pid}，profile ${PROFILE}，日志 .tmp/electron-dev.log）`);
  }
  return { pid: child.pid };
}

function printStatus() {
  const pids = readPids();
  portOpen(VITE_PORT).then(async (viteUp) => {
    const httpOk = viteUp ? await waitHttp(VITE_URL, 2000) : false;
    log(`Vite     ${VITE_URL}  -> ${httpOk ? '运行中' : '未运行'}`);
    log(`后端     http://127.0.0.1:${API_PORT}  -> ${(await portOpen(API_PORT)) ? '运行中' : '未运行'}`);
    const eAlive = pids && pidAlive(pids.electronPid);
    log(`Electron (pid ${pids ? pids.electronPid : '-'}) -> ${eAlive ? '运行中' : '未运行'}`);
    log(`profile: ${pids ? pids.profile : PROFILE}`);
    log(`AI_CANVAS_HOME: ${pids ? pids.home : HOME}`);
    if (pids && pids.startedAt) log(`启动于: ${pids.startedAt}`);
  });
}

async function stop() {
  const pids = readPids();
  if (pids) {
    if (pids.electronPid && pidAlive(pids.electronPid)) { killTree(pids.electronPid); log(`- 已停止 Electron pid ${pids.electronPid}`); }
    if (pids.vitePid && pidAlive(pids.vitePid)) { killTree(pids.vitePid); log(`- 已停止 Vite pid ${pids.vitePid}`); }
    if (pids.backendPid && pidAlive(pids.backendPid)) { killTree(pids.backendPid); log(`- 已停止后端 pid ${pids.backendPid}`); }
  }
  // 兜底：按命令行关键字回收（pid 文件可能过期）
  for (const pid of findProcesses(path.basename(PROFILE))) { killTree(pid); log(`- 兜底停止进程 pid ${pid}`); }
  for (const pid of findProcesses(`vite.js --host 127.0.0.1 --port ${VITE_PORT}`)) { killTree(pid); log(`- 兜底停止 Vite pid ${pid}`); }
  for (const pid of findProcesses(path.join(ROOT, 'server', 'index.js'))) { killTree(pid); log(`- 兜底停止后端 pid ${pid}`); }
  clearPids();
  log('已停止。');
}

async function main() {
  if (mode === 'status') return printStatus();
  if (mode === 'stop') return stop();
  if (mode === 'restart') {
    await stop();
    await sleep(600);
  }
  ensureHome();
  log(`ai-canvas 开发模式启动：${ROOT}`);
  log(`  页面 ${VITE_URL}  后端 http://127.0.0.1:${API_PORT}  数据 ${HOME}`);
  if (CDP) log(`  DevTools 调试端口 ${CDP}（dev 模式可用）`);
  const be = await startBackend();
  const vite = await startVite();
  const el = await startElectron({ foreground: mode === 'foreground' });
  const prev = readPids() || {};
  writePids({
    backendPid: be.pid || prev.backendPid || null,
    vitePid: vite.pid || prev.vitePid || null,
    electronPid: el.pid,
    profile: PROFILE,
    home: HOME,
    vitePort: VITE_PORT,
    apiPort: API_PORT,
    cdpPort: CDP || null,
    startedAt: new Date().toISOString(),
  });
  log('启动完成。停止用: node tools/dev-start.mjs --stop');
}

main().catch(async (e) => {
  warn(`启动失败：${e.message}`);
  try {
    const pids = readPids();
    if (pids && pids.electronPid && !pidAlive(pids.electronPid)) clearPids();
  } catch {}
  process.exitCode = 1;
});
