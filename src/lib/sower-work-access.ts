import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, parseSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

export type SowerWorkAccess =
  | { allowed: true; user: { id: string; username: string; name: string; tenantId: string } }
  | { allowed: false; status: 401 | 403 | 503; message: string };

/** 每次访问查库，不以旧会话角色或业务管理视图角色代替登录权限。 */
export async function getSowerWorkAccess(): Promise<SowerWorkAccess> {
  try {
    const cookieStore = await cookies();
    const session = await parseSession(cookieStore.get(SESSION_COOKIE)?.value);
    if (!session) {
      return { allowed: false, status: 401, message: "未登录或会话已失效" };
    }
    const user = await prisma.user.findUnique({ where: { username: session.username } });
    if (!user || user.status !== "active" || user.authRole !== session.role || user.tenantId !== session.tenantId) {
      return { allowed: false, status: 401, message: "未登录或会话已失效" };
    }
    if (user.authRole !== "admin") {
      return { allowed: false, status: 403, message: "Sower Work 目前仅向管理账号开放" };
    }
    return { allowed: true, user: { id: user.id, username: user.username, name: user.name, tenantId: user.tenantId } };
  } catch {
    return { allowed: false, status: 503, message: "授权查询暂不可用，请稍后重试" };
  }
}

/** 云端 bridge 在代理静态资源、接口、流式连接和 WebSocket 握手前调用。 */
export function sowerWorkAccessResponse(access: SowerWorkAccess): NextResponse {
  const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
  if (!access.allowed) {
    return NextResponse.json({ error: access.message }, { status: access.status, headers });
  }
  headers["X-Sower-User-Id"] = access.user.id;
  headers["X-Sower-Username"] = encodeURIComponent(access.user.username);
  return NextResponse.json({
    allowed: true,
    userId: access.user.id,
    userName: access.user.name,
    tenantId: access.user.tenantId
  }, { headers });
}
