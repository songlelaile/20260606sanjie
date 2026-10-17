import { getGiftPlansOverview, saveGiftPlan } from "@/lib/model-gateway/credit-gift-plans";
import { parseGiftPlanInput } from "@/lib/model-gateway/credit-gift-plans-contract";
import { creditPoolRead, creditPoolWrite } from "../credit-pool/_shared";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  return creditPoolRead(getGiftPlansOverview);
}
export async function POST(request: Request) {
  return creditPoolWrite(request, value => {
    const { userId, points, reason, requestKey, expiresAt } = parseGiftPlanInput(value);
    return { userId, points, reason, requestKey, expiresAt };
  }, saveGiftPlan);
}
