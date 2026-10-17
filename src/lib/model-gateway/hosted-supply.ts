import "server-only";
import { randomUUID } from "node:crypto";
import type { GatewayModel } from "@/lib/model-gateway/catalog";
import { getGatewayBillingSnapshot } from "@/lib/model-gateway/billing";
import { applyGatewayBillingCost, GatewayBillingError, type GatewayBillingSnapshot } from "@/lib/model-gateway/billing-contract";
import { findAvailableGatewayModel } from "@/lib/model-gateway/runtime-catalog";
import { formatUsd, parseUpstreamUsdCost, usdToCnyCents } from "@/lib/model-gateway/relay-routing";
import { assertGatewayBalance, recordGatewayUsage, type GatewayAuth } from "@/lib/model-gateway/store";

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
  usdCnyRate: number | null;
  credentialId?: string;
  baseUrl?: string;
};

type JsonObject = Record<string, unknown>;

export function hostedSupplyKind(urlString: string, method: string): HostedSupplyKind | null {
  let url: URL;
  try { url = new URL(urlString); } catch { return null; }
  if (url.hostname.toLowerCase() !== HOSTED_SUPPLY_HOST || method.toUpperCase() !== "POST") return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) return "chat.completions";
  if (path.endsWith("/images/generations")) return "images.generations";
  if (path.endsWith("/images/edits")) return "images.edits";
  if (path.endsWith("/videos")) return "videos";
  return null;
}

function object(value: unknown): JsonObject | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

export function readHostedSupplyRequest(input: { bodyText?: string; form?: FormData }): { modelName: string; body: JsonObject } {
  if (input.form) {
    const model = input.form.get("model");
    const modelName = typeof model === "string" ? model.trim().slice(0, 160) : "";
    const body: JsonObject = {};
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
}): Promise<HostedSupplyHold> {
  const lookup = input.kind === "images.edits" ? "images.generations" : input.kind;
  const model = await findAvailableGatewayModel(input.modelName, lookup);
  if (!model || model.provider !== "shaozhuang") throw new HostedSupplyError(`模型未开通：${input.modelName.slice(0, 160)}`, 404);
  const baseMinimum = minimumCents(model, input.kind, input.body);
  const billingSnapshot = await getGatewayBillingSnapshot(input.user.id);
  if (billingSnapshot.userId !== input.user.id) throw new HostedSupplyError("积分账户与当前登录不一致", 401);
  const minimum = applyGatewayBillingCost(baseMinimum, billingSnapshot);
  const hold: HostedSupplyHold = {
    auth: supplyAuth(input.user), model, kind: input.kind, body: input.body, billingSnapshot,
    billingEventId: randomUUID(), startedAt: Date.now(), usdCnyRate: input.usdCnyRate
  };
  if (!await assertGatewayBalance(input.user.id, minimum)) {
    await recordGatewayUsage({
      auth: hold.auth, endpoint: input.kind, provider: model.provider, model: model.id,
      costCents: 0, baseCostCents: baseMinimum, billingSnapshot, billingEventId: hold.billingEventId,
      ...(input.kind === "chat.completions" ? { promptTokens: textSizeTokens(input.body), completionTokens: 0, totalTokens: textSizeTokens(input.body) } : {}),
      status: "error", error: "INSUFFICIENT_BALANCE",
      audit: { durationMs: 0, outcome: "balance_rejected" },
      metadata: { upstreamModel: model.upstreamModel, source: "hosted_supply", tokenSource: input.kind === "chat.completions" ? "estimated" : "unreported", costSource: "catalog" }
    });
    throw new HostedSupplyError("余额不足，请先购买模型额度", 402);
  }
  return hold;
}

function positiveInteger(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function succeeded(status: number, data: JsonObject, kind: HostedSupplyKind, requestedImages: number) {
  if (status < 200 || status >= 300 || data.error || data.status === "failed") return false;
  if (kind === "chat.completions") return Array.isArray(data.choices) && data.choices.length > 0;
  if (kind === "videos") return typeof data.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(data.id);
  return Array.isArray(data.data) && data.data.length > 0 && data.data.length <= requestedImages;
}

export async function settleHostedSupply(hold: HostedSupplyHold, response: { status: number; bytes: Uint8Array; contentType: string }): Promise<{ reject: boolean }> {
  let data: JsonObject | null = null;
  if (response.contentType.includes("json") || response.bytes.byteLength) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(response.bytes));
      data = object(parsed);
    } catch { data = null; }
  }
  const requestedImages = hold.kind.startsWith("images.") ? imageCount(hold.body) : 1;
  const ok = !!data && succeeded(response.status, data, hold.kind, requestedImages);
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
  const usd = ok && data ? parseUpstreamUsdCost(data) : null;
  const settledCents = usd != null && hold.usdCnyRate != null ? usdToCnyCents(usd, hold.usdCnyRate) : null;
  const baseCostCents = settledCents ?? catalogCents;
  const costSource = settledCents == null ? "catalog" : "upstream_usd";
  try {
    await recordGatewayUsage({
      auth: hold.auth, endpoint: hold.kind, provider: hold.model.provider, model: hold.model.id,
      requestId: data && typeof data.id === "string" ? data.id : "",
      ...(hold.kind === "chat.completions" || reportedFields.length ? { promptTokens, completionTokens, totalTokens } : {}),
      ...(hold.kind.startsWith("images.") ? { imageCount: images } : {}),
      baseCostCents, costCents: applyGatewayBillingCost(baseCostCents, hold.billingSnapshot),
      billingSnapshot: hold.billingSnapshot, billingEventId: hold.billingEventId,
      audit: { durationMs: Math.max(0, Date.now() - hold.startedAt), upstreamStatus: response.status, outcome: ok ? "success" : "upstream_error" },
      status: ok ? "ok" : "error", error: ok ? "" : `upstream_http_${response.status}`,
      metadata: {
        upstreamModel: hold.model.upstreamModel, source: "hosted_supply",
        ...(hold.credentialId ? { credentialId: hold.credentialId } : {}),
        ...(hold.baseUrl ? { baseUrl: hold.baseUrl } : {}),
        reportedTokenFields: reportedFields.join(","),
        tokenSource: reportedFields.length === 3 ? "reported" : reportedFields.length ? "partial" : hold.kind === "chat.completions" ? "estimated" : "unreported",
        costSource, ...(settledCents == null || usd == null || hold.usdCnyRate == null ? {} : { usdCost: formatUsd(usd), usdCnyRate: formatUsd(hold.usdCnyRate) })
      }
    });
  } catch (error) {
    if (error instanceof GatewayBillingError && error.code === "INSUFFICIENT_BALANCE") {
      throw new HostedSupplyError(error.message, 402);
    }
    throw new HostedSupplyError("本次供应调用未能完成扣积分，请稍后在积分流水核对", 503);
  }
  return { reject: response.status < 400 && !ok };
}
