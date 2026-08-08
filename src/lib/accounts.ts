import "server-only";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import type { Role, Session } from "./auth";

export interface AuthAccount {
  username: string;
  name: string;
  role: Role; // 登录权限角色
  tenantId: string;
}

const PASSWORD_HASH_PREFIX = "scrypt";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;

const EMPTY_MANAGEMENT_DASHBOARD = {
  productCount: 0,
  monthlyNetSales: 0,
  monthlyProfitEstimate: 0,
  monthlyGsvOpportunity: 0,
  marketSalesGap: 0,
  historicalMarginRate: 0,
  plannedProfit: 0,
  availableAdBudget: 0,
  plannedMarginRate: 0,
  topProducts: []
};

function defaultShopIdForTenant(tenantId: string) {
  return `shop-${tenantId}`;
}

function emptyJsonArray(): Prisma.InputJsonValue {
  return [];
}

async function createBlankDefaultShop(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    shopName: string;
    createdBy: string;
  }
) {
  const shopId = defaultShopIdForTenant(input.tenantId);
  await Promise.all([
    tx.workspace.deleteMany({ where: { tenantId: input.tenantId } }),
    tx.calcRun.deleteMany({ where: { tenantId: input.tenantId } })
  ]);
  await tx.shop.create({
    data: {
      id: shopId,
      tenantId: input.tenantId,
      name: input.shopName,
      platform: "淘宝",
      createdBy: input.createdBy
    }
  });
  await tx.shopCalcRun.create({
    data: {
      tenantId: input.tenantId,
      shopId,
      runId: "",
      cycleId: "",
      createdAt: "",
      investmentResults: emptyJsonArray(),
      breakthroughResults: emptyJsonArray(),
      audiencePlans: emptyJsonArray(),
      managementDashboard: EMPTY_MANAGEMENT_DASHBOARD as Prisma.InputJsonValue
    }
  });
}

function normalizePassword(password: string): string {
  return password.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function passwordCandidates(password: string): string[] {
  const normalized = normalizePassword(password);
  return Array.from(
    new Set([
      normalized,
      password,
      `${normalized} `,
      ` ${normalized}`,
      ` ${normalized} `,
      `${normalized}\u200B`,
      `\u200B${normalized}`,
      `${normalized}\uFEFF`,
      `\uFEFF${normalized}`
    ])
  );
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return [
    PASSWORD_HASH_PREFIX,
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("hex"),
    hash.toString("hex")
  ].join("$");
}

function isPasswordHash(value: string): boolean {
  return value.startsWith(`${PASSWORD_HASH_PREFIX}$`);
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!isPasswordHash(stored)) {
    return stored === password;
  }

  const [prefix, rawN, rawR, rawP, saltHex, hashHex] = stored.split("$");
  if (prefix !== PASSWORD_HASH_PREFIX || !rawN || !rawR || !rawP || !saltHex || !hashHex) {
    return false;
  }

  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, {
      N: Number(rawN),
      r: Number(rawR),
      p: Number(rawP)
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * 登录校验：按用户名查库并用 scrypt 加盐哈希校验。
 * 历史明文账号首次成功登录后会自动升级为哈希，避免线上老账号被锁死。
 * 返回 "disabled" 表示账号密码正确但已被管理员禁用。
 */
export async function findAccount(
  username: string,
  password: string
): Promise<AuthAccount | "disabled" | null> {
  const normalizedPassword = normalizePassword(password);
  const user = await prisma.user.findUnique({ where: { username: username.trim() } });
  const matchedPassword = user
    ? passwordCandidates(password).find((candidate) => verifyPassword(candidate, user.password))
    : null;
  if (!user || matchedPassword == null) {
    return null;
  }
  if (user.status === "disabled") {
    return "disabled";
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      lastActiveAt: new Date(),
      ...(!isPasswordHash(user.password) || matchedPassword !== normalizedPassword
        ? { password: hashPassword(normalizedPassword) }
        : {})
    }
  });
  return {
    username: user.username,
    name: user.name,
    role: user.authRole === "admin" ? "admin" : "tenant",
    tenantId: user.tenantId
  };
}

/**
 * 校验「已登录会话对应的账号是否仍然有效」，并核对租户与登录角色。
 * 供采集插件登录门槛端点 /api/auth/me 用：验签通过后再查一次库，
 * 让管理员禁用、删除、迁移账号或修改登录角色后即时生效，而不必等会话自然过期。
 * 只按用户名查、不校验密码（调用方已通过 HMAC 验签确认会话真实性）。
 */
export async function isSessionAccountValid(
  session: Pick<Session, "username" | "tenantId" | "role">
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { username: session.username.trim() },
    select: { tenantId: true, authRole: true, status: true }
  });
  if (!user || user.status === "disabled") return false;
  const role: Role = user.authRole === "admin" ? "admin" : "tenant";
  return user.tenantId === session.tenantId && role === session.role;
}

/** 校验待注册账号的基本字段（长度、是否重名）。 */
export async function validateRegistration(input: {
  username: string;
  password: string;
}): Promise<string | null> {
  const username = input.username.trim();
  const password = normalizePassword(input.password);
  // 账号即手机号：大陆 11 位，1 开头，第二位 3-9。
  if (!/^1[3-9]\d{9}$/.test(username)) {
    return "请输入正确的 11 位手机号";
  }
  if (password.length < 6) {
    return "密码至少 6 个字符";
  }
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    return "该手机号已注册";
  }
  return null;
}

/** 邀请码注册：为每个租户账号创建独立租户，首次登录默认空白数据。 */
export async function createTenantOperator(input: {
  username: string;
  password: string;
  name: string;
  shopName: string;
}): Promise<AuthAccount> {
  const username = input.username.trim();
  const password = normalizePassword(input.password);
  const name = input.name.trim() || username;
  const rawShopName = input.shopName.trim();
  const shopName = rawShopName && rawShopName !== "未备注" ? rawShopName : name;
  const user = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: shopName,
        slug: `tenant-${username}-${randomBytes(3).toString("hex")}`
      }
    });
    await createBlankDefaultShop(tx, {
      tenantId: tenant.id,
      shopName,
      createdBy: name
    });
    return tx.user.create({
      data: {
        tenantId: tenant.id,
        username,
        password: hashPassword(password),
        name,
        authRole: "tenant",
        role: "operator",
        shopName
      }
    });
  });
  return {
    username: user.username,
    name: user.name,
    role: "tenant",
    tenantId: user.tenantId
  };
}

/** 邀请注册：邀请码消耗与租户账号创建保持同一事务，避免“码已用但账号未创建”。 */
export async function createTenantOperatorByInvite(input: {
  username: string;
  password: string;
  name: string;
  inviteCode: string;
}): Promise<{ ok: true; account: AuthAccount } | { ok: false; error: string }> {
  const username = input.username.trim();
  const password = normalizePassword(input.password);
  const name = input.name.trim() || username;
  const code = input.inviteCode.trim().toUpperCase();
  if (!code) {
    return { ok: false, error: "请输入邀请码" };
  }

  return prisma.$transaction(async (tx) => {
    const existingUser = await tx.user.findUnique({ where: { username } });
    if (existingUser) {
      return { ok: false, error: "该手机号已注册" };
    }

    const invite = await tx.inviteCode.findUnique({ where: { code } });
    if (!invite) {
      return { ok: false, error: "邀请码无效或已失效" };
    }
    if (invite.usedCount >= invite.maxUses) {
      return { ok: false, error: "邀请码使用次数已用尽" };
    }

    const consumed = await tx.inviteCode.updateMany({
      where: { id: invite.id, usedCount: { lt: invite.maxUses } },
      data: { usedCount: { increment: 1 } }
    });
    if (consumed.count === 0) {
      return { ok: false, error: "邀请码使用次数已用尽" };
    }

    const rawShopName = invite.note.trim();
    const shopName = rawShopName && rawShopName !== "未备注" ? rawShopName : name;
    const tenant = await tx.tenant.create({
      data: {
        name: shopName,
        slug: `tenant-${username}-${randomBytes(3).toString("hex")}`
      }
    });
    await createBlankDefaultShop(tx, {
      tenantId: tenant.id,
      shopName,
      createdBy: name
    });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        username,
        password: hashPassword(password),
        name,
        authRole: "tenant",
        role: "operator",
        shopName
      }
    });
    return {
      ok: true,
      account: {
        username: user.username,
        name: user.name,
        role: "tenant",
        tenantId: user.tenantId
      }
    };
  });
}
