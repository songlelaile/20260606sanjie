import { NextResponse, type NextRequest } from "next/server";
import { ROLE_HOME, SESSION_COOKIE, canAccess, parseSession } from "@/lib/auth";
import { authRedirectUrl } from "@/lib/auth-redirect-url";
import { isExtensionApi, isPrivateSourcePath, rejectsCrossSiteMutation } from "@/lib/request-security";
import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityRateLimitResponse } from "@/lib/security-response";
import { isActiveSecurityAccount, securityAccountIdentity } from "@/lib/security-web-account";

const AUTH_RESPONSE_HEADERS = { "Cache-Control": "private, no-store" };
const PUBLIC_DMP_REPORT_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow"
};
const PUBLIC_DMP_REPORT_PATH = /^\/shared\/dmp-reports\/[a-f0-9]{64}$/i;
const PUBLIC_DMP_REPORT_EVENTS_PATH = /^\/api\/shared\/dmp-reports\/[a-f0-9]{64}$/i;
const SIGNED_PAYMENT_NOTIFY_PATHS = new Set(["/api/payments/alipay/notify", "/api/payments/wechat/notify"]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPrivateSourcePath(pathname)) return new NextResponse(null, { status: 404, headers: AUTH_RESPONSE_HEADERS });
  const declaredAi = request.headers.has("x-sanjie-ai-client") || /^Bearer\s+sja_/i.test(request.headers.get("authorization") || "");
  if (declaredAi && pathname !== "/api/ai-access/execute") {
    return NextResponse.json({ error: "AI 访问必须使用管理账号授权通道", code: "AI_CHANNEL_REQUIRED" }, { status: 403, headers: AUTH_RESPONSE_HEADERS });
  }
  // Framework runtime scripts and the public tool icon must remain available to the login page.
  if (pathname.startsWith("/_next/static/") || pathname === "/favicon.ico" ||
      /^\/downloads\/[^/]+\.(?:png|jpg|jpeg|webp|svg|ico)$/i.test(pathname)) return NextResponse.next();
  // Provider notifications use cryptographic signatures in their handlers, not
  // browser cookies. Only these exact POST routes bypass browser/session checks.
  if (SIGNED_PAYMENT_NOTIFY_PATHS.has(pathname)) {
    if (request.method !== "POST") return new NextResponse(null, { status: 405, headers: { Allow: "POST", ...AUTH_RESPONSE_HEADERS } });
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/") && rejectsCrossSiteMutation(request)) {
    return NextResponse.json({ error: "跨站操作被拒绝", code: "CROSS_SITE_REQUEST" }, { status: 403, headers: AUTH_RESPONSE_HEADERS });
  }
  // This single endpoint validates its own short-lived, database-backed admin grant.
  if (pathname === "/api/ai-access/execute") return NextResponse.next();

  const explicitToken = isExtensionApi(pathname) ? request.headers.get("x-sanjie-session")?.trim() : undefined;
  const independentCredential = pathname === "/login" || pathname === "/privacy" ||
    pathname.startsWith("/api/auth/") || pathname.startsWith("/shared/dashboards/") ||
    PUBLIC_DMP_REPORT_PATH.test(pathname) || PUBLIC_DMP_REPORT_EVENTS_PATH.test(pathname) ||
    pathname.startsWith("/v1/") || pathname.startsWith("/api/v1/");
  const session = independentCredential ? null : await parseSession(explicitToken || request.cookies.get(SESSION_COOKIE)?.value);
  if (session && pathname !== "/api/auth/logout") {
    try {
      if (!await isActiveSecurityAccount(session)) return NextResponse.json({ error: "会话已失效" }, { status: 401, headers: AUTH_RESPONSE_HEADERS });
    } catch {
      return NextResponse.json({ error: "安全验证暂不可用", code: "SECURITY_UNAVAILABLE" }, { status: 503, headers: AUTH_RESPONSE_HEADERS });
    }
    if (!pathname.startsWith("/api/auth/") && !pathname.startsWith("/v1/") && !pathname.startsWith("/api/v1/")) {
      const assets = pathname.startsWith("/creative/") || pathname.startsWith("/api/creative/assets/");
      const api = pathname.startsWith("/api/");
      const writing = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      const namespace = assets ? "web-assets" : api ? (writing ? "web-api-write" : "web-api-read") : "web-pages";
      const rate = await consumeSecurityRateLimit(namespace, securityAccountIdentity(session), assets ? 300 : api ? (writing ? 90 : 180) : 120, 60);
      const denied = securityRateLimitResponse(rate);
      if (denied) return denied;
    }
  }

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
    pathname === "/api/dmp-market-reports" ||
    pathname.startsWith("/api/dmp-source-data") ||
    pathname === "/api/dmp-report-exports" ||
    pathname.startsWith("/api/dmp-report-shares") ||
    pathname.startsWith("/api/dmp-runtime/") ||
    pathname.startsWith("/v1/") ||
    pathname.startsWith("/api/v1/")
  ) {
    return NextResponse.next();
  }

  // 未登录：API 返回 401，页面跳转登录
  if (!session) {
    if (pathname.startsWith("/api/") || pathname.startsWith("/downloads/")) {
      return NextResponse.json(
        { error: "未登录" },
        { status: 401, headers: AUTH_RESPONSE_HEADERS }
      );
    }
    const url = authRedirectUrl(request.nextUrl);
    url.pathname = "/login";
    if (pathname.startsWith("/shared/dmp-reports/")) {
      url.searchParams.set("returnTo", `${pathname}${request.nextUrl.search}`);
    }
    const response = NextResponse.redirect(url);
    response.headers.set("Cache-Control", AUTH_RESPONSE_HEADERS["Cache-Control"]);
    return response;
  }

  // 已登录但页面越权 → 跳本角色首页（API 不做角色限制，先做界面区分）
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/downloads/") && !canAccess(session.role, pathname)) {
    const url = authRedirectUrl(request.nextUrl);
    url.pathname = ROLE_HOME[session.role];
    const response = NextResponse.redirect(url);
    response.headers.set("Cache-Control", AUTH_RESPONSE_HEADERS["Cache-Control"]);
    return response;
  }

  // 全部创作资源实时核对数据库授权，不能只保护 HTML 而公开功能脚本。
  if (pathname.startsWith("/creative/")) {
    // With skipMiddlewareUrlNormalize, request.url retains 127.0.0.1 instead of
    // NextURL normalizing it to localhost and turning this into an HTTPS proxy.
    const url = new URL(request.url);
    url.pathname = `/api/creative/assets/${pathname.slice("/creative/".length)}`;
    return NextResponse.rewrite(url);
  }

  // 安装包保留原下载地址及原文件，但不再允许匿名获取整套功能代码。
  if (pathname.startsWith("/downloads/")) {
    // With skipMiddlewareUrlNormalize, request.url retains 127.0.0.1 instead of
    // NextURL normalizing it to localhost and turning this into an HTTPS proxy.
    const url = new URL(request.url);
    url.pathname = `/api/protected-downloads/${pathname.slice("/downloads/".length)}`;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  // Node middleware supports the shared database quota (Next.js >=15.5).
  runtime: "nodejs",
  // Include static paths to deny maps/backups and protect installation archives.
  matcher: ["/((?!_next/image).*)"]
};
