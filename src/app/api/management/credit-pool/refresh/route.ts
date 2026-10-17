import { refreshGatewayCreditPool } from "@/lib/model-gateway/credit-pool-accounting";
import { parseCreditPoolApplyInput } from "@/lib/model-gateway/credit-pool-management-contract";
import { creditPoolWrite } from "../_shared";
import { tryProcessPendingGiftPlans } from "@/lib/model-gateway/credit-gift-plans";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return creditPoolWrite(request, parseCreditPoolApplyInput, async (adminId, input) => {
    const result = await refreshGatewayCreditPool(adminId, input);
    const automaticGifts = await tryProcessPendingGiftPlans();
    return { operation: "source_refresh", committed: result.refreshed, replayed: result.replayed,
      eventId: `source-refresh:${input.requestKey}`, requestKey: input.requestKey, automaticGifts };
  });
}
