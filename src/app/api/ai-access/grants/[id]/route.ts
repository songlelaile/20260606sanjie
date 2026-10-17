import { revokeAIAccessGrant, setAIAccessGrantEnabled } from "@/lib/ai-access";
import { aiAccessErrorResponse, aiAccessJson, requireAIAccessAdmin } from "@/lib/ai-access-route-security";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityAccountIdentity } from "@/lib/security-web-account";
import { securityRateLimitResponse } from "@/lib/security-response";

export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAIAccessAdmin();
    const limited = securityRateLimitResponse(await consumeSecurityRateLimit("ai-grant-toggle", securityAccountIdentity(actor), 60, 60));
    if (limited) return limited;
    const body = await readJsonWithLimit(request, 1024);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 1 || typeof (body as { enabled?: unknown }).enabled !== "boolean") {
      return aiAccessJson({ error: "通道开关参数无效" }, 400);
    }
    const grant = await setAIAccessGrantEnabled(actor, (await context.params).id, (body as { enabled: boolean }).enabled);
    return aiAccessJson({ data: { grant } });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return aiAccessJson({ error: "通道开关信息过长" }, 413);
    if (error instanceof SyntaxError) return aiAccessJson({ error: "通道开关请求格式无效" }, 400);
    return aiAccessErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAIAccessAdmin();
    return aiAccessJson({ data: await revokeAIAccessGrant(actor, (await context.params).id) });
  } catch (error) { return aiAccessErrorResponse(error); }
}
