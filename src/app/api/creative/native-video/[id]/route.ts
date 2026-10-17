import { nativeVideoStatusRoute } from "@/lib/model-gateway/native-video-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return nativeVideoStatusRoute(request, (await context.params).id);
}
