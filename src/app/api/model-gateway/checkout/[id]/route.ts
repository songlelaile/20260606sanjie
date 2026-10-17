import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { getCheckout } from "@/lib/model-gateway/scan-payment";
import { gatewayPaymentErrorResponse } from "@/lib/model-gateway/payment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== "active") return NextResponse.json({ error: "未登录或账号不可用" }, { status: 401, headers });
    const { id } = await params;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return NextResponse.json({ error: "订单不存在", code: "ORDER_NOT_FOUND" }, { status: 404, headers });
    return NextResponse.json({ data: { order: await getCheckout(user.id, id) } }, { headers });
  } catch (error) {
    const failure = gatewayPaymentErrorResponse(error, "支付状态暂时无法查询，请稍后重试");
    return NextResponse.json(failure.body, { status: failure.status, headers });
  }
}
