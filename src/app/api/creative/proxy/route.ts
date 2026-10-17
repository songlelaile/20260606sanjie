import { lookup } from "node:dns/promises";
import { NextResponse } from "next/server";
import { assertResolvedAddresses, evaluateCreativeProxy } from "@/lib/creative-proxy";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";
import { getRelayRuntime } from "@/lib/model-gateway/relay-config";
import { getUserSupplyCredential, getUserSupplyRuntime, UserSupplyError } from "@/lib/model-gateway/user-supply";
import { Sub2ApiProvisionError } from "@/lib/model-gateway/sub2api-provisioner";
import { redactSupplySecrets, runSupplyWithFailover } from "@/lib/model-gateway/supply-failover";
import { requireGatewayFxSnapshot } from "@/lib/model-gateway/exchange-rate";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";
import { publicCreditServiceFailure } from "@/lib/model-gateway/public-errors";
import { getGatewayAvailableBalance, refundGatewayBillingHold, bindGatewayBillingHoldSharedSource, getGatewaySharedVideoSupplyBinding } from "@/lib/model-gateway/billing-hold";
import { getSharedWalletPlatformSupply, getGatewaySharedPlatformRuntime } from "@/lib/model-gateway/shared-wallet-source";
import { gatewayOutcomeFingerprint } from "@/lib/model-gateway/billing-request";
import { prisma } from "@/lib/db";
import {
  hostedSupplyKind, HostedSupplyError, readHostedSupplyRequest, replaceSupplyModel,
  hostedVideoTaskId, reserveHostedSupply, markHostedSupplyDispatched, bindHostedSupplyCredential, markHostedSupplyUnknown,
  settleHostedSupply, type HostedSupplyHold
} from "@/lib/model-gateway/hosted-supply";
import { findGatewayVideoJob, reconcileGatewayVideoTerminal } from "@/lib/model-gateway/video-jobs";
import { relayFetch } from "@/lib/model-gateway/relay-network";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";
import { rejectsCrossSiteMutation } from "@/lib/request-security";
import { consumeSecurityRateLimit } from "@/lib/security-rate-limit";
import { securityRateLimitResponse } from "@/lib/security-response";
import { securityAccountIdentity } from "@/lib/security-web-account";
import { creativeImageReceiptStore, creativeImageRequestSha256, creativeByokImageRequestSha256, creativeByokImageDefinitiveRejection, CreativeImageReceiptError, type PreparedImageReceipt } from "@/lib/creative-image-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const FORWARD_HEADERS = new Set(["authorization", "content-type", "accept", "idempotency-key"]);

function jsonError(message: string, status: number, billingEventId?: string) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store", ...(billingEventId ? { "X-Gateway-Billing-Id": billingEventId } : {}) } });
}

function creditServiceError(error: unknown, billingEventId?: string, submission: "not-submitted" | "unknown" = "unknown", unconfirmedSettlement = false) {
  const failure = publicCreditServiceFailure(error);
  if (!failure && !unconfirmedSettlement) return null;
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (billingEventId) headers.set("X-Gateway-Billing-Id", billingEventId);
  if (submission === "not-submitted") headers.set("X-Sanjie-Provider-Submission", "not-submitted");
  return NextResponse.json({
    error: submission === "not-submitted" ? failure!.message : "服务暂时繁忙，请稍后查看原任务状态，避免重复提交。",
    code: "CREDIT_SERVICE_UNAVAILABLE",
    ...(submission === "not-submitted" ? { providerSubmitted: false, definitiveFailure: true } : { stateUncertain: true })
  }, { status: 503, headers });
}

// This proof is emitted only by local branches before a billing reservation
// or provider dispatch. Never apply it to provider responses or replay conflicts.
function requestNotSubmittedError(message: string, status: number, extraHeaders?: Headers) {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Sanjie-Provider-Submission", "not-submitted");
  return NextResponse.json({ error: message, code: "CREATIVE_REQUEST_NOT_SUBMITTED", providerSubmitted: false, definitiveFailure: true }, { status, headers });
}

function purchaseRequiredError() {
  return NextResponse.json({ error: "可用积分不足，请购买套餐后继续创作", code: "INSUFFICIENT_BALANCE",
    purchaseUrl: "/models", providerSubmitted: false, definitiveFailure: true }, {
    status: 402, headers: { "Cache-Control": "no-store", "X-Sanjie-Provider-Submission": "not-submitted" }
  });
}

function supplyConfigurationError(configReadable: boolean, detail?: { reasonCode: string; message?: string }) {
  return NextResponse.json({
    error: detail?.message || (configReadable ? "供应订阅未配置，请联系管理员" : "供应订阅暂不可用，请稍后重试"),
    code: configReadable ? "CREATIVE_SUPPLY_NOT_CONFIGURED" : "CREATIVE_SUPPLY_UNAVAILABLE",
    ...(detail ? { reasonCode: detail.reasonCode } : {}),
    providerSubmitted: false,
    definitiveFailure: true
  }, {
    status: 503,
    // Only local pre-submission failures receive this marker. Upstream response
    // headers are never forwarded, so a provider cannot assert this provenance.
    headers: { "Cache-Control": "no-store", "X-Sanjie-Provider-Submission": "not-submitted" }
  });
}

const UNCONFIGURED_SUPPLY_REASONS = new Set([
  "USER_SUPPLY_PROVISION_NOT_CONFIGURED", "USER_SUPPLY_NOT_CONFIGURED",
  "supply_provisioning_unconfigured", "supply_provisioning_encryption_unconfigured"
]);
const PUBLIC_SUPPLY_MESSAGES = new Map<string, string>([
  ["USER_SUPPLY_PROVISION_PENDING", "当前账号的供应凭据正在配发，请稍后重试"],
  ["USER_SUPPLY_DECRYPT_FAILED", "当前账号的供应凭据无法读取，请联系管理员检查凭据配置"],
  ["USER_SUPPLY_STORE_UNAVAILABLE", "当前账号的供应配置暂不可用，请联系管理员检查配置存储"],
  ["USER_SUPPLY_USER_INVALID", "当前账号标识无效，请重新登录后重试"],
  ["USER_SUPPLY_USER_DISABLED", "当前账号暂不可用，请重新登录或联系管理员"],
  ["USER_SUPPLY_PROVIDER_UNCONFIRMED", "当前账号的供应凭据尚未确认，请稍后重试或联系管理员"],
  ["USER_SUPPLY_LEASE_LOST", "当前账号的供应凭据配发尚未完成，请稍后重试"],
  ["USER_SUPPLY_PROVISION_FAILED", "当前账号的供应凭据配发未完成，请稍后重试或联系管理员"],
  ["USER_SUPPLY_UNAVAILABLE", "当前账号的供应凭据暂不可用，请稍后重试或联系管理员"],
  ...["supply_provisioning_invalid_config", "supply_provisioning_invalid_config_path",
    "supply_provisioning_config_unreadable", "supply_provisioning_config_permissions",
    "supply_provisioning_config_corrupt", "supply_provisioning_config_unwritable",
    "supply_provisioning_config_busy", "supply_provisioning_auth_rejected",
    "supply_provisioning_2fa_required", "supply_provisioning_inactive_owner",
    "supply_provisioning_invalid_session", "supply_provisioning_group_forbidden"
  ].map((code): [string, string] => [code, "供应凭据配发配置需要检查，请联系管理员"]),
  ...["supply_provisioning_rate_limited", "supply_provisioning_key_count_exceeded"
  ].map((code): [string, string] => [code, "供应凭据配发暂受限制，请稍后重试或联系管理员"]),
  ...["supply_provisioning_failed", "supply_provisioning_invalid_input", "supply_provisioning_timeout",
    "supply_provisioning_network_failed", "supply_provisioning_upstream_failed", "supply_provisioning_invalid_response",
    "supply_provisioning_response_too_large", "supply_provisioning_key_mismatch", "supply_provisioning_key_conflict",
    "supply_provisioning_list_limit", "supply_provisioning_unconfirmed"
  ].map((code): [string, string] => [code, "供应凭据配发尚未完成，请稍后重试或联系管理员"])
]);

function userSupplyConfigurationError(error: unknown) {
  // Preserve only known local reason codes. Exception messages/statuses may
  // contain private issuer/configuration details and never reach the browser.
  if (!(error instanceof UserSupplyError || error instanceof Sub2ApiProvisionError)) return supplyConfigurationError(false);
  if (UNCONFIGURED_SUPPLY_REASONS.has(error.code)) return supplyConfigurationError(true, { reasonCode: error.code });
  const message = PUBLIC_SUPPLY_MESSAGES.get(error.code);
  if (!message) return supplyConfigurationError(false);
  return supplyConfigurationError(false, { reasonCode: error.code, message });
}

function expectedAccount(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new HostedSupplyError("请求账号标识无效。", 400);
  }
  return value;
}

function accountChangedError() {
  return NextResponse.json({
    error: "登录账号已变化，本次未提交生成。请回到当前账号重新核对素材和方案。",
    code: "CREATIVE_ACCOUNT_CHANGED",
    providerSubmitted: false,
    definitiveFailure: true
  }, {
    status: 409,
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

async function boundedBytes(stream: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new HostedSupplyError("请求或响应超过转发上限。", 413);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function publicHostedBytes(bytes: Uint8Array, keys: readonly string[], supplyHold: HostedSupplyHold | null) {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HostedSupplyError("上游响应格式无效。", 502);
  const data = redactSupplySecrets(parsed, keys) as Record<string, unknown>;
  const taskId = supplyHold?.kind === "videos" ? hostedVideoTaskId(data) : "";
  return new TextEncoder().encode(JSON.stringify({ ...data, ...(taskId ? { id: taskId } : {}), ...(supplyHold ? { model: supplyHold.model.id } : {}) }));
}

async function readPayload(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  const bytes = await boundedBytes(request.body, MAX_BYTES);
  if (contentType.includes("multipart/form-data")) {
    const form = await new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
    const accounts = form.getAll("__sz_expected_account");
    if (accounts.length > 1) throw new HostedSupplyError("请求账号标识不能重复。", 400);
    const account = expectedAccount(accounts.length ? accounts[0] : undefined);
    const receipts = form.getAll("__sz_image_receipt");
    if (receipts.length > 1) throw new HostedSupplyError("图片回执身份不能重复。", 400);
    const receiptIdentity: unknown = receipts.length ? JSON.parse(String(receipts[0])) : undefined;
    const headers = pickHeaders(JSON.parse(String(form.get("__sz_headers") || "{}")));
    const upstream = new FormData();
    for (const [key, value] of form.entries()) {
      if (key.startsWith("__sz_")) continue;
      upstream.append(key, value);
    }
    return {
      url: String(form.get("__sz_url") || ""),
      method: String(form.get("__sz_method") || "POST"),
      expectedAccount: account,
      receiptIdentity,
      expectedQuoteCents: form.has("__sz_quote_cents") ? Number(form.get("__sz_quote_cents")) : undefined,
      headers,
      body: upstream
    };
  }
  const body = JSON.parse(new TextDecoder().decode(bytes)) as {
    url?: string;
    method?: string;
    headers?: Record<string, unknown>;
    bodyText?: string;
    bodyBase64?: string;
    contentType?: string;
    expectedAccount?: unknown;
    expectedQuoteCents?: number;
    receiptIdentity?: unknown;
  } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const headers = pickHeaders(body.headers || {});
  if (body.contentType && !headers["content-type"]) headers["content-type"] = body.contentType;
  let payload: BodyInit | undefined;
  if (body.bodyBase64) {
    const bytes = Buffer.from(body.bodyBase64, "base64");
    if (bytes.length > MAX_BYTES) return { error: "请求体超过转发上限。" };
    payload = bytes;
  } else if (body.bodyText) {
    if (Buffer.byteLength(body.bodyText) > MAX_BYTES) return { error: "请求体超过转发上限。" };
    payload = body.bodyText;
  }
  return {
    url: String(body.url || ""),
    method: String(body.method || "GET"),
    expectedAccount: expectedAccount(body.expectedAccount),
    expectedQuoteCents: body.expectedQuoteCents,
    receiptIdentity: body.receiptIdentity,
    headers,
    body: payload
  };
}

export async function POST(request: Request) {
  if (rejectsCrossSiteMutation(request)) return requestNotSubmittedError("跨站转发被拒绝。", 403);
  const session = await getCurrentSession();
  if (!session) return requestNotSubmittedError("未登录", 401);
  try {
    const access = await getCreativeAccessForSession(session);
    if (!access.allowed) return requestNotSubmittedError(access.reason === "invalid_account" ? "会话已失效" : "请先充值开通作图与视频工作台", access.reason === "invalid_account" ? 401 : 402);
  } catch {
    return requestNotSubmittedError("授权查询暂不可用，请重试", 503);
  }

  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BYTES) return requestNotSubmittedError("请求体超过转发上限。", 413);
  let payload: Awaited<ReturnType<typeof readPayload>>;
  try { payload = await readPayload(request); } catch (error) { return requestNotSubmittedError(error instanceof HostedSupplyError ? error.message : "转发请求格式无效。", error instanceof HostedSupplyError ? error.status : 400); }
  if (!payload) return requestNotSubmittedError("转发请求格式无效。", 400);
  if ("error" in payload) return requestNotSubmittedError(payload.error || "请求体超过转发上限。", 413);

  // This is a request-context guard, not an authorization credential. Old
  // clients may omit it; new clients bind prepared assets to their original
  // session so a cookie change cannot debit a different account. It is never
  // forwarded to the supplier and is checked before any reservation or fetch.
  if (payload.expectedAccount !== undefined && payload.expectedAccount !== `${session.tenantId}:${session.username}`) {
    return accountChangedError();
  }

  const decision = evaluateCreativeProxy(payload.url, payload.method);
  if (!decision.ok) return requestNotSubmittedError(decision.error, decision.status);

  // Count actual upstream mutations, independent of how a human or an agent
  // drives the browser. Read-only task polling does not consume this allowance.
  if (!["GET", "HEAD"].includes(payload.method.toUpperCase())) {
    for (const [namespace, limit, window] of [["creative-execute-minute", 100, 60], ["creative-execute-hour", 500, 3600]] as const) {
      const denied = securityRateLimitResponse(await consumeSecurityRateLimit(namespace, securityAccountIdentity(session), limit, window));
      if (denied) return requestNotSubmittedError("请求过于频繁，请稍后重试。", denied.status, denied.headers);
    }
  }

  const target = new URL(payload.url);
  const hostname = target.hostname;
  let addresses: string[] = [];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  } catch {
    return requestNotSubmittedError("上游地址无法解析。", 502);
  }
  const resolved = assertResolvedAddresses(addresses);
  if (!resolved.ok) return requestNotSubmittedError(resolved.error, resolved.status);

  const method = payload.method.toUpperCase();
  const headers = { ...payload.headers };
  // A user-supplied key selects BYOK even when its provider shares the platform
  // hostname. An invalid key must never silently switch to paid platform supply.
  const personalAuthorization = headers.authorization?.trim() || "";
  if (personalAuthorization && !/^Bearer\s+\S+$/i.test(personalAuthorization)) {
    return requestNotSubmittedError("个人 API 密钥格式无效，请核对配置", 400);
  }
  const personalApi = !!personalAuthorization;
  let supplyHold: HostedSupplyHold | null = null;
  let hostedKey = "";
  let hostedKeys: string[] = [];
  let userSupply: Awaited<ReturnType<typeof getUserSupplyRuntime>> | null = null;
  let sharedSupply: Awaited<ReturnType<typeof getSharedWalletPlatformSupply>> | null = null;
  let settled = false;
  let providerAttempted = false;
  let imageReceipt: PreparedImageReceipt | undefined;
  // Opt-in BYOK receipts use a nonfinancial dispatch binding. Never reserve,
  // settle, refund or silently fall back to platform supply in this branch.
  let byokReceipt: PreparedImageReceipt | undefined;
  let byokOwnerId = "";
  if (personalApi && payload.receiptIdentity !== undefined) {
    const kind = hostedSupplyKind(payload.url, method);
    if (!["images.generations", "images.edits"].includes(kind || "") || target.search || target.hash || payload.expectedAccount !== `${session.tenantId}:${session.username}`) {
      return requestNotSubmittedError("自有 API 图片回执参数或账号不完整，本次未提交。", 400);
    }
    let owner: Awaited<ReturnType<typeof getCurrentUser>>;
    try { owner = await getCurrentUser(); } catch { return requestNotSubmittedError("当前账号暂无法核对，本次未提交。", 503); }
    if (!owner || owner.tenantId !== session.tenantId || owner.username !== session.username) return accountChangedError();
    try {
      const registration = await creativeImageReceiptStore.registerByok(owner, payload.receiptIdentity, headers["idempotency-key"],
        await creativeByokImageRequestSha256(payload.url, payload.body, personalAuthorization));
      if (!registration.created) return NextResponse.json(registration.descriptor, {status:registration.descriptor?.state === "complete" ? 200 : 202,headers:{"Cache-Control":"no-store"}});
      byokReceipt = registration.handle; byokOwnerId = owner.id;
    } catch (error) {
      return NextResponse.json({error:"原图片回执仍需核对，请保留原任务，避免重复提交。",code:error instanceof CreativeImageReceiptError ? error.code : "IMAGE_RECEIPT_UNAVAILABLE",stateUncertain:true},
        {status:error instanceof CreativeImageReceiptError ? error.status : 503,headers:{"Cache-Control":"no-store"}});
    }
  }
  let hostedContent = false;
  let hostedVideoJob: Awaited<ReturnType<typeof findGatewayVideoJob>> = null;
  let hostedVideoTask = "";
  let hostedUserId = "";
  if (hostname === "sub.shaozhuangai.com" && !personalApi) {
    const kind = hostedSupplyKind(payload.url, method);
    let user: Awaited<ReturnType<typeof getCurrentUser>>;
    let relay: Awaited<ReturnType<typeof getRelayRuntime>> | null = null;
    try { user = await getCurrentUser(); relay = user ? await getRelayRuntime() : null; }
    catch { return kind ? supplyConfigurationError(false) : jsonError("供应订阅暂不可用，请稍后重试", 503); }
    if (!user) return requestNotSubmittedError("会话已失效", 401);
    if (!relay) return kind ? supplyConfigurationError(false) : jsonError("供应订阅暂不可用，请稍后重试", 503);
    // A browser-selected path cannot borrow the platform credential. Hosted
    // requests use only the supported protocol under the configured origin.
    const relayBase = relay.baseUrl.replace(/\/+$/, "");
    if (relayBase !== "https://sub.shaozhuangai.com/v1" || target.hash) return requestNotSubmittedError("托管供应地址与当前配置不一致", 503);
    if (payload.receiptIdentity !== undefined && kind !== "images.generations" && kind !== "images.edits") return requestNotSubmittedError("图片回执仅用于图片生成请求。", 400);
    if (kind) {
      try {
        if ((await getGatewayAvailableBalance(prisma, user.id)).availableCents <= 0) return purchaseRequiredError();
      } catch { return requestNotSubmittedError("积分余额暂不可用，请稍后重试", 503); }
      try { userSupply = await getUserSupplyRuntime(user.id); }
      catch (error) {
        const unconfigured = (error instanceof UserSupplyError || error instanceof Sub2ApiProvisionError) &&
          (UNCONFIGURED_SUPPLY_REASONS.has(error.code) || error.code === "USER_SUPPLY_PROVISION_PENDING");
        if (!unconfigured) return userSupplyConfigurationError(error);
        try { sharedSupply = await getSharedWalletPlatformSupply(user.id); }
        catch { return userSupplyConfigurationError(error); }
      }
      if (userSupply) {
        if (!userSupply.primary.apiKey && !userSupply.backup?.apiKey) return supplyConfigurationError(true);
        if (userSupply.baseUrl.replace(/\/+$/, "") !== relayBase) return requestNotSubmittedError("供应配置已变化，请重新核对后重试", 503);
        hostedKey = userSupply.primary.apiKey || userSupply.backup!.apiKey;
        hostedKeys = [userSupply.primary.apiKey, userSupply.backup?.apiKey || ""];
      } else if (sharedSupply && sharedSupply.baseUrl === relayBase) {
        hostedKey = sharedSupply.apiKey;
        hostedKeys = [hostedKey];
      } else return supplyConfigurationError(true);
      const form = typeof FormData !== "undefined" && payload.body instanceof FormData ? payload.body : undefined;
      const bodyText = typeof payload.body === "string" ? payload.body : payload.body instanceof Uint8Array ? new TextDecoder().decode(payload.body) : undefined;
      let supplyRequest: ReturnType<typeof readHostedSupplyRequest>;
      try { supplyRequest = readHostedSupplyRequest({ bodyText: form ? undefined : bodyText, form }); }
      catch (error) { return requestNotSubmittedError(error instanceof HostedSupplyError ? error.message : "供应请求格式无效", 400); }
      if (!supplyRequest.modelName) return requestNotSubmittedError("请提供有效的 model 模型名", 400);
      if (kind === "images.edits" && !(form?.has("image") || form?.has("image[]") || supplyRequest.body.image || supplyRequest.body.images)) return requestNotSubmittedError("图片编辑需要 image 或 images", 400);
      if (payload.receiptIdentity !== undefined) {
        try {
          const registration = await creativeImageReceiptStore.register(
            { id: user.id, tenantId: user.tenantId, username: user.username }, payload.receiptIdentity, headers["idempotency-key"],
            await creativeImageRequestSha256(kind, payload.body));
          if (!registration.created) return NextResponse.json(registration.descriptor, { status: registration.descriptor?.state === "complete" ? 200 : 202, headers: { "Cache-Control": "no-store" } });
          imageReceipt = registration.handle;
        } catch (error) {
          // A collision/expired registration may belong to an already charged
          // original. Never turn receipt uncertainty into a retryable failure.
          return NextResponse.json({ error: "图片回执暂需核对，请保留原任务，避免重复提交。", code: error instanceof CreativeImageReceiptError ? error.code : "IMAGE_RECEIPT_UNAVAILABLE", stateUncertain: true },
            { status: error instanceof CreativeImageReceiptError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
        }
      }
      try {
        supplyHold = await reserveHostedSupply({
          user: { id: user.id, username: user.username },
          kind, modelName: supplyRequest.modelName, body: supplyRequest.body, usdCnyRate: relay.usdCnyRate, fxSnapshot: requireGatewayFxSnapshot(relay),
          baseUrl: relayBase, form, idempotencyKey: headers["idempotency-key"], expectedQuoteCents: payload.expectedQuoteCents
        });
        if (sharedSupply) await bindGatewayBillingHoldSharedSource({ userId: user.id,
          eventId: supplyHold.billingEventId, credentialFingerprint: sharedSupply.credentialFingerprint });
        // The quote may add a default output-token budget. Send exactly the
        // validated billed request instead of the original unbounded payload.
        if (!form) {
          payload.body = JSON.stringify(supplyHold.body);
          headers["content-type"] = "application/json";
        }
        payload.body = replaceSupplyModel(payload.body, supplyHold.model.upstreamModel);
        // The persisted event stays stable across a permitted credential failover.
        headers["idempotency-key"] = supplyHold.billingEventId;
      } catch (error) {
        if (imageReceipt) await creativeImageReceiptStore.markNotSubmitted(imageReceipt, "IMAGE_RECEIPT_PRE_DISPATCH_FAILED").catch(() => undefined);
        if (supplyHold) {
          try { await markHostedSupplyUnknown(supplyHold, "disconnect"); }
          catch { return jsonError("积分扣款状态暂不可用，当前请求未发送", 503, supplyHold.billingEventId); }
        }
        const creditFailure = creditServiceError(error, supplyHold?.billingEventId,
          supplyHold && !supplyHold.dispatched ? "not-submitted" : "unknown");
        if (creditFailure) return creditFailure;
        // A replay may describe a previously dispatched task. Database failures
        // may also leave a reservation whose result needs reconciliation.
        if (!supplyHold && ((error instanceof HostedSupplyError && [400, 401, 402, 404, 503].includes(error.status)) ||
            (error instanceof GatewayBillingError && ["INSUFFICIENT_BALANCE", "ACCOUNT_UNAVAILABLE", "FX_RATE_STALE", "FX_RATE_UNAVAILABLE", "INVALID_FX_SNAPSHOT", "INVALID_CHOICE_COUNT", "INVALID_TOKEN_BUDGET", "INVALID_IMAGE_COUNT", "VIDEO_PRICE_MISSING"].includes(error.code)))) {
          if (error.status === 402) return purchaseRequiredError();
          return requestNotSubmittedError(error.message, error.status);
        }
        if (error instanceof HostedSupplyError || error instanceof GatewayBillingError) return jsonError(error.message, error.status);
        return jsonError("积分结算暂不可用，请稍后重试", 503);
      }
      payload.url = `${relayBase}/${kind === "chat.completions" ? "chat/completions" : kind === "images.generations" ? "images/generations" : kind === "images.edits" ? "images/edits" : "videos"}`;
    } else {
      const video = target.pathname.match(/^\/v1\/(videos|requests)\/([A-Za-z0-9_-]{1,200})(\/content)?\/?$/);
      if (!["GET", "HEAD"].includes(method) || !video) return jsonError("此托管端点或请求方法不允许转发", 403);
      const variant = target.searchParams.get("variant");
      if ([...target.searchParams.keys()].some((key) => key !== "variant") || (variant && (!video[3] || !["video", "thumbnail", "spritesheet"].includes(variant)))) return jsonError("视频下载参数无效", 400);
      let job: Awaited<ReturnType<typeof findGatewayVideoJob>>;
      try { job = await findGatewayVideoJob(user.id, video[2]); }
      catch { return jsonError("视频任务归属查询暂不可用", 503); }
      if (!job) return jsonError("视频任务不存在或不属于当前用户", 404);
      if (job.provider !== "shaozhuang" || job.baseUrl !== relayBase) return jsonError("视频任务供应地址已变化", 409);
      let credential: { baseUrl: string; apiKey: string };
      try {
        if (job.credentialId) credential = await getUserSupplyCredential(user.id, job.credentialId);
        else {
          const binding = await getGatewaySharedVideoSupplyBinding(user.id, video[2]);
          if (binding) {
            const runtime = await getGatewaySharedPlatformRuntime();
            if (runtime.baseUrl !== binding.providerBaseUrl || runtime.credentialFingerprint !== binding.credentialFingerprint ||
                runtime.configVersion !== binding.configVersion || runtime.epoch && runtime.epoch.id !== binding.epochId) {
              return jsonError("原视频供应绑定已变化，请核对原任务", 409);
            }
            credential = runtime;
          } else credential = relay;
        }
      } catch (error) {
        return jsonError("原视频供应凭据暂不可用，请核对原任务", error instanceof GatewayBillingError && error.status === 409 ? 409 : 503);
      }
      if (!credential.apiKey) return jsonError("原视频供应凭据暂不可用", 503);
      if (credential.baseUrl.replace(/\/+$/, "") !== job.baseUrl) return jsonError("原视频供应绑定暂不可用", 409);
      hostedKey = credential.apiKey;
      hostedKeys = [hostedKey];
      payload.url = `${relayBase}/${video[1]}/${video[2]}${video[3] || ""}${variant ? `?variant=${variant}` : ""}`;
      hostedContent = !!video[3];
      hostedVideoJob = job; hostedVideoTask = video[2]; hostedUserId = user.id;
    }
    headers.authorization = `Bearer ${hostedKey}`;
  }
  if (typeof FormData !== "undefined" && payload.body instanceof FormData) {
    delete headers["content-type"];
  }
  try {
  if (supplyHold) await markHostedSupplyDispatched(supplyHold);
  const durableImageDispatch = !!imageReceipt || !!byokReceipt;
  const providerDeadline = AbortSignal.timeout(120000);
  // A durable original belongs to its receipt after dispatch commits. A browser
  // disconnect must not cancel its provider work or prevent staging/settlement.
  // Other proxy requests retain their existing client-cancellation behavior.
  const signal = durableImageDispatch ? providerDeadline : AbortSignal.any([request.signal, providerDeadline]);
  const send = async (key: string) => {
    // Honor cancellation before handing this original over to durable dispatch.
    // After that commit, only its original provider deadline governs the work.
    if (durableImageDispatch && !providerAttempted) request.signal.throwIfAborted();
    if (imageReceipt && supplyHold) await creativeImageReceiptStore.markDispatch(imageReceipt, supplyHold.billingEventId);
    if (byokReceipt) await creativeImageReceiptStore.markByokDispatch(byokReceipt);
    providerAttempted = true;
    return (hostedKey ? relayFetch : fetch)(payload.url, {
      method, headers: { ...headers, ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: method === "GET" || method === "HEAD" ? undefined : payload.body,
      cache: "no-store", redirect: "error", signal
    });
  };
  const upstream = userSupply ? (await runSupplyWithFailover(userSupply, async credential => {
    if (supplyHold) await bindHostedSupplyCredential(supplyHold, credential.id);
    return send(credential.apiKey);
  })).response : await send(hostedKey);
  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  if (supplyHold && !/json/i.test(contentType) && upstream.ok) {
    await upstream.body?.cancel();
    await markHostedSupplyUnknown(supplyHold, "ambiguous_response");
    settled = true;
    return jsonError("上游结果暂未确认，已扣积分保留待核对", 502, supplyHold.billingEventId);
  }
  if ((method === "GET" || method === "HEAD") && (contentType.startsWith("video/") || contentType.startsWith("application/octet-stream") || (hostedContent && contentType.startsWith("image/")))) {
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
      headers: { "Cache-Control": "no-store", "Content-Type": redactSupplySecrets(contentType, hostedKeys) as string, "X-Content-Type-Options": "nosniff" }
    });
  }
  let bytes = await boundedBytes(upstream.body, MAX_BYTES);
  const rawResponseText = supplyHold ? new TextDecoder().decode(bytes) : undefined;
  if (byokReceipt) {
    // Full body completion precedes any successful descriptor. Partial bodies,
    // non-200 replies and persistence failures retain the original UUID.
    if (upstream.status === 200 && /json/i.test(contentType)) {
      try {
        const safe = publicHostedBytes(bytes,[personalAuthorization.replace(/^Bearer\s+/i, "")],null);
        await creativeImageReceiptStore.stageByok(byokReceipt,safe);
        const descriptor = await creativeImageReceiptStore.completeByok(byokReceipt);
        return NextResponse.json(descriptor,{headers:{"Cache-Control":"no-store","X-Sanjie-Image-Receipt-Id":descriptor.receipt.receiptId}});
      } catch {
        return NextResponse.json({error:"图片回执保存尚未确认，请查看原任务，避免重复提交。",code:"IMAGE_RECEIPT_PERSIST_UNCONFIRMED",stateUncertain:true,receipt:byokReceipt.registration.identity},
          {status:503,headers:{"Cache-Control":"no-store"}});
      }
    }
    if ([400,401,403,404,413,422,429].includes(upstream.status) && /json/i.test(contentType)) {
      try {
        // A complete explicit error response is known rejection evidence;
        // arbitrary status/body or an accepted image response remains unknown.
        if (creativeByokImageDefinitiveRejection(bytes,upstream.status)) {
          await creativeImageReceiptStore.markByokRejected(byokReceipt,upstream.status);
          const descriptor = await creativeImageReceiptStore.descriptor(byokOwnerId,byokReceipt.registration.identity);
          return NextResponse.json(descriptor,{status:200,headers:{"Cache-Control":"no-store"}});
        }
      } catch { /* No definite evidence: preserve the original unknown receipt. */ }
    }
    return NextResponse.json({error:"自有 API 原图片回执尚未确认，请保留原任务，避免重复提交。",code:"IMAGE_RECEIPT_UNCONFIRMED",stateUncertain:true,receipt:byokReceipt.registration.identity},
      {status:502,headers:{"Cache-Control":"no-store"}});
  }
  if (hostedKey) {
    if (method === "HEAD") bytes = new Uint8Array();
    else {
      try { bytes = publicHostedBytes(bytes, hostedKeys, supplyHold); }
      catch {
        if (supplyHold) { await markHostedSupplyUnknown(supplyHold, "ambiguous_response"); settled = true; }
        return jsonError("上游响应格式无效，请检查任务状态", 502, supplyHold?.billingEventId);
      }
    }
  }
  if (hostedVideoJob && !hostedContent && method === "GET" && upstream.ok) {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (data && typeof data === "object" && !Array.isArray(data)) await reconcileGatewayVideoTerminal(hostedUserId, hostedVideoTask, hostedVideoJob, data as Record<string, unknown>);
  }
  let receiptStaged = false;
  if (imageReceipt && supplyHold && upstream.ok) {
    try {
      await creativeImageReceiptStore.stage(imageReceipt, bytes, supplyHold.billingEventId);
      receiptStaged = true;
    } catch { /* Preserve the existing settlement contract; do not invent a refund. */ }
  }
  if (supplyHold) {
    try {
      const result = await settleHostedSupply(supplyHold, { status: upstream.status, bytes, contentType, rawResponseText });
      settled = true;
      if (result.reject) return jsonError("上游结果暂未确认，已扣积分保留待核对", 502, supplyHold.billingEventId);
    } catch (error) {
      await markHostedSupplyUnknown(supplyHold, "settlement_failed");
      settled = true;
      return creditServiceError(error, supplyHold.billingEventId, "unknown", true)!;
    }
  }
  if (imageReceipt && supplyHold && upstream.ok) {
    try {
      if (!receiptStaged) throw new CreativeImageReceiptError("IMAGE_RECEIPT_PERSIST_UNCONFIRMED", 503, "图片回执保存未确认。");
      const descriptor = await creativeImageReceiptStore.complete(imageReceipt, supplyHold.billingEventId);
      return NextResponse.json(descriptor, { headers: { "Cache-Control": "no-store", "X-Gateway-Billing-Id": supplyHold.billingEventId, "X-Sanjie-Image-Receipt-Id": descriptor.receipt.receiptId } });
    } catch {
      return NextResponse.json({ error: "图片结果已返回，持久回执暂未确认，请查看原任务，避免重复提交。", code: "IMAGE_RECEIPT_PERSIST_UNCONFIRMED", stateUncertain: true, receipt: imageReceipt.registration.identity, billingEventId: supplyHold.billingEventId },
        { status: 503, headers: { "Cache-Control": "no-store", "X-Gateway-Billing-Id": supplyHold.billingEventId } });
    }
  }
  return new NextResponse(method === "HEAD" ? null : bytes, {
    status: hostedKey && [401, 403].includes(upstream.status) ? 502 : upstream.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": redactSupplySecrets(contentType, hostedKeys) as string,
      ...(supplyHold ? { "X-Gateway-Billing-Id": supplyHold.billingEventId } : {})
    }
  });
  } catch (error) {
    if (byokReceipt && !providerAttempted) await creativeImageReceiptStore.markNotSubmitted(byokReceipt, "IMAGE_RECEIPT_PRE_DISPATCH_FAILED").catch(() => undefined);
    if (byokReceipt) return NextResponse.json({error:"自有 API 原任务回执尚未确认，请保留原任务，避免重复提交。",code:"IMAGE_RECEIPT_UNCONFIRMED",stateUncertain:true,receipt:byokReceipt.registration.identity},{status:502,headers:{"Cache-Control":"no-store"}});
    if (imageReceipt && !providerAttempted) await creativeImageReceiptStore.markNotSubmitted(imageReceipt, "IMAGE_RECEIPT_PRE_DISPATCH_FAILED").catch(() => undefined);
    if (supplyHold && !settled) {
      if (supplyHold.dispatched && !providerAttempted) {
        try {
          const refunded = await refundGatewayBillingHold({userId:supplyHold.auth.userId,eventId:supplyHold.billingEventId,reason:"confirmed_failed",
            evidenceFingerprint:gatewayOutcomeFingerprint({reason:"local_before_provider_send"})});
          return creditServiceError(error,supplyHold.billingEventId,"not-submitted") || requestNotSubmittedError(
            refunded.hold?.refundedCents > 0 ? "生成请求未发送，本次扣分已退回" : "生成请求未发送，请核对原任务与积分记录",503,new Headers({"X-Gateway-Billing-Id":supplyHold.billingEventId}));
        } catch { return creditServiceError(error,supplyHold.billingEventId,"unknown",true)!; }
      }
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || ("status" in error && error.status === 504));
      try { await markHostedSupplyUnknown(supplyHold, timedOut ? "timeout" : "disconnect"); }
      catch { return creditServiceError(error, supplyHold.billingEventId, "unknown", true)!; }
      if (!supplyHold.dispatched) return creditServiceError(error, supplyHold.billingEventId, "not-submitted") || jsonError("生成服务暂时繁忙，请稍后重试", 503, supplyHold.billingEventId);
    }
    const creditFailure = creditServiceError(error, supplyHold?.billingEventId);
    if (creditFailure) return creditFailure;
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || ("status" in error && error.status === 504));
    return jsonError(timedOut ? "上游请求超时，已扣积分保留待核对，请勿自动重试。" : "上游连接中断，请核对任务与积分流水后再操作。", timedOut ? 504 : 502, supplyHold?.billingEventId);
  }
}
