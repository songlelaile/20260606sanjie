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

/** 登录校验：按用户名查库并比对密码（演示用明文比对；生产应改加盐哈希）。 */
export async function findAccount(username: string, password: string): Promise<AuthAccount | null> {
  const user = await prisma.user.findUnique({ where: { username: username.trim() } });
  if (!user || user.password !== password) {
    return null;
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

/** 校验待注册账号的基本字段（长度、是否重名）。 */
export async function validateRegistration(input: {
  username: string;
  password: string;
}): Promise<string | null> {
  const username = input.username.trim();
  if (username.length < 3) {
    return "账号至少 3 个字符";
  }
  if (input.password.length < 6) {
    return "密码至少 6 个字符";
  }
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return "该账号已存在";
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
