import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { rejectsCrossSiteMutation } from "@/lib/request-security";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { cancelGatewayBillingHold, cancelGatewayBillingRequest } from "@/lib/model-gateway/billing-hold";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";

import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityRateLimitResponse } from "@/lib/security-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  try {
    if (rejectsCrossSiteMutation(request)) return NextResponse.json({ error: "跨站取消请求被拒绝" }, { status: 403, headers });
    const user = await getCurrentUser();
    if (!user || user.status !== "active") return NextResponse.json({ error: "请重新登录", code: "AUTH_REQUIRED" }, { status: 401, headers });
    const body = await readJsonWithLimit(request, 2048);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new GatewayBillingError("INVALID_REQUEST", "取消请求无效", 400);
    const input = body as Record<string, unknown>;
    const denied = securityRateLimitResponse(await consumeSecurityRateLimit("creative-billing-cancel", "user:" + user.id, 300, 60));
    if (denied) return denied;
    if (input.expectedAccount !== undefined && input.expectedAccount !== `${user.tenantId}:${user.username}`) throw new GatewayBillingError("ACCOUNT_CHANGED", "账号已变化，请回到原账号取消", 409);
    if (Object.keys(input).some(key => !["billingEventId", "idempotencyKey", "expectedAccount"].includes(key)) || !!input.billingEventId === !!input.idempotencyKey) throw new GatewayBillingError("INVALID_REQUEST", "请使用原任务计费编号或请求标识取消", 400);
    const result = typeof input.billingEventId === "string"
      ? await cancelGatewayBillingHold({ userId: user.id, eventId: input.billingEventId })
      : typeof input.idempotencyKey === "string"
        ? await cancelGatewayBillingRequest({ userId: user.id, idempotencyKey: input.idempotencyKey })
        : null;
    if (!result) throw new GatewayBillingError("INVALID_REQUEST", "取消请求标识无效", 400);
    const hold = result.hold;
    const cancelled = !hold || !!hold.cancelledAt;
    const alreadyRefunded = !!hold && hold.refundedCents > 0;
    return NextResponse.json({ cancelled, providerCancelled: false, refundOnCancel: false,
      billingEventId: hold?.eventId ?? null, chargedCents: hold?.chargedCents ?? 0, refundedCents: hold?.refundedCents ?? 0,
      replayed: result.replayed, message: alreadyRefunded ? "该任务已失败并退回积分，本次取消不会改变已完成的退款。" : "已记录取消；已提交任务的积分不退回，供应任务可能继续执行。" }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof GatewayBillingError ? error.message : "取消记录暂不可用，请重试",
      code: error instanceof GatewayBillingError ? error.code : "CANCEL_RECORD_UNAVAILABLE" }, { status: error instanceof GatewayBillingError ? error.status : error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 503, headers });
  }
}
