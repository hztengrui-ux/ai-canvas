// 运营系统接口：全部走「权限码校验 + 行级数据权限」双层拦截
// 控制面接口不碰数据面（素材/产出），保持控制面/数据面分离
import * as accounts from "./accounts.js";
import * as rbac from "./rbac.js";
import * as audit from "./audit.js";

function ctx(req, user) {
  return {
    username: user?.username || "-",
    ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().split(",")[0].trim(),
    ua: req.headers["user-agent"] || ""
  };
}

/**
 * 行级数据权限：按 dataScope 过滤账号列表
 * all → 全量；dept → 本部门及子部门；self → 仅本人；custom → 指定的部门集合
 */
function applyDataScope(rows, user) {
  if (!user) return [];
  if ((user.roleIds || []).includes("r-super") || user.dataScope === "all") return rows;

  if (user.dataScope === "self") {
    return rows.filter((r) => r.id === user.id);
  }
  if (user.dataScope === "dept") {
    const scope = new Set(rbac.deptSubtree(user.deptId));
    return rows.filter((r) => r.id === user.id || scope.has(r.deptId));
  }
  if (user.dataScope === "custom") {
    const scope = new Set(user.customDeptIds || []);
    return rows.filter((r) => r.id === user.id || scope.has(r.deptId));
  }
  return rows;
}

export function mountAdmin(app, { requirePerm, requireLogin }) {
  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      if (!res.headersSent) res.status(400).json({ error: err.message || "操作失败" });
    }
  };

  const log = (req, action, detail = {}) =>
    audit.record("admin.action", { action, ...detail }, ctx(req, req.user));

  // ---------- 运营看板 ----------
  app.get(
    "/api/admin/overview",
    requireLogin,
    requirePerm("admin:dashboard:view"),
    wrap((req) => {
      const users = accounts.listUsersFull();
      const stats = audit.stats(7);
      return {
        accounts: {
          total: users.length,
          active: users.filter((u) => u.status === "active").length,
          disabled: users.filter((u) => u.status === "disabled").length,
          online: users.filter((u) => rbac.activeTokenCount(u.id) > 0).length
        },
        roles: rbac.listRoles().length,
        depts: rbac.listDepts().length,
        audit: stats,
        recent: audit.query({ limit: 12, days: 7 })
      };
    })
  );

  // ---------- 账号管理 ----------
  app.get(
    "/api/admin/accounts",
    requireLogin,
    requirePerm("admin:account:view"),
    wrap((req) => {
      const { keyword = "", status = "", deptId = "", roleId = "" } = req.query;
      let rows = accounts.listUsersFull();

      // 行级数据权限先行，再做条件筛选
      rows = applyDataScope(rows, req.user);

      const kw = String(keyword).trim().toLowerCase();
      if (kw) {
        rows = rows.filter(
          (r) =>
            r.username.toLowerCase().includes(kw) ||
            (r.nickname || "").toLowerCase().includes(kw) ||
            (r.email || "").toLowerCase().includes(kw) ||
            (r.phone || "").includes(kw)
        );
      }
      if (status) rows = rows.filter((r) => r.status === status);
      if (deptId) rows = rows.filter((r) => r.deptId === deptId);
      if (roleId) rows = rows.filter((r) => (r.roleIds || []).includes(roleId));

      return {
        rows: rows.map((r) => ({ ...r, online: rbac.activeTokenCount(r.id) > 0 })),
        total: rows.length
      };
    })
  );

  app.post(
    "/api/admin/accounts",
    requireLogin,
    requirePerm("admin:account:create"),
    wrap((req) => {
      const created = accounts.createUser(req.body || {}, req.user);
      log(req, "新增账号", { target: created.username });
      return { ok: true, user: accounts.getUser(created.id) };
    })
  );

  app.put(
    "/api/admin/accounts/:id",
    requireLogin,
    requirePerm("admin:account:edit"),
    wrap((req) => {
      const before = accounts.getUser(req.params.id);
      const after = accounts.updateUser(req.params.id, req.body || {}, req.user);
      log(req, "编辑账号", { target: after.username, from: before?.roleNames, to: after.roleNames });
      return { ok: true, user: after };
    })
  );

  app.delete(
    "/api/admin/accounts/:id",
    requireLogin,
    requirePerm("admin:account:delete"),
    wrap((req) => {
      const target = accounts.getUser(req.params.id);
      // 2026-10-14：删除 / 停用 / 强制下线超管，都要求操作者本身是超管
      if (target?.roleIds?.includes("r-super") && !req.user?.roleIds?.includes("r-super")) {
        throw new Error("只有超级管理员可以删除超级管理员账号");
      }
      accounts.deleteUser(req.params.id);
      rbac.revokeUserTokens(req.params.id);
      accounts.killSessions(req.params.id);
      log(req, "删除账号", { target: target?.username || req.params.id });
      return { ok: true };
    })
  );

  app.post(
    "/api/admin/accounts/:id/status",
    requireLogin,
    requirePerm("admin:account:edit"),
    wrap((req) => {
      const before = accounts.getUser(req.params.id);
      if (before?.roleIds?.includes("r-super") && !req.user?.roleIds?.includes("r-super")) {
        throw new Error("只有超级管理员可以停用/启用超级管理员账号");
      }
      const user = accounts.setUserStatus(req.params.id, req.body?.status);
      if (user.status === "disabled") {
        accounts.killSessions(user.id);
        rbac.revokeUserTokens(user.id);
      }
      log(req, user.status === "disabled" ? "停用账号" : "启用账号", { target: user.username });
      return { ok: true, user };
    })
  );

  app.post(
    "/api/admin/accounts/:id/reset",
    requireLogin,
    requirePerm("admin:account:reset"),
    wrap((req) => {
      accounts.adminResetPassword(req.params.id, req.body?.password, req.user);
      accounts.killSessions(req.params.id);
      rbac.revokeUserTokens(req.params.id);
      log(req, "重置密码", { target: accounts.getUser(req.params.id)?.username });
      return { ok: true };
    })
  );

  app.post(
    "/api/admin/accounts/:id/kick",
    requireLogin,
    requirePerm("admin:account:kick"),
    wrap((req) => {
      const targetUser = accounts.getUser(req.params.id);
      if (targetUser?.roleIds?.includes("r-super") && !req.user?.roleIds?.includes("r-super")) {
        throw new Error("只有超级管理员可以强制超管下线");
      }
      const n = accounts.killSessions(req.params.id);
      rbac.revokeUserTokens(req.params.id);
      log(req, "强制下线", { target: accounts.getUser(req.params.id)?.username, sessions: n });
      return { ok: true, sessions: n };
    })
  );

  // ---------- 角色与权限 ----------
  app.get(
    "/api/admin/roles",
    requireLogin,
    requirePerm("admin:role:view"),
    wrap(() => {
      const users = accounts.listUsersFull();
      return {
        rows: rbac.listRoles().map((r) => ({
          ...r,
          memberCount: users.filter((u) => (u.roleIds || []).includes(r.id)).length
        })),
        permissions: rbac.PERMISSIONS,
        dataScopes: rbac.DATA_SCOPES
      };
    })
  );

  app.post(
    "/api/admin/roles",
    requireLogin,
    requirePerm("admin:role:edit"),
    wrap((req) => {
      const role = rbac.upsertRole(req.body || {});
      log(req, req.body?.id ? "编辑角色" : "新增角色", { target: role.name });
      return { ok: true, role };
    })
  );

  app.delete(
    "/api/admin/roles/:id",
    requireLogin,
    requirePerm("admin:role:edit"),
    wrap((req) => {
      const role = rbac.listRoles().find((r) => r.id === req.params.id);
      rbac.deleteRole(req.params.id);
      log(req, "删除角色", { target: role?.name || req.params.id });
      return { ok: true };
    })
  );

  // ---------- 组织架构 ----------
  app.get(
    "/api/admin/depts",
    requireLogin,
    requirePerm("admin:dept:view"),
    wrap(() => {
      const users = accounts.listUsersFull();
      return {
        rows: rbac.listDepts().map((d) => ({
          ...d,
          memberCount: users.filter((u) => u.deptId === d.id).length
        }))
      };
    })
  );

  app.post(
    "/api/admin/depts",
    requireLogin,
    requirePerm("admin:dept:edit"),
    wrap((req) => {
      const dept = rbac.upsertDept(req.body || {});
      log(req, req.body?.id ? "编辑部门" : "新增部门", { target: dept.name });
      return { ok: true, dept };
    })
  );

  app.delete(
    "/api/admin/depts/:id",
    requireLogin,
    requirePerm("admin:dept:edit"),
    wrap((req) => {
      const dept = rbac.listDepts().find((d) => d.id === req.params.id);
      rbac.deleteDept(req.params.id);
      log(req, "删除部门", { target: dept?.name || req.params.id });
      return { ok: true };
    })
  );

  // ---------- 日志审计 ----------
  app.get(
    "/api/admin/logs",
    requireLogin,
    requirePerm("admin:log:view"),
    wrap((req) => ({
      events: audit.query({
        limit: Math.min(Number(req.query.limit) || 200, 500),
        level: String(req.query.level || ""),
        type: String(req.query.type || ""),
        days: Math.min(Number(req.query.days) || 7, 30)
      })
    }))
  );

  // ---------- 客户端密钥 ----------
  app.get(
    "/api/admin/apikeys",
    requireLogin,
    requirePerm("admin:apikey:view"),
    wrap(() => ({ rows: rbac.listApiKeys() }))
  );

  app.post(
    "/api/admin/apikeys/:id/rotate",
    requireLogin,
    requirePerm("admin:apikey:rotate"),
    wrap((req) => {
      const out = rbac.rotateApiKey(req.params.id);
      log(req, "轮换密钥", { target: out.id });
      // 明文只在此刻返回一次
      return { ok: true, plain: out.plain };
    })
  );
}
