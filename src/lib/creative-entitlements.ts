import "server-only";
import type { Session } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { CreativeAccess } from "@/lib/creative-access-policy";

/** Preserve the deployed signed-in access rule while checking revocation live. */
export async function getCreativeAccessForSession(session: Session | null): Promise<CreativeAccess> {
  if (!session) return { allowed: false, reason: "invalid_account", expiresAt: null };
  const user = await prisma.user.findUnique({
    where: { username: session.username },
    select: { status: true, tenantId: true, authRole: true }
  });
  if (!user || user.status !== "active" || user.tenantId !== session.tenantId ||
      (user.authRole === "admin" ? "admin" : "tenant") !== session.role) {
    return { allowed: false, reason: "invalid_account", expiresAt: null };
  }
  return { allowed: true, reason: user.authRole === "admin" ? "admin" : "authenticated", expiresAt: null };
}

export const UNAVAILABLE_CREATIVE_ACCESS: CreativeAccess = { allowed: false, reason: "unavailable", expiresAt: null };
