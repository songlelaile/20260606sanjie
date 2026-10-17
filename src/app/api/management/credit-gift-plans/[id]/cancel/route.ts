import { cancelGiftPlan } from "@/lib/model-gateway/credit-gift-plans";
import { parseCreditPoolSourceReadInput } from "@/lib/model-gateway/credit-pool-management-contract";
import { creditPoolWrite } from "../../../credit-pool/_shared";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return creditPoolWrite(request, parseCreditPoolSourceReadInput, async adminId => cancelGiftPlan(adminId, (await context.params).id));
}
