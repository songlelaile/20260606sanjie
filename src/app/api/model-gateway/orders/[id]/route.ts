import { NextResponse } from "next/server";
import { getGatewayOrder } from "@/lib/model-gateway/store";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { gatewayPaymentErrorResponse } from "@/lib/model-gateway/payment";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const [session, user] = await Promise.all([getCurrentSession(), getCurrentUser()]);
    if (!session || !user || user.status !== "active") {
      return NextResponse.json({ error: "未登录或账号不可用" }, { status: 401, headers });
    }
    const { id } = await params;
    const isAdmin = session.role === "admin" && user.authRole === "admin";
    const order = await getGatewayOrder(user.id, id, isAdmin);
    if (!order) {
      return NextResponse.json({ error: "订单不存在", code: "ORDER_NOT_FOUND" }, { status: 404, headers });
    }
    return NextResponse.json({ data: { order } }, { headers });
  } catch (error) {
    const failure = gatewayPaymentErrorResponse(error, "订单服务暂时不可用，请稍后刷新");
    return NextResponse.json(failure.body, { status: failure.status, headers });
  }
}
