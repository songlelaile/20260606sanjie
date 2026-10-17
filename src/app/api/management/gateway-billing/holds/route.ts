import { NextResponse } from "next/server";
import { listGatewayBillingHoldsPendingReconciliation } from "@/lib/model-gateway/billing-hold";
import { BILLING_PRIVATE_HEADERS, gatewayBillingAdminGuard, gatewayBillingErrorResponse } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const auth = await gatewayBillingAdminGuard();
    if ("response" in auth) return auth.response;
    return NextResponse.json({ data: { items: await listGatewayBillingHoldsPendingReconciliation({ limit: 50 }), limit: 50 } }, { headers: BILLING_PRIVATE_HEADERS });
  } catch (error) { return gatewayBillingErrorResponse(error); }
}
