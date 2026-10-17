import { nativeVideoContentRoute } from "@/lib/model-gateway/native-video-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return nativeVideoContentRoute(request, (await context.params).id);
}
