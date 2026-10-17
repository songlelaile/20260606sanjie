import { NextResponse } from "next/server";
import { getGatewayBillingRules, updateGatewayBillingRule } from "@/lib/model-gateway/billing";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import {
  BILLING_PRIVATE_HEADERS, gatewayBillingAdminGuard, gatewayBillingErrorResponse, parseGatewayBillingRuleInput
} from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const auth = await gatewayBillingAdminGuard();
    if ("response" in auth) return auth.response;
    return NextResponse.json({ data: await getGatewayBillingRules() }, { headers: BILLING_PRIVATE_HEADERS });
  } catch (error) {
    return gatewayBillingErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const auth = await gatewayBillingAdminGuard();
    if ("response" in auth) return auth.response;
    const input = parseGatewayBillingRuleInput(await readJsonWithLimit(request, 4096));
    return NextResponse.json({ data: await updateGatewayBillingRule(auth.adminId, input) }, { headers: BILLING_PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "扣费规则请求不能超过 4 KiB", code: "REQUEST_TOO_LARGE" }, { status: 413, headers: BILLING_PRIVATE_HEADERS });
    }
    return gatewayBillingErrorResponse(error);
  }
}
