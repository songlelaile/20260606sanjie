import { NextResponse, type NextRequest } from "next/server";
import { ROLE_HOME, SESSION_COOKIE, canAccess, parseSession } from "@/lib/auth";

const AUTH_RESPONSE_HEADERS = { "Cache-Control": "private, no-store" };

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 只读分享页放行（分享页靠高熵 token 授权），但拒绝非读取语义的方法。
  if (pathname.startsWith("/shared/dashboards/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new NextResponse(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" }
      });
    }
    return NextResponse.next();
  }

  // 登录页、认证接口、公开隐私政策与 API-key 鉴权的模型兼容端点放行。
  if (
    pathname === "/login" ||
    pathname === "/privacy" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/dmp-reports") ||
    pathname.startsWith("/api/dmp-report-shares") ||
    pathname.startsWith("/api/dmp-runtime/") ||
    pathname.startsWith("/v1/")
  ) {
    return NextResponse.next();
  }

  const session = await parseSession(request.cookies.get(SESSION_COOKIE)?.value);

  // 未登录：API 返回 401，页面跳转登录
  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "未登录" },
        { status: 401, headers: AUTH_RESPONSE_HEADERS }
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    if (pathname.startsWith("/shared/dmp-reports/")) {
      url.searchParams.set("returnTo", `${pathname}${request.nextUrl.search}`);
    }
    const response = NextResponse.redirect(url);
    response.headers.set("Cache-Control", AUTH_RESPONSE_HEADERS["Cache-Control"]);
    return response;
  }

  // 已登录但页面越权 → 跳本角色首页（API 不做角色限制，先做界面区分）
  if (!pathname.startsWith("/api/") && !canAccess(session.role, pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = ROLE_HOME[session.role];
    const response = NextResponse.redirect(url);
    response.headers.set("Cache-Control", AUTH_RESPONSE_HEADERS["Cache-Control"]);
    return response;
  }

  return NextResponse.next();
}

export const config = {
  // 排除 _next 内部资源、favicon 与 public/downloads 静态下载：
  // downloads/ 下仅放面向所有人的公开静态分发物，直出不走鉴权；达摩盘付费插件
  // 存放在 private-assets/，只能通过带数据库授权校验的 API 下载。
  // ⚠️ 切勿往 public/downloads/ 放任何含租户数据的文件——public/ 一律无鉴权对外。
  // favicon.ico 的点需转义，避免 /faviconXico 之类被误旁路。
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|downloads/).*)"]
};
