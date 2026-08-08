import { NextResponse } from "next/server";
import { createGatewayOrder, getGatewayOverview } from "@/lib/model-gateway/store";
import { getCurrentUser } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const overview = await getGatewayOverview(user.id);
  return NextResponse.json({ data: { orders: overview.orders } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { planCode?: string } | null;
  try {
    const order = await createGatewayOrder(user.id, body?.planCode || "");
    return NextResponse.json({ data: { order } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "下单失败" }, { status: 400 });
  }
}
