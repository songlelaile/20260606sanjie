import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";
import { getCreditPoolOperationReceipt } from "@/lib/model-gateway/credit-pool-management-view";
import { parseCreditPoolOperation, parseCreditPoolRequestKey } from "@/lib/model-gateway/credit-pool-management-contract";
import { creditPoolRead } from "../../_shared";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ requestKey: string }> }) {
  return creditPoolRead(async adminId => {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== "operation") || params.getAll("operation").length !== 1) throw new GatewayBillingError("POOL_INPUT_INVALID", "核对操作参数无效", 400);
    const operation = parseCreditPoolOperation(params.get("operation"));
    const requestKey = parseCreditPoolRequestKey((await context.params).requestKey);
    const receipt = await getCreditPoolOperationReceipt(adminId, operation, requestKey);
    return { operation, requestKey, state: receipt ? "committed" : "not_found", receipt };
  });
}
