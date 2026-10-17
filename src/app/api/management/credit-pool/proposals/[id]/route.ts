import { getCreditPoolProposalView } from "@/lib/model-gateway/credit-pool-management-view";
import { parseCreditPoolId } from "@/lib/model-gateway/credit-pool-management-contract";
import { creditPoolRead } from "../../_shared";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return creditPoolRead(async adminId => getCreditPoolProposalView(adminId, parseCreditPoolId((await context.params).id)));
}
