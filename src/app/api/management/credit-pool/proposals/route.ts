import { prepareGatewayPoolAdoption, prepareGatewayPoolRefresh } from "@/lib/model-gateway/credit-pool-accounting";
import { getCreditPoolProposalView } from "@/lib/model-gateway/credit-pool-management-view";
import { parseCreditPoolPrepareInput } from "@/lib/model-gateway/credit-pool-management-contract";
import { creditPoolWrite } from "../_shared";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return creditPoolWrite(request, parseCreditPoolPrepareInput, async (adminId, input) => {
    const refs = { snapshotId: input.snapshotId, snapshotHash: input.snapshotHash };
    const proposal = input.operation === "adoption" ? await prepareGatewayPoolAdoption(adminId, refs) : await prepareGatewayPoolRefresh(adminId, refs);
    return getCreditPoolProposalView(adminId, proposal.proposalId);
  });
}
