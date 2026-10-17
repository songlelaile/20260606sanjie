import { NextResponse } from "next/server";
import { ACTIVE_SHOP_COOKIE, SESSION_COOKIE } from "@/lib/auth";

export async function POST() {
  const response = NextResponse.json(
    { data: { ok: true } },
    { headers: { "Cache-Control": "no-store" } }
  );
  // 同时清除当前主机 Cookie 与生产环境跨子域 SSO Cookie。
  response.cookies.delete(SESSION_COOKIE);
  if (process.env.NODE_ENV === "production") {
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      domain: ".shaozhuangai.com",
      path: "/",
      maxAge: 0
    });
  }
  response.cookies.delete(ACTIVE_SHOP_COOKIE);
  return response;
}
