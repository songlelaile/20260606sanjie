import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";

export const CREATIVE_CREDIT_HEADERS = { "Cache-Control": "private, no-store" };
export async function creativeCreditAccountGuard(): Promise<{ userId: string } | { response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") return { response: NextResponse.json({ error: "未登录或账号已失效", code: "AUTH_REQUIRED" }, { status: 401, headers: CREATIVE_CREDIT_HEADERS }) };
  return { userId: user.id };
}

export function creativeCreditErrorResponse(error: unknown) {
  if (error instanceof GatewayBillingError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: CREATIVE_CREDIT_HEADERS });
  return NextResponse.json({ error: "积分信息暂不可用，请稍后重试", code: "CREDIT_SERVICE_UNAVAILABLE" }, { status: 503, headers: CREATIVE_CREDIT_HEADERS });
}

export function creativeCreditLedgerPage(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((name) => name !== "page") || params.getAll("page").length > 1) throw new GatewayBillingError("INVALID_QUERY", "积分记录仅支持当前账号的页码查询");
  const raw = params.get("page");
  if (raw === null) return 1;
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new GatewayBillingError("INVALID_QUERY", "页码必须是 1 至 999999 的整数");
  return Number(raw);
}
