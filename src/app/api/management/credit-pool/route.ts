import { getCreditPoolManagementOverview } from "@/lib/model-gateway/credit-pool-management-view";
import { creditPoolRead } from "./_shared";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() { return creditPoolRead(() => getCreditPoolManagementOverview()); }
