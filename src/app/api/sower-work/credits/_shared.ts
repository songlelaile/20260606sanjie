import { NextResponse } from "next/server";
import { getSowerWorkAccess, sowerWorkAccessResponse } from "@/lib/sower-work-access";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";

export const SOWER_WORK_CREDIT_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };

/** Resolve the wallet only from the current live Sower Work administrator session. */
export async function sowerWorkCreditAccountGuard(): Promise<{ userId: string } | { response: NextResponse }> {
  const access = await getSowerWorkAccess();
  if (!access.allowed) {
    const response = sowerWorkAccessResponse(access);
    response.headers.set("Vary", "Cookie");
    return { response };
  }
  return { userId: access.user.id };
}

/** No identity or filter supplied by the requester can select another wallet. */
export function sowerWorkCreditQuery(request: Request, ledger = false): number {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(name => !ledger || name !== "page") || params.getAll("page").length > 1) {
    throw new GatewayBillingError("INVALID_QUERY", ledger ? "积分记录仅支持当前登录账号的页码查询" : "积分查询仅支持当前登录账号");
  }
  const page = params.get("page");
  if (page === null) return 1;
  if (!/^[1-9]\d{0,5}$/.test(page)) throw new GatewayBillingError("INVALID_QUERY", "页码必须是 1 至 999999 的整数");
  return Number(page);
}

export function sowerWorkCreditErrorResponse(error: unknown): NextResponse {
  if (error instanceof GatewayBillingError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: SOWER_WORK_CREDIT_HEADERS });
  }
  return NextResponse.json({ error: "积分信息暂不可用，请稍后重试", code: "CREDIT_SERVICE_UNAVAILABLE" }, { status: 503, headers: SOWER_WORK_CREDIT_HEADERS });
}
