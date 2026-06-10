// 认证 + 角色权限配置（纯配置，不依赖 next/headers 与 Prisma，
// client、server 与中间件 edge 运行时均可安全引用）。
// 账号已落库（见 src/lib/accounts.ts）；本文件仅负责会话编解码与路由权限。

export type Role = "tenant" | "admin";

export const SESSION_COOKIE = "sanjie_session";

export interface Session {
  username: string;
  role: Role;
  name: string;
  /** 所属租户，用于多租户数据隔离。 */
  tenantId: string;
}

/** 每个角色登录后的默认首页。 */
export const ROLE_HOME: Record<Role, string> = {
  tenant: "/dashboards/management",
  admin: "/dashboards/management"
};

/** 每个角色可访问的页面路由前缀。 */
const ROLE_ALLOWED_PREFIXES: Record<Role, string[]> = {
  // 租户版：运营日常（看板 + 数据导入 + 预填写）
  tenant: ["/dashboards", "/imports", "/prefill"],
  // 管理版：在租户版全部功能之上，额外多一个「管理」（及管理后台/版本留痕）。
  admin: ["/dashboards", "/imports", "/prefill", "/management", "/admin", "/versions"]
};

export function canAccess(role: Role, pathname: string): boolean {
  if (pathname === "/") {
    return true;
  }
  return ROLE_ALLOWED_PREFIXES[role].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function serializeSession(session: Session): string {
  return encodeURIComponent(JSON.stringify(session));
}

export function parseSession(value: string | undefined): Session | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<Session>;
    if (
      (parsed.role === "tenant" || parsed.role === "admin") &&
      typeof parsed.username === "string" &&
      typeof parsed.tenantId === "string"
    ) {
      return {
        username: parsed.username,
        role: parsed.role,
        name: parsed.name ?? parsed.username,
        tenantId: parsed.tenantId
      };
    }
    return null;
  } catch {
    return null;
  }
}
