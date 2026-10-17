import "server-only";
import { prisma } from "@/lib/db";
import { gatewayNativeFundingSnapshot, bindGatewayNativePoolFunding } from "./credit-pool-accounting";
import { contractHash } from "./source-quote.mjs";
import { randomUUID } from "node:crypto";
import { nativeSubmissionBaseQuote, nativeModelSubmissionQuotes, issueNativeSubmissionQuote, verifyNativeSubmissionQuote } from "./native-video-quote";
import { getNativeVideoCreateSupply, getNativeVideoSupplyForJob, readNativeVideoSupplyConfig, sub2VideoBindingFingerprint, SUB2_VIDEO_ORIGIN, type NativeVideoSupply } from "./native-video-supply";
import { getRelayRuntime } from "./relay-config";
import { getUserSupplyCredential, getUserSupplyRuntime } from "./user-supply";
import { runSupplyWithFailover, redactSupplySecrets, type SupplyCredentials } from "./supply-failover";
import { relayFetch } from "./relay-network";
import { getGatewayBillingSnapshot } from "./billing";
import { applyGatewayBillingCost, GatewayBillingError } from "./billing-contract";
import { getGatewayAvailableBalance, reserveGatewayBillingHold, markGatewayBillingHoldDispatched, bindGatewayBillingHoldCredential, markGatewayBillingHoldUnknown, releaseGatewayBillingHold, refundGatewayBillingHold, settleGatewayBillingHold } from "./billing-hold";
import { recordGatewayUsage } from "./store";
import { findNativeVideoJob, findActiveNativeVideoJob, insertNativeVideoJob, requireNativeVideoJob, updateNativeVideoJob, type NativeVideoJob } from "./native-video-store";
import { NativeVideoError, digest, stable, plain, parseNativeVideoConfig, nativeTariff, nativeTokenCost, nativeTaskId, safeVideoUrl, validateNativeRequest, NATIVE_VIDEO_ENDPOINT, NATIVE_VIDEO_PATH, type NativeVideoOwner, type NativeVideoModel } from "./native-video-contract";
import { nativeVideoAssets, releaseNativeVideoAssets } from "./native-video-assets";

export const NATIVE_VIDEO_BODY_BYTES = 24 * 1024 * 1024;
const RESPONSE_BYTES = 1024 * 1024;
const MEDIA_BYTES = 256 * 1024 * 1024;
type UserNativeSupply = NativeVideoSupply & { credentialId?: string; credentials?: SupplyCredentials; bindingId?: string };
const SUB2_TASK_ENDPOINT = SUB2_VIDEO_ORIGIN + "/api/v3/contents/generations/tasks";

function ownedSub2Supply(key: string, credentialId: string, bindingId: string, models: NativeVideoModel[], credentials?: SupplyCredentials): UserNativeSupply {
  return { kind: "sub2api", provider: "shaozhuang", key, credentialId, credentials, bindingId,
    endpoint: SUB2_TASK_ENDPOINT, binding: sub2VideoBindingFingerprint(key, bindingId), models };
}

/** Direct Ark bindings retain their explicit issuer; only Sub2API uses this user's provisioned pair. */
async function createSupply(owner: NativeVideoOwner): Promise<UserNativeSupply> {
  const config = await readNativeVideoSupplyConfig();
  let bindingId: string, models: NativeVideoModel[];
  if (config) {
    if (!config.enabled) throw new NativeVideoError("NATIVE_VIDEO_DISABLED", "平台视频供应尚未开通", 503);
    const active = config.bindings.find(binding => binding.bindingId === config.activeBindingId)!;
    if (active.provider === "ark") {
      const configured = await getNativeVideoCreateSupply();
      if (configured.kind !== "ark") throw new NativeVideoError("NATIVE_VIDEO_SUPPLY_UNAVAILABLE", "视频供应配置已变化，请重新核对", 503);
      return configured;
    }
    bindingId = active.bindingId; models = active.models;
  } else {
    // Legacy protocol metadata does not require a global Key for a new owned dispatch.
    const legacy = parseNativeVideoConfig(process.env.MODEL_GATEWAY_SEEDANCE_CONFIG);
    if (!legacy.enabled) throw new NativeVideoError("NATIVE_VIDEO_DISABLED", "平台视频供应尚未开通", 503);
    const relay = await getRelayRuntime();
    if (!legacy.bindingId || relay.baseUrl.replace(/\/+$/, "") !== SUB2_VIDEO_ORIGIN + "/v1") {
      throw new NativeVideoError("NATIVE_VIDEO_SUPPLY_UNAVAILABLE", "平台视频供应尚未配置", 503);
    }
    bindingId = legacy.bindingId; models = legacy.models;
  }
  try {
    const current = await getUserSupplyRuntime(owner.id);
    if (current.baseUrl.replace(/\/+$/, "") !== SUB2_VIDEO_ORIGIN + "/v1") throw new Error();
    const selected = current.primary.apiKey ? current.primary : current.backup;
    if (!selected?.apiKey) throw new Error();
    return ownedSub2Supply(selected.apiKey, selected.id, bindingId, models, { primary: current.primary, backup: current.backup });
  } catch { throw new NativeVideoError("NATIVE_VIDEO_SUPPLY_UNAVAILABLE", "当前账号的视频供应凭据暂不可用", 503); }
}

async function supplyForJob(owner: NativeVideoOwner, job: NativeVideoJob): Promise<UserNativeSupply> {
  // All pre-upgrade Ark and Sub2API jobs keep the exact retained-binding resolver.
  if (!job.credentialId) return getNativeVideoSupplyForJob(job.bindingFingerprint);
  let retained: Awaited<ReturnType<typeof getUserSupplyCredential>>;
  try {
    retained = await getUserSupplyCredential(owner.id, job.credentialId);
    if (!retained.apiKey || retained.baseUrl.replace(/\/+$/, "") !== SUB2_VIDEO_ORIGIN + "/v1") throw new Error();
  } catch { throw new NativeVideoError("NATIVE_VIDEO_SUPPLY_UNAVAILABLE", "原视频供应凭据暂不可用，任务保留待核对", 503); }
  const bindings: Array<{ bindingId: string; models: NativeVideoModel[] }> = [];
  try {
    const config = await readNativeVideoSupplyConfig();
    bindings.push(...(config?.bindings.filter(binding => binding.provider === "sub2api") || []));
  } catch { /* A retained legacy protocol binding may still prove this exact owned task. */ }
  try {
    const legacy = parseNativeVideoConfig(process.env.MODEL_GATEWAY_SEEDANCE_CONFIG);
    if (legacy.bindingId) bindings.push(legacy);
  } catch { /* Do not expose configuration or credential errors. */ }
  for (const binding of bindings) {
    const current = ownedSub2Supply(retained.apiKey, job.credentialId, binding.bindingId, binding.models);
    if (current.binding === job.bindingFingerprint) return current;
  }
  throw new NativeVideoError("NATIVE_VIDEO_BINDING_CHANGED", "原视频供应绑定已变更，任务保留待核对", 409);
}

function auth(owner: NativeVideoOwner) { return { userId: owner.id, username: owner.username, apiKeyId: null, keyPrefix: "web-session" }; }
export function nativeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new NativeVideoError("NATIVE_VIDEO_IDEMPOTENCY_REQUIRED", "视频创建需要有效的幂等标识");
  return value;
}
export async function nativeVideoCapabilities(owner: NativeVideoOwner) {
  const shared = { provider: "shaozhuang", adapter: "ark", billingMode: "prepaid_quote", quoteEndpoint: NATIVE_VIDEO_PATH + "/quote", createEndpoint: NATIVE_VIDEO_PATH,
    statusEndpoint: NATIVE_VIDEO_PATH + "/{taskId}", cancelEndpoint: "", limits: { bodyBytes: NATIVE_VIDEO_BODY_BYTES } };
  try {
    const current = await createSupply(owner);
    const snapshot = await getGatewayBillingSnapshot(owner.id);
    if (snapshot.tenantId !== owner.tenantId) throw new NativeVideoError("ACCOUNT_CHANGED", "当前账号已变更", 409);
    return { ...shared, provider: current.provider, configured: true, billingMode: "prepaid_quote", reason: { code: "READY", message: "提交时按本次报价扣积分，失败退回，取消不退" },
      models: current.models.map(model => ({ id: model.id, label: model.label, providerModel: model.id,
        durations: model.durations, resolutions: model.resolutions, ratios: model.ratios, generateAudio: model.generateAudio,
        reservationCents: 0, billingMode: "prepaid_quote", submissionQuotes: nativeModelSubmissionQuotes(model,snapshot), priceVersion: model.priceVersion })),
      billing: { mode: "submission_quote", billingMode: "prepaid_quote", quoteAvailable: true, quoteEndpoint: NATIVE_VIDEO_PATH + "/quote", refundOnFailure: true, refundOnCancel: false, adjustmentOnSuccess: false } };
  } catch (cause) {
    return { ...shared, configured: false, models: [], billing: { mode: "completion_tokens", currency: "CNY", quoteAvailable: false },
      reason: { code: cause instanceof NativeVideoError ? cause.code : "NATIVE_VIDEO_UNAVAILABLE", message: "平台视频供应或价格尚未就绪，请联系管理员" } };
  }
}
export function publicNativeVideoJob(job: NativeVideoJob) {
  const succeeded = job.state === "succeeded" && job.holdStatus === "settled" && !!job.resultUrl;
  const failed = job.state === "failed" && (job.holdStatus === "released" || job.billingMode === "prepaid_quote");
  const cancelled = !!job.cancelledAt && !job.refundedCents;
  const stateUncertain = !cancelled && !failed && (job.state === "unknown" || (!job.providerTaskId && job.holdStatus !== "reserved") || job.holdStatus === "unknown");
  return { id: job.id, status: cancelled ? "cancelled" : succeeded ? "succeeded" : failed ? "failed" : job.state === "reserved" ? "queued" : "running",
    stateUncertain, ...(succeeded ? { content: { video_url: `${NATIVE_VIDEO_PATH}/${encodeURIComponent(job.id)}/content` } } : {}),
    ...(job.errorCode ? { error: { code: job.errorCode, message: failed ? (job.errorCode === "NATIVE_VIDEO_BALANCE_REJECTED" ? "余额不足，本次请求未发送，也未扣积分" : job.billingMode === "prepaid_quote" ? (job.refundedCents ? "视频生成失败，本次积分已退回" : cancelled ? "视频请求已取消，积分不退回" : "视频生成失败，退款正在核对") : job.billingMode === "direct_usage" ? "供应商确认视频生成失败，本次未扣积分" : "供应商确认视频生成失败，冻结积分已释放") : "原视频任务仍待核对，请勿重复创建" } } : {}),
    billing: { billingMode: job.billingMode ?? "reservation", reservedCents: ["reserved", "dispatched", "unknown"].includes(job.holdStatus) ? job.heldCents : 0,
      settledCents: job.settledCents === null ? null : job.billingMode === "prepaid_quote" ? (job.chargedCents ?? 0) - (job.refundedCents ?? 0) : job.settledCents,
      amountDueCents: job.amountDueCents ?? 0, quoteCents:job.quoteCents, chargedCents:job.chargedCents ?? 0, refundedCents:job.refundedCents ?? 0, cancelled:cancelled } };
}
async function boundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new NativeVideoError("NATIVE_VIDEO_RECEIPT_INVALID", "视频回执为空", 502);
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > RESPONSE_BYTES) throw new Error(); chunks.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!plain(body)) throw new Error();
    return body;
  } catch { await reader.cancel().catch(() => undefined); throw new NativeVideoError("NATIVE_VIDEO_RECEIPT_INVALID", "视频回执无法核验", 502); }
  finally { reader.releaseLock(); }
}
function headers(key: string) { return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" }; }
async function unknown(owner: NativeVideoOwner, job: NativeVideoJob, code: string) {
  // If storage is unavailable, durable 'dispatched' still prevents resubmission.
  await markGatewayBillingHoldUnknown({ userId: owner.id, eventId: job.eventId, reason: "ambiguous_response" });
  await updateNativeVideoJob(owner, job.id, { state: "unknown", errorCode: code });
  return publicNativeVideoJob(await requireNativeVideoJob(owner, job.id));
}
export async function quoteNativeVideo(owner: NativeVideoOwner, body: Record<string, unknown>) {
  const { expectedAccount: _account, quoteToken: _quote, ...publicBody } = body;
  const current = await createSupply(owner);
  const model = current.models.find(item => item.id === body.model);
  if (!model) throw new NativeVideoError("NATIVE_VIDEO_MODEL_UNAVAILABLE", "平台未开通该视频模型", 503);
  const material = await nativeVideoAssets(owner, current, { expectedAccount: body.expectedAccount, ...publicBody });
  validateNativeRequest(material.body, model, material.trustedUris);
  const tariff = nativeTariff(model, publicBody);
  const snapshot = await gatewayNativeFundingSnapshot(await getGatewayBillingSnapshot(owner.id));
  if (snapshot.tenantId !== owner.tenantId || snapshot.username !== owner.username) throw new NativeVideoError("ACCOUNT_CHANGED", "当前账号已变更", 409);
  return issueNativeSubmissionQuote(owner, digest(stable(publicBody)), tariff, snapshot, nativeSubmissionBaseQuote(model, publicBody, tariff));
}
export async function createNativeVideo(owner: NativeVideoOwner, body: Record<string, unknown>, rawIdempotency: unknown) {
  const idempotencyKey = nativeIdempotencyKey(rawIdempotency);
  const { expectedAccount: _account, quoteToken, ...publicBody } = body;
  const requestFingerprint = digest(stable(publicBody));
  const previous = await findNativeVideoJob(owner, { idempotencyKey });
  if (previous) {
    if (previous.requestFingerprint !== requestFingerprint) throw new NativeVideoError("NATIVE_VIDEO_IDEMPOTENCY_CONFLICT", "幂等标识已用于不同视频方案", 409);
    return publicNativeVideoJob(previous); // Never redispatch a persisted request.
  }
  const duplicate = await findActiveNativeVideoJob(owner, requestFingerprint);
  if (duplicate) return publicNativeVideoJob(duplicate);
  if ((await getGatewayAvailableBalance(prisma,owner.id)).availableCents<=0) throw new GatewayBillingError("INSUFFICIENT_BALANCE","可用积分不足，请先购买积分",402);
  const current = await createSupply(owner);
  const model = current.models.find(item => item.id === body.model);
  if (!model) throw new NativeVideoError("NATIVE_VIDEO_MODEL_UNAVAILABLE", "平台未开通该视频模型", 503);
  const material = await nativeVideoAssets(owner, current, { expectedAccount: body.expectedAccount, ...publicBody });
  let providerBody = validateNativeRequest(material.body, model, material.trustedUris);
  const tariff = nativeTariff(model, publicBody);
  const billingSnapshot = await gatewayNativeFundingSnapshot(await getGatewayBillingSnapshot(owner.id));
  if (billingSnapshot.tenantId !== owner.tenantId || billingSnapshot.username !== owner.username) throw new NativeVideoError("ACCOUNT_CHANGED", "当前账号已变更", 409);
  const quoteCents = applyGatewayBillingCost(nativeSubmissionBaseQuote(model, publicBody, tariff), billingSnapshot);
  verifyNativeSubmissionQuote(quoteToken, owner, requestFingerprint, tariff, billingSnapshot, quoteCents);
  const eventId = `native-video:${randomUUID()}`;
  const id = `nv_${randomUUID()}`;
  let reservation;
  try {
    reservation = await reserveGatewayBillingHold({ auth: auth(owner), billingSnapshot, eventId, billingMode: "prepaid_quote",
      quoteCents, requestFingerprint,
      endpoint: NATIVE_VIDEO_ENDPOINT, provider: current.provider, model: model.id, idempotencyKey: `native-video:${idempotencyKey}`,
      onReserved: async (tx, hold) => { await insertNativeVideoJob(tx, { id, userId: owner.id, tenantId: owner.tenantId,
        eventId: hold.eventId, idempotencyHash: digest(idempotencyKey), requestFingerprint, bindingFingerprint: current.binding,
        credentialId: current.credentialId,
        model: model.id, upstreamModel: model.upstreamModel, tariff });
        await bindGatewayNativePoolFunding(tx,hold.eventId,{jobId:id,provider:current.provider,endpoint:current.endpoint,keyFingerprint:digest(current.key),bindingFingerprint:current.binding});
      } });
  } catch (cause) {
    if (cause instanceof NativeVideoError && cause.code === "NATIVE_VIDEO_ALREADY_ACTIVE") {
      const existing = await findActiveNativeVideoJob(owner, requestFingerprint); if (existing) return publicNativeVideoJob(existing);
    }
    throw cause;
  }
  const stored = await findNativeVideoJob(owner, { idempotencyKey });
  if (!stored) throw new NativeVideoError("NATIVE_VIDEO_STORAGE_UNAVAILABLE", "视频任务记录暂不可用，请通过原幂等标识核对", 503);
  if (!reservation.shouldDispatch) return publicNativeVideoJob(stored);
  let claim;
  try { claim = await markGatewayBillingHoldDispatched({ userId: owner.id, eventId: stored.eventId }); }
  catch (cause) {
    if (stored.billingMode === "prepaid_quote") {
      // A failed dispatch claim has never granted permission for a provider POST.
      // Cancellation wins under the same wallet lock and keeps its original fee.
      await refundGatewayBillingHold({userId:owner.id,eventId:stored.eventId,reason:"pre_dispatch"}).catch(()=>undefined);
      await updateNativeVideoJob(owner,stored.id,{state:"failed",errorCode:"NATIVE_VIDEO_PRE_DISPATCH_FAILED"}).catch(()=>undefined);
    } else if (cause instanceof GatewayBillingError && cause.code === "INSUFFICIENT_BALANCE") {
      // The billing layer already released this undispatched event atomically.
      await updateNativeVideoJob(owner, stored.id, { state: "failed", errorCode: "NATIVE_VIDEO_BALANCE_REJECTED" });
    }
    throw cause;
  }
  if (!claim.shouldDispatch) return publicNativeVideoJob(await requireNativeVideoJob(owner, stored.id));
  let providerAttempted = false;
  try {
    // Recheck moderation/authorization and persist protection immediately before
    // dispatch. The existing wallet and idempotency remain authoritative.
    const leasedMaterial = await nativeVideoAssets(owner, current, { expectedAccount: body.expectedAccount, ...publicBody }, stored.id);
    providerBody = validateNativeRequest(leasedMaterial.body, model, leasedMaterial.trustedUris);
    await updateNativeVideoJob(owner, stored.id, { state: "submitting" });
    const signal = AbortSignal.timeout(60_000);
    const send = (key: string) => { providerAttempted = true; return relayFetch(current.endpoint, { method: "POST", headers: { ...headers(key), "Idempotency-Key": stored.eventId },
      body: JSON.stringify(providerBody), signal, cache: "no-store" }); };
    const response = current.credentials ? (await runSupplyWithFailover(current.credentials, async credential => {
      await bindGatewayBillingHoldCredential({ userId: owner.id, eventId: stored.eventId, credentialId: credential.id,
        nativeDispatch:{jobId:stored.id,provider:current.provider,endpoint:current.endpoint,keyFingerprint:digest(credential.apiKey),bindingFingerprint:sub2VideoBindingFingerprint(credential.apiKey,current.bindingId!)} });
      await updateNativeVideoJob(owner, stored.id, { state: "submitting", credentialId: credential.id, bindingFingerprint: sub2VideoBindingFingerprint(credential.apiKey, current.bindingId!) });
      return send(credential.apiKey);
    })).response : await send(current.key);
    if (!response.ok) {
      if (stored.billingMode === "prepaid_quote" && [400,401,403,404,422].includes(response.status)) {
        let rejected: Record<string, unknown> | null = null;
        try { rejected = await boundedJson(response); } catch { /* An unreadable reply is still uncertain. */ }
        if (rejected && !nativeTaskId(rejected.id) && plain(rejected.error)) {
          await refundGatewayBillingHold({userId:owner.id,eventId:stored.eventId,reason:"confirmed_failed",evidenceFingerprint:digest(stable({eventId:stored.eventId,status:response.status,outcome:"provider_rejected"}))});
          await updateNativeVideoJob(owner,stored.id,{state:"failed",errorCode:"NATIVE_VIDEO_PROVIDER_FAILED"});
          await releaseNativeVideoAssets(owner, current, stored.id, "failed");
          return publicNativeVideoJob(await requireNativeVideoJob(owner,stored.id));
        }
      } else await response.body?.cancel();
      return unknown(owner, stored, "NATIVE_VIDEO_CREATE_UNCERTAIN");
    }
    const receipt = redactSupplySecrets(await boundedJson(response), current.credentials
      ? [current.credentials.primary.apiKey, current.credentials.backup?.apiKey || ""] : [current.key]) as Record<string, unknown>;
    if (!nativeTaskId(receipt.id)) return unknown(owner, stored, "NATIVE_VIDEO_CREATE_UNCERTAIN");
    await updateNativeVideoJob(owner, stored.id, { state: "processing", providerTaskId: receipt.id });
    return publicNativeVideoJob(await requireNativeVideoJob(owner, stored.id));
  } catch {
    if (!providerAttempted && stored.billingMode === "prepaid_quote") {
      await refundGatewayBillingHold({userId:owner.id,eventId:stored.eventId,reason:"confirmed_failed",evidenceFingerprint:digest(stable({eventId:stored.eventId,outcome:"local_before_provider_send"}))});
      await updateNativeVideoJob(owner,stored.id,{state:"failed",errorCode:"NATIVE_VIDEO_PROVIDER_FAILED"});
      await releaseNativeVideoAssets(owner, current, stored.id, "failed");
      return publicNativeVideoJob(await requireNativeVideoJob(owner,stored.id));
    }
    return unknown(owner, stored, "NATIVE_VIDEO_CREATE_UNCERTAIN");
  }
}
export async function resolveNativeVideo(owner: NativeVideoOwner, rawIdempotency: unknown) {
  const job = await findNativeVideoJob(owner, { idempotencyKey: nativeIdempotencyKey(rawIdempotency) });
  if (!job) throw new NativeVideoError("NATIVE_VIDEO_NOT_FOUND", "未找到当前账号的原视频请求；尚不能据此确认上游未受理", 404);
  return publicNativeVideoJob(job);
}
export async function pollNativeVideo(owner: NativeVideoOwner, id: string) {
  const job = await requireNativeVideoJob(owner, id);
  if (job.state === "succeeded" || (job.state === "failed" && !(job.billingMode === "prepaid_quote" && job.completionTokens !== null && !job.usageId)) || !job.providerTaskId) {
    if (["succeeded", "failed"].includes(job.state)) {
      try { await releaseNativeVideoAssets(owner, await supplyForJob(owner, job), id, job.state as "succeeded" | "failed"); } catch { /* Keep the original terminal receipt. */ }
    }
    return publicNativeVideoJob(job);
  }
  const current = await supplyForJob(owner, job);
  const response = await relayFetch(`${current.endpoint}/${encodeURIComponent(job.providerTaskId)}`, {
    method: "GET", headers: headers(current.key), signal: AbortSignal.timeout(30_000), cache: "no-store" });
  // A lookup error (including task binding TTL/404) is never creation failure or refund evidence.
  if (!response.ok) { await response.body?.cancel(); throw new NativeVideoError("NATIVE_VIDEO_STATUS_UNAVAILABLE", "原视频任务状态暂不可核验，请稍后查询", 502); }
  const receipt = redactSupplySecrets(await boundedJson(response), [current.key]) as Record<string, unknown>;
  if (receipt.id !== job.providerTaskId) throw new NativeVideoError("NATIVE_VIDEO_RECEIPT_MISMATCH", "视频回执不属于原任务", 502);
  if (receipt.status === "succeeded") {
    const usage = plain(receipt.usage) ? receipt.usage : {};
    if (typeof usage.completion_tokens !== "number") throw new NativeVideoError("NATIVE_VIDEO_USAGE_INVALID", "完成回执缺少输出用量，原任务保留待核对", 502);
    const tokens = usage.completion_tokens;
    if (job.completionTokens !== null && job.completionTokens !== tokens) throw new NativeVideoError("NATIVE_VIDEO_USAGE_INVALID", "完成回执与原任务已确认用量不一致，请保留任务待核对", 502);
    if (current.kind === "ark" && usage.total_tokens !== undefined && usage.total_tokens !== tokens) {
      throw new NativeVideoError("NATIVE_VIDEO_USAGE_INVALID", "完成回执用量矛盾，原任务保留待核对", 502);
    }
    const baseCostCents = nativeTokenCost(tokens, job.tariff);
    const content = plain(receipt.content) ? receipt.content : {};
    const url = safeVideoUrl(content.video_url, job.tariff.mediaHosts);
    const outcomeFingerprint = digest(stable({ id: job.providerTaskId, status: "succeeded", tokens, priceVersion: job.tariff.priceVersion, baseCostCents }));
    const finalCostCents = applyGatewayBillingCost(baseCostCents, job.billingSnapshot);
    await settleGatewayBillingHold({ userId: owner.id, eventId: job.eventId, finalCostCents, outcomeFingerprint,
      writeUsage: async (tx, frozen) => {
        const currentJob = await findNativeVideoJob(owner, { id }, tx);
        if (!currentJob || currentJob.state === "failed" || Number(currentJob.refundedCents) > 0 || (currentJob.completionTokens !== null && currentJob.completionTokens !== tokens)) {
          throw new NativeVideoError("NATIVE_VIDEO_USAGE_INVALID", "完成回执与原任务已确认用量不一致，请保留任务待核对", 502);
        }
        // Bind a proven completion to its task within the same settlement lock.
        // Delivery remains processing until an allowed media URL is available.
        if (currentJob.state === "unknown") await updateNativeVideoJob(owner, id, { state: "processing" }, tx);
        await recordGatewayUsage({ auth: auth(owner), endpoint: NATIVE_VIDEO_ENDPOINT, provider: current.provider, model: job.model,
          requestId: job.providerTaskId!, completionTokens: tokens, totalTokens: tokens, costCents: finalCostCents, baseCostCents,
          billingSnapshot: frozen.billingSnapshot, billingEventId: frozen.eventId, status: "ok",
          metadata: { nativeVideoJobId: id, priceVersion: job.tariff.priceVersion, costSource:"catalog",
            nativeChargeEvidence:{schema:"SANJIE_NATIVE_CHARGE_V1",jobId:id,taskId:job.providerTaskId!,provider:current.provider,endpoint:current.endpoint,keyFingerprint:digest(current.key),
              bindingFingerprint:current.binding,tariffHash:contractHash(job.tariff),priceVersion:job.tariff.priceVersion,completionTokens:tokens,outcomeHash:outcomeFingerprint},
            ...(job.credentialId ? { credentialId: job.credentialId } : {}) }, audit: { upstreamStatus: 200, outcome: "success" } }, tx);
        await updateNativeVideoJob(owner, id, { state: url ? "succeeded" : "processing", ...(url ? { resultUrl: url } : {}),
          completionTokens: tokens, errorCode: url ? "" : "NATIVE_VIDEO_RESULT_MISSING" }, tx);
      } });
    // Repairs only a crash from a prior implementation; settlement itself is idempotent.
    await updateNativeVideoJob(owner, id, { state: url ? "succeeded" : "processing", ...(url ? { resultUrl: url } : {}),
      completionTokens: tokens, errorCode: url ? "" : "NATIVE_VIDEO_RESULT_MISSING" });
  } else if (job.billingMode === "prepaid_quote" && ["failed", "cancelled", "expired"].includes(String(receipt.status))) {
    const usage = plain(receipt.usage) ? receipt.usage : {};
    const tokens = usage.completion_tokens;
    const evidenceFingerprint = digest(stable({id:job.providerTaskId,status:receipt.status,outcome:"confirmed_failed"}));
    await refundGatewayBillingHold({userId:owner.id,eventId:job.eventId,reason:"confirmed_failed",evidenceFingerprint});
    // Refund the customer independently of the supplier accounting evidence.
    // A positive failed-task usage stays visible for later source reconciliation.
    if (typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 && receipt.status === "failed") {
      await updateNativeVideoJob(owner,id,{state:"failed",completionTokens:tokens,errorCode:"NATIVE_VIDEO_PROVIDER_FAILED"});
      const baseCostCents = nativeTokenCost(tokens, job.tariff);
      const finalCostCents = applyGatewayBillingCost(baseCostCents,job.billingSnapshot);
      const outcomeFingerprint = digest(stable({id:job.providerTaskId,status:"failed",tokens,priceVersion:job.tariff.priceVersion,baseCostCents}));
      try {
        await settleGatewayBillingHold({userId:owner.id,eventId:job.eventId,finalCostCents,outcomeFingerprint,
          writeUsage:async(tx,frozen)=>{
            await recordGatewayUsage({auth:auth(owner),endpoint:NATIVE_VIDEO_ENDPOINT,provider:current.provider,model:job.model,
              requestId:job.providerTaskId!,completionTokens:tokens,totalTokens:tokens,costCents:finalCostCents,baseCostCents,
              billingSnapshot:frozen.billingSnapshot,billingEventId:frozen.eventId,status:"error",error:"NATIVE_VIDEO_PROVIDER_FAILED",
              metadata:{nativeVideoJobId:id,priceVersion:job.tariff.priceVersion,costSource:"catalog",
                nativeChargeEvidence:{schema:"SANJIE_NATIVE_CHARGE_V1",jobId:id,taskId:job.providerTaskId!,provider:current.provider,endpoint:current.endpoint,keyFingerprint:digest(current.key),
                  bindingFingerprint:current.binding,tariffHash:contractHash(job.tariff),priceVersion:job.tariff.priceVersion,completionTokens:tokens,status:"failed",outcomeHash:outcomeFingerprint},
                ...(job.credentialId?{credentialId:job.credentialId}:{})},audit:{upstreamStatus:200,outcome:"provider_failed"}},tx);
          }});
      } catch(cause) {
        if (!(cause instanceof GatewayBillingError) || cause.code !== "POOL_SOURCE_USAGE_UNPROVEN") throw cause;
      }
      await updateNativeVideoJob(owner,id,{state:"failed",completionTokens:tokens,errorCode:"NATIVE_VIDEO_PROVIDER_FAILED"});
    }
    await updateNativeVideoJob(owner,id,{state:"failed",errorCode:"NATIVE_VIDEO_PROVIDER_FAILED"});
  } else if (receipt.status === "failed") {
    if (job.holdStatus === "settled" || Number(job.amountDueCents) > 0) throw new NativeVideoError("NATIVE_VIDEO_FAILURE_AMBIGUOUS", "原任务已确认消费，后续失败回执不能撤销扣费", 502);
    // Preserve the legacy Sub2API contract. Direct Ark release additionally
    // requires explicit zero usage; absence/contradiction cannot prove no charge.
    const usage = plain(receipt.usage) ? receipt.usage : {};
    if ((current.kind === "ark" && (usage.completion_tokens !== 0 || (usage.total_tokens !== undefined && usage.total_tokens !== 0))) ||
        (usage.completion_tokens !== undefined && usage.completion_tokens !== 0)) throw new NativeVideoError("NATIVE_VIDEO_FAILURE_AMBIGUOUS", "失败回执用量无法证明未消费，保留积分待核对", 502);
    const evidenceFingerprint = digest(stable({ id: job.providerTaskId, status: "failed", completionTokens: 0 }));
    await releaseGatewayBillingHold({ userId: owner.id, eventId: job.eventId, reason: "confirmed_not_consumed", evidenceFingerprint });
    await updateNativeVideoJob(owner, id, { state: "failed", errorCode: "NATIVE_VIDEO_PROVIDER_FAILED" });
  } else if (!["queued", "running", "processing"].includes(String(receipt.status))) {
    throw new NativeVideoError("NATIVE_VIDEO_STATUS_UNKNOWN", "供应商任务状态仍待核对", 502);
  }
  const finalJob = await requireNativeVideoJob(owner, id);
  if (finalJob.state === "succeeded" || finalJob.state === "failed") await releaseNativeVideoAssets(owner, current, id, finalJob.state);
  return publicNativeVideoJob(finalJob);
}

export async function nativeVideoContent(owner: NativeVideoOwner, id: string, request: Request) {
  const job = await requireNativeVideoJob(owner, id);
  const url = safeVideoUrl(job.resultUrl, job.tariff.mediaHosts);
  if (job.state !== "succeeded" || job.holdStatus !== "settled" || !url) throw new NativeVideoError("NATIVE_VIDEO_RESULT_NOT_READY", "当前视频尚未完成交付", 409);
  const range = request.headers.get("range");
  if (range && !/^bytes=\d+-\d*$/.test(range)) throw new NativeVideoError("NATIVE_VIDEO_RANGE_INVALID", "仅支持单段视频读取", 416);
  // No supplier Authorization is ever sent to the CDN. relayFetch pins public DNS and rejects redirects.
  const response = await relayFetch(url, { headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(60_000), cache: "no-store" });
  if (![200, 206].includes(response.status) || !/^video\//i.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel(); throw new NativeVideoError("NATIVE_VIDEO_MEDIA_UNAVAILABLE", "视频文件链接暂不可用，请联系管理员核对原任务", 502);
  }
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > MEDIA_BYTES || !response.body) {
    await response.body?.cancel(); throw new NativeVideoError("NATIVE_VIDEO_MEDIA_TOO_LARGE", "视频文件不符合平台读取限制", 502);
  }
  const reader = response.body.getReader(); let size = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await reader.read(); if (next.done) { controller.close(); reader.releaseLock(); return; }
        size += next.value.byteLength; if (size > MEDIA_BYTES || size > declared) throw new Error("Video size exceeds declared bound"); controller.enqueue(next.value);
      } catch (cause) { await reader.cancel().catch(() => undefined); controller.error(cause); }
    }, async cancel() { await reader.cancel(); }
  });
  const out = new Headers({ "Content-Type": response.headers.get("content-type")!, "Content-Length": String(declared), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": `inline; filename="${id}.mp4"` });
  for (const name of ["content-range", "accept-ranges"]) { const value = response.headers.get(name); if (value) out.set(name, value); }
  return new Response(stream, { status: response.status, headers: out });
}
