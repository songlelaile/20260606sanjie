import "server-only";
import { NextResponse } from "next/server";
import { parseSession, SESSION_COOKIE } from "@/lib/auth";
import { SowerWorkAccessError } from "@/lib/sower-work-entitlements";
import { SOWER_WORK_EXTENSION_ID, SOWER_WORK_ORIGIN, SOWER_WORK_PRODUCT_ID, SOWER_WORK_VERSION } from "@/lib/sower-work-product";

export const SOWER_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
  "X-Sower-Product-Id": SOWER_WORK_PRODUCT_ID,
  "X-Sower-Release-Version": SOWER_WORK_VERSION
};
function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (origin === SOWER_WORK_ORIGIN || origin === "chrome-extension://" + SOWER_WORK_EXTENSION_ID) return origin;
  const url = new URL(request.url);
  if (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname) && origin === url.origin) return origin;
  throw new SowerWorkAccessError(403, "ORIGIN_REJECTED", "请求来源不允许");
}
export function sowerWorkHeaders(request: Request) {
  const origin = allowedOrigin(request);
  return {
    ...SOWER_PRIVATE_HEADERS,
    Vary: "Origin",
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-sanjie-session"
  };
}
export function sowerWorkOptions(request: Request) {
  try { return new NextResponse(null, { status: 204, headers: sowerWorkHeaders(request) }); }
  catch (error) { return sowerWorkError(error); }
}
export function sowerWorkError(error: unknown) {
  const known = error instanceof SowerWorkAccessError;
  return NextResponse.json({
    error: known ? error.message : "授权服务暂时不可用，请稍后重试",
    code: known ? error.code : "AUTHORIZATION_UNAVAILABLE"
  }, { status: known ? error.status : 503, headers: SOWER_PRIVATE_HEADERS });
}
export async function readSowerWorkSession(request: Request) {
  allowedOrigin(request);
  const explicit = request.headers.get("x-sanjie-session");
  let raw: string | undefined = explicit ?? undefined;
  if (!explicit) {
    const item = (request.headers.get("cookie") ?? "").split(";")
      .map(part => part.trim()).find(part => part.startsWith(SESSION_COOKIE + "="));
    raw = item?.slice(SESSION_COOKIE.length + 1);
  }
  // Cookie-authenticated writes require a same-site origin. Header credentials
  // are never supplied by a browser ambiently and are used by the extension.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !explicit &&
      request.headers.get("origin") !== SOWER_WORK_ORIGIN &&
      !(process.env.NODE_ENV !== "production" && allowedOrigin(request) === new URL(request.url).origin)) {
    throw new SowerWorkAccessError(403, "ORIGIN_REQUIRED", "写入请求须来自官网");
  }
  if (!raw || raw.length > 8192) throw new SowerWorkAccessError(401, "LOGIN_REQUIRED", "请先登录官网");
  let session = await parseSession(raw);
  if (!session) {
    try { session = await parseSession(decodeURIComponent(raw)); } catch { /* invalid encoding */ }
  }
  if (!session) throw new SowerWorkAccessError(401, "LOGIN_REQUIRED", "请先登录官网");
  return session;
}
export async function readSowerWorkJson(request: Request, maxBytes = 8192): Promise<unknown> {
  allowedOrigin(request);
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new SowerWorkAccessError(415, "JSON_REQUIRED", "请求须为 JSON");
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new SowerWorkAccessError(413, "BODY_TOO_LARGE", "请求过大");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new SowerWorkAccessError(400, "INVALID_BODY", "缺少请求内容");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new SowerWorkAccessError(413, "BODY_TOO_LARGE", "请求过大");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof SowerWorkAccessError) throw error;
    throw new SowerWorkAccessError(400, "INVALID_BODY", "请求 JSON 无效");
  } finally { reader.releaseLock(); }
}
