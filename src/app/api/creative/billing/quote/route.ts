import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { rejectsCrossSiteMutation } from "@/lib/request-security";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { getGatewayBillingSnapshot } from "@/lib/model-gateway/billing";
import { findAvailableGatewayModel } from "@/lib/model-gateway/runtime-catalog";
import { prepareGatewayBillingQuote } from "@/lib/model-gateway/billing-request";
import { applyGatewayBillingCost, centsToPoints, GatewayBillingError } from "@/lib/model-gateway/billing-contract";

import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityRateLimitResponse } from "@/lib/security-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
type Endpoint = "chat.completions" | "images.generations" | "images.edits" | "videos";

/** Read-only site price. Prompts and credentials are neither stored nor echoed. */
export async function POST(request: Request) {
  try {
    if (rejectsCrossSiteMutation(request)) return NextResponse.json({ error: "跨站报价请求被拒绝" }, { status: 403, headers });
    const user = await getCurrentUser();
    if (!user || user.status !== "active") return NextResponse.json({ error: "请重新登录", code: "AUTH_REQUIRED" }, { status: 401, headers });
    const body = await readJsonWithLimit(request, 32 * 1024 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new GatewayBillingError("INVALID_REQUEST", "报价请求无效", 400);
    const input = body as Record<string, unknown>;
    const denied = securityRateLimitResponse(await consumeSecurityRateLimit("creative-billing-quote", "user:" + user.id, 120, 60));
    if (denied) return denied;
    if (input.expectedAccount !== undefined && input.expectedAccount !== `${user.tenantId}:${user.username}`) throw new GatewayBillingError("ACCOUNT_CHANGED", "账号已变化，请重新核对报价", 409);
    if (!["chat.completions", "images.generations", "images.edits", "videos"].includes(String(input.endpoint)) || typeof input.model !== "string" || !input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw new GatewayBillingError("INVALID_REQUEST", "模型或报价参数无效", 400);
    const endpoint = input.endpoint as Endpoint;
    const model = await findAvailableGatewayModel(input.model, endpoint === "images.edits" ? "images.generations" : endpoint);
    if (!model || model.provider !== "shaozhuang") throw new GatewayBillingError("MODEL_UNAVAILABLE", "平台未开通该模型", 404);
    const snapshot = await getGatewayBillingSnapshot(user.id);
    const quoteCents = applyGatewayBillingCost(prepareGatewayBillingQuote(model, endpoint, { ...input.body as Record<string, unknown> }), snapshot);
    return NextResponse.json({ billingMode: "prepaid_quote", quoteCents, quotePoints: centsToPoints(quoteCents),
      refundOnFailure: true, refundOnCancel: false, message: "提交时扣报价积分；生成失败退回，取消不退。" }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof GatewayBillingError ? error.message : "积分报价暂不可用，请重试",
      code: error instanceof GatewayBillingError ? error.code : "QUOTE_UNAVAILABLE" }, { status: error instanceof GatewayBillingError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 503, headers });
  }
}
