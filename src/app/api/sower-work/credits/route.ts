import { NextResponse } from "next/server";
import { getCreativeCredits } from "@/lib/creative-credit";
import { SOWER_WORK_CREDIT_META, type SowerWorkCreditsResponse } from "@/lib/sower-work-credit-contract";
import { sowerWorkCreditAccountGuard, sowerWorkCreditErrorResponse, sowerWorkCreditQuery, SOWER_WORK_CREDIT_HEADERS } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const account = await sowerWorkCreditAccountGuard();
    if ("response" in account) return account.response;
    sowerWorkCreditQuery(request);
    const response: SowerWorkCreditsResponse = { data: await getCreativeCredits(account.userId), meta: SOWER_WORK_CREDIT_META };
    return NextResponse.json(response, { headers: SOWER_WORK_CREDIT_HEADERS });
  } catch (error) { return sowerWorkCreditErrorResponse(error); }
}
