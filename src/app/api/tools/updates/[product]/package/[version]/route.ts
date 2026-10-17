import { serveExtensionUpdate } from "@/lib/extension-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ product: string; version: string }> }) {
  const { product, version } = await context.params;
  if (product === "ai-automation") return serveExtensionUpdate(product, version, request.headers.get("accept-encoding"));
  return serveExtensionUpdate(product, version);
}
