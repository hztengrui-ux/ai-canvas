// RBAC 权限底座：权限码、角色、组织架构、数据范围
// 控制面（角色/权限/组织）与数据面（素材/产出）分离：这里只管控制面
import fs from "node:fs";
import crypto from "node:crypto";
import { dataFile, HOME as DIR } from "./paths.js";

const ROLES_FILE = dataFile("roles.json");
const DEPTS_FILE = dataFile("depts.json");
const KEYS_FILE = dataFile("apikeys.json");
const TOKENS_FILE = dataFile("refresh-tokens.json");

// ---------- 权限码矩阵（接口级权限，后端强制校验） ----------
export const PERMISSIONS = [
  { code: "admin:dashboard:view", group: "运营看板", label: "查看看板" },
  { code: "admin:account:view", group: "账号管理", label: "查看账号" },
  { code: "admin:account:create", group: "账号管理", label: "新增账号" },
  { code: "admin:account:edit", group: "账号管理", label: "编辑账号" },
  { code: "admin:account:delete", group: "账号管理", label: "删除账号" },
  { code: "admin:account:reset", group: "账号管理", label: "重置密码" },
  { code: "admin:account:kick", group: "账号管理", label: "强制下线" },
  { code: "admin:role:view", group: "角色权限", label: "查看角色" },
  { code: "admin:role:edit", group: "角色权限", label: "编辑角色" },
  { code: "admin:dept:view", group: "组织架构", label: "查看部门" },
  { code: "admin:dept:edit", group: "组织架构", label: "编辑部门" },
  { code: "admin:log:view", group: "日志审计", label: "查看日志" },
  { code: "admin:apikey:view", group: "客户端密钥", label: "查看密钥" },
  { code: "admin:apikey:rotate", group: "客户端密钥", label: "轮换密钥" },
  { code: "admin:customer:view", group: "客户中心", label: "查看客户" },
  { code: "admin:customer:edit", group: "客户中心", label: "编辑客户档案 / 人工调账" },
  { code: "admin:recharge:view", group: "充值管理", label: "查看充值订单与统计" },
  { code: "admin:recharge:manage", group: "充值管理", label: "补单 / 退款 / 改价 / 自动管理" },
  { code: "admin:payment:view", group: "支付通道", label: "查看支付通道" },
  { code: "admin:payment:config", group: "支付通道", label: "配置与测试支付通道" },
  { code: "admin:setting:edit", group: "系统设置", label: "修改设置" }
];

export const ALL_CODES = PERMISSIONS.map((p) => p.code);

// 数据范围枚举
export const DATA_SCOPES = [
  { value: "all", label: "全部数据" },
  { value: "dept", label: "本部门及子部门" },
  { value: "self", label: "仅本人" },
  { value: "custom", label: "自定义范围" }
];

// ---------- 默认种子数据 ----------
const DEFAULT_ROLES = [
  {
    id: "r-super",
    name: "超级管理员",
    code: "super_admin",
    remark: "拥有全部权限，不受数据范围限制",
    builtin: true,
    perms: ALL_CODES
  },
  {
    id: "r-operator",
    name: "运营",
    code: "operator",
    remark: "负责日常运营与账号维护",
    builtin: true,
    perms: [
      "admin:dashboard:view",
      "admin:account:view",
      "admin:account:create",
      "admin:account:edit",
      "admin:account:reset",
      "admin:role:view",
      "admin:dept:view",
      "admin:log:view",
      "admin:customer:view",
      "admin:customer:edit",
      "admin:recharge:view",
      "admin:recharge:manage",
      "admin:payment:view"
    ]
  },
  {
    id: "r-designer",
    name: "设计师",
    code: "designer",
    remark: "仅使用创作功能，可查看本人用量",
    builtin: true,
    perms: ["admin:dashboard:view"]
  },
  {
    id: "r-auditor",
    name: "审核员",
    code: "auditor",
    remark: "负责内容与操作审计",
    builtin: true,
    perms: [
      "admin:dashboard:view",
      "admin:account:view",
      "admin:log:view",
      "admin:customer:view",
      "admin:recharge:view",
      "admin:payment:view"
    ]
  }
];

const DEFAULT_DEPTS = [
  { id: "d-root", name: "跨多多科技", parentId: "", sort: 0 },
  { id: "d-ai", name: "AI 创作中心", parentId: "d-root", sort: 1 },
  { id: "d-ops", name: "运营部", parentId: "d-root", sort: 2 },
  { id: "d-design", name: "设计部", parentId: "d-ai", sort: 3 },
  { id: "d-review", name: "审核组", parentId: "d-ops", sort: 4 }
];

// ---------- 通用读写 ----------
function readJson(file, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
}

function hiddenCode(len = 32) {
  return crypto.randomBytes(len).toString("hex").slice(0, len);
}

// ---------- 角色 ----------
// 权限码只增不减：老安装的 roles.json 里内置角色不会自动带上新权限码，
// 这里用一次性版本标记做增量合并（之后管理员手工取消的权限不会被反复加回）。
const PERM_SYNC_FILE = dataFile("perm-sync.json");
const PERM_VERSION = 2;

function syncBuiltinPerms(roles) {
  try {
    const marker = readJson(PERM_SYNC_FILE, { version: 1 });
    if ((marker.version || 1) >= PERM_VERSION) return roles;
    let changed = false;
    for (const role of roles) {
      const def = DEFAULT_ROLES.find((r) => r.id === role.id);
      if (!def || !role.builtin) continue;
      const merged = [...new Set([...(role.perms || []), ...def.perms])];
      if (merged.length !== (role.perms || []).length) {
        role.perms = merged;
        changed = true;
      }
    }
    if (changed) writeJson(ROLES_FILE, roles);
    writeJson(PERM_SYNC_FILE, { version: PERM_VERSION });
    return roles;
  } catch {
    return roles;
  }
}

export function listRoles() {
  const roles = readJson(ROLES_FILE, null);
  if (!roles) {
    writeJson(ROLES_FILE, DEFAULT_ROLES);
    return DEFAULT_ROLES;
  }
  return syncBuiltinPerms(roles);
}

export function roleByCode(code) {
  return listRoles().find((r) => r.code === code) || null;
}

export function upsertRole({ id, name, code, remark, perms }) {
  const roles = listRoles();
  const clean = (perms || []).filter((p) => ALL_CODES.includes(p));

  if (id) {
    const idx = roles.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error("角色不存在");
    if (roles[idx].builtin && code && code !== roles[idx].code) {
      throw new Error("内置角色的标识不可修改");
    }
    if (name) roles[idx].name = name;
    if (remark != null) roles[idx].remark = remark;
    if (perms) roles[idx].perms = clean;
    writeJson(ROLES_FILE, roles);
    return roles[idx];
  }

  if (!name) throw new Error("请填写角色名称");
  const finalCode = code || `role_${hiddenCode(6)}`;
  if (roles.some((r) => r.code === finalCode)) throw new Error("角色标识已存在");

  const role = {
    id: `r-${hiddenCode(8)}`,
    name,
    code: finalCode,
    remark: remark || "",
    builtin: false,
    perms: clean
  };
  roles.push(role);
  writeJson(ROLES_FILE, roles);
  return role;
}

export function deleteRole(id) {
  const roles = listRoles();
  const role = roles.find((r) => r.id === id);
  if (!role) throw new Error("角色不存在");
  if (role.builtin) throw new Error("内置角色不可删除");
  writeJson(
    ROLES_FILE,
    roles.filter((r) => r.id !== id)
  );
  return true;
}

// ---------- 权限计算 ----------
export function permissionsOf(roleIds = []) {
  const roles = listRoles();
  const set = new Set();
  for (const rid of roleIds) {
    const role = roles.find((r) => r.id === rid);
    if (role) (role.perms || []).forEach((p) => set.add(p));
  }
  return [...set];
}

export function roleNamesOf(roleIds = []) {
  const roles = listRoles();
  return roleIds.map((rid) => roles.find((r) => r.id === rid)?.name).filter(Boolean);
}

export function hasPermission(user, code) {
  if (!user) return false;
  // 超管直通，避免因角色数据异常把管理员锁死
  if ((user.roleIds || []).includes("r-super")) return true;
  return permissionsOf(user.roleIds).includes(code);
}

// ---------- 组织架构 ----------
export function listDepts() {
  const depts = readJson(DEPTS_FILE, null);
  if (!depts) {
    writeJson(DEPTS_FILE, DEFAULT_DEPTS);
    return DEFAULT_DEPTS;
  }
  return depts;
}

export function deptMap() {
  const map = {};
  for (const d of listDepts()) map[d.id] = d.name;
  return map;
}

/** 取某个部门及其全部子部门 id（行级数据权限用） */
export function deptSubtree(deptId) {
  const depts = listDepts();
  const out = new Set();
  const walk = (id) => {
    if (!id || out.has(id)) return;
    out.add(id);
    for (const d of depts) if (d.parentId === id) walk(d.id);
  };
  walk(deptId);
  return [...out];
}

export function upsertDept({ id, name, parentId, sort }) {
  const depts = listDepts();
  if (id) {
    const idx = depts.findIndex((d) => d.id === id);
    if (idx < 0) throw new Error("部门不存在");
    if (name) depts[idx].name = name;
    if (parentId != null) {
      if (parentId === id) throw new Error("不能把部门挂到自己下面");
      depts[idx].parentId = parentId;
    }
    if (sort != null) depts[idx].sort = Number(sort) || 0;
    writeJson(DEPTS_FILE, depts);
    return depts[idx];
  }
  if (!name) throw new Error("请填写部门名称");
  const dept = { id: `d-${hiddenCode(8)}`, name, parentId: parentId || "", sort: Number(sort) || 0 };
  depts.push(dept);
  writeJson(DEPTS_FILE, depts);
  return dept;
}

export function deleteDept(id) {
  const depts = listDepts();
  if (!depts.some((d) => d.id === id)) throw new Error("部门不存在");
  if (depts.some((d) => d.parentId === id)) throw new Error("请先移除该部门下的子部门");
  writeJson(
    DEPTS_FILE,
    depts.filter((d) => d.id !== id)
  );
  return true;
}

// ---------- 客户端密钥（桌面端 API Key） ----------
export function listApiKeys() {
  const keys = readJson(KEYS_FILE, null);
  if (!keys) {
    const seed = [
      {
        id: "k-desktop",
        name: "桌面客户端",
        prefix: "ak_desktop",
        // 只存哈希，明文只在生成时返回一次
        hash: crypto.createHash("sha256").update("ak_desktop_default").digest("hex"),
        status: "active",
        createdAt: new Date().toISOString(),
        rotatedAt: "",
        lastUsedAt: ""
      }
    ];
    writeJson(KEYS_FILE, seed);
    return seed.map(({ hash, ...rest }) => rest);
  }
  return keys.map(({ hash, ...rest }) => rest);
}

export function rotateApiKey(id) {
  const keys = readJson(KEYS_FILE, []);
  const idx = keys.findIndex((k) => k.id === id);
  if (idx < 0) throw new Error("密钥不存在");

  const plain = `${keys[idx].prefix}_${hiddenCode(32)}`;
  keys[idx].hash = crypto.createHash("sha256").update(plain).digest("hex");
  keys[idx].rotatedAt = new Date().toISOString();
  keys[idx].status = "active";
  writeJson(KEYS_FILE, keys);
  return { id, plain };
}

export function verifyApiKey(plain) {
  if (!plain) return false;
  const keys = readJson(KEYS_FILE, []);
  const hash = crypto.createHash("sha256").update(String(plain)).digest("hex");
  const hit = keys.find((k) => k.hash === hash && k.status === "active");
  if (!hit) return false;
  hit.lastUsedAt = new Date().toISOString();
  writeJson(KEYS_FILE, keys);
  return true;
}

// ---------- RefreshToken（可强制下线的关键） ----------
export function listRefreshTokens() {
  return readJson(TOKENS_FILE, []);
}

export function issueRefreshToken({ userId, username, clientType = "web", ip = "", ua = "" }) {
  const tokens = listRefreshTokens();
  const token = {
    token: hiddenCode(48),
    userId,
    username,
    clientType,
    ip,
    ua: String(ua).slice(0, 160),
    isValid: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString()
  };
  tokens.push(token);
  // 只保留最近 500 条，避免无限增长
  writeJson(TOKENS_FILE, tokens.slice(-500));
  return token.token;
}

export function revokeUserTokens(userId) {
  const tokens = listRefreshTokens();
  let n = 0;
  for (const t of tokens) {
    if (t.userId === userId && t.isValid) {
      t.isValid = false;
      n += 1;
    }
  }
  writeJson(TOKENS_FILE, tokens);
  return n;
}

export function activeTokenCount(userId) {
  return listRefreshTokens().filter(
    (t) => t.userId === userId && t.isValid && new Date(t.expiresAt) > new Date()
  ).length;
}

export function pruneTokens() {
  const now = Date.now();
  const tokens = listRefreshTokens().filter(
    (t) => t.isValid && new Date(t.expiresAt).getTime() > now
  );
  writeJson(TOKENS_FILE, tokens);
  return tokens.length;
}
