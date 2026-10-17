import { createAIAccessGrant, listAIAccessGrants } from "@/lib/ai-access";
import { aiAccessErrorResponse, aiAccessJson, requireAIAccessAdmin } from "@/lib/ai-access-route-security";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityAccountIdentity } from "@/lib/security-web-account";
import { securityRateLimitResponse } from "@/lib/security-response";
import { getActiveShopCookie } from "@/lib/session-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { return aiAccessJson({ data: { grants: await listAIAccessGrants(await requireAIAccessAdmin()) } }); }
  catch (error) { return aiAccessErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAIAccessAdmin();
    const limited = securityRateLimitResponse(await consumeSecurityRateLimit("ai-grant-create", securityAccountIdentity(actor), 20, 3600));
    if (limited) return limited;
    const body = await readJsonWithLimit(request, 4096);
    if (!body || typeof body !== "object" || Array.isArray(body)) return aiAccessJson({ error: "授权参数无效" }, 400);
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some(key => !["name", "scope"].includes(key)) ||
        (input.name !== undefined && typeof input.name !== "string") ||
        !["read", "action"].includes(String(input.scope))) {
      return aiAccessJson({ error: "授权参数无效" }, 400);
    }
    const result = await createAIAccessGrant(actor, { name: input.name as string | undefined, scope: input.scope as "read" | "action", activeShopId: await getActiveShopCookie() });
    return aiAccessJson({ data: result }, 201);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return aiAccessJson({ error: "授权信息过长" }, 413);
    if (error instanceof SyntaxError) return aiAccessJson({ error: "授权请求格式无效" }, 400);
    return aiAccessErrorResponse(error);
  }
}
