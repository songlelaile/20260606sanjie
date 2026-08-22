import { NextResponse, type NextRequest } from "next/server";
import { ROLE_HOME, SESSION_COOKIE, canAccess, parseSession } from "@/lib/auth";

const AUTH_RESPONSE_HEADERS = { "Cache-Control": "private, no-store" };
const PUBLIC_DMP_REPORT_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow"
};
const PUBLIC_DMP_REPORT_PATH = /^\/shared\/dmp-reports\/[a-f0-9]{64}$/i;
const PUBLIC_DMP_REPORT_EVENTS_PATH = /^\/api\/shared\/dmp-reports\/[a-f0-9]{64}$/i;

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

  // 达摩盘 HTML 报告以高熵令牌作为只读访问凭证。只放行格式完全匹配的页面，
  // 避免把同前缀下的其它页面或将来的管理端点一并公开。
  if (PUBLIC_DMP_REPORT_PATH.test(pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new NextResponse(null, {
        status: 405,
        headers: { Allow: "GET, HEAD", ...PUBLIC_DMP_REPORT_HEADERS }
      });
    }
    const response = NextResponse.next();
    for (const [name, value] of Object.entries(PUBLIC_DMP_REPORT_HEADERS)) {
      response.headers.set(name, value);
    }
    return response;
  }

  // 分享页的匿名行为端点只接收埋点写入。完整报告 JSON 的 GET 不对外公开；
  // token 格式不合法的相似路径继续进入下方的正常登录鉴权。
  if (PUBLIC_DMP_REPORT_EVENTS_PATH.test(pathname)) {
    if (request.method !== "POST" && request.method !== "OPTIONS") {
      return new NextResponse(null, {
        status: 405,
        headers: { Allow: "POST, OPTIONS", ...AUTH_RESPONSE_HEADERS }
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
    pathname.startsWith("/api/dmp-source-data") ||
    pathname === "/api/dmp-report-exports" ||
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
