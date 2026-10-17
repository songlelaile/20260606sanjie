import "server-only";
import { NextResponse } from "next/server";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";
import { rejectsCrossSiteMutation } from "@/lib/request-security";
import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityRateLimitResponse } from "@/lib/security-response";
import { securityAccountIdentity } from "@/lib/security-web-account";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { GatewayBillingError } from "./billing-contract";
import { NativeVideoError, plain, type NativeVideoOwner } from "./native-video-contract";
import { createNativeVideo, quoteNativeVideo, nativeVideoCapabilities, pollNativeVideo, resolveNativeVideo, nativeVideoContent, NATIVE_VIDEO_BODY_BYTES } from "./native-video";

const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
function json(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: noStore }); }
function notSubmitted(value: { error: string; code: string }, status: number, headers: HeadersInit = {}) {
  return NextResponse.json({ error: value.error, code: "NATIVE_VIDEO_REQUEST_NOT_SUBMITTED", reasonCode: value.code,
    providerSubmitted: false, definitiveFailure: true }, {
    status, headers: { ...noStore, ...Object.fromEntries(new Headers(headers)), "X-Sanjie-Provider-Submission": "not-submitted" }
  });
}
async function preflightResponse(response: Response) {
  // Only responses returned before createNativeVideo is invoked reach here.
  if (response.headers.get("X-Sanjie-Provider-Submission") === "not-submitted") return response;
  const body = await response.json() as { error: string; code: string };
  return notSubmitted(body, response.status, response.headers);
}
async function context(request: Request, checkExpected: string | null | undefined, create: boolean): Promise<NativeVideoOwner | Response> {
  if (rejectsCrossSiteMutation(request)) return json({ error: "跨站请求已拒绝", code: "CROSS_SITE_REJECTED" }, 403);
  const session = await getCurrentSession();
  if (!session) return json({ error: "请先登录", code: "ACCOUNT_UNAVAILABLE" }, 401);
  if (checkExpected !== undefined && checkExpected !== `${session.tenantId}:${session.username}`) {
    return NextResponse.json({ error: "登录账号已变化，请回到原账号核对任务", code: "CREATIVE_ACCOUNT_CHANGED", ...(create ? { providerSubmitted: false, definitiveFailure: true } : {}) },
      { status: 409, headers: { ...noStore, ...(create ? { "X-Sanjie-Provider-Submission": "not-submitted" } : {}) } });
  }
  const user = await getCurrentUser();
  if (!user || user.tenantId !== session.tenantId || user.username !== session.username) return json({ error: "当前登录已失效", code: "ACCOUNT_UNAVAILABLE" }, 401);
  const access = await getCreativeAccessForSession(session);
  if (!access.allowed) return json({ error: "当前账号没有视频工作台权限", code: "CREATIVE_ACCESS_DENIED" }, 403);
  const rules = create ? [["native-video-create-minute", 12, 60], ["native-video-create-hour", 100, 3600]] as const : [["native-video-read-minute", 180, 60]] as const;
  for (const [namespace, limit, window] of rules) {
    const denied = securityRateLimitResponse(await consumeSecurityRateLimit(namespace, securityAccountIdentity(session), limit, window));
    if (denied) return denied;
  }
  return { id: user.id, tenantId: user.tenantId, username: user.username };
}
function failure(cause: unknown, creating = false) {
  if (creating && cause instanceof NativeVideoError && cause.status === 503 &&
      ["NATIVE_VIDEO_CONFIG_INVALID", "NATIVE_VIDEO_SUPPLY_UNAVAILABLE", "NATIVE_VIDEO_DISABLED", "NATIVE_VIDEO_MODEL_UNAVAILABLE"].includes(cause.code)) {
    return NextResponse.json({ error: cause.message,
      code: cause.code === "NATIVE_VIDEO_MODEL_UNAVAILABLE" ? cause.code : "NATIVE_VIDEO_NOT_CONFIGURED",
      providerSubmitted: false, definitiveFailure: true },
      { status: 503, headers: { ...noStore, "X-Sanjie-Provider-Submission": "not-submitted" } });
  }
  if (cause instanceof RequestBodyTooLargeError) return creating
    ? notSubmitted({ error: "视频请求超过 24 MiB", code: "NATIVE_VIDEO_BODY_TOO_LARGE" }, 413)
    : json({ error: "视频请求超过 24 MiB", code: "NATIVE_VIDEO_BODY_TOO_LARGE" }, 413);
  if (creating && ((cause instanceof GatewayBillingError && cause.code === "INSUFFICIENT_BALANCE" && cause.status === 402) ||
      (cause instanceof NativeVideoError && cause.status === 400 && ["NATIVE_VIDEO_REQUEST_INVALID", "NATIVE_VIDEO_ASSET_UNSUPPORTED", "NATIVE_VIDEO_IDEMPOTENCY_REQUIRED"].includes(cause.code)))) {
    return notSubmitted({ error: cause.message, code: cause.code }, cause.status);
  }
  if (cause instanceof NativeVideoError || cause instanceof GatewayBillingError) return json({ error: cause.message, code: cause.code }, cause.status);
  // Never echo provider replies, URLs, credentials, SQL, or arbitrary exceptions.
  return json({ error: "视频服务暂不可用，已提交的请求请通过原任务查询", code: "NATIVE_VIDEO_UNAVAILABLE" }, 503);
}
export async function nativeVideoConfigRoute(request: Request) {
  try { const owner = await context(request, request.headers.get("X-Sanjie-Expected-Account"), false);
    return owner instanceof Response ? owner : json(await nativeVideoCapabilities(owner));
  } catch (cause) { return failure(cause); }
}
export async function nativeVideoCreateRoute(request: Request) {
  let createInvoked = false;
  try {
    // Reject cross-origin/body abuse before reading or creating any durable state.
    if (rejectsCrossSiteMutation(request)) return notSubmitted({ error: "跨站请求已拒绝", code: "CROSS_SITE_REJECTED" }, 403);
    const body = await readJsonWithLimit(request, NATIVE_VIDEO_BODY_BYTES);
    if (!plain(body) || typeof body.expectedAccount !== "string" || !body.expectedAccount || body.expectedAccount.length > 256) return notSubmitted({ error: "请提交账号标识和有效视频方案", code: "NATIVE_VIDEO_REQUEST_INVALID" }, 400);
    const owner = await context(request, body.expectedAccount, true);
    if (owner instanceof Response) return await preflightResponse(owner);
    createInvoked = true;
    return json(await createNativeVideo(owner, body, request.headers.get("Idempotency-Key")), 202);
  } catch (cause) {
    if (!createInvoked && !(cause instanceof RequestBodyTooLargeError)) {
      return notSubmitted({ error: "视频请求尚未提交，前置验证暂不可用，请稍后重试", code: "NATIVE_VIDEO_PREFLIGHT_UNAVAILABLE" }, cause instanceof SyntaxError ? 400 : 503);
    }
    return failure(cause, true);
  }
}
export async function nativeVideoStatusRoute(request: Request, id: string) {
  try {
    const owner = await context(request, request.headers.get("X-Sanjie-Expected-Account"), false);
    if (owner instanceof Response) return owner;
    if (!/^nv_[a-f0-9-]{36}$/.test(id)) return json({ error: "视频任务不存在", code: "NATIVE_VIDEO_NOT_FOUND" }, 404);
    return json(await pollNativeVideo(owner, id));
  } catch (cause) { return failure(cause); }
}
export async function nativeVideoResolveRoute(request: Request) {
  try { const owner = await context(request, request.headers.get("X-Sanjie-Expected-Account"), false);
    return owner instanceof Response ? owner : json(await resolveNativeVideo(owner, request.headers.get("Idempotency-Key")));
  } catch (cause) { return failure(cause); }
}
export async function nativeVideoContentRoute(request: Request, id: string) {
  try {
    // A <video> element cannot set custom headers. Ownership is checked from its
    // signed session and exact local job ID; no client/provider URL is accepted.
    const owner = await context(request, undefined, false);
    if (owner instanceof Response) return owner;
    if (!/^nv_[a-f0-9-]{36}$/.test(id)) return json({ error: "视频任务不存在", code: "NATIVE_VIDEO_NOT_FOUND" }, 404);
    return await nativeVideoContent(owner, id, request);
  } catch (cause) { return failure(cause); }
}

export async function nativeVideoQuoteRoute(request: Request) {
  try {
    if (rejectsCrossSiteMutation(request)) return json({ error: "跨站请求已拒绝", code: "CROSS_SITE_REJECTED" }, 403);
    const body = await readJsonWithLimit(request, NATIVE_VIDEO_BODY_BYTES);
    if (!plain(body) || typeof body.expectedAccount !== "string" || !body.expectedAccount || body.expectedAccount.length > 256) return json({ error: "请提交账号标识和有效视频方案", code: "NATIVE_VIDEO_REQUEST_INVALID" }, 400);
    const owner = await context(request, body.expectedAccount, false);
    return owner instanceof Response ? owner : json(await quoteNativeVideo(owner, body));
  } catch (cause) { return failure(cause); }
}
