import { NextResponse, type NextRequest } from "next/server";
import { ROLE_HOME, SESSION_COOKIE, canAccess, parseSession } from "@/lib/auth";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 登录页与认证接口放行
  if (pathname === "/login" || pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  const session = await parseSession(request.cookies.get(SESSION_COOKIE)?.value);

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
  // 排除 _next 内部资源、favicon 与 public/downloads 静态下载：
  // downloads/ 下是面向所有人的公开静态分发物（插件 ZIP 等），直出不走鉴权。
  // ⚠️ 切勿往 public/downloads/ 放任何含租户数据的文件——public/ 一律无鉴权对外。
  // favicon.ico 的点需转义，避免 /faviconXico 之类被误旁路。
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|downloads/).*)"]
};
