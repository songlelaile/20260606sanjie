import { NextResponse } from "next/server";
import { getCreativeCreditLedger } from "@/lib/creative-credit";
import { creativeCreditAccountGuard, creativeCreditErrorResponse, creativeCreditLedgerPage, CREATIVE_CREDIT_HEADERS } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const account = await creativeCreditAccountGuard();
    if ("response" in account) return account.response;
    const page = creativeCreditLedgerPage(request);
    return NextResponse.json({ data: await getCreativeCreditLedger(account.userId, page) }, { headers: CREATIVE_CREDIT_HEADERS });
  } catch (error) { return creativeCreditErrorResponse(error); }
}
