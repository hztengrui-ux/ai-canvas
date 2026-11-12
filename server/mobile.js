// 手机端（微信小程序）账号会话
//
// 设计取舍（为什么这么薄）：
//   桌面端的会话键是「机器令牌」（/api/session 下发，全站 /api 都认它）。
//   手机端绝不能拿那枚令牌 —— 它绕过账号密码，发给手机等于把后门给出去。
//   但整条 RBAC 链（requireLogin / requirePerm / req.user）都是围绕
//   `accounts.currentUser(token)` 写的，重写一套权限判断既慢又容易漏。
//
//   所以这里只做一件小事：**发一枚 m_ 前缀的令牌，并用它当 accounts 的会话键**。
//   `accounts.login({ localToken: "m_xxx" })` 会把账号会话挂在这枚令牌上，
//   于是 accounts.currentUser("m_xxx") 就是真实用户，后续接口一行都不用改。
//
// 与桌面端的两点差异：
//   1. 有效期 7 天（桌面 12 小时）：手机是"掏出来看一眼"，天天重登会被骂。
//   2. 滑动续期：剩余不足 1 天时自动续到 7 天（见 resolve）。
import crypto from "node:crypto";
import * as accounts from "./accounts.js";

/** 手机端令牌前缀，用来和 64 位机器令牌区分 */
export const MOBILE_PREFIX = "m_";

/** 手机端会话有效期：7 天 */
export const MOBILE_TTL = 7 * 24 * 60 * 60 * 1000;

/** 剩余不足 1 天就续期（避免每个请求都写 sessions.json） */
const REFRESH_BELOW = 24 * 60 * 60 * 1000;

export function newMobileToken() {
  return `${MOBILE_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
}

/** 形状校验：只认 m_ + 64 位 hex，避免把任意字符串丢进 accounts 里查 */
export function isMobileToken(token) {
  return typeof token === "string" && /^m_[0-9a-f]{64}$/.test(token);
}

/**
 * 手机端登录。
 * @returns {{ok:boolean, token?:string, expiresIn?:number, user?:object, code?:string, error?:string}}
 */
export function login({ username, password, ip = "", ua = "" } = {}) {
  const token = newMobileToken();
  // 复用 accounts.login：账号密码校验、失败锁定、停用判断、审计字段全在那一处，
  // 这里再写一遍只会有两份不一致的登录规则。
  const r = accounts.login({ username, password, localToken: token, ip, ua });
  if (!r.ok) return r;
  accounts.extendSession(token, MOBILE_TTL);
  return { ok: true, token, expiresIn: MOBILE_TTL, user: r.user };
}

/**
 * 把令牌解析成用户（同时做滑动续期）。
 * 返回 null 表示令牌无效/已过期。
 */
export function resolve(token) {
  if (!isMobileToken(token)) return null;
  const user = accounts.currentUser(token);
  if (!user) return null;
  const s = accounts.sessionOf(token);
  if (s && Number(s.expiresAt || 0) - Date.now() < REFRESH_BELOW) {
    accounts.extendSession(token, MOBILE_TTL);
  }
  return user;
}

export function logout(token) {
  if (!isMobileToken(token)) return false;
  accounts.logout(token);
  return true;
}

export function sessionOf(token) {
  return isMobileToken(token) ? accounts.sessionOf(token) : null;
}
