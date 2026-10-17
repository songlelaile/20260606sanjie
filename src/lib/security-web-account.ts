import "server-only";
import type { Session } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function isActiveSecurityAccount(session: Session): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { username: session.username },
    select: { status: true, tenantId: true, authRole: true }
  });
  return !!user && user.status === "active" && user.tenantId === session.tenantId &&
    (user.authRole === "admin" ? "admin" : "tenant") === session.role;
}

/** Stable across refresh, login and token rotation; never use a raw cookie as a quota key. */
export function securityAccountIdentity(session: Session): string {
  return JSON.stringify([session.tenantId, session.username]);
}
