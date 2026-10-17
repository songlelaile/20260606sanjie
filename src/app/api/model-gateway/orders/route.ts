import { NextResponse } from "next/server";
import { createGatewayOrder, getGatewayOverview } from "@/lib/model-gateway/store";
import { getCurrentUser } from "@/lib/server-session";
import { gatewayPaymentErrorResponse, GatewayPaymentError } from "@/lib/model-gateway/payment";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== "active") {
      return NextResponse.json({ error: "未登录或账号不可用" }, { status: 401, headers });
    }
    const overview = await getGatewayOverview(user.id);
    return NextResponse.json({ data: { orders: overview.orders } }, { headers });
  } catch (error) {
    const failure = gatewayPaymentErrorResponse(error, "订单服务暂时不可用，请稍后刷新");
    return NextResponse.json(failure.body, { status: failure.status, headers });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== "active") {
      return NextResponse.json({ error: "未登录或账号不可用" }, { status: 401, headers });
    }
    const body = await readJsonWithLimit(request, 4096);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !("planCode" in body) || typeof body.planCode !== "string" || body.planCode.length > 80) {
      throw new GatewayPaymentError("INVALID_PLAN", "请选择有效套餐", 400);
    }
    const order = await createGatewayOrder(user.id, body.planCode.trim());
    return NextResponse.json({ data: { order } }, { status: 201, headers });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "请求内容过大", code: "REQUEST_TOO_LARGE" }, { status: 413, headers });
    }
    const failure = gatewayPaymentErrorResponse(error, "订单服务暂时不可用，未能完成下单");
    return NextResponse.json(failure.body, { status: failure.status, headers });
  }
}
