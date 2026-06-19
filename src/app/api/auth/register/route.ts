import { NextResponse } from "next/server";
import { ROLE_HOME, SESSION_COOKIE, serializeSession } from "@/lib/auth";
import { createTenantOperator, validateRegistration } from "@/lib/accounts";
import { consumeInviteCode } from "@/lib/store/runtime-store";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { username?: string; password?: string; name?: string; inviteCode?: string }
    | null;

  const username = (body?.username ?? "").trim();
  const password = body?.password ?? "";
  const name = (body?.name ?? "").trim() || username;
  const inviteCode = body?.inviteCode ?? "";

  // 1) 账号字段校验
  const fieldError = await validateRegistration({ username, password });
  if (fieldError) {
    return NextResponse.json({ error: fieldError }, { status: 400 });
  }

  // 2) 消费管理后台签发的邀请码（吊销/用尽即失效）
  const invite = await consumeInviteCode(inviteCode, { name, username });
  if (!invite.ok) {
    return NextResponse.json({ error: invite.error }, { status: 400 });
  }

  // 3) 在邀请码所属租户下创建运营账号并下发会话（注册即登录）
  const account = await createTenantOperator({
    tenantId: invite.invite.tenantId,
    username,
    password,
    name,
    shopName: invite.invite.note
  });

  const response = NextResponse.json({
    data: { role: account.role, name: account.name, home: ROLE_HOME[account.role] }
  });
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
    maxAge: 60 * 60 * 8
  });
  return response;
}
