import { NextResponse } from "next/server";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";
import { rejectsCrossSiteMutation } from "@/lib/request-security";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityAccountIdentity } from "@/lib/security-web-account";
import { securityRateLimitResponse } from "@/lib/security-response";
import { generateNarration, readNarration, narrationCapabilities, narrationErrorView, NarrationError, parseNarrationInput, type NarrationReceipt } from "@/lib/video-narration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
function errorResponse(error: unknown) { const view = narrationErrorView(error); return NextResponse.json(view.body, { status: view.status, headers: PRIVATE_HEADERS }); }
async function guard() {
  const session = await getCurrentSession();
  if (!session) throw new NarrationError("NARRATION_AUTH_REQUIRED", "请先登录后生成脚本配音。", 401);
  const access = await getCreativeAccessForSession(session);
  if (!access.allowed) throw new NarrationError("NARRATION_ACCESS_DENIED", "当前账号没有创作权限。", access.reason === "invalid_account" ? 401 : 402);
  const user = await getCurrentUser();
  if (!user || user.status !== "active" || user.username !== session.username || user.tenantId !== session.tenantId) throw new NarrationError("NARRATION_AUTH_REQUIRED", "登录账号已失效。", 401);
  return { session, user };
}
function audioResponse(result: { receipt: NarrationReceipt; bytes: Uint8Array }) {
  const receipt = result.receipt;
  return new NextResponse(new Uint8Array(result.bytes), { headers: { ...PRIVATE_HEADERS, "Content-Type": "audio/wav",
    "X-Narration-Request-Id": receipt.requestId, "X-Narration-Duration": String(receipt.durationSeconds),
    "X-Narration-Fingerprint": receipt.fingerprint, "X-Narration-Content-Hash": receipt.contentHash || "",
    "X-Narration-Billing-Event": receipt.billingEventId, "X-Narration-Origin": "script_narration" } });
}
export async function GET(request: Request) {
  try {
    const { user } = await guard(); const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !["requestId", "expectedAccountKey"].includes(key)) || params.getAll("requestId").length > 1 || params.getAll("expectedAccountKey").length !== 1) throw new NarrationError("NARRATION_INPUT_INVALID", "配音查询参数无效。");
    if (params.get("expectedAccountKey") !== user.id) throw new NarrationError("NARRATION_ACCOUNT_CHANGED", "登录账号已变化，请切回原账号核对配音。", 409);
    const requestId = params.get("requestId");
    if (!requestId) return NextResponse.json({ data: narrationCapabilities() }, { headers: PRIVATE_HEADERS });
    return audioResponse(await readNarration(user, requestId));
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    if (rejectsCrossSiteMutation(request)) throw new NarrationError("NARRATION_CROSS_SITE_REJECTED", "跨站配音请求已拒绝。", 403);
    const { user, session } = await guard();
    let raw: unknown;
    try { raw = await readJsonWithLimit(request, 16 * 1024); }
    catch (error) { if (error instanceof RequestBodyTooLargeError) throw new NarrationError("NARRATION_INPUT_TOO_LARGE", "配音请求超过 16 KiB。", 413); throw error; }
    const input = parseNarrationInput(raw);
    if (input.expectedAccountKey !== user.id) throw new NarrationError("NARRATION_ACCOUNT_CHANGED", "登录账号已变化，已阻止跨账号生成。", 409);
    const denied = securityRateLimitResponse(await consumeSecurityRateLimit("creative-narration-minute", securityAccountIdentity(session), 20, 60));
    if (denied) return denied;
    return audioResponse(await generateNarration(user, input));
  } catch (error) { return errorResponse(error); }
}
