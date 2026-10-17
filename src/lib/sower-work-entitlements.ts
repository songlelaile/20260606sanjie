import "server-only";
import { randomUUID } from "node:crypto";
import type { Session } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { SOWER_WORK_ACCESS_DAYS, SOWER_WORK_PRODUCT_ID } from "@/lib/sower-work-product";
import { resolveToolEntitlementAccess } from "@/lib/tool-entitlements";
import type { ToolEntitlementAccess } from "@/lib/types/domain";

export class SowerWorkAccessError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}
export const NO_SOWER_WORK_ACCESS: ToolEntitlementAccess = {
  allowed: false, status: "not_granted", grantedAt: null, expiresAt: null, remainingDays: 0
};
export type SowerWorkAccount = { id: string; username: string; tenantId: string };
export type SowerWorkAccess = {
  productId: typeof SOWER_WORK_PRODUCT_ID;
  authorized: boolean;
  account: SowerWorkAccount;
  entitlement: ToolEntitlementAccess;
};
const userSelect = {
  id: true, username: true, tenantId: true, authRole: true, status: true,
  toolEntitlements: {
    where: { toolCode: SOWER_WORK_PRODUCT_ID },
    select: { status: true, grantedAt: true, expiresAt: true, note: true },
    take: 1
  }
} as const;
type SelectedUser = {
  id: string; username: string; tenantId: string; authRole: string; status: string;
  toolEntitlements: { status: string; grantedAt: Date; expiresAt: Date | null; note: string }[];
};
function accessFrom(user: SelectedUser, now = new Date()) {
  const record = user.toolEntitlements[0];
  const entitlement = resolveToolEntitlementAccess(record, now);
  return {
    access: {
      productId: SOWER_WORK_PRODUCT_ID,
      authorized: entitlement.allowed,
      account: { id: user.id, username: user.username, tenantId: user.tenantId },
      entitlement
    } satisfies SowerWorkAccess,
    // Every admin mutation rotates this value, including revoke then regrant.
    revision: record?.note ?? ""
  };
}
function requireActiveUser(user: SelectedUser | null): asserts user is SelectedUser {
  if (!user || user.status !== "active") {
    throw new SowerWorkAccessError(401, "ACCOUNT_INVALID", "账号已失效，请重新登录");
  }
}
export async function loadSowerWorkSessionAccess(session: Session, now = new Date()) {
  const user = await prisma.user.findUnique({ where: { username: session.username }, select: userSelect });
  requireActiveUser(user);
  if (user.tenantId !== session.tenantId || user.authRole !== session.role) {
    throw new SowerWorkAccessError(401, "SESSION_STALE", "会话已失效，请重新登录");
  }
  return accessFrom(user, now);
}
export async function loadSowerWorkAccountAccess(account: SowerWorkAccount, now = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: account.id }, select: userSelect });
  requireActiveUser(user);
  if (user.username !== account.username || user.tenantId !== account.tenantId) {
    throw new SowerWorkAccessError(403, "ACCOUNT_MISMATCH", "授权账号不匹配");
  }
  return accessFrom(user, now);
}
export function requireSowerWorkAccess(access: SowerWorkAccess) {
  if (!access.authorized) {
    throw new SowerWorkAccessError(403, "SOWER_WORK_NOT_AUTHORIZED",
      access.entitlement.status === "expired" ? "Sower Work 授权已到期，请联系管理员续期" : "Sower Work 尚未开通或已撤销，请联系管理员开通");
  }
}
// Neither tenant "owner" nor an old signed admin role is a grant authority.
async function requireCurrentAdmin(session: Session, db: Pick<typeof prisma, "user"> = prisma) {
  const actor = await db.user.findUnique({
    where: { username: session.username },
    select: { id: true, username: true, tenantId: true, authRole: true, status: true }
  });
  if (session.role !== "admin" || !actor || actor.status !== "active" ||
      actor.authRole !== "admin" || actor.tenantId !== session.tenantId) {
    throw new SowerWorkAccessError(403, "ADMIN_REQUIRED", "仅当前有效的官网管理员可管理授权");
  }
  return actor;
}
export async function listSowerWorkUsers(session: Session, query: { search: string; page: number }) {
  await requireCurrentAdmin(session);
  const where = query.search ? {
    OR: [{ username: { contains: query.search, mode: "insensitive" as const } },
      { name: { contains: query.search, mode: "insensitive" as const } }]
  } : {};
  const users = await prisma.user.findMany({
    where, orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: (query.page - 1) * 50, take: 51,
    select: { ...userSelect, name: true }
  });
  return {
    users: users.slice(0, 50).map(user => ({
      ...accessFrom(user).access.account, name: user.name, status: user.status,
      authRole: user.authRole, entitlement: accessFrom(user).access.entitlement
    })),
    page: query.page, hasMore: users.length > 50
  };
}
export async function setSowerWorkEntitlement(session: Session, input: { userId: string; enabled: boolean }) {
  // The service itself guards writes: a future caller cannot bypass the route guard.
  return prisma.$transaction(async tx => {
    const actor = await requireCurrentAdmin(session, tx);
    const target = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true, status: true } });
    if (!target) throw new SowerWorkAccessError(404, "USER_NOT_FOUND", "用户不存在");
    if (input.enabled && target.status !== "active") {
      throw new SowerWorkAccessError(409, "ACCOUNT_DISABLED", "请先恢复账号，再开通 Sower Work");
    }
    const grantedAt = new Date();
    const expiresAt = new Date(grantedAt.getTime() + SOWER_WORK_ACCESS_DAYS * 86_400_000);
    const shared = {
      status: input.enabled ? "active" : "revoked",
      grantedBy: actor.id + ":" + actor.username,
      note: "SOWER_COLLECTOR_GRANT_V1:" + randomUUID()
    };
    const record = await tx.toolEntitlement.upsert({
      where: { userId_toolCode: { userId: input.userId, toolCode: SOWER_WORK_PRODUCT_ID } },
      create: { userId: input.userId, toolCode: SOWER_WORK_PRODUCT_ID, ...shared, grantedAt,
        expiresAt: input.enabled ? expiresAt : null },
      update: { ...shared, ...(input.enabled ? { grantedAt, expiresAt } : {}) },
      select: { status: true, grantedAt: true, expiresAt: true }
    });
    return { id: input.userId, productId: SOWER_WORK_PRODUCT_ID, entitlement: resolveToolEntitlementAccess(record) };
  });
}
