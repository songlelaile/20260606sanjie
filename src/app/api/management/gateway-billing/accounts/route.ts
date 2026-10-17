import { NextResponse } from "next/server";
import { listGatewayBillingAccounts } from "@/lib/model-gateway/billing";
import {
  BILLING_PRIVATE_HEADERS, gatewayBillingAdminGuard, gatewayBillingErrorResponse, parseGatewayBillingAccountsQuery
} from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = await gatewayBillingAdminGuard();
    if ("response" in auth) return auth.response;
    const query = parseGatewayBillingAccountsQuery(request);
    return NextResponse.json({ data: await listGatewayBillingAccounts(query) }, { headers: BILLING_PRIVATE_HEADERS });
  } catch (error) {
    return gatewayBillingErrorResponse(error);
  }
}
