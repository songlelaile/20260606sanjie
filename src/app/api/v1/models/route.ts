import { handleGatewayModels } from "@/lib/model-gateway/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleGatewayModels(request);
}
