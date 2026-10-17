import { createHash } from "node:crypto";
import { authorizeAIAccessToken, recordAIAccessEvent } from "@/lib/ai-access";
import { resolveAiAccessOperation, evaluateAiAccessOperation } from "@/lib/ai-access-operation-policy";
import { executeAiAccessOperation } from "@/lib/ai-access-operations";
import { aiAccessErrorResponse, aiAccessJson } from "@/lib/ai-access-route-security";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityRateLimitResponse } from "@/lib/security-response";
import { trustedClientIp } from "@/lib/security-client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    // Bound invalid credentials and scope denials before authorization writes
    // an audit row. No bearer, IP or body is persisted as a quota identity.
    const ip = trustedClientIp(request);
    const attempt = securityRateLimitResponse(await consumeSecurityRateLimit(
      ip ? "ai-channel-ip-attempt" : "ai-channel-unknown-attempt", ip ?? "unknown-client", ip ? 120 : 600, 60));
    if (attempt) return attempt;
    const token = /^Bearer\s+(sja_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") || "")?.[1];
    if (!token) return aiAccessJson({ error: "请提供管理员签发的 AI 授权令牌", code: "AI_TOKEN_REQUIRED" }, 401);
    const tokenAttempt = securityRateLimitResponse(await consumeSecurityRateLimit(
      "ai-channel-token-attempt", createHash("sha256").update(token).digest("hex"), 90, 60));
    if (tokenAttempt) return tokenAttempt;
    const body = await readJsonWithLimit(request, 8192);
    const resolved = resolveAiAccessOperation(body);
    if (!resolved.allowed) return aiAccessJson({ error: resolved.error, code: resolved.code }, resolved.status);
    const authorization = await authorizeAIAccessToken(token, "read");
    if (!authorization) return aiAccessJson({ error: "AI 授权无效、已关闭、已撤销或账号权限已变化", code: "AI_TOKEN_INVALID" }, 401);
    const limited = securityRateLimitResponse(await consumeSecurityRateLimit("ai-channel-execute", JSON.stringify([authorization.tenantId, authorization.userId]), 60, 60));
    if (limited) return limited;
    const permitted = evaluateAiAccessOperation(body, authorization.scope);
    if (!permitted.allowed) {
      await recordAIAccessEvent(authorization, { method: resolved.operation.method, path: resolved.operation.path.split("?")[0], status: permitted.status });
      return aiAccessJson({ error: permitted.error, code: permitted.code }, permitted.status);
    }
    const event = { method: permitted.operation.method, path: permitted.operation.path.split("?")[0] };
    await recordAIAccessEvent(authorization, event);
    try {
      const result = await executeAiAccessOperation(permitted.operation, authorization);
      await recordAIAccessEvent(authorization, { ...event, status: 200 });
      return aiAccessJson({ data: result });
    } catch (error) {
      const response = aiAccessErrorResponse(error);
      await recordAIAccessEvent(authorization, { ...event, status: response.status });
      return response;
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return aiAccessJson({ error: "AI 通道请求过长" }, 413);
    if (error instanceof SyntaxError) return aiAccessJson({ error: "AI 通道请求格式无效" }, 400);
    return aiAccessErrorResponse(error);
  }
}
