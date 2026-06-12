import { NextResponse } from "next/server";
import { ROLE_HOME, SESSION_COOKIE, serializeSession } from "@/lib/auth";
import { findAccount } from "@/lib/accounts";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { username?: string; password?: string }
    | null;
  const account = await findAccount(body?.username?.trim() ?? "", body?.password ?? "");
  if (account === "disabled") {
    return NextResponse.json({ error: "该账号已被禁用，请联系管理员" }, { status: 403 });
  }
  if (!account) {
    return NextResponse.json({ error: "账号或密码错误" }, { status: 401 });
  }
  const response = NextResponse.json({
    data: { role: account.role, name: account.name, home: ROLE_HOME[account.role] }
  });
  response.cookies.set(
    SESSION_COOKIE,
    serializeSession({
      username: account.username,
      role: account.role,
      name: account.name,
      tenantId: account.tenantId
    }),
    {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 8
    }
  );
  return response;
}
