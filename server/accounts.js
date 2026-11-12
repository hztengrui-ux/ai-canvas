// 账号与会话：首次启动引导创建管理员，密码用 scrypt 加盐哈希，会话内存态 + 过期
import fs from "node:fs";
import crypto from "node:crypto";
import { deptMap, roleNamesOf, permissionsOf } from "./rbac.js";
import { dataFile, HOME as DIR } from "./paths.js";

const USERS_FILE = dataFile("users.json");

const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 小时（未勾选「记住这台设备」）
// 勾选「记住这台设备」后的有效期。桌面端是本机应用，30 天免登录是常见做法；
// 12 小时会在"隔一晚再打开"时必然弹登录框，用户体感就是"这软件老要我登录"。
const REMEMBER_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天
const MAX_FAIL = 5; // 连续失败锁定阈值
const LOCK_MS = 5 * 60 * 1000; // 锁定时长

// token -> { userId, username, loginAt, expiresAt, ip, ua }
// 桌面端要求「记住登录」：会话必须落盘，否则内置服务每次重启都会
// 重新生成会话令牌，用户每次开应用都得重新登录一遍。
const sessions = new Map();
// username -> { fail, lockedUntil }
const failures = new Map();

const SESSIONS_FILE = dataFile("sessions.json");

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    const now = Date.now();
    for (const [token, s] of Object.entries(raw?.sessions || {})) {
      if (s && s.expiresAt > now) sessions.set(token, s);
    }
  } catch {
    /* 首次运行没有文件，正常 */
  }
}

function saveSessions() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify({ sessions: Object.fromEntries(sessions) }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );
  } catch {
    /* 落盘失败不影响本次会话 */
  }
}

// 进程启动就把有效会话读回来
loadSessions();

// ---------- 存储 ----------
function readUsers() {
  try {
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    return Array.isArray(raw?.users) ? raw.users : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
}

// ---------- 密码 ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash: derived };
}

function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(String(expected || ""), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- 对外：账号是否存在 ----------
export function hasAccounts() {
  return readUsers().length > 0;
}

// 去掉凭据字段后的完整档案（运营系统用）
export function listUsersFull() {
  const depts = deptMap();
  return readUsers().map((u) => {
    const { salt, hash, ...safe } = u;
    return {
      ...safe,
      nickname: safe.nickname || safe.username,
      email: safe.email || "",
      phone: safe.phone || "",
      deptId: safe.deptId || "",
      deptName: depts[safe.deptId] || "",
      roleIds: safe.roleIds?.length ? safe.roleIds : ["r-operator"],
      roleNames: roleNamesOf(safe.roleIds?.length ? safe.roleIds : ["r-operator"]),
      status: safe.status || "active",
      dataScope: safe.dataScope || "all",
      lastLoginIp: safe.lastLoginIp || "",
      lastLoginAt: safe.lastLoginAt || "",
      createdAt: safe.createdAt || ""
    };
  });
}

export function getUser(id) {
  return listUsersFull().find((u) => u.id === id) || null;
}

export function listUsers() {
  return readUsers().map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || ""
  }));
}

/** 首位账号自动成为超级管理员，其余默认运营 */
function defaultRoleIds(isFirst) {
  return [isFirst ? "r-super" : "r-operator"];
}

const isSuperUser = (actor) => Boolean(actor?.roleIds?.includes("r-super"));
const isSuperId = (id) => readUsers().some((u) => u.id === id && (u.roleIds || []).includes("r-super"));

/**
 * ⚠️ 2026-10-14 修复（越权提权）：只有超级管理员才能授予 r-super。
 *
 * 原实现里「运营」这个默认角色就带 admin:account:create / admin:account:edit，
 * 而 createUser / updateUser 对入参 roleIds 完全没有白名单校验，于是：
 *   - POST /api/admin/accounts 带 roleIds:["r-super"] → 直接造出一个超管
 *   - PUT  /api/admin/accounts/<自己> 带 roleIds:["r-super"] → 自我提权（实测权限 8→15）
 * 三条利用路径里这条最短，根本不需要改自己的角色。
 */
function assertCanGrantSuper(roleIds, actor) {
  if (!Array.isArray(roleIds) || !roleIds.includes("r-super")) return;
  if (!isSuperUser(actor)) {
    throw new Error("只有超级管理员可以授予超级管理员角色");
  }
}

export function createUser({
  username,
  password,
  role = "admin",
  nickname = "",
  email = "",
  phone = "",
  deptId = "",
  roleIds = null,
  dataScope = "all"
}, actor = null) {
  const name = String(username || "").trim();
  if (name.length < 2) throw new Error("用户名至少 2 个字符");
  if (String(password || "").length < 6) throw new Error("密码至少 6 位");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不正确");
  if (phone && !/^1\d{10}$/.test(phone)) throw new Error("手机号需为 11 位");

  const users = readUsers();
  if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    throw new Error("该用户名已存在");
  }

  // 首次初始化（users 为空）没有「操作者」概念，此时允许直接建超管；
  // 之后的任何创建都必须通过 assertCanGrantSuper。
  if (users.length > 0) assertCanGrantSuper(roleIds, actor);

  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID().slice(0, 8),
    username: name,
    nickname: nickname || name,
    role,
    email,
    phone,
    deptId,
    roleIds: roleIds?.length ? roleIds : defaultRoleIds(users.length === 0),
    status: "active",
    dataScope,
    salt,
    hash,
    createdAt: new Date().toISOString(),
    lastLoginAt: "",
    lastLoginIp: ""
  };
  users.push(user);
  writeUsers(users);
  return { id: user.id, username: user.username, role: user.role, roleIds: user.roleIds };
}

// ---------- 运营系统：账号维护 ----------
export function updateUser(id, patch = {}, actor = null) {
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx < 0) throw new Error("账号不存在");

  const u = users[idx];
  if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
    throw new Error("邮箱格式不正确");
  }
  if (patch.phone && !/^1\d{10}$/.test(patch.phone)) throw new Error("手机号需为 11 位");
  if (
    patch.nickname != null &&
    patch.nickname !== "" &&
    String(patch.nickname).length > 20
  ) {
    throw new Error("昵称最多 20 个字符");
  }

  // ⚠️ 2026-10-14 修复（越权提权）：改角色时也要走「谁能授予超管」的校验，
  // 否则运营角色可以直接把自己写成 r-super。
  if (patch.roleIds) assertCanGrantSuper(patch.roleIds, actor);

  // ⚠️ 2026-10-14 修复：非超管不得改动超管账号（防「运营把超管降级/停用」）
  if (isSuperId(id) && !isSuperUser(actor)) {
    throw new Error("只有超级管理员可以修改超级管理员账号");
  }

  // 保住最后一个超级管理员，避免把自己锁在门外
  const wasSuper = (u.roleIds || []).includes("r-super");
  const willBeSuper = patch.roleIds ? patch.roleIds.includes("r-super") : wasSuper;
  if (wasSuper && !willBeSuper) {
    const supers = users.filter((x) => (x.roleIds || []).includes("r-super"));
    if (supers.length <= 1) throw new Error("至少保留一名超级管理员");
  }

  for (const k of ["nickname", "email", "phone", "deptId", "dataScope"]) {
    if (patch[k] != null) u[k] = patch[k];
  }
  if (patch.roleIds) u.roleIds = patch.roleIds;
  writeUsers(users);
  return getUser(id);
}

export function deleteUser(id, actor = null) {
  const users = readUsers();
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error("账号不存在");
  // 2026-10-14：非超管不得删除超管账号
  if ((u.roleIds || []).includes("r-super") && !isSuperUser(actor)) {
    throw new Error("只有超级管理员可以删除超级管理员账号");
  }
  if ((u.roleIds || []).includes("r-super")) {
    const supers = users.filter((x) => (x.roleIds || []).includes("r-super"));
    if (supers.length <= 1) throw new Error("至少保留一名超级管理员");
  }
  writeUsers(users.filter((x) => x.id !== id));
  return true;
}

export function setUserStatus(id, status) {
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx < 0) throw new Error("账号不存在");
  if (users[idx].status !== "disabled" && status === "disabled") {
    const supers = users.filter((x) => (x.roleIds || []).includes("r-super"));
    const isSuper = (users[idx].roleIds || []).includes("r-super");
    if (isSuper && supers.length <= 1) throw new Error("至少保留一名可用的超级管理员");
  }
  users[idx].status = status;
  writeUsers(users);
  return getUser(id);
}

export function adminResetPassword(id, newPassword, actor = null) {
  if (String(newPassword || "").length < 6) throw new Error("新密码至少 6 位");
  const users = readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx < 0) throw new Error("账号不存在");
  // ⚠️ 2026-10-14 修复（越权接管）：重置超管密码 = 直接接管系统。
  // 原实现只要持有 admin:account:reset（默认「运营」角色就有）即可重置超管密码，
  // 实测：运营重置超管密码后用新密码登录超管成功。现在要求操作者本身是超管。
  if ((users[idx].roleIds || []).includes("r-super") && !isSuperUser(actor)) {
    throw new Error("只有超级管理员可以重置超级管理员的密码");
  }
  const { salt, hash } = hashPassword(newPassword);
  users[idx].salt = salt;
  users[idx].hash = hash;
  writeUsers(users);
  return true;
}

// ---------- 登录 / 登出 ----------
export function login({ username, password, localToken, ip = "", ua = "", remember = false }) {
  const name = String(username || "").trim();
  const key = name.toLowerCase();

  const lock = failures.get(key);
  if (lock?.lockedUntil && Date.now() < lock.lockedUntil) {
    const left = Math.ceil((lock.lockedUntil - Date.now()) / 1000);
    return { ok: false, code: "LOCKED", error: `尝试次数过多，请 ${left} 秒后再试` };
  }

  const user = readUsers().find((u) => u.username.toLowerCase() === key);
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    const cur = failures.get(key) || { fail: 0, lockedUntil: 0 };
    cur.fail += 1;
    if (cur.fail >= MAX_FAIL) {
      cur.lockedUntil = Date.now() + LOCK_MS;
      cur.fail = 0;
    }
    failures.set(key, cur);
    return { ok: false, code: "BAD_CREDENTIALS", error: "用户名或密码不正确" };
  }

  failures.delete(key);

  // 停用的账号即使密码正确也不放行
  if ((user.status || "active") === "disabled") {
    return { ok: false, code: "DISABLED", error: "该账号已被停用，请联系管理员" };
  }

  // 用本地令牌当会话键，避免再引一层 cookie
  const token = localToken || crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    role: user.role,
    loginAt: Date.now(),
    // 勾了「记住这台设备」→ 30 天；否则 12 小时。
    // 桌面端隔一晚再打开必然过期，用户体感就是"这软件老要我登录"。
    expiresAt: Date.now() + (remember ? REMEMBER_TTL : SESSION_TTL),
    ip,
    ua
  });

  const users = readUsers();
  const idx = users.findIndex((u) => u.id === user.id);
  if (idx >= 0) {
    users[idx].lastLoginAt = new Date().toISOString();
    users[idx].lastLoginIp = ip || "";
    writeUsers(users);
  }
  saveSessions();

  return {
    ok: true,
    token,
    user: publicUser(users[idx] || user)
  };
}

/** 对外暴露的安全用户对象（不含凭据） */
function publicUser(u) {
  const roleIds = u.roleIds?.length ? u.roleIds : ["r-operator"];
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname || u.username,
    role: u.role,
    roleIds,
    roleNames: roleNamesOf(roleIds),
    perms: permissionsOf(roleIds),
    deptId: u.deptId || "",
    deptName: deptMap()[u.deptId] || "",
    dataScope: u.dataScope || "all",
    status: u.status || "active",
    email: u.email || "",
    phone: u.phone || ""
  };
}

export { publicUser };

export function logout(token) {
  const existed = sessions.delete(token);
  saveSessions();
  return { ok: true, existed };
}

export function sessionOf(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    saveSessions();
    return null;
  }
  return s;
}

export function currentUser(token) {
  const s = sessionOf(token);
  if (!s) return null;
  const u = readUsers().find((x) => x.id === s.userId);
  if (!u) return null;
  if ((u.status || "active") === "disabled") {
    sessions.delete(token);
    return null;
  }
  return publicUser(u);
}

/** 强制下线：清掉该用户的全部会话 */
export function killSessions(userId) {
  let n = 0;
  for (const [k, v] of sessions) {
    if (v.userId === userId) {
      sessions.delete(k);
      n += 1;
    }
  }
  if (n) saveSessions();
  return n;
}

/**
 * 踢掉某个用户的**其它**会话，保留 keepToken 这一条。
 * 手机端改密后用：改完密码还把旧设备留在登录态，等于改了个寂寞。
 */
export function killOtherSessions(userId, keepToken) {
  let n = 0;
  for (const [k, v] of sessions) {
    if (v.userId === userId && k !== keepToken) {
      sessions.delete(k);
      n += 1;
    }
  }
  if (n) saveSessions();
  return n;
}

/**
 * 延长会话有效期（手机端滑动续期用）。
 *
 * 为什么需要：桌面端会话 12 小时足够（人就在电脑前，重登一次不痛）。
 * 手机端是"掏出来看一眼"，12 小时意味着每天都要输一遍密码 —— 实际会被用户骂。
 * 所以手机端令牌登录时给 7 天，并在剩余不足 1 天时续一次（见 mobile.js）。
 *
 * 不存在的令牌返回 false（不凭空造会话）。
 */
export function extendSession(token, ttlMs = SESSION_TTL) {
  const s = sessions.get(token);
  if (!s) return false;
  s.expiresAt = Date.now() + ttlMs;
  saveSessions();
  return true;
}

// ---------- 改密 ----------
export function changePassword({ token, oldPassword, newPassword }) {
  const s = sessionOf(token);
  if (!s) throw new Error("登录已失效，请重新登录");
  if (String(newPassword || "").length < 6) throw new Error("新密码至少 6 位");

  const users = readUsers();
  const idx = users.findIndex((u) => u.id === s.userId);
  if (idx < 0) throw new Error("账号不存在");
  if (!verifyPassword(oldPassword, users[idx].salt, users[idx].hash)) {
    throw new Error("原密码不正确");
  }

  const { salt, hash } = hashPassword(newPassword);
  users[idx].salt = salt;
  users[idx].hash = hash;
  writeUsers(users);
  return true;
}

// ---------- 会话清理 ----------
/**
 * 老版本账号没有 roleIds / status / dataScope 等字段，启动时补齐一次。
 * 规则：原本 role=admin 的视为超级管理员，其余为运营。
 */
export function migrateUsers() {
  const users = readUsers();
  if (!users.length) return 0;

  let changed = 0;
  for (const u of users) {
    if (!u.roleIds?.length) {
      u.roleIds = u.role === "admin" ? ["r-super"] : ["r-operator"];
      changed += 1;
    }
    if (!u.status) u.status = "active";
    if (!u.dataScope) u.dataScope = "all";
    if (!u.nickname) u.nickname = u.username;
  }

  // 兜底：确保至少有一名超级管理员
  if (!users.some((u) => (u.roleIds || []).includes("r-super"))) {
    users[0].roleIds = ["r-super"];
    changed += 1;
  }

  if (changed) writeUsers(users);
  return changed;
}

export function sweepSessions() {
  const now = Date.now();
  let removed = 0;
  for (const [k, v] of sessions) {
    if (now > v.expiresAt) {
      sessions.delete(k);
      removed += 1;
    }
  }
  if (removed) saveSessions();
  return removed;
}

export function sessionCount() {
  return sessions.size;
}
