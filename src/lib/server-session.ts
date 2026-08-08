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
  return prisma.user.findUnique({
    where: { username: session.username }
  });
}
