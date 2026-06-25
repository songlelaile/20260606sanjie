import "server-only";
import { prisma } from "./db";
import type { Role } from "./auth";

export interface AuthAccount {
  username: string;
  password: string;
  name: string;
  role: Role; // 登录权限角色
  tenantId: string;
}

/**
 * 登录校验：按用户名查库并比对密码（演示用明文比对；生产应改加盐哈希）。
 * 返回 "disabled" 表示账号密码正确但已被管理员禁用。
 */
export async function findAccount(
  username: string,
  password: string
): Promise<AuthAccount | "disabled" | null> {
  const user = await prisma.user.findUnique({ where: { username: username.trim() } });
  if (!user || user.password !== password) {
    return null;
  }
  if (user.status === "disabled") {
    return "disabled";
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
  return {
    username: user.username,
    password: user.password,
    name: user.name,
    role: user.authRole === "admin" ? "admin" : "tenant",
    tenantId: user.tenantId
  };
}

/**
 * 校验「已登录会话对应的账号是否仍然有效」（未被禁用、未被删除）。
 * 供采集插件登录门槛端点 /api/auth/me 用：验签通过后再查一次库，
 * 让管理员禁用/删除账号后即时生效，而不必等会话自然过期（最长 8h）。
 * 只按用户名查、不校验密码（调用方已通过 HMAC 验签确认会话真实性）。
 */
export async function isAccountActive(username: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { username: username.trim() } });
  if (!user) return false;                 // 已删除
  if (user.status === "disabled") return false; // 已禁用
  return true;
}

/** 校验待注册账号的基本字段（长度、是否重名）。 */
export async function validateRegistration(input: {
  username: string;
  password: string;
}): Promise<string | null> {
  const username = input.username.trim();
  // 账号即手机号：大陆 11 位，1 开头，第二位 3-9。
  if (!/^1[3-9]\d{9}$/.test(username)) {
    return "请输入正确的 11 位手机号";
  }
  if (input.password.length < 6) {
    return "密码至少 6 个字符";
  }
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return "该手机号已注册";
  }
  return null;
}

/** 在指定租户下创建一个运营账号（注册即加入邀请码所属租户）。 */
export async function createTenantOperator(input: {
  tenantId: string;
  username: string;
  password: string;
  name: string;
  shopName: string;
}): Promise<AuthAccount> {
  const user = await prisma.user.create({
    data: {
      tenantId: input.tenantId,
      username: input.username.trim(),
      password: input.password,
      name: input.name.trim() || input.username.trim(),
      authRole: "tenant",
      role: "operator",
      shopName: input.shopName
    }
  });
  return {
    username: user.username,
    password: user.password,
    name: user.name,
    role: "tenant",
    tenantId: user.tenantId
  };
}
