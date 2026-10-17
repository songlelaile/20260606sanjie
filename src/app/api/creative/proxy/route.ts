import { lookup } from "node:dns/promises";
import { NextResponse } from "next/server";
import { assertResolvedAddresses, evaluateCreativeProxy } from "@/lib/creative-proxy";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { getRelayRuntime } from "@/lib/model-gateway/relay-config";
import { getUserSupplyCredential, getUserSupplyRuntime } from "@/lib/model-gateway/user-supply";
import { redactSupplySecrets, runSupplyWithFailover } from "@/lib/model-gateway/supply-failover";
import { findGatewayVideoJob } from "@/lib/model-gateway/video-jobs";
import { relayFetch, RelayNetworkError } from "@/lib/model-gateway/relay-network";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";
import {
  hostedSupplyKind, HostedSupplyError, readHostedSupplyRequest, replaceSupplyModel,
  reserveHostedSupply, settleHostedSupply, type HostedSupplyHold
} from "@/lib/model-gateway/hosted-supply";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";
import { rejectsCrossSiteMutation } from "@/lib/request-security";
import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityRateLimitResponse } from "@/lib/security-response";
import { securityAccountIdentity } from "@/lib/security-web-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const FORWARD_HEADERS = new Set(["authorization", "content-type", "accept", "idempotency-key"]);

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function supplyConfigurationError(configReadable: boolean) {
  return NextResponse.json({
    error: configReadable ? "供应订阅未配置，请联系管理员" : "供应订阅暂不可用，请稍后重试",
    code: configReadable ? "CREATIVE_SUPPLY_NOT_CONFIGURED" : "CREATIVE_SUPPLY_UNAVAILABLE",
    providerSubmitted: false,
    definitiveFailure: true
  }, {
    status: 503,
    // Only local pre-submission failures receive this marker. Upstream response
    // headers are never forwarded, so a provider cannot assert this provenance.
    headers: { "Cache-Control": "no-store", "X-Sanjie-Provider-Submission": "not-submitted" }
  });
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
  if (rejectsCrossSiteMutation(request)) return jsonError("跨站转发被拒绝。", 403);
  const session = await getCurrentSession();
  if (!session) return jsonError("未登录", 401);
  try {
    const access = await getCreativeAccessForSession(session);
    if (!access.allowed) return jsonError(access.reason === "invalid_account" ? "会话已失效" : "请先充值开通作图与视频工作台", access.reason === "invalid_account" ? 401 : 402);
  } catch {
    return jsonError("授权查询暂不可用，请重试", 503);
  }

  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_BYTES) return jsonError("请求体超过转发上限。", 413);
  let payload: Awaited<ReturnType<typeof readPayload>>;
  try { payload = await readPayload(request); } catch { return jsonError("转发请求格式无效。", 400); }
  if (!payload) return jsonError("转发请求格式无效。", 400);
  if ("error" in payload) return jsonError(payload.error || "请求体超过转发上限。", 413);

  const decision = evaluateCreativeProxy(payload.url, payload.method);
  if (!decision.ok) return jsonError(decision.error, decision.status);

  // Count actual upstream mutations, independent of how a human or an agent
  // drives the browser. Read-only task polling does not consume this allowance.
  if (!["GET", "HEAD"].includes(payload.method.toUpperCase())) {
    for (const [namespace, limit, window] of [["creative-execute-minute", 100, 60], ["creative-execute-hour", 500, 3600]] as const) {
      const denied = securityRateLimitResponse(await consumeSecurityRateLimit(namespace, securityAccountIdentity(session), limit, window));
      if (denied) return denied;
    }
  }

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
  let supplyHold: HostedSupplyHold | null = null;
  let supplyRuntime: Awaited<ReturnType<typeof getUserSupplyRuntime>> | null = null;
  let upstreamUrl = payload.url;
  let supplySecrets: string[] = [];
  if (hostname === "sub.shaozhuangai.com") {
    const user = await getCurrentUser();
    if (!user) return jsonError("会话已失效", 401);
    // The hosted credential is never attached to an arbitrary client-selected path.
    const path = new URL(payload.url).pathname;
    const allowedGeneration = /^\/v1\/(?:chat\/completions|images\/(?:generations|edits)|videos)\/?$/.test(path);
    const videoRead = /^\/v1\/(?:videos|requests)\/([A-Za-z0-9_-]{1,200})(\/content)?\/?$/.exec(path);
    const modelRead = /^\/v1\/models\/?$/.test(path);
    if ((method === "POST" && !allowedGeneration) ||
      (["GET", "HEAD"].includes(method) && !videoRead && !modelRead) ||
      !["POST", "GET", "HEAD"].includes(method)) return jsonError("供应请求路径或方法不受支持。", 400);
    const kind = hostedSupplyKind(payload.url, method);
    const form = typeof FormData !== "undefined" && payload.body instanceof FormData ? payload.body : undefined;
    const bodyText = typeof payload.body === "string" ? payload.body : payload.body instanceof Uint8Array ? new TextDecoder().decode(payload.body) : undefined;
    const supplyRequest = kind ? readHostedSupplyRequest({ bodyText: form ? undefined : bodyText, form }) : { modelName: "", body: {} };
    if (method === "POST" && (!kind || !supplyRequest.modelName)) return jsonError("请提供有效的供应模型。", 400);
    if (videoRead) {
      let job: Awaited<ReturnType<typeof findGatewayVideoJob>>;
      try { job = await findGatewayVideoJob(user.id, videoRead[1]); }
      catch { return jsonError("视频任务查询暂不可用", 503); }
      if (!job || job.provider !== "shaozhuang") return jsonError("视频任务不存在或不属于当前用户", 404);
      let credential: { baseUrl: string; apiKey: string };
      try {
        // Legacy video rows keep their original global route; never assign them a new user's Key.
        credential = job.credentialId ? await getUserSupplyCredential(user.id, job.credentialId) : await getRelayRuntime();
      } catch { return supplyConfigurationError(false); }
      if (!credential.apiKey) return supplyConfigurationError(true);
      if (credential.baseUrl !== job.baseUrl) return jsonError("任务创建后上游地址已变更，请恢复原地址后查询", 409);
      const requested = new URL(payload.url);
      const variant = requested.searchParams.get("variant");
      if ([...requested.searchParams.keys()].some((key) => key !== "variant") ||
        (variant && !["video", "thumbnail", "spritesheet"].includes(variant))) return jsonError("视频下载参数无效", 400);
      upstreamUrl = `${job.baseUrl}/videos/${videoRead[1]}${videoRead[2] || ""}${variant ? `?variant=${variant}` : ""}`;
      headers.authorization = `Bearer ${credential.apiKey}`;
      supplySecrets = [credential.apiKey];
    } else {
      try { supplyRuntime = await getUserSupplyRuntime(user.id); }
      catch { return supplyConfigurationError(false); }
      if (!supplyRuntime.primary.apiKey && !supplyRuntime.backup?.apiKey) return supplyConfigurationError(true);
      supplySecrets = [supplyRuntime.primary.apiKey, supplyRuntime.backup?.apiKey || ""];
      upstreamUrl = `${supplyRuntime.baseUrl}/${path.replace(/^\/v1\//, "").replace(/\/$/, "")}`;
      headers.authorization = `Bearer ${supplyRuntime.primary.apiKey || supplyRuntime.backup!.apiKey}`;
    }
    if (kind && supplyRuntime) {
      try {
        supplyHold = await reserveHostedSupply({
          user: { id: user.id, username: user.username },
          kind, modelName: supplyRequest.modelName, body: supplyRequest.body, usdCnyRate: supplyRuntime.usdCnyRate
        });
        supplyHold.baseUrl = supplyRuntime.baseUrl;
        supplyHold.credentialId = supplyRuntime.primary.apiKey ? supplyRuntime.primary.id : supplyRuntime.backup?.id;
        payload.body = replaceSupplyModel(payload.body, supplyHold.model.upstreamModel);
      } catch (error) {
        if (error instanceof HostedSupplyError || error instanceof GatewayBillingError) return jsonError(error.message, error.status);
        return jsonError("积分结算暂不可用，请稍后重试", 503);
      }
    }
  }
  if (typeof FormData !== "undefined" && payload.body instanceof FormData) {
    delete headers["content-type"];
  }
  try {
  const signal = AbortSignal.timeout(120000);
  const transport = hostname === "sub.shaozhuangai.com" ? relayFetch : fetch;
  const send = (authorization: string) => transport(upstreamUrl, {
    method,
    headers: { ...headers, ...(authorization ? { authorization } : {}) },
    body: method === "GET" || method === "HEAD" ? undefined : payload.body,
    cache: "no-store",
    redirect: "error",
    signal
  });
  let upstream: Response;
  if (supplyRuntime) {
    const result = await runSupplyWithFailover(supplyRuntime, (credential) => {
      if (supplyHold) supplyHold.credentialId = credential.id;
      return send(`Bearer ${credential.apiKey}`);
    });
    upstream = result.response;
    if (supplyHold) supplyHold.credentialId = result.credentialId;
  } else upstream = await send(headers.authorization || "");
  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  if (supplyHold && (contentType.startsWith("video/") || contentType.startsWith("application/octet-stream"))) {
    await upstream.body?.cancel();
    return jsonError("这次供应调用无法按流式结果扣积分", 502);
  }
  if (upstream.ok && (method === "GET" || method === "HEAD") && (contentType.startsWith("video/") || contentType.startsWith("image/") || contentType.startsWith("application/octet-stream"))) {
    if (Number(upstream.headers.get("content-length") || 0) > MAX_MEDIA_BYTES) {
      await upstream.body?.cancel();
      return jsonError("视频文件超过 256 MiB 下载上限。", 502);
    }
    let total = 0;
    const bounded = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > MAX_MEDIA_BYTES) { controller.error(new Error("媒体响应超过下载上限")); return; }
        controller.enqueue(chunk);
      }
    });
    return new NextResponse(method === "HEAD" ? null : upstream.body?.pipeThrough(bounded) ?? null, {
      status: upstream.status,
      headers: { "Cache-Control": "no-store", "Content-Type": redactSupplySecrets(contentType, supplySecrets) as string, "X-Content-Type-Options": "nosniff" }
    });
  }
  let bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return jsonError("上游响应超过转发上限。", 502);
  if (supplySecrets.length) {
    const text = new TextDecoder().decode(bytes);
    let safeText: string;
    try { safeText = JSON.stringify(redactSupplySecrets(JSON.parse(text), supplySecrets)); }
    catch { safeText = redactSupplySecrets(text, supplySecrets) as string; }
    bytes = new TextEncoder().encode(safeText);
  }
  if (supplyHold) {
    try {
      const settled = await settleHostedSupply(supplyHold, { status: upstream.status, bytes, contentType });
      if (settled.reject) return jsonError("上游响应无法结算，本次未扣积分", 502);
    } catch (error) {
      if (error instanceof HostedSupplyError || error instanceof GatewayBillingError) return jsonError(error.message, error.status);
      return jsonError("本次供应调用未能完成扣积分，请稍后在积分流水核对", 503);
    }
  }
  return new NextResponse(bytes, {
    status: upstream.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": redactSupplySecrets(contentType, supplySecrets) as string
    }
  });
  } catch (error) {
    if (supplyHold) {
      await settleHostedSupply(supplyHold, { status: 502, bytes: new Uint8Array(), contentType: "application/json" }).catch(() => undefined);
    }
    const timedOut = error instanceof RelayNetworkError && [499, 504].includes(error.status) ||
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return jsonError(timedOut ? "上游请求超时，请检查任务状态后重试。" : "上游连接失败，请检查 API 配置。", timedOut ? 504 : 502);
  }
}
