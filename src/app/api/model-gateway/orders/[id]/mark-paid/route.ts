import { NextResponse } from "next/server";
import { markGatewayOrderPaidByOrderId } from "@/lib/model-gateway/store";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [session, user] = await Promise.all([getCurrentSession(), getCurrentUser()]);
  if (!session || !user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可手动确认付款" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const order = await markGatewayOrderPaidByOrderId(id);
    return NextResponse.json({ data: { order } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "确认失败" }, { status: 400 });
  }
}
