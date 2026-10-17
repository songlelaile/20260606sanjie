import "server-only";
import type { Session } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { CREATIVE_TOOL_CODE, resolveCreativeAccess, type CreativeAccess } from "@/lib/creative-access-policy";

export async function getCreativeAccessForSession(session: Session | null): Promise<CreativeAccess> {
  if (!session) return { allowed: false, reason: "invalid_account", expiresAt: null };
  const user = await prisma.user.findUnique({ where: { username: session.username } });
  const valid = !!user && user.status === "active" && user.tenantId === session.tenantId &&
    (user.authRole === "admin" ? "admin" : "tenant") === session.role;
  if (!valid || !user) return resolveCreativeAccess({ valid: false, admin: false, invitation: null, paidAt: null });
  const [invitation, order] = await Promise.all([
    prisma.toolEntitlement.findUnique({ where: { userId_toolCode: { userId: user.id, toolCode: CREATIVE_TOOL_CODE } } }),
    prisma.gatewayOrder.findFirst({
      where: { userId: user.id, status: "paid", paidAt: { not: null }, amountCents: { gt: 0 } },
      orderBy: { paidAt: "desc" }, select: { paidAt: true }
    })
  ]);
  return resolveCreativeAccess({ valid, admin: user.authRole === "admin", invitation, paidAt: order?.paidAt ?? null });
}

export const UNAVAILABLE_CREATIVE_ACCESS: CreativeAccess = { allowed: false, reason: "unavailable", expiresAt: null };
