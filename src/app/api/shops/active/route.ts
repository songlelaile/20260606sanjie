import { NextResponse } from "next/server";
import { ACTIVE_SHOP_COOKIE } from "@/lib/auth";
import { validateShopForCurrentTenant } from "@/lib/store/runtime-store";

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as { shopId?: string } | null;
  const shopId = body?.shopId?.trim() ?? "";
  if (!shopId) {
    return NextResponse.json({ error: "shopId 必填" }, { status: 400 });
  }
  const shop = await validateShopForCurrentTenant(shopId);
  if (!shop) {
    return NextResponse.json({ error: "店铺不存在" }, { status: 404 });
  }
  const response = NextResponse.json({ data: { shop } });
  response.cookies.set(ACTIVE_SHOP_COOKIE, shop.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365
  });
  return response;
}
