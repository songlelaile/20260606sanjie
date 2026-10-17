import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { creativeCreditAccountGuard, creativeCreditLedgerPage, CREATIVE_CREDIT_HEADERS } from "@/app/api/creative/credits/_shared";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only account history; never creates a wallet, order or payment. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const account = await creativeCreditAccountGuard();
    if ("response" in account) return account.response;
    const page = creativeCreditLedgerPage(request);
    const pageSize = 20;
    const where = { userId: account.userId };
    const [items, total] = await Promise.all([
      prisma.gatewayOrder.findMany({
        where, skip: (page - 1) * pageSize, take: pageSize,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, planName: true, amountCents: true, creditCents: true,
          status: true, creditAllocationState: true, paymentProvider: true, createdAt: true, paidAt: true }
      }),
      prisma.gatewayOrder.count({ where })
    ]);
    return NextResponse.json({ data: { items, total, page, pageSize } }, { headers: CREATIVE_CREDIT_HEADERS });
  } catch (error) {
    if (error instanceof GatewayBillingError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers: CREATIVE_CREDIT_HEADERS });
    }
    return NextResponse.json({ error: "充值订单暂不可用，请稍后重试", code: "ORDER_SERVICE_UNAVAILABLE" }, { status: 503, headers: CREATIVE_CREDIT_HEADERS });
  }
}
