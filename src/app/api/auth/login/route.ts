import { NextResponse } from "next/server";
import {
  ACTIVE_SHOP_COOKIE,
  ROLE_HOME,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  serializeSession
} from "@/lib/auth";
import { findAccount } from "@/lib/accounts";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
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
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS
  });
  response.cookies.delete(ACTIVE_SHOP_COOKIE);
  return response;
}
