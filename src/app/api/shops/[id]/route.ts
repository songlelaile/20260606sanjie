import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ACTIVE_SHOP_COOKIE } from "@/lib/auth";
import { deleteShop, updateShop } from "@/lib/store/runtime-store";

function setActiveShopCookie(response: NextResponse, shopId: string) {
  response.cookies.set(ACTIVE_SHOP_COOKIE, shopId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | { name?: string; platform?: string }
    | null;
  const result = await updateShop({
    shopId: id,
    name: body?.name ?? "",
    platform: body?.platform
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: { shop: result.shop } });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const activeBeforeDelete = (await cookies()).get(ACTIVE_SHOP_COOKIE)?.value ?? "";
  const result = await deleteShop(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const activeStillExists = result.shops.some((shop) => shop.id === activeBeforeDelete);
  const activeShopId = activeStillExists ? activeBeforeDelete : result.activeShopId;
  const response = NextResponse.json({
    data: {
      deletedShopId: result.deletedShopId,
      activeShopId,
      shops: result.shops
    }
  });
  setActiveShopCookie(response, activeShopId);
  return response;
}
