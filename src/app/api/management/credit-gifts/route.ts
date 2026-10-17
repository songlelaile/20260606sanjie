import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { getGatewayCreditGiftOverview, giftGatewayCredits } from "@/lib/model-gateway/credit-gifts";
import { parseGatewayCreditGiftInput } from "@/lib/model-gateway/credit-gifts-contract";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { rejectsCrossSiteMutation } from "@/lib/request-security";
import { BILLING_PRIVATE_HEADERS, gatewayBillingErrorResponse } from "../gateway-billing/_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function creditGiftAdminGuard(): Promise<{ adminId: string } | { response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) {
    return { response: NextResponse.json({ error: "未登录", code: "AUTH_REQUIRED" }, { status: 401, headers: BILLING_PRIVATE_HEADERS }) };
  }
  if (user.authRole !== "admin" || user.status !== "active") {
    return { response: NextResponse.json({ error: "仅启用中的管理员可赠送积分", code: "ADMIN_REQUIRED" }, { status: 403, headers: BILLING_PRIVATE_HEADERS }) };
  }
  return { adminId: user.id };
}

export async function GET() {
  try {
    const auth = await creditGiftAdminGuard();
    if ("response" in auth) return auth.response;
    return NextResponse.json({ data: await getGatewayCreditGiftOverview() }, { headers: BILLING_PRIVATE_HEADERS });
  } catch (error) {
    return gatewayBillingErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await creditGiftAdminGuard();
    if ("response" in auth) return auth.response;
    if (rejectsCrossSiteMutation(request)) {
      return NextResponse.json({ error: "跨站操作被拒绝", code: "CROSS_SITE_REQUEST" }, { status: 403, headers: BILLING_PRIVATE_HEADERS });
    }
    const body = await readJsonWithLimit(request, 4096);
    if (body === null) {
      return NextResponse.json({ error: "赠送积分请求必须是有效的 JSON 对象", code: "INVALID_JSON" }, { status: 400, headers: BILLING_PRIVATE_HEADERS });
    }
    const { userId, points, reason, requestKey } = parseGatewayCreditGiftInput(body);
    return NextResponse.json({ data: await giftGatewayCredits(auth.adminId, { userId, points, reason, requestKey }) }, { headers: BILLING_PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "赠送积分请求不能超过 4 KiB", code: "REQUEST_TOO_LARGE" }, { status: 413, headers: BILLING_PRIVATE_HEADERS });
    }
    return gatewayBillingErrorResponse(error);
  }
}
