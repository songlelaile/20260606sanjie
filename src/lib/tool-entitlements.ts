import "server-only";
import type { Session } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  DMP_AUTOMATION_ACCESS_DAYS,
  DMP_AUTOMATION_TOOL_CODE
} from "@/lib/dmp-product";
import type { ToolEntitlementAccess } from "@/lib/types/domain";

type EntitlementRecord = {
  status: string;
  grantedAt: Date;
  expiresAt: Date | null;
};

export const NO_DMP_AUTOMATION_ACCESS: ToolEntitlementAccess = {
  allowed: false,
  status: "not_granted",
  grantedAt: null,
  expiresAt: null,
  remainingDays: 0
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 生成一次达摩盘授权的完整 30 天窗口。
 * 起点只能是管理员点击“开通/续费”时的服务器时间，不能使用 User.createdAt。
 */
export function createDmpEntitlementWindow(now = new Date()) {
  return {
    grantedAt: now,
    expiresAt: new Date(now.getTime() + DMP_AUTOMATION_ACCESS_DAYS * DAY_MS)
  };
}

export function resolveToolEntitlementAccess(
  record: EntitlementRecord | null | undefined,
  now = new Date()
): ToolEntitlementAccess {
  if (!record) return { ...NO_DMP_AUTOMATION_ACCESS };
  const grantedAt = record.grantedAt.toISOString();
  const expiresAt = record.expiresAt?.toISOString() ?? null;
  if (record.status !== "active") {
    return { allowed: false, status: "revoked", grantedAt, expiresAt, remainingDays: 0 };
  }
  if (!record.expiresAt || record.expiresAt.getTime() <= now.getTime()) {
    return { allowed: false, status: "expired", grantedAt, expiresAt, remainingDays: 0 };
  }
  return {
    allowed: true,
    status: "active",
    grantedAt,
    expiresAt,
    remainingDays: Math.max(1, Math.ceil((record.expiresAt.getTime() - now.getTime()) / DAY_MS))
  };
}

export async function getDmpAutomationAccessForSession(
  session: Pick<Session, "username" | "tenantId" | "role">
): Promise<ToolEntitlementAccess> {
  const user = await prisma.user.findUnique({
    where: { username: session.username.trim() },
    select: {
      tenantId: true,
      authRole: true,
      status: true,
      toolEntitlements: {
        where: { toolCode: DMP_AUTOMATION_TOOL_CODE },
        select: { status: true, grantedAt: true, expiresAt: true },
        take: 1
      }
    }
  });
  const role = user?.authRole === "admin" ? "admin" : "tenant";
  if (!user || user.status === "disabled" || user.tenantId !== session.tenantId || role !== session.role) {
    return { ...NO_DMP_AUTOMATION_ACCESS };
  }
  return resolveToolEntitlementAccess(user.toolEntitlements[0]);
}

export async function getDmpAutomationAccessForUserIds(
  userIds: string[]
): Promise<Map<string, ToolEntitlementAccess>> {
  if (userIds.length === 0) return new Map();
  const records = await prisma.toolEntitlement.findMany({
    where: { userId: { in: userIds }, toolCode: DMP_AUTOMATION_TOOL_CODE },
    select: { userId: true, status: true, grantedAt: true, expiresAt: true }
  });
  return new Map(records.map((record) => [record.userId, resolveToolEntitlementAccess(record)]));
}

export async function setDmpAutomationEntitlement(input: {
  userId: string;
  enabled: boolean;
  grantedBy: string;
}): Promise<{ ok: true; access: ToolEntitlementAccess } | { ok: false; error: string; status: number }> {
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } });
  if (!user) return { ok: false, error: "用户不存在", status: 404 };

  // 每次开通/续费都从本次操作时刻重新顺延 30 天；账号注册时间不参与计算。
  const { grantedAt, expiresAt } = createDmpEntitlementWindow();
  const record = await prisma.toolEntitlement.upsert({
    where: {
      userId_toolCode: { userId: input.userId, toolCode: DMP_AUTOMATION_TOOL_CODE }
    },
    create: {
      userId: input.userId,
      toolCode: DMP_AUTOMATION_TOOL_CODE,
      status: input.enabled ? "active" : "revoked",
      grantedBy: input.grantedBy,
      grantedAt,
      expiresAt: input.enabled ? expiresAt : null
    },
    update: {
      status: input.enabled ? "active" : "revoked",
      grantedBy: input.grantedBy,
      ...(input.enabled ? { grantedAt, expiresAt } : {})
    },
    select: { status: true, grantedAt: true, expiresAt: true }
  });
  return { ok: true, access: resolveToolEntitlementAccess(record) };
}
