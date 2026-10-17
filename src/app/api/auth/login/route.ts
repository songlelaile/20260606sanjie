import { NextResponse } from "next/server";
import {
  ACTIVE_SHOP_COOKIE,
  ROLE_HOME,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  serializeSession
} from "@/lib/auth";
import { findAccount } from "@/lib/accounts";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { consumeSecurityRateLimit, type SecurityRateLimitResult } from "@/lib/security-rate-limit";
import { trustedClientIp } from "@/lib/security-client-ip";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };
const MAX_LOGIN_BODY_BYTES = 16 * 1024;
const LOGIN_WINDOW_SECONDS = 300;

function limitedResponse(result: SecurityRateLimitResult) {
  if (result.allowed) return null;
  const unavailable = result.reason === "unavailable";
  return NextResponse.json(
    { error: unavailable ? "登录保护服务暂不可用，请稍后重试" : "登录尝试过于频繁，请稍后重试" },
    { status: unavailable ? 503 : 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(result.retryAfterSeconds) } }
  );
}

export async function POST(request: Request) {
  const ip = trustedClientIp(request);
  const ipDenied = limitedResponse(await consumeSecurityRateLimit(
    "auth.login.ip", ip || "unknown", ip ? 50 : 200, LOGIN_WINDOW_SECONDS
  ));
  if (ipDenied) return ipDenied;

  let rawBody: unknown;
  try {
    rawBody = await readJsonWithLimit(request, MAX_LOGIN_BODY_BYTES);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RequestBodyTooLargeError ? "登录信息过长，请精简后重试" : "请提交有效的登录信息" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400, headers: NO_STORE_HEADERS }
    );
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json({ error: "请提交有效的登录信息" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const body = rawBody as { username?: unknown; password?: unknown };
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || username.length > 256 || !password) {
    return NextResponse.json({ error: "账号或密码错误" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  const normalizedAccount = username.normalize("NFKC").trim().toLowerCase();
  if (!normalizedAccount || normalizedAccount.length > 512) {
    return NextResponse.json({ error: "账号或密码错误" }, { status: 401, headers: NO_STORE_HEADERS });
  }
  const accountDenied = limitedResponse(await consumeSecurityRateLimit(
    "auth.login.account", normalizedAccount, 10, LOGIN_WINDOW_SECONDS
  ));
  if (accountDenied) return accountDenied;
  const account = await findAccount(username, password);
  if (account === "disabled") {
    return NextResponse.json(
      { error: "该账号已被禁用，请联系管理员" },
      { status: 403, headers: NO_STORE_HEADERS }
    );
  }
  if (!account) {
    return NextResponse.json(
      { error: "账号或密码错误" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }
  const response = NextResponse.json(
    { data: { role: account.role, name: account.name, home: ROLE_HOME[account.role] } },
    { headers: NO_STORE_HEADERS }
  );
  const sessionCookie = await serializeSession({
    username: account.username,
    role: account.role,
    name: account.name,
    tenantId: account.tenantId
  });
  response.cookies.set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    domain: process.env.NODE_ENV === "production" && !process.env.SANJIE_TEST_ENVIRONMENT ? ".shaozhuangai.com" : undefined,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS
  });
  response.cookies.delete(ACTIVE_SHOP_COOKIE);
  return response;
}
