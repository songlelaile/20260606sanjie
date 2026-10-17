import "server-only";
import { randomUUID } from "node:crypto";
import { publicCreditServiceFailure } from "./public-errors";
import { NextResponse } from "next/server";
import { type GatewayModel } from "@/lib/model-gateway/catalog";
import { getGatewayBillingSnapshot } from "@/lib/model-gateway/billing";
import { applyGatewayBillingCost, GatewayBillingError, type GatewayBillingSnapshot, type GatewayFxSnapshot } from "@/lib/model-gateway/billing-contract";
import { requireGatewayFxSnapshot, gatewayFxMetadata } from "@/lib/model-gateway/exchange-rate";
import { getRelayRuntime, RelayConfigError } from "@/lib/model-gateway/relay-config";
import { getUserSupplyCredential, getUserSupplyRuntime, UserSupplyError } from "@/lib/model-gateway/user-supply";
import { redactSupplySecrets, runSupplyWithFailover, type SupplyCredentials } from "@/lib/model-gateway/supply-failover";
import { formatUsd, parseUpstreamUsdCost, usdToCnyCents } from "@/lib/model-gateway/relay-routing";
import { normalizeRelayBaseUrl, relayFetch, RelayNetworkError } from "@/lib/model-gateway/relay-network";
import { findAvailableGatewayModel, listAvailableGatewayModels } from "@/lib/model-gateway/runtime-catalog";
import { findGatewayVideoJob, reconcileGatewayVideoTerminal } from "@/lib/model-gateway/video-jobs";
import { gatewayOutcomeFingerprint, gatewayRequestFingerprint, prepareGatewayBillingQuote } from "@/lib/model-gateway/billing-request";
import { reserveGatewayBillingHold, markGatewayBillingHoldDispatched, bindGatewayBillingHoldCredential, markGatewayBillingHoldUnknown, releaseGatewayBillingHold, settleGatewayBillingHold, refundGatewayBillingHold } from "@/lib/model-gateway/billing-hold";
import {
  assertGatewayBalance,
  authenticateGatewayKey,
  recordGatewayUsage,
  type GatewayAuth
} from "@/lib/model-gateway/store";

type JsonObject = Record<string, unknown>;
type EnvMap = Record<string, string | undefined>;
type Endpoint = GatewayModel["endpoint"] | "images.edits";
type Upstream = { baseUrl: string; apiKey: string; credentialId?: string; supply?: SupplyCredentials };
type UsageInput = Parameters<typeof recordGatewayUsage>[0];
type Parsed = {
  auth: GatewayAuth; body: JsonObject; form?: FormData; model: GatewayModel; upstream: Upstream;
  billingSnapshot: GatewayBillingSnapshot; billingEventId: string; startedAt: number;
  settlementAttempt?: UsageInput;
  holdReserved?: boolean; dispatched?: boolean; providerAttempted?: boolean;
};

const NO_STORE = { "Cache-Control": "private, no-store" };
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

class GatewayFailure extends Error {
  constructor(message: string, readonly status = 502, readonly code = "upstream_error") { super(message); }
}

function endpointPath(endpoint: Endpoint) {
  return endpoint === "chat.completions" ? "chat/completions"
    : endpoint === "images.generations" ? "images/generations"
      : endpoint === "images.edits" ? "images/edits" : "videos";
}

// Keep the original synchronous env helpers for older callers and tests.
export function buildGatewayUpstreamUrl(model: GatewayModel, env: EnvMap = process.env) {
  return `${normalizeRelayBaseUrl(String(env[model.baseUrlEnv] || model.defaultBaseUrl))}/${endpointPath(model.endpoint)}`;
}

export function resolveGatewayUpstreamApiKey(model: GatewayModel, env: EnvMap = process.env) {
  return String(env[model.apiKeyEnv] || "").trim();
}

export function getMissingUpstreamApiKeyError(model: GatewayModel, env: EnvMap = process.env) {
  if (resolveGatewayUpstreamApiKey(model, env)) return null;
  return `上游 ${model.provider} 还没有配置 API Key`;
}

function jsonError(message: string, status: number, code = "model_gateway_error", headers: Record<string, string> = {}) {
  return NextResponse.json({ error: { message, type: "model_gateway_error", code } }, { status, headers: { ...headers, ...NO_STORE } });
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function upstreamSecrets(upstream: Upstream) {
  return upstream.supply ? [upstream.supply.primary.apiKey, upstream.supply.backup?.apiKey || ""] : [upstream.apiKey];
}

async function resolveUpstream(model: GatewayModel, userId: string): Promise<Upstream & { fxSnapshot?: GatewayFxSnapshot }> {
  if (model.provider === "shaozhuang") {
    const relay = await getRelayRuntime();
    const supply = await getUserSupplyRuntime(userId);
    if (supply.baseUrl !== relay.baseUrl) throw new UserSupplyError("供应配置已变化，请重新核对后重试");
    return {
      baseUrl: relay.baseUrl,
      apiKey: supply.primary.apiKey || supply.backup?.apiKey || "",
      credentialId: supply.primary.apiKey ? supply.primary.id : supply.backup?.id,
      supply: { primary: supply.primary, backup: supply.backup },
      fxSnapshot: requireGatewayFxSnapshot(relay)
    };
  }
  return {
    baseUrl: normalizeRelayBaseUrl(String(process.env[model.baseUrlEnv] || model.defaultBaseUrl)),
    apiKey: resolveGatewayUpstreamApiKey(model)
  };
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function textSizeTokens(body: JsonObject) {
  const raw = JSON.stringify(body.messages || body.input || body.prompt || "");
  return Math.max(1, Math.ceil(raw.length / 4));
}

function tokenCostCents(model: GatewayModel, promptTokens: number, completionTokens: number) {
  return Math.max(1,
    Math.ceil((promptTokens / 1000) * (model.promptCentsPer1K ?? 1)) +
    Math.ceil((completionTokens / 1000) * (model.completionCentsPer1K ?? 2)));
}

function imageCostCents(model: GatewayModel, count: number) {
  return Math.max(1, Math.ceil(count * (model.imageCents ?? 50)));
}

async function readLimitedBody(request: Request, maxBytes: number) {
  if (Number(request.headers.get("content-length") || 0) > maxBytes) {
    throw new GatewayFailure("请求体过大", 413, "request_too_large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new GatewayFailure("请求体过大", 413, "request_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function parseGatewayRequest(request: Request, endpoint: Endpoint): Promise<Parsed | { error: Response }> {
  const auth = await authenticateGatewayKey(request.headers.get("authorization"));
  if (!auth) return { error: jsonError("API Key 无效或已停用", 401, "invalid_api_key") };
  const bytes = await readLimitedBody(request, MAX_REQUEST_BYTES);
  let body: JsonObject;
  let form: FormData | undefined;
  const contentType = request.headers.get("content-type") || "";
  if (contentType.startsWith("multipart/form-data") && (endpoint === "images.edits" || endpoint === "videos")) {
    try {
      form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
      for (const name of ["model", "prompt", "n", "stream", "max_tokens", "max_completion_tokens"]) {
        if (form.getAll(name).length > 1) return { error: jsonError(`${name} 参数不能重复`, 400, "invalid_request") };
      }
      body = Object.fromEntries([...form.entries()].filter((entry) => typeof entry[1] === "string"));
    } catch { return { error: jsonError("multipart 请求体无效", 400, "invalid_request") }; }
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { parsed = null; }
    if (!isObject(parsed)) return { error: jsonError("请求体必须是 JSON 对象", 400, "invalid_request") };
    body = parsed;
  }
  if (body.stream === true || body.stream === "true") {
    return { error: jsonError("暂不支持 stream=true，请使用非流式请求", 400, "stream_not_supported") };
  }
  if (typeof body.model !== "string" || !body.model.trim()) {
    return { error: jsonError("请提供 model 模型名", 400, "invalid_model") };
  }
  const model = await findAvailableGatewayModel(body.model, endpoint === "images.edits" ? "images.generations" : endpoint);
  if (!model) return { error: jsonError(`模型未开通或端点不匹配：${body.model.slice(0, 160)}`, 404, "model_not_found") };
  if (endpoint === "chat.completions" && (!Array.isArray(body.messages) || !body.messages.length)) {
    return { error: jsonError("messages 必须是非空数组", 400, "invalid_request") };
  }
  if (endpoint !== "chat.completions" && (typeof body.prompt !== "string" || !body.prompt.trim())) {
    return { error: jsonError("prompt 必须是非空字符串", 400, "invalid_request") };
  }
  if (endpoint.startsWith("images.") && body.n !== undefined) {
    const n = typeof body.n === "string" && form ? Number(body.n) : body.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) {
      return { error: jsonError("n 必须是 1 到 10 的整数", 400, "invalid_request") };
    }
    body.n = n;
  }
  if (endpoint === "images.edits" && !(form?.has("image") || form?.has("image[]") || body.image || body.images)) {
    return { error: jsonError("图片编辑需要 image 或 images", 400, "invalid_request") };
  }
  if (endpoint === "videos" && (!model.videoCents || !Number.isSafeInteger(model.videoCents) || model.videoCents <= 0)) {
    return { error: jsonError("视频模型尚未配置任务计价", 503, "video_price_missing") };
  }
  const upstream = await resolveUpstream(model, auth.userId);
  if (!upstream.apiKey) return { error: jsonError(`上游 ${model.provider} 还没有配置 API Key`, 503, "upstream_key_missing") };
  const billingSnapshot = { ...await getGatewayBillingSnapshot(auth.userId), ...(upstream.fxSnapshot ? { fxSnapshot: upstream.fxSnapshot } : {}) };
  const baseMinimum = prepareGatewayBillingQuote(model, endpoint, body);
  const minimum = applyGatewayBillingCost(baseMinimum, billingSnapshot);
  const idempotencyKey = request.headers.get("idempotency-key") || undefined;
  const parsed: Parsed = { auth, body, form, model, upstream, billingSnapshot, billingEventId: randomUUID(), startedAt: Date.now() };
  // A replay must reach its original frozen quote even if that hold consumed the available balance.
  if (!idempotencyKey && !await assertGatewayBalance(auth.userId, minimum)) {
    try { await recordGatewayUsage({ auth, endpoint, provider: model.provider, model: model.id,
      costCents: 0, baseCostCents: baseMinimum, billingSnapshot, billingEventId: parsed.billingEventId,
      ...(endpoint === "chat.completions" ? { promptTokens: textSizeTokens(body), completionTokens: 0, totalTokens: textSizeTokens(body) } : {}),
      status: "error", error: "INSUFFICIENT_BALANCE",
      audit: { durationMs: Math.max(0, Date.now() - parsed.startedAt), outcome: "balance_rejected" },
      metadata: { ...billingMetadata(parsed, endpoint), tokenSource: endpoint === "chat.completions" ? "estimated" : "unreported" } });
    } catch (error) {
      const failed = failureResponse(error);
      failed.headers.set("X-Gateway-Billing-Id", parsed.billingEventId);
      return { error: failed };
    }
    return { error: jsonError("余额不足，请先购买模型额度", 402, "insufficient_balance", { "X-Gateway-Billing-Id": parsed.billingEventId }) };
  }
  const reservation = await reserveGatewayBillingHold({ auth, billingSnapshot, eventId: parsed.billingEventId, billingMode: "prepaid_quote",
    quoteCents: minimum, requestFingerprint: await gatewayRequestFingerprint({ endpoint, model: model.id, body, form }),
    endpoint, provider: model.provider, model: model.id, idempotencyKey });
  if (!reservation.shouldDispatch) throw new GatewayFailure("该请求已提交，请核对原调用状态，勿重复生成", 409, "request_already_submitted");
  parsed.billingSnapshot = reservation.hold.billingSnapshot;
  parsed.billingEventId = reservation.hold.eventId;
  parsed.holdReserved = true;
  return parsed;
}

/** Only billing-relevant parameters enter the ledger; prompts, images and credentials do not. */
function billingMetadata(parsed: Parsed, endpoint: Endpoint) {
  const { body, model, upstream } = parsed;
  const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value).slice(0, 160) : "";
  return {
    upstreamModel: model.upstreamModel, baseUrl: upstream.baseUrl,
    ...(upstream.credentialId ? { credentialId: upstream.credentialId } : {}),
    size: text(body.size), quality: text(body.quality), responseFormat: text(body.response_format),
    requestedImageCount: endpoint.startsWith("images.") ? Number(body.n ?? 1) : 0,
    inputImageCount: parsed.form
      ? [...parsed.form.entries()].filter(([key, value]) => ["image", "image[]"].includes(key) && value instanceof Blob).length
      : Array.isArray(body.images) ? body.images.length : Array.isArray(body.image) ? body.image.length : body.image ? 1 : 0,
    ...(endpoint === "videos" ? { billing: "accepted_task", seconds: text(body.seconds ?? body.duration) } : {})
  };
}

function requestSignal(request: Request) {
  const configured = Number(process.env.MODEL_GATEWAY_TIMEOUT_MS || 120_000);
  const timeout = Number.isFinite(configured) ? Math.min(300_000, Math.max(1_000, configured)) : 120_000;
  return AbortSignal.any([request.signal, AbortSignal.timeout(timeout)]);
}

async function parseUpstreamResponse(response: Response, keys: readonly string[]) {
  // Re-use the bounded reader, including chunked responses without Content-Length.
  const bytes = await readLimitedBody(new Request("https://gateway.internal/", {
    method: "POST", body: response.body, duplex: "half"
  } as RequestInit), MAX_RESPONSE_BYTES).catch((error) => {
    if (error instanceof GatewayFailure) throw new GatewayFailure("上游响应过大", 502, "invalid_upstream_response");
    throw error;
  });
  let data: unknown;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch {
    const status = response.status >= 400 && ![401, 403].includes(response.status) ? response.status : 502;
    throw new GatewayFailure(`上游返回非 JSON 响应（HTTP ${response.status}），请检查 Base URL 和兼容端点`, status, "invalid_upstream_response");
  }
  if (!isObject(data)) throw new GatewayFailure("上游返回无效 JSON 对象", 502, "invalid_upstream_response");
  return redactSupplySecrets(data, keys) as JsonObject;
}

async function forward(request: Request, parsed: Parsed, endpoint: Endpoint) {
  const { model, body, form, upstream } = parsed;
  const headers: Record<string, string> = { Authorization: `Bearer ${upstream.apiKey}`, "Idempotency-Key": parsed.billingEventId };
  let payload: BodyInit;
  if (form) { form.set("model", model.upstreamModel); payload = form; }
  else { headers["Content-Type"] = "application/json"; payload = JSON.stringify({ ...body, model: model.upstreamModel }); }
  const dispatch = await markGatewayBillingHoldDispatched({ userId: parsed.auth.userId, eventId: parsed.billingEventId });
  if (!dispatch.shouldDispatch) throw new GatewayFailure("该请求已提交，请核对原调用状态", 409, "request_already_submitted");
  parsed.billingSnapshot = dispatch.hold.billingSnapshot;
  parsed.dispatched = true;
  const signal = requestSignal(request);
  const send = (apiKey: string) => {
    parsed.providerAttempted = true;
    return relayFetch(`${upstream.baseUrl}/${endpointPath(endpoint)}`, {
      method: "POST", headers: { ...headers, Authorization: `Bearer ${apiKey}` }, body: payload, signal, cache: "no-store"
    });
  };
  let response: Response;
  if (upstream.supply) {
    const result = await runSupplyWithFailover(upstream.supply, async credential => {
      upstream.credentialId = credential.id;
      await bindGatewayBillingHoldCredential({ userId: parsed.auth.userId, eventId: parsed.billingEventId, credentialId: credential.id });
      return send(credential.apiKey);
    });
    response = result.response;
  } else response = await send(upstream.apiKey);
  return { status: response.status, data: await parseUpstreamResponse(response, upstreamSecrets(upstream)), retryAfter: response.headers.get("retry-after") };
}

function upstreamSucceeded(status: number, data: JsonObject) {
  return status >= 200 && status < 300 && !data.error;
}

function responseError(data: JsonObject) {
  return isObject(data.error) && typeof data.error.message === "string" ? data.error.message.slice(0, 1000)
    : typeof data.message === "string" ? data.message.slice(0, 1000) : "upstream_error";
}

function responseBillingError(status: number, data: JsonObject) {
  const code = isObject(data.error) ? data.error.code : undefined;
  if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(code) && !/sk-|bearer|api.?key|password/i.test(code)) return code;
  return data.status === "failed" ? "upstream_task_failed" : `upstream_http_${status}`;
}

function normalizeVideoReply(data: JsonObject, request: Request, upstreamBaseUrl: string, fallbackId?: string) {
  const nested = [data, ...(isObject(data.data) ? [data.data] : []), ...(isObject(data.video) ? [data.video] : [])];
  const id = nested.flatMap((item) => [item.request_id, item.id, item.task_id])
    .find((value): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)) ?? fallbackId;
  if (!id) return data;
  const own = new URL(request.url);
  const ownPrefix = own.pathname.startsWith("/v1/") ? "/v1" : "/api/v1";
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") {
      try {
        const target = new URL(value, upstreamBaseUrl);
        const base = new URL(upstreamBaseUrl);
        if (target.origin === base.origin && /\/(?:videos|requests)\/[^/]+\/content$/.test(target.pathname)) {
          const variant = target.searchParams.get("variant");
          return `${own.origin}${ownPrefix}/videos/${id}/content${variant && ["video", "thumbnail", "spritesheet"].includes(variant) ? `?variant=${variant}` : ""}`;
        }
      } catch { /* Non-URL strings pass through. */ }
      return value;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  return { ...rewrite(data) as JsonObject, id };
}

async function recordResponse(parsed: Parsed, endpoint: Endpoint, response: { status: number; data: JsonObject }) {
  const { auth, model, body, upstream } = parsed;
  const { data, status } = response;
  const ok = upstreamSucceeded(status, data) && data.status !== "failed";
  const usage = isObject(data.usage) ? data.usage : {};
  const isTokenCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
  const reportedFields = [
    isTokenCount(usage.prompt_tokens ?? usage.input_tokens) ? "prompt" : "",
    isTokenCount(usage.completion_tokens ?? usage.output_tokens) ? "completion" : "",
    isTokenCount(usage.total_tokens) ? "total" : ""
  ].filter(Boolean);
  const reportedUsage = reportedFields.length > 0;
  const promptTokens = positiveInteger(usage.prompt_tokens ?? usage.input_tokens, endpoint === "chat.completions" ? textSizeTokens(body) : 0);
  const completionTokens = positiveInteger(usage.completion_tokens ?? usage.output_tokens, 0);
  const totalTokens = positiveInteger(usage.total_tokens, promptTokens + completionTokens);
  const imageCount = Array.isArray(data.data) ? data.data.length : Number(body.n ?? 1);
  const catalogCents = !ok ? 0 : endpoint === "chat.completions" ? tokenCostCents(model, promptTokens, completionTokens)
    : endpoint === "videos" ? model.videoCents! : imageCostCents(model, imageCount);
  const usd = parseUpstreamUsdCost(data);
  const frozenRate = parsed.billingSnapshot.fxSnapshot?.rate ?? null;
  const settledCents = usd != null && frozenRate != null ? usdToCnyCents(usd, frozenRate) : null;
  const baseCostCents = settledCents ?? catalogCents;
  const costSource = settledCents == null ? "catalog" : "upstream_usd";
  const input: UsageInput = {
    auth, endpoint, provider: model.provider, model: model.id,
    requestId: typeof data.id === "string" ? data.id : "",
    ...(endpoint === "chat.completions" || reportedUsage ? { promptTokens, completionTokens, totalTokens } : {}),
    ...(endpoint.startsWith("images.") ? { imageCount } : {}),
    baseCostCents, costCents: applyGatewayBillingCost(baseCostCents, parsed.billingSnapshot),
    billingSnapshot: parsed.billingSnapshot, billingEventId: parsed.billingEventId,
    audit: { durationMs: Math.max(0, Date.now() - parsed.startedAt), upstreamStatus: status, outcome: ok ? "success" : "upstream_error" },
    status: ok ? "ok" : "error", error: ok ? "" : responseBillingError(status, data),
    metadata: { ...billingMetadata(parsed, endpoint), ...gatewayFxMetadata(parsed.billingSnapshot.fxSnapshot), reportedTokenFields: reportedFields.join(","),
      tokenSource: reportedFields.length === 3 ? "reported" : reportedUsage ? "partial" : endpoint === "chat.completions" ? "estimated" : "unreported",
      costSource, ...(settledCents == null || usd == null || frozenRate == null ? {} : { usdCost: formatUsd(usd), usdCnyRate: formatUsd(frozenRate) }) }
  };
  parsed.settlementAttempt = input;
  try { await settleGatewayBillingHold({ userId: auth.userId, eventId: parsed.billingEventId, finalCostCents: input.costCents,
    outcomeFingerprint: gatewayOutcomeFingerprint({ status, data }),
    writeUsage: async (tx, frozen) => { await recordGatewayUsage({ ...input, billingSnapshot: frozen.billingSnapshot, billingEventId: frozen.eventId }, tx); } });
  } finally {
    if (!ok) await refundGatewayBillingHold({ userId: auth.userId, eventId: parsed.billingEventId, reason: "confirmed_failed",
      evidenceFingerprint: gatewayOutcomeFingerprint({ status, data }) });
  }
}

function failureResponse(error: unknown) {
  const publicCredit = publicCreditServiceFailure(error);
  if (publicCredit) return jsonError(publicCredit.message, publicCredit.status, publicCredit.code);
  if (error instanceof GatewayBillingError) return jsonError(error.message, error.status, error.code);
  if (error instanceof UserSupplyError) return jsonError(error.message, error.status, error.code);
  if (error instanceof GatewayFailure) return jsonError(error.message, error.status, error.code);
  if (error instanceof RelayConfigError) return jsonError("上游配置不可用，请由管理员检查配置", 503, "upstream_config_invalid");
  if (error instanceof RelayNetworkError) {
    return jsonError(error.message, [499, 504].includes(error.status) ? 504 : 502,
      [499, 504].includes(error.status) ? "upstream_timeout" : "gateway_unavailable");
  }
  // Never serialize arbitrary exception text, which may contain URL/userinfo/headers/API keys.
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return jsonError("上游请求超时或已取消，请稍后查询任务状态；生成请求请勿自动重试", 504, "upstream_timeout");
  }
  return jsonError("网关连接或服务暂不可用，请检查上游配置后重试", 502, "gateway_unavailable");
}

async function handleGeneration(request: Request, endpoint: Endpoint) {
  let parsed: Parsed | undefined;
  let recorded = false;
  try {
    const result = await parseGatewayRequest(request, endpoint);
    if ("error" in result) return result.error;
    parsed = result;
    const response = await forward(request, parsed, endpoint);
    if (endpoint === "videos") response.data = normalizeVideoReply(response.data, request, parsed.upstream.baseUrl);
    if (upstreamSucceeded(response.status, response.data)) {
      const valid = endpoint === "chat.completions" ? Array.isArray(response.data.choices) && response.data.choices.length > 0
        : endpoint === "videos" ? typeof response.data.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(response.data.id)
          : Array.isArray(response.data.data) && response.data.data.length > 0 && response.data.data.length <= Number(parsed.body.n ?? 1);
      if (!valid) throw new GatewayFailure("上游响应缺少兼容协议字段，请检查模型和端点", 502, "invalid_upstream_response");
    }
    await recordResponse(parsed, endpoint, response);
    recorded = true;
    const status = response.status === 401 || response.status === 403 ? 502
      : response.status < 200 || response.status >= 300 ? response.status
        : response.data.error || response.data.status === "failed" ? 502 : response.status;
    const headers: Record<string, string> = { ...NO_STORE, "X-Gateway-Billing-Id": parsed.billingEventId };
    if (response.retryAfter && /^\d{1,6}$/.test(response.retryAfter)) headers["Retry-After"] = response.retryAfter;
    if (response.data.error || response.status >= 400) {
      return jsonError(`上游调用失败：${responseError(response.data)}`, status, "upstream_error", headers);
    }
    // Expose public alias to callers while retaining all compatible payload fields.
    return NextResponse.json({ ...response.data, model: parsed.model.id }, { status, headers });
  } catch (error) {
    if (parsed?.holdReserved && !recorded) {
      if (parsed.dispatched && !parsed.providerAttempted) {
        await refundGatewayBillingHold({userId:parsed.auth.userId,eventId:parsed.billingEventId,reason:"confirmed_failed",
          evidenceFingerprint:gatewayOutcomeFingerprint({reason:"local_before_provider_send"})}).catch(() => undefined);
      } else if (parsed.dispatched) {
        await markGatewayBillingHoldUnknown({ userId: parsed.auth.userId, eventId: parsed.billingEventId,
          reason: parsed.settlementAttempt ? "settlement_failed" : error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "timeout" : "ambiguous_response" }).catch(() => undefined);
      } else {
        await releaseGatewayBillingHold({ userId: parsed.auth.userId, eventId: parsed.billingEventId, reason: "pre_dispatch" }).catch(() => undefined);
      }
    }
    const failure = failureResponse(error);
    if (parsed) failure.headers.set("X-Gateway-Billing-Id", parsed.billingEventId);
    return failure;
  }
}

export async function handleGatewayChatCompletions(request: Request) { return handleGeneration(request, "chat.completions"); }
export async function handleGatewayImageGenerations(request: Request) { return handleGeneration(request, "images.generations"); }
export async function handleGatewayImageEdits(request: Request) { return handleGeneration(request, "images.edits"); }
export async function handleGatewayVideoCreate(request: Request) { return handleGeneration(request, "videos"); }

export async function handleGatewayModels(request: Request) {
  try {
    if (!await authenticateGatewayKey(request.headers.get("authorization"))) return jsonError("API Key 无效或已停用", 401, "invalid_api_key");
    const models = await listAvailableGatewayModels();
    return NextResponse.json({ object: "list", data: models.map((model) => ({
      id: model.id, object: "model", created: 0, owned_by: model.provider,
      kind: model.kind, endpoint: endpointPath(model.endpoint)
    })) }, { headers: NO_STORE });
  } catch (error) { return failureResponse(error); }
}

export async function handleGatewayVideoRead(request: Request, id: string, content = false) {
  try {
    const auth = await authenticateGatewayKey(request.headers.get("authorization"));
    if (!auth) return jsonError("API Key 无效或已停用", 401, "invalid_api_key");
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) return jsonError("视频任务 ID 无效", 400, "invalid_video_id");
    const job = await findGatewayVideoJob(auth.userId, id);
    if (!job) return jsonError("视频任务不存在或不属于当前用户", 404, "video_not_found");
    if (job.provider !== "shaozhuang") return jsonError("视频任务上游不受支持", 503);
    // Tasks created before per-user supply retain their original global route.
    const relay = job.credentialId ? await getUserSupplyCredential(auth.userId, job.credentialId) : await getRelayRuntime();
    if (!relay.apiKey) return jsonError("上游 shaozhuang 还没有配置 API Key", 503, "upstream_key_missing");
    if (relay.baseUrl !== job.baseUrl) return jsonError("任务创建后上游地址已变更，请恢复原地址后查询", 409, "video_upstream_changed");
    const variant = new URL(request.url).searchParams.get("variant");
    if (variant && !["video", "thumbnail", "spritesheet"].includes(variant)) return jsonError("下载 variant 无效", 400, "invalid_variant");
    const url = `${job.baseUrl}/videos/${encodeURIComponent(id)}${content ? "/content" : ""}${content && variant ? `?variant=${variant}` : ""}`;
    const upstreamHeaders: Record<string, string> = { Authorization: `Bearer ${relay.apiKey}` };
    const range = request.headers.get("range");
    if (content && range) {
      if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 100) return jsonError("下载 Range 无效", 400, "invalid_range");
      upstreamHeaders.Range = range;
    }
    const response = await relayFetch(url, { method: "GET", headers: upstreamHeaders, signal: requestSignal(request), cache: "no-store" });
    if (!content || !response.ok || /json/i.test(response.headers.get("content-type") || "")) {
      const data = await parseUpstreamResponse(response, [relay.apiKey]);
      if (!content && response.ok) await reconcileGatewayVideoTerminal(auth.userId, id, job, data);
      if (!response.ok || data.error) return jsonError(`上游调用失败：${responseError(data)}`, [401, 403].includes(response.status) || response.ok ? 502 : response.status, "upstream_error");
      if (content) return jsonError("上游未返回可下载的视频内容", 502, "invalid_upstream_response");
      return NextResponse.json({ ...normalizeVideoReply(data, request, job.baseUrl, id), model: job.model }, { status: response.status, headers: NO_STORE });
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/^(video\/|image\/|application\/octet-stream)/i.test(contentType)) {
      await response.body?.cancel();
      return jsonError("上游返回的下载格式无效", 502, "invalid_upstream_response");
    }
    // Stream bytes with only safe media/range headers, omitting cookies and credentials.
    const headers: Record<string, string> = { ...NO_STORE,
      "Content-Type": contentType.split(";")[0], "X-Content-Type-Options": "nosniff" };
    const contentRange = response.headers.get("content-range");
    if (contentRange && /^bytes \d+-\d+\/(?:\d+|\*)$/.test(contentRange)) headers["Content-Range"] = contentRange;
    if (response.headers.get("accept-ranges") === "bytes") headers["Accept-Ranges"] = "bytes";
    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d{1,15}$/.test(contentLength)) headers["Content-Length"] = contentLength;
    return new Response(response.body, { status: response.status, headers });
  } catch (error) { return failureResponse(error); }
}
