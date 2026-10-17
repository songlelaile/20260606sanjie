import { listAIAccessEvents } from "@/lib/ai-access";
import { aiAccessErrorResponse, aiAccessJson, requireAIAccessAdmin } from "@/lib/ai-access-route-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return aiAccessJson({ data: { events: await listAIAccessEvents(await requireAIAccessAdmin()) } }); }
  catch (error) { return aiAccessErrorResponse(error); }
}
