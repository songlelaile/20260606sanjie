import { receiveScanNotification } from "@/lib/model-gateway/scan-payment";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    await receiveScanNotification("alipay", request);
    return new Response("success", { headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("failure", { status: 400, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  }
}
