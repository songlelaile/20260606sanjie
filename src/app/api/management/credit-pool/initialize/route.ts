import { initializeGatewayCreditPool } from "@/lib/model-gateway/credit-pool-accounting";
import { parseCreditPoolApplyInput } from "@/lib/model-gateway/credit-pool-management-contract";
import { creditPoolWrite } from "../_shared";
import { tryProcessPendingGiftPlans } from "@/lib/model-gateway/credit-gift-plans";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return creditPoolWrite(request, parseCreditPoolApplyInput, async (adminId, input) => {
    const result = await initializeGatewayCreditPool(adminId, input);
    const automaticGifts = await tryProcessPendingGiftPlans();
    return { operation: "adoption", committed: result.initialized, replayed: result.replayed, eventId: result.eventId, requestKey: input.requestKey, automaticGifts };
  });
}
