import { lookup } from "node:dns/promises";
import { NextResponse } from "next/server";
import { assertResolvedAddresses, evaluateCreativeProxy } from "@/lib/creative-proxy";
import { getCurrentSession } from "@/lib/server-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BYTES = 32 * 1024 * 1024;
const FORWARD_HEADERS = new Set(["authorization", "content-type", "accept", "idempotency-key"]);

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

function pickHeaders(input: Record<string, unknown>) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input || {})) {
    const name = key.toLowerCase();
    if (!FORWARD_HEADERS.has(name) || typeof value !== "string" || value.length > 8000) continue;
    headers[name] = value;
  }
  return headers;
}

async function readPayload(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const headers = pickHeaders(JSON.parse(String(form.get("__sz_headers") || "{}")));
    const upstream = new FormData();
    for (const [key, value] of form.entries()) {
      if (key.startsWith("__sz_")) continue;
      upstream.append(key, value);
    }
    return {
      url: String(form.get("__sz_url") || ""),
      method: String(form.get("__sz_method") || "POST"),
      headers,
      body: upstream
    };
  }
  const body = (await request.json().catch(() => null)) as {
    url?: string;
    method?: string;
    headers?: Record<string, unknown>;
    bodyText?: string;
    bodyBase64?: string;
    contentType?: string;
  } | null;
  if (!body) return null;
  const headers = pickHeaders(body.headers || {});
  if (body.contentType && !headers["content-type"]) headers["content-type"] = body.contentType;
  let payload: BodyInit | undefined;
  if (body.bodyBase64) {
    const bytes = Buffer.from(body.bodyBase64, "base64");
    if (bytes.length > MAX_BYTES) return { error: "请求体超过转发上限。" };
    payload = bytes;
  } else if (body.bodyText) {
    if (body.bodyText.length > MAX_BYTES) return { error: "请求体超过转发上限。" };
    payload = body.bodyText;
  }
  return {
    url: String(body.url || ""),
    method: String(body.method || "GET"),
    headers,
    body: payload
  };
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return jsonError("跨站转发被拒绝。", 403);
  const session = await getCurrentSession();
  if (!session) return jsonError("未登录", 401);

  const payload = await readPayload(request);
  if (!payload) return jsonError("转发请求格式无效。", 400);
  if ("error" in payload) return jsonError(payload.error || "请求体超过转发上限。", 413);

  const decision = evaluateCreativeProxy(payload.url, payload.method);
  if (!decision.ok) return jsonError(decision.error, decision.status);

  const hostname = new URL(payload.url).hostname;
  let addresses: string[] = [];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  } catch {
    return jsonError("上游地址无法解析。", 502);
  }
  const resolved = assertResolvedAddresses(addresses);
  if (!resolved.ok) return jsonError(resolved.error, resolved.status);

  const method = payload.method.toUpperCase();
  const headers = { ...payload.headers };
  if (typeof FormData !== "undefined" && payload.body instanceof FormData) {
    delete headers["content-type"];
  }
  const upstream = await fetch(payload.url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : payload.body,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(120000)
  });
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return jsonError("上游响应超过转发上限。", 502);
  return new NextResponse(bytes, {
    status: upstream.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream"
    }
  });
}
