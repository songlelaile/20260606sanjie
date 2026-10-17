import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";
import { CreativeConfigProfileError, creativeConfigAccountKey, creativeConfigOwnerFingerprint, getCreativeConfigProfiles, putCreativeConfigProfile,
  resolveCreativeConfigProfile, unlinkCreativeConfigProfile, type CreativeConfigOwner } from "@/lib/creative-config-profile-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: HEADERS }); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  if (site === "cross-site" || origin && origin !== new URL(request.url).origin || request.method !== "GET" && !origin) {
    throw new CreativeConfigProfileError("CONFIG_ORIGIN_INVALID", "请从当前网站账号的模型配置入口操作。", 403);
  }
}
async function owner(): Promise<CreativeConfigOwner> {
  let user;
  try { user = await getCurrentUser(); }
  catch { throw new CreativeConfigProfileError("ACCOUNT_UNAVAILABLE", "当前账号暂无法核对，请稍后重试，原绑定仍保留。", 503); }
  if (!user) throw new CreativeConfigProfileError("ACCOUNT_UNAVAILABLE", "请先登录当前账号。", 401);
  return { id: user.id, tenantId: user.tenantId, username: user.username };
}
function errorResponse(error: unknown) {
  if (error instanceof CreativeConfigProfileError) return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof RequestBodyTooLargeError) return json({ error: "模型配置请求超过大小限制。", code: "CONFIG_TOO_LARGE" }, 413);
  return json({ error: "账号配置结果暂无法确认，请稍后重新载入核对绑定。", code: "CONFIG_STORE_UNAVAILABLE" }, 503);
}
export async function GET(request: Request) {
  try { sameOrigin(request); return json({ data: await getCreativeConfigProfiles(await owner()) }); }
  catch (error) { return errorResponse(error); }
}
async function mutate(request: Request, method: "POST" | "PUT" | "DELETE") {
  try {
    sameOrigin(request);
    const user = await owner();
    const input = await readJsonWithLimit(request, 48 * 1024);
    if (!object(input)) throw new CreativeConfigProfileError("CONFIG_INVALID", "模型配置请求格式无效。");
    if (input.accountKey !== creativeConfigAccountKey(user)) throw new CreativeConfigProfileError("ACCOUNT_CHANGED", "登录账号已变化，请重新载入；原账号绑定仍保留。", 409);
    if (method === "POST") {
      if (input.operation === "resolveAll") return json({ data: await getCreativeConfigProfiles(user, true) });
      if (input.operation === "resolve") return json({ data: await resolveCreativeConfigProfile(user, input.provider) });
      throw new CreativeConfigProfileError("CONFIG_OPERATION_INVALID", "模型配置操作无效。");
    }
    if (input.ownerFingerprint !== creativeConfigOwnerFingerprint(user)) throw new CreativeConfigProfileError("ACCOUNT_CHANGED", "登录账号已变化，请重新载入后确认绑定。", 409);
    return json({ data: method === "PUT" ? await putCreativeConfigProfile(user, input) : await unlinkCreativeConfigProfile(user, input) });
  } catch (error) { return errorResponse(error); }
}
export function POST(request: Request) { return mutate(request, "POST"); }
export function PUT(request: Request) { return mutate(request, "PUT"); }
export function DELETE(request: Request) { return mutate(request, "DELETE"); }
