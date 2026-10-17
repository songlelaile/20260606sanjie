import { NextResponse } from "next/server";
import {
  ACTIVE_SHOP_COOKIE,
  ROLE_HOME,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  serializeSession
} from "@/lib/auth";
import {
  createTenantOperator,
  createTenantOperatorByInvite,
  validateRegistration
} from "@/lib/accounts";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { trustedClientIp } from "@/lib/security-client-ip";
import { consumeSecurityRateLimit, type SecurityRateLimitResult } from "@/lib/security-rate-limit";
import { provisionRegisteredUserSupply } from "@/lib/model-gateway/user-supply";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };
const MAX_REGISTRATION_BODY_BYTES = 16 * 1024;

function limitedResponse(result: SecurityRateLimitResult) {
  if (result.allowed) return null;
  const unavailable = result.reason === "unavailable";
  return NextResponse.json(
    { error: unavailable ? "注册保护服务暂不可用，请稍后重试" : "注册尝试过于频繁，请稍后重试" },
    { status: unavailable ? 503 : 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(result.retryAfterSeconds) } }
  );
}

export async function POST(request: Request) {
  const ip = trustedClientIp(request);
  // Unknown is a shared temporary site-wide allowance until trusted ingress is
  // configured. Two windows bound both bursts and daily account creation abuse.
  const shortDenied = limitedResponse(await consumeSecurityRateLimit(
    "auth.register.ip.short", ip || "unknown", ip ? 5 : 50, 600
  ));
  if (shortDenied) return shortDenied;
  const dailyDenied = limitedResponse(await consumeSecurityRateLimit(
    "auth.register.ip.daily", ip || "unknown", ip ? 30 : 500, 86_400
  ));
  if (dailyDenied) return dailyDenied;

  let rawBody: unknown;
  try {
    rawBody = await readJsonWithLimit(request, MAX_REGISTRATION_BODY_BYTES);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RequestBodyTooLargeError
        ? "注册信息过长，请精简后重试" : "请提交有效的注册信息" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400, headers: NO_STORE_HEADERS }
    );
  }
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return NextResponse.json(
      { error: "请提交有效的注册信息" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }
  const body = rawBody as Record<string, unknown>;
  const typeError = typeof body.username !== "string" || typeof body.password !== "string"
    ? "手机号和密码必须是文本"
    : body.name !== undefined && typeof body.name !== "string"
      ? "姓名 / 昵称必须是文本"
      : body.inviteCode !== undefined && typeof body.inviteCode !== "string"
        ? "邀请码必须是文本"
        : null;
  if (typeError) {
    return NextResponse.json(
      { error: typeError },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const username = (body.username as string).trim();
  const password = body.password as string;
  const rawName = body.name as string | undefined;
  const rawInviteCode = body.inviteCode as string | undefined;
  const name = rawName?.trim() || username;
  const inviteCode = rawInviteCode?.trim() || "";

  try {
    // 保留原始文本供长度与不可见字符校验，随后仅传递规范化字段。
    const fieldError = await validateRegistration({
      username: body.username as string,
      password,
      name: rawName,
      inviteCode: rawInviteCode
    });
    if (fieldError) {
      return NextResponse.json(
        { error: fieldError },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    // 两者都创建独立租户；创作权限仅由邀请注册事务或后续充值开通。
    const created = inviteCode
      ? await createTenantOperatorByInvite({ username, password, name, inviteCode })
      : await createTenantOperator({ username, password, name });
    if (!created.ok) {
      return NextResponse.json(
        { error: created.error },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }
    const account = created.account;
    // Supplier credentials have their own durable pending state. An unavailable
    // supplier must not roll back a successful self/invite registration.
    await provisionRegisteredUserSupply(account.username).catch(() => undefined);

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
  } catch {
    return NextResponse.json(
      { error: "注册暂时不可用，请稍后重试" },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }
}
