import { handleGatewayImageEdits } from "@/lib/model-gateway/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleGatewayImageEdits(request);
}
