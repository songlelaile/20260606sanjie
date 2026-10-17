import "server-only";
import { NextResponse } from "next/server";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { AIAccessError } from "@/lib/ai-access";

export function aiAccessJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer"
  } });
}

export async function requireAIAccessAdmin() {
  const session = await getCurrentSession();
  if (!session) throw new AIAccessError("UNAUTHORIZED", "请先登录管理账号", 401);
  const user = await getCurrentUser();
  if (!user || user.status !== "active" || user.authRole !== "admin" || session.role !== "admin") {
    throw new AIAccessError("ADMIN_REQUIRED", "AI 授权通道仅限管理账号", 403);
  }
  return session;
}

export function aiAccessErrorResponse(error: unknown) {
  return error instanceof AIAccessError
    ? aiAccessJson({ error: error.message, code: error.code }, error.status)
    : aiAccessJson({ error: "AI 授权服务暂不可用，请稍后重试", code: "AI_ACCESS_UNAVAILABLE" }, 503);
}
