import { serveExtensionBootstrap } from "@/lib/extension-update-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ product: string }> }) {
  const { product } = await context.params;
  return serveExtensionBootstrap(product);
}
