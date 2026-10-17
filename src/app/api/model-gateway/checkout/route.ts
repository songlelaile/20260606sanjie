import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { createCheckout, getCheckoutProviders, isScanProvider } from "@/lib/model-gateway/scan-payment";
import { gatewayPaymentErrorResponse, GatewayPaymentError } from "@/lib/model-gateway/payment";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== "active") return NextResponse.json({ error: "未登录或账号不可用" }, { status: 401, headers });
    return NextResponse.json({ data: { providers: getCheckoutProviders() } }, { headers });
  } catch (error) {
    const failure = gatewayPaymentErrorResponse(error, "支付方式暂时不可用");
    return NextResponse.json(failure.body, { status: failure.status, headers });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user || user.status !== "active") return NextResponse.json({ error: "未登录或账号不可用" }, { status: 401, headers });
    const body = await readJsonWithLimit(request, 4096);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !("planCode" in body) || typeof body.planCode !== "string" || !body.planCode.trim() || body.planCode.length > 80 ||
        !("provider" in body) || !isScanProvider(body.provider)) {
      throw new GatewayPaymentError("INVALID_CHECKOUT", "请选择有效套餐与支付方式", 400);
    }
    const order = await createCheckout(user.id, body.planCode.trim(), body.provider);
    return NextResponse.json({ data: { order } }, { status: 201, headers });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "请求内容过大", code: "REQUEST_TOO_LARGE" }, { status: 413, headers });
    const failure = gatewayPaymentErrorResponse(error, "支付下单暂时不可用，请稍后重试");
    return NextResponse.json(failure.body, { status: failure.status, headers });
  }
}
