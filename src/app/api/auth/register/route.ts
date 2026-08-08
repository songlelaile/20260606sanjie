import { NextResponse } from "next/server";
import {
  ACTIVE_SHOP_COOKIE,
  ROLE_HOME,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  serializeSession
} from "@/lib/auth";
import { createTenantOperatorByInvite, validateRegistration } from "@/lib/accounts";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { username?: string; password?: string; name?: string; inviteCode?: string }
    | null;

  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const name = typeof body?.name === "string" ? body.name.trim() || username : username;
  const inviteCode = typeof body?.inviteCode === "string" ? body.inviteCode : "";

  // 1) 账号字段校验
  const fieldError = await validateRegistration({ username, password });
  if (fieldError) {
    return NextResponse.json(
      { error: fieldError },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  // 2) 创建独立租户账号并下发会话（注册即登录，新租户默认无数据）
  const created = await createTenantOperatorByInvite({
    username,
    password,
    name,
    inviteCode
  });
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
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS
  });
  response.cookies.delete(ACTIVE_SHOP_COOKIE);
  return response;
}
