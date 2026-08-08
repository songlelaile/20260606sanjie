import { NextResponse } from "next/server";
import { createShop, getShopSwitcherData } from "@/lib/store/runtime-store";

export async function GET() {
  return NextResponse.json({ data: await getShopSwitcherData() });
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
