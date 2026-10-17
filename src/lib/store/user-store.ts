import "server-only";
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { hashPassword } from "@/lib/accounts";
import { prisma } from "@/lib/db";
import { getServerSession } from "@/lib/session-server";
import { getDmpAutomationAccessForUserIds, NO_DMP_AUTOMATION_ACCESS } from "@/lib/tool-entitlements";
import {
  CREATIVE_TOOL_CODE,
  REGISTRATION_SOURCE_TOOL_CODE,
  resolveCreativeAccess,
  type CreativeAccess
} from "@/lib/creative-access-policy";
import type { InviteCode, ManagedUser, ToolEntitlementAccess } from "@/lib/types/domain";

// These records describe registration; only creative_studio grants product access.
const REGISTRATION_SOURCE = REGISTRATION_SOURCE_TOOL_CODE;
const CREATIVE_STUDIO = CREATIVE_TOOL_CODE;

export type RegistrationManagedUser = ManagedUser & {
  authRole: "admin" | "tenant";
  registrationSource: "self" | "invite" | "legacy";
  inviteCodeId: string | null;
  registeredBy: string | null;
  registrationSourceRecordedAt: string | null;
  creativeStudioAccess: ToolEntitlementAccess;
  creativeAccess: CreativeAccess;
};

export class UserManagementInputError extends Error {}
export class UserManagementAccessError extends Error {
  readonly status = 403;
}

async function requireAccount() {
  const session = await getServerSession();
  if (!session) throw new UserManagementAccessError("未登录或会话已失效");
  const user = await prisma.user.findUnique({
    where: { username: session.username },
    select: { id: true, username: true, tenantId: true, authRole: true, status: true }
  });
  const role = user?.authRole === "admin" ? "admin" : "tenant";
  if (!user || user.status === "disabled" || user.tenantId !== session.tenantId || role !== session.role) {
    throw new UserManagementAccessError("账号或租户归属已变更，请重新登录");
  }
  return { ...session, id: user.id };
}

async function requireAdmin() {
  const account = await requireAccount();
  if (account.role !== "admin") throw new UserManagementAccessError("仅管理员可执行此操作");
  return account;
}

type EntitlementRecord = {
  toolCode: string;
  status: string;
  note: string;
  grantedBy: string;
  grantedAt: Date;
  expiresAt: Date | null;
};

function creativeAccess(record: EntitlementRecord | undefined, now: Date): ToolEntitlementAccess {
  if (!record) return { ...NO_DMP_AUTOMATION_ACCESS };
  const grantedAt = record.grantedAt.toISOString();
  const expiresAt = record.expiresAt?.toISOString() ?? null;
  if (record.status !== "active") {
    return { allowed: false, status: "revoked", grantedAt, expiresAt, remainingDays: 0 };
  }
  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
    return { allowed: false, status: "expired", grantedAt, expiresAt, remainingDays: 0 };
  }
  return {
    allowed: true, status: "active", grantedAt, expiresAt,
    remainingDays: record.expiresAt ? Math.max(1, Math.ceil((record.expiresAt.getTime() - now.getTime()) / 86_400_000)) : 0
  };
}

function registrationMetadata(record: EntitlementRecord | undefined) {
  const inviteCodeId = record?.status === "active" && /^invite:[A-Za-z0-9_-]{1,128}$/.test(record.note)
    ? record.note.slice("invite:".length) : null;
  const registrationSource = record?.status === "active" && record.note === "self" ? "self"
    : inviteCodeId ? "invite" : "legacy";
  return {
    registrationSource: registrationSource as RegistrationManagedUser["registrationSource"],
    inviteCodeId,
    registeredBy: registrationSource !== "legacy" ? record?.grantedBy || null : null,
    registrationSourceRecordedAt: registrationSource !== "legacy" ? record!.grantedAt.toISOString() : null
  };
}

/** Tenant callers can only read their own members; administrators manage accounts across tenants. */
export async function getManagedUsers(): Promise<RegistrationManagedUser[]> {
  const session = await requireAccount();
  const users = await prisma.user.findMany({
    where: session.role === "admin" ? {} : { tenantId: session.tenantId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, tenantId: true, name: true, username: true, email: true, authRole: true,
      role: true, shopName: true, status: true, createdAt: true, lastActiveAt: true,
      toolEntitlements: {
        where: { toolCode: { in: [REGISTRATION_SOURCE, CREATIVE_STUDIO] } },
        select: { toolCode: true, status: true, note: true, grantedBy: true, grantedAt: true, expiresAt: true }
      },
      gatewayOrders: {
        where: { status: "paid", paidAt: { not: null }, amountCents: { gt: 0 } },
        orderBy: { paidAt: "desc" },
        take: 1,
        select: { paidAt: true }
      }
    }
  });
  const dmpAccess = await getDmpAutomationAccessForUserIds(users.map((user) => user.id));
  const now = new Date();
  return users.map((user) => ({
    id: user.id, tenantId: user.tenantId, name: user.name, username: user.username,
    email: user.email, role: user.role as ManagedUser["role"], shopName: user.shopName,
    status: user.status as ManagedUser["status"], authRole: user.authRole === "admin" ? "admin" : "tenant",
    ...registrationMetadata(user.toolEntitlements.find((record) => record.toolCode === REGISTRATION_SOURCE)),
    creativeStudioAccess: creativeAccess(user.toolEntitlements.find((record) => record.toolCode === CREATIVE_STUDIO), now),
    creativeAccess: resolveCreativeAccess({
      valid: user.status === "active",
      admin: user.authRole === "admin",
      invitation: user.toolEntitlements.find((record) => record.toolCode === CREATIVE_STUDIO) ?? null,
      paidAt: user.gatewayOrders[0]?.paidAt ?? null
    }, now),
    dmpAutomationAccess: dmpAccess.get(user.id) ?? { ...NO_DMP_AUTOMATION_ACCESS },
    createdAt: user.createdAt.toISOString(), lastActiveAt: user.lastActiveAt.toISOString()
  }));
}

type ManagedUserActionResult = { ok: true } | { ok: false; error: string; status: number };
function validId(id: string) { return /^[A-Za-z0-9_-]{1,128}$/.test(id); }

async function mutateManagedUser(
  id: string,
  action: (tx: Prisma.TransactionClient, target: { id: string; tenantId: string; username: string; authRole: string }, actor: string) => Promise<number>
): Promise<ManagedUserActionResult> {
  if (!validId(id)) return { ok: false, error: "用户 ID 无效", status: 400 };
  try {
    const session = await requireAdmin();
    return await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { id: true, tenantId: true, username: true, authRole: true } });
      if (!target) return { ok: false, error: "用户不存在", status: 404 };
      if (target.id === session.id || target.username === session.username) {
        return { ok: false, error: "不能对当前登录的账号执行此操作", status: 400 };
      }
      if (target.authRole === "admin") return { ok: false, error: "不能操作管理员账号", status: 403 };
      const count = await action(tx, target, session.username);
      return count > 0 ? { ok: true } : { ok: false, error: "账号已变更，请刷新后重试", status: 409 };
    });
  } catch (error) {
    if (error instanceof UserManagementAccessError) return { ok: false, error: error.message, status: error.status };
    throw error;
  }
}

function targetWhere(target: { id: string; tenantId: string; username: string }, actor: string) {
  return { id: target.id, tenantId: target.tenantId, username: { equals: target.username, not: actor }, authRole: { not: "admin" } };
}

/** Only change status; workspace, source records and existing tool grants are preserved. */
export async function setManagedUserStatus(id: string, status: "active" | "disabled"): Promise<ManagedUserActionResult> {
  if (status !== "active" && status !== "disabled") return { ok: false, error: "status 仅支持 active / disabled", status: 400 };
  return mutateManagedUser(id, async (tx, target, actor) => {
    const result = await tx.user.updateMany({ where: targetWhere(target, actor), data: { status } });
    return result.count;
  });
}

/** Keep the existing explicit account-deletion endpoint; never delete the tenant's workspace. */
export async function deleteManagedUser(id: string): Promise<ManagedUserActionResult> {
  return mutateManagedUser(id, async (tx, target, actor) => {
    const result = await tx.user.deleteMany({ where: targetWhere(target, actor) });
    return result.count;
  });
}

export async function resetManagedUserPassword(id: string): Promise<{ ok: true; password: string } | { ok: false; error: string; status: number }> {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const password = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join("");
  const result = await mutateManagedUser(id, async (tx, target, actor) => {
    const update = await tx.user.updateMany({ where: targetWhere(target, actor), data: { password: hashPassword(password) } });
    return update.count;
  });
  return result.ok ? { ok: true, password } : result;
}

function toDomainInvite(row: { id: string; tenantId: string; code: string; registrationUrl: string; usedCount: number; maxUses: number; note: string; createdBy: string; createdAt: Date }): InviteCode {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export async function getInviteCodes(): Promise<InviteCode[]> {
  const session = await requireAdmin();
  const rows = await prisma.inviteCode.findMany({ where: { tenantId: session.tenantId }, orderBy: { createdAt: "desc" } });
  return rows.map(toDomainInvite);
}

export async function createInviteCode(input: { note: string; maxUses: number }): Promise<InviteCode> {
  const session = await requireAdmin();
  if (typeof input.note !== "string" || input.note.length > 200) throw new UserManagementInputError("说明最多 200 个字符");
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 99) throw new UserManagementInputError("可用次数必须是 1 到 99 的整数");
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join("");
    try {
      return toDomainInvite(await prisma.inviteCode.create({ data: {
        tenantId: session.tenantId, code, registrationUrl: `/login?invite=${code}`,
        usedCount: 0, maxUses: input.maxUses, note: input.note.trim() || "未备注", createdBy: session.name || session.username
      } }));
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const fields = error.meta?.target;
      if (!Array.isArray(fields) || !fields.includes("code")) throw error;
    }
  }
  throw new Error("生成邀请码失败，请重试");
}

/** Deleting a code revokes future registrations. Source entitlements remain attached to existing users. */
export async function deleteInviteCode(id: string): Promise<boolean> {
  const session = await requireAdmin();
  if (!validId(id)) throw new UserManagementInputError("邀请码 ID 无效");
  return (await prisma.inviteCode.deleteMany({ where: { id, tenantId: session.tenantId } })).count > 0;
}

/** Compatibility helper. Registration itself consumes an invite inside the account-creation transaction. */
export async function consumeInviteCode(rawCode: string): Promise<{ ok: true; invite: InviteCode } | { ok: false; error: string }> {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,32}$/.test(code)) return { ok: false, error: "邀请码格式无效" };
  return prisma.$transaction(async (tx) => {
    const invite = await tx.inviteCode.findUnique({ where: { code } });
    if (!invite) return { ok: false, error: "邀请码无效或已失效" };
    if (invite.usedCount >= invite.maxUses) return { ok: false, error: "邀请码使用次数已用尽" };
    const consumed = await tx.inviteCode.updateMany({ where: { id: invite.id, code, maxUses: invite.maxUses, usedCount: { lt: invite.maxUses } }, data: { usedCount: { increment: 1 } } });
    if (!consumed.count) return { ok: false, error: "邀请码无效或使用次数已用尽" };
    return { ok: true, invite: toDomainInvite({ ...invite, usedCount: invite.usedCount + 1 }) };
  });
}
