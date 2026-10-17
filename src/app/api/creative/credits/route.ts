import { NextResponse } from "next/server";
import { getCreativeCredits } from "@/lib/creative-credit";
import { creativeCreditAccountGuard, creativeCreditErrorResponse, CREATIVE_CREDIT_HEADERS } from "./_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const account = await creativeCreditAccountGuard();
    if ("response" in account) return account.response;
    return NextResponse.json({ data: await getCreativeCredits(account.userId) }, { headers: CREATIVE_CREDIT_HEADERS });
  } catch (error) { return creativeCreditErrorResponse(error); }
}
