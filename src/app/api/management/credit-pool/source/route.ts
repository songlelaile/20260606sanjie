import { persistGatewaySharedSourceSnapshot } from "@/lib/model-gateway/credit-pool-accounting";
import { getCreditPoolManagementOverview } from "@/lib/model-gateway/credit-pool-management-view";
import { parseCreditPoolVerificationInput } from "@/lib/model-gateway/credit-pool-management-contract";
import { creditPoolWrite } from "../_shared";
import { tryProcessPendingGiftPlans } from "@/lib/model-gateway/credit-gift-plans";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return creditPoolWrite(request, parseCreditPoolVerificationInput, async (adminId, input) => {
    const result = await persistGatewaySharedSourceSnapshot(adminId, input.requestKey);
    if (result.ready) await tryProcessPendingGiftPlans();
    return getCreditPoolManagementOverview();
  });
}
