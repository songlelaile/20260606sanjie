import { NextResponse } from "next/server";
import { listGatewayBillingLedger } from "@/lib/model-gateway/billing";
import {
  BILLING_PRIVATE_HEADERS, gatewayBillingAdminGuard, gatewayBillingErrorResponse, parseGatewayBillingLedgerQuery
} from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await gatewayBillingAdminGuard();
    if ("response" in auth) return auth.response;
    const query = parseGatewayBillingLedgerQuery(request);
    return NextResponse.json({ data: await listGatewayBillingLedger(query) }, { headers: BILLING_PRIVATE_HEADERS });
  } catch (error) {
    return gatewayBillingErrorResponse(error);
  }
}
