import { NextResponse, type NextRequest } from "next/server";
import { ROLE_HOME, SESSION_COOKIE, canAccess, parseSession } from "@/lib/auth";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 登录页与认证接口放行
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  // 未登录：API 返回 401，页面跳转登录
  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "未登录" }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // 已登录但页面越权 → 跳本角色首页（API 不做角色限制，先做界面区分）
  if (!pathname.startsWith("/api/") && !canAccess(session.role, pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = ROLE_HOME[session.role];
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
