import { NextResponse } from "next/server";
import { ACTIVE_SHOP_COOKIE, SESSION_COOKIE } from "@/lib/auth";

export async function POST() {
  const response = NextResponse.json(
    { data: { ok: true } },
    { headers: { "Cache-Control": "no-store" } }
  );
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(ACTIVE_SHOP_COOKIE);
  return response;
}
