import { handleGatewayVideoRead } from "@/lib/model-gateway/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleGatewayVideoRead(request, id, false);
}
