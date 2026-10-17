import "server-only";
import { randomUUID } from "node:crypto";
import type { GatewayModel } from "@/lib/model-gateway/catalog";
import { getGatewayBillingSnapshot } from "@/lib/model-gateway/billing";
import { applyGatewayBillingCost, GatewayBillingError, sanitizeGatewayFxSnapshot, type GatewayBillingSnapshot, type GatewayFxSnapshot } from "@/lib/model-gateway/billing-contract";
import { requireGatewayFxSnapshot, gatewayFxMetadata } from "@/lib/model-gateway/exchange-rate";
import { findAvailableGatewayModel } from "@/lib/model-gateway/runtime-catalog";
import { formatUsd, parseUpstreamUsdCost, usdToCnyCents } from "@/lib/model-gateway/relay-routing";
import { recordGatewayUsage, type GatewayAuth } from "@/lib/model-gateway/store";
import { gatewayOutcomeFingerprint, gatewayRequestFingerprint, prepareGatewayBillingQuote } from "@/lib/model-gateway/billing-request";
import { reserveGatewayBillingHold, isGatewaySharedBillingHold, getGatewayBillingHoldPricing, markGatewayBillingHoldDispatched, bindGatewayBillingHoldCredential, markGatewayBillingHoldUnknown, releaseGatewayBillingHold, settleGatewayBillingHold, refundGatewayBillingHold } from "@/lib/model-gateway/billing-hold";

import { freezeGatewayLocalPricing, validateGatewayLocalPricing, localGatewayCharge, type GatewayLocalChargeEvidence } from "./local-pricing";
import { parseExactSharedUpstreamCost } from "./shared-wallet-usage.mjs";
import { quoteGatewayCharge } from "./source-quote.mjs";

export const HOSTED_SUPPLY_HOST = "sub.shaozhuangai.com";

export type HostedSupplyKind = "chat.completions" | "images.generations" | "images.edits" | "videos";

export class HostedSupplyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HostedSupplyError";
  }
}

export type HostedSupplyHold = {
  auth: GatewayAuth;
  model: GatewayModel;
  kind: HostedSupplyKind;
  body: Record<string, unknown>;
  billingSnapshot: GatewayBillingSnapshot;
  billingEventId: string;
  startedAt: number;
  baseUrl: string;
  dispatched: boolean;
  credentialId?: string;
};

type JsonObject = Record<string, unknown>;

export function hostedSupplyKind(urlString: string, method: string): HostedSupplyKind | null {
  let url: URL;
  try { url = new URL(urlString); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== HOSTED_SUPPLY_HOST || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443") || method.toUpperCase() !== "POST") return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/v1/chat/completions") return "chat.completions";
  if (path === "/v1/images/generations") return "images.generations";
  if (path === "/v1/images/edits") return "images.edits";
  if (path === "/v1/videos") return "videos";
  return null;
}

function object(value: unknown): JsonObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** The task ID is used for user ownership; aliases must normalize before settlement. */
export function hostedVideoTaskId(data: unknown) {
  const root = object(data);
  if (!root) return "";
  const nested = [root, object(root.data), object(root.video)].filter((value): value is JsonObject => !!value);
  return nested.flatMap((item) => [item.request_id, item.id, item.task_id])
    .find((value): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)) || "";
}

export function readHostedSupplyRequest(input: { bodyText?: string; form?: FormData }): { modelName: string; body: JsonObject } {
  if (input.form) {
    for (const name of ["model", "prompt", "n", "stream", "max_tokens", "max_completion_tokens"]) {
      if (input.form.getAll(name).length > 1) throw new HostedSupplyError(`供应请求字段 ${name} 不能重复`, 400);
    }
    const model = input.form.get("model");
    const modelName = typeof model === "string" ? model.trim().slice(0, 160) : "";
    const body: JsonObject = Object.fromEntries([...input.form.entries()].filter((entry) => typeof entry[1] === "string"));
    const prompt = input.form.get("prompt");
    if (typeof prompt === "string") body.prompt = prompt.slice(0, 20_000);
    const count = input.form.get("n");
    if (typeof count === "string" && count.trim()) body.n = Number(count);
    if (modelName) body.model = modelName;
    return { modelName, body };
  }
  if (!input.bodyText) return { modelName: "", body: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(input.bodyText); } catch { return { modelName: "", body: {} }; }
  const body = object(parsed);
  if (!body) return { modelName: "", body: {} };
  const modelName = typeof body.model === "string" ? body.model.trim().slice(0, 160) : "";
  return { modelName, body };
}

export function replaceSupplyModel(body: BodyInit | undefined, upstreamModel: string): BodyInit | undefined {
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    body.set("model", upstreamModel);
    return body;
  }
  const text = typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : "";
  if (!text) return body;
  const parsed = JSON.parse(text);
  const record = object(parsed);
  if (!record) throw new HostedSupplyError("供应请求格式无效", 400);
  return JSON.stringify({ ...record, model: upstreamModel });
}

function textSizeTokens(body: JsonObject) {
  return Math.max(1, Math.ceil(JSON.stringify(body.messages || body.prompt || "").length / 4));
}

function tokenCostCents(model: GatewayModel, promptTokens: number, completionTokens: number) {
  return Math.max(1,
    Math.ceil((promptTokens / 1000) * (model.promptCentsPer1K ?? 1)) +
    Math.ceil((completionTokens / 1000) * (model.completionCentsPer1K ?? 2)));
}

function imageCostCents(model: GatewayModel, count: number) {
  return Math.max(1, Math.ceil(count * (model.imageCents ?? 50)));
}

function imageCount(body: JsonObject) {
  const count = body.n === undefined ? 1 : body.n;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 10) {
    throw new HostedSupplyError("n 必须是 1 到 10 的整数", 400);
  }
  return count;
}

function minimumCents(model: GatewayModel, kind: HostedSupplyKind, body: JsonObject) {
  if (body.stream === true || body.stream === "true") throw new HostedSupplyError("暂不支持流式供应调用", 400);
  if (kind !== "chat.completions" && (typeof body.prompt !== "string" || !body.prompt.trim())) throw new HostedSupplyError("prompt 必须是非空字符串", 400);
  if (kind === "videos") {
    if (!model.videoCents || !Number.isSafeInteger(model.videoCents) || model.videoCents <= 0) {
      throw new HostedSupplyError("视频模型尚未配置任务计价", 503);
    }
    return model.videoCents;
  }
  if (kind.startsWith("images.")) return imageCostCents(model, imageCount(body));
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HostedSupplyError("messages 必须是非空数组", 400);
  return tokenCostCents(model, textSizeTokens(body), 0);
}

function supplyAuth(user: { id: string; username: string }): GatewayAuth {
  return { userId: user.id, username: user.username, apiKeyId: null, keyPrefix: "web-session" };
}

export async function reserveHostedSupply(input: {
  user: { id: string; username: string };
  kind: HostedSupplyKind;
  modelName: string;
  body: JsonObject;
  usdCnyRate: number | null;
  fxSnapshot?: GatewayFxSnapshot;
  baseUrl: string;
  form?: FormData;
  idempotencyKey?: string;
  expectedQuoteCents?: number;
}): Promise<HostedSupplyHold> {
  const lookup = input.kind === "images.edits" ? "images.generations" : input.kind;
  const model = await findAvailableGatewayModel(input.modelName, lookup);
  if (!model || model.provider !== "shaozhuang") throw new HostedSupplyError(`模型未开通：${input.modelName.slice(0, 160)}`, 404);
  minimumCents(model, input.kind, input.body);
  const baseMinimum = prepareGatewayBillingQuote(model, input.kind, input.body);
  const fxSnapshot = input.fxSnapshot === undefined ? requireGatewayFxSnapshot({ usdCnyRate: input.usdCnyRate }) : sanitizeGatewayFxSnapshot(input.fxSnapshot);
  const billingSnapshot = { ...await getGatewayBillingSnapshot(input.user.id), ...(fxSnapshot ? { fxSnapshot } : {}), localPricing: freezeGatewayLocalPricing(model,input.kind,input.body) };
  if (billingSnapshot.userId !== input.user.id) throw new HostedSupplyError("积分账户与当前登录不一致", 401);
  const minimum = applyGatewayBillingCost(baseMinimum, billingSnapshot);
  if (input.expectedQuoteCents !== undefined && input.expectedQuoteCents !== minimum) throw new HostedSupplyError("积分报价已变化，请重新核对后提交", 409);
  const hold: HostedSupplyHold = {
    auth: supplyAuth(input.user), model, kind: input.kind, body: input.body, billingSnapshot,
    billingEventId: randomUUID(), startedAt: Date.now(), baseUrl: input.baseUrl, dispatched: false
  };
  try {
    const reservation = await reserveGatewayBillingHold({
      auth: hold.auth, billingSnapshot, eventId: hold.billingEventId, quoteCents: minimum, billingMode: "prepaid_quote",
      requestFingerprint: await gatewayRequestFingerprint({ endpoint: input.kind, model: model.id, body: input.body, form: input.form }),
      endpoint: input.kind, provider: model.provider, model: model.id, idempotencyKey: input.idempotencyKey
    });
    if (!reservation.shouldDispatch) throw new HostedSupplyError("此请求已受理，请查询原任务或积分流水，勿重复发送", 409);
    hold.billingSnapshot = reservation.hold.billingSnapshot;
    hold.billingEventId = reservation.hold.eventId;
  } catch (error) {
    if (!(error instanceof GatewayBillingError) || error.code !== "INSUFFICIENT_BALANCE") throw error;
    await recordGatewayUsage({
      auth: hold.auth, endpoint: input.kind, provider: model.provider, model: model.id,
      costCents: 0, baseCostCents: baseMinimum, billingSnapshot, billingEventId: hold.billingEventId,
      ...(input.kind === "chat.completions" ? { promptTokens: textSizeTokens(input.body), completionTokens: 0, totalTokens: textSizeTokens(input.body) } : {}),
      status: "error", error: "INSUFFICIENT_BALANCE",
      audit: { durationMs: 0, outcome: "balance_rejected" },
      metadata: { upstreamModel: model.upstreamModel, source: "hosted_supply", tokenSource: input.kind === "chat.completions" ? "estimated" : "unreported", costSource: "catalog" }
    });
    throw new HostedSupplyError(error.message, 402);
  }
  return hold;
}

export async function markHostedSupplyDispatched(hold: HostedSupplyHold) {
  const result = await markGatewayBillingHoldDispatched({ userId: hold.auth.userId, eventId: hold.billingEventId });
  if (!result.shouldDispatch) throw new HostedSupplyError("此请求已发送，请查询原任务，勿重复生成", 409);
  hold.billingSnapshot = result.hold.billingSnapshot;
  hold.dispatched = true;
}

export async function bindHostedSupplyCredential(hold: HostedSupplyHold, credentialId: string) {
  hold.credentialId = credentialId;
  await bindGatewayBillingHoldCredential({ userId: hold.auth.userId, eventId: hold.billingEventId, credentialId });
}

export async function markHostedSupplyUnknown(hold: HostedSupplyHold, reason: "ambiguous_response" | "settlement_failed" | "disconnect" | "timeout") {
  if (!hold.dispatched) return releaseGatewayBillingHold({ userId: hold.auth.userId, eventId: hold.billingEventId, reason: "pre_dispatch" });
  return markGatewayBillingHoldUnknown({ userId: hold.auth.userId, eventId: hold.billingEventId, reason });
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function succeeded(status: number, data: JsonObject, kind: HostedSupplyKind, requestedImages: number) {
  if (status < 200 || status >= 300 || data.error || data.status === "failed") return false;
  if (kind === "chat.completions") return Array.isArray(data.choices) && data.choices.length > 0;
  if (kind === "videos") return !!hostedVideoTaskId(data);
  return Array.isArray(data.data) && data.data.length > 0 && data.data.length <= requestedImages;
}

export async function settleHostedSupply(hold: HostedSupplyHold, response: { status: number; bytes: Uint8Array; contentType: string; rawResponseText?: string }): Promise<{ reject: boolean }> {
  let data: JsonObject | null = null;
  if (response.contentType.includes("json") || response.bytes.byteLength) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(response.bytes));
      data = object(parsed);
    } catch { data = null; }
  }
  const confirmedFailed = !!data && (response.status >= 400 || !!data.error || data.status === "failed");
  if (confirmedFailed) await refundGatewayBillingHold({ userId: hold.auth.userId, eventId: hold.billingEventId, reason: "confirmed_failed",
    evidenceFingerprint: gatewayOutcomeFingerprint({ status: response.status, data }) });
  const sharedSource = await isGatewaySharedBillingHold(hold.auth.userId, hold.billingEventId);
  // Financial proof uses original bytes only. Redacted/re-stringified JSON loses numeric lexemes.
  const exactCost = sharedSource && response.rawResponseText !== undefined ? parseExactSharedUpstreamCost(response.rawResponseText) : null;
  const rawCostBody = response.rawResponseText === undefined ? data : (() => { try { return object(JSON.parse(response.rawResponseText!)); } catch { return null; } })();
  const hasActualCost = !!rawCostBody && (Object.hasOwn(rawCostBody,"actual_cost") || !!object(rawCostBody.usage) && Object.hasOwn(object(rawCostBody.usage)!,"actual_cost"));
  if (sharedSource && hasActualCost && !exactCost) {
    await markHostedSupplyUnknown(hold, "ambiguous_response");
    return { reject: true };
  }
  if (sharedSource) {
    const durable = await getGatewayBillingHoldPricing(hold.auth.userId,hold.billingEventId);
    hold.billingSnapshot = durable.billingSnapshot;
    if (!exactCost && (durable.endpoint !== hold.kind || durable.model !== hold.model.id)) { await markHostedSupplyUnknown(hold,"ambiguous_response"); return {reject:true}; }
  }
  const requestedImages = sharedSource && hold.billingSnapshot.localPricing ? hold.billingSnapshot.localPricing.requestedCount : hold.kind.startsWith("images.") ? imageCount(hold.body) : 1;
  const ok = !!data && succeeded(response.status, data, hold.kind, requestedImages);
  // A parsed definitive error refunds the user's submission fee. Supplier
  // consumption is recorded independently; a timeout or unreadable reply is unknown.
  if (!ok && !(!!data && (response.status >= 400 || !!data.error || data.status === "failed"))) {
    await markHostedSupplyUnknown(hold, "ambiguous_response");
    return { reject: true };
  }
  const usage = data && object(data.usage) ? data.usage as JsonObject : {};
  const reportedFields = [
    typeof usage.prompt_tokens === "number" || typeof usage.input_tokens === "number" ? "prompt" : "",
    typeof usage.completion_tokens === "number" || typeof usage.output_tokens === "number" ? "completion" : "",
    typeof usage.total_tokens === "number" ? "total" : ""
  ].filter(Boolean);
  const promptTokens = positiveInteger(usage.prompt_tokens ?? usage.input_tokens, hold.kind === "chat.completions" ? textSizeTokens(hold.body) : 0);
  const completionTokens = positiveInteger(usage.completion_tokens ?? usage.output_tokens, 0);
  const totalTokens = positiveInteger(usage.total_tokens, promptTokens + completionTokens);
  const images = data && Array.isArray(data.data) ? data.data.length : requestedImages;
  const catalogCents = !ok ? 0 : hold.kind === "chat.completions" ? tokenCostCents(hold.model, promptTokens, completionTokens)
    : hold.kind === "videos" ? hold.model.videoCents! : imageCostCents(hold.model, images);
  const usd = data ? parseUpstreamUsdCost(data) : null;
  const frozenRate = hold.billingSnapshot.fxSnapshot?.rate ?? null;
  const exactQuote = sharedSource && exactCost && frozenRate != null ? quoteGatewayCharge({actualUsd:exactCost.usdCostLexical,fxRate:String(frozenRate),multiplierBps:hold.billingSnapshot.multiplierBps}) : null;
  if (sharedSource && exactCost && !exactQuote) { await markHostedSupplyUnknown(hold,"ambiguous_response"); return {reject:true}; }
  const settledCents = exactQuote?.baseCents ?? (!sharedSource && usd != null && frozenRate != null ? usdToCnyCents(usd, frozenRate) : null);
  let localChargeEvidence: GatewayLocalChargeEvidence | undefined;
  let localCents: number | undefined;
  if (sharedSource && !exactQuote && ok) {
    try {
      const pricing=validateGatewayLocalPricing(hold.billingSnapshot.localPricing);
      const reported = Number.isSafeInteger(usage.prompt_tokens ?? usage.input_tokens) && Number(usage.prompt_tokens ?? usage.input_tokens)>=0 && Number.isSafeInteger(usage.completion_tokens ?? usage.output_tokens) && Number(usage.completion_tokens ?? usage.output_tokens)>=0;
      if (hold.kind === "chat.completions" && (!reported || (usage.prompt_tokens !== undefined && usage.input_tokens !== undefined && usage.prompt_tokens !== usage.input_tokens) ||
        (usage.completion_tokens !== undefined && usage.output_tokens !== undefined && usage.completion_tokens !== usage.output_tokens) ||
        (usage.total_tokens !== undefined && (!Number.isSafeInteger(usage.total_tokens) || usage.total_tokens !== promptTokens+completionTokens)))) throw new Error("AMBIGUOUS_RETURNED_USAGE");
      if ([usage.prompt_tokens,usage.input_tokens,usage.completion_tokens,usage.output_tokens].some(value=>value !== undefined && (typeof value!=="number" || !Number.isSafeInteger(value) || value<0))) throw new Error("INVALID_RETURNED_USAGE");
      localChargeEvidence={schema:"SANJIE_LOCAL_CHARGE_V1",pricingHash:pricing.hash,outcomeHash:gatewayOutcomeFingerprint({status:response.status,data}),
        promptTokens:hold.kind === "chat.completions" ? promptTokens : 0,
        completionTokens:hold.kind === "chat.completions" ? completionTokens : 0,
        quantity:hold.kind.startsWith("images.") ? images : 1,tokenSource:reported ? "reported" : "estimated",success:true};
      localCents=localGatewayCharge(pricing,localChargeEvidence);
    } catch { await markHostedSupplyUnknown(hold,"ambiguous_response"); return {reject:true}; }
  }
  const baseCostCents = settledCents ?? localCents ?? catalogCents;
  const costSource = settledCents == null ? "catalog" : "upstream_usd";
  try {
    const usageInput: Parameters<typeof recordGatewayUsage>[0] = {
      auth: hold.auth, endpoint: hold.kind, provider: hold.model.provider, model: hold.model.id,
      requestId: hold.kind === "videos" ? hostedVideoTaskId(data) : data && typeof data.id === "string" ? data.id : "",
      ...(hold.kind === "chat.completions" || reportedFields.length ? { promptTokens, completionTokens, totalTokens } : {}),
      ...(hold.kind.startsWith("images.") ? { imageCount: images } : {}),
      baseCostCents, costCents: applyGatewayBillingCost(baseCostCents, hold.billingSnapshot),
      billingSnapshot: hold.billingSnapshot, billingEventId: hold.billingEventId,
      audit: { durationMs: Math.max(0, Date.now() - hold.startedAt), upstreamStatus: response.status, outcome: ok ? "success" : "upstream_error" },
      status: ok ? "ok" : "error", error: ok ? "" : `upstream_http_${response.status}`,
      metadata: {
        upstreamModel: hold.model.upstreamModel, baseUrl: hold.baseUrl, source: "hosted_supply", ...gatewayFxMetadata(hold.billingSnapshot.fxSnapshot),
        ...(hold.credentialId ? { credentialId: hold.credentialId } : {}),
        ...(hold.kind === "videos" ? { billing: "accepted_task" } : {}),
        reportedTokenFields: reportedFields.join(","),
        tokenSource: reportedFields.length === 3 ? "reported" : reportedFields.length ? "partial" : hold.kind === "chat.completions" ? "estimated" : "unreported",
        costSource, ...(localChargeEvidence ? {localChargeEvidence:{...localChargeEvidence}} : {}), ...(exactCost && exactQuote ? {usdCost:exactCost.usdCostLexical,usdCostLexical:exactCost.usdCostLexical,upstreamCostField:exactCost.upstreamCostField,usdCnyRate:String(frozenRate)}
          : settledCents == null || usd == null || frozenRate == null ? {} : { usdCost: formatUsd(usd), usdCnyRate: formatUsd(frozenRate) })
      }
    };
    await settleGatewayBillingHold({
      userId: hold.auth.userId, eventId: hold.billingEventId, finalCostCents: usageInput.costCents,
      outcomeFingerprint: gatewayOutcomeFingerprint({ status: response.status, data }),
      writeUsage: (tx, frozen) => recordGatewayUsage({ ...usageInput, billingSnapshot: frozen.billingSnapshot, billingEventId: frozen.eventId }, tx)
    });
  } catch (error) {
    if (error instanceof GatewayBillingError && error.code === "INSUFFICIENT_BALANCE") {
      throw new HostedSupplyError(error.message, 402);
    }
    throw new HostedSupplyError("本次供应调用未能完成扣积分，请稍后在积分流水核对", 503);
  }
  return { reject: response.status < 400 && !ok };
}
