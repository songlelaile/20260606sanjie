import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE, parseSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function getCurrentSession() {
  const store = await cookies();
  return parseSession(store.get(SESSION_COOKIE)?.value);
}

export async function getCurrentUser() {
  const session = await getCurrentSession();
  if (!session) {
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { username: session.username }
  });
  if (!user || user.status !== "active" || user.tenantId !== session.tenantId ||
    (user.authRole === "admin" ? "admin" : "tenant") !== session.role) return null;
  return user;
}
