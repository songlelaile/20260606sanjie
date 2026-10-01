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

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { username?: string; password?: string; name?: string; inviteCode?: string }
    | null;

  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const name = typeof body?.name === "string" ? body.name.trim() || username : username;
  const inviteCode = typeof body?.inviteCode === "string" ? body.inviteCode.trim() : "";

  // 1) 账号字段校验
  const fieldError = await validateRegistration({ username, password });
  if (fieldError) {
    return NextResponse.json(
      { error: fieldError },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  // 2) 有邀请码走邀请注册；无邀请码走自主注册。两者都创建独立租户并下发会话。
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
    domain: process.env.NODE_ENV === "production" ? ".shaozhuangai.com" : undefined,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS
  });
  response.cookies.delete(ACTIVE_SHOP_COOKIE);
  return response;
}
