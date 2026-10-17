import { NextResponse } from "next/server";
import { getActiveShopCookie } from "@/lib/session-server";
import { createShop, getShopSwitcherData } from "@/lib/store/runtime-store";

export async function GET() {
  const [data, cookieShopId] = await Promise.all([
    getShopSwitcherData(),
    getActiveShopCookie()
  ]);
  const explicitId = String(cookieShopId ?? "").trim();
  const activeShopExplicit = Boolean(
    explicitId
    && data.shops.filter((shop) => shop.id === explicitId).length === 1
    && data.activeShopId === explicitId
  );
  return NextResponse.json({ data: { ...data, activeShopExplicit } });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { name?: string; platform?: string }
    | null;
  const result = await createShop({
    name: body?.name ?? "",
    platform: body?.platform
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: { shop: result.shop } }, { status: 201 });
}
