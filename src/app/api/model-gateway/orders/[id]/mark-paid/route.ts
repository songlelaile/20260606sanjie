import { NextResponse } from "next/server";
import { markGatewayOrderPaidByOrderId } from "@/lib/model-gateway/store";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { gatewayPaymentErrorResponse, parseManualPaymentConfirmation } from "@/lib/model-gateway/payment";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const [session, user] = await Promise.all([getCurrentSession(), getCurrentUser()]);
    if (!session || !user || user.status !== "active") {
      return NextResponse.json({ error: "未登录或账号不可用" }, { status: 401, headers });
    }
    if (session.role !== "admin" || user.authRole !== "admin") {
      return NextResponse.json({ error: "仅管理员可手动确认付款" }, { status: 403, headers });
    }
    const { id } = await params;
    const body = await readJsonWithLimit(request, 8192);
    const confirmation = parseManualPaymentConfirmation(body, user.id);
    const order = await markGatewayOrderPaidByOrderId(id, confirmation);
    return NextResponse.json({ data: { order } }, { headers });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "请求内容过大", code: "REQUEST_TOO_LARGE" }, { status: 413, headers });
    }
    const failure = gatewayPaymentErrorResponse(error, "付款确认暂时不可用，请稍后核对订单状态");
    return NextResponse.json(failure.body, { status: failure.status, headers });
  }
}
