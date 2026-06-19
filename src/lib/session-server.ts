import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { SESSION_COOKIE, parseSession, type Session } from "./auth";

/**
 * 读取当前请求的会话（服务端组件 / 路由处理器可用）。
 * 用 React cache() 做请求级 memo：同一请求内多次调用只解析一次 cookie。
 */
export const getServerSession = cache(async (): Promise<Session | null> => {
  const store = await cookies();
  return await parseSession(store.get(SESSION_COOKIE)?.value);
});

/** 取当前租户 id；未登录时抛错（受 middleware 保护的路由不会触发）。 */
export async function requireTenantId(): Promise<string> {
  const session = await getServerSession();
  if (!session) {
    throw new Error("未登录或会话已失效");
  }
  return session.tenantId;
}
