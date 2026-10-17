import { createHash } from "node:crypto";
import type { GatewayModel } from "./catalog";
import { GatewayBillingError, GATEWAY_MAX_COST_CENTS } from "./billing-contract";

export type GatewayLocalPricing = {
  schema: "SANJIE_LOCAL_PRICING_V1"; version: 1; model: string; endpoint: string;
  promptCentsPer1K: number; completionCentsPer1K: number; imageCents: number; videoCents: number;
  requestedCount: number; maxOutputTokens: number; inputTokensEstimate: number;
  rounding: "ceil_per_component_min_one"; hash: string;
};
export type GatewayLocalChargeEvidence = {
  schema: "SANJIE_LOCAL_CHARGE_V1"; pricingHash: string; outcomeHash: string;
  promptTokens: number; completionTokens: number; quantity: number;
  tokenSource: "reported" | "estimated"; success: true;
};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])) : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const fail = (): never => { throw new GatewayBillingError("POOL_SOURCE_USAGE_UNPROVEN", "本地冻结计价或成功结果需核对", 409); };
const whole = (value: unknown, max = 1_000_000_000): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
export function validateGatewayLocalPricing(value: unknown): GatewayLocalPricing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as GatewayLocalPricing;
  const { hash: digest, ...base } = v;
  if (Object.keys(v).sort().join() !== ["schema","version","model","endpoint","promptCentsPer1K","completionCentsPer1K","imageCents","videoCents","requestedCount","maxOutputTokens","inputTokensEstimate","rounding","hash"].sort().join() ||
    v.schema !== "SANJIE_LOCAL_PRICING_V1" || v.version !== 1 || v.rounding !== "ceil_per_component_min_one" ||
    !["chat.completions", "images.generations", "images.edits", "videos"].includes(v.endpoint) || typeof v.model !== "string" || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(v.model) ||
    ![v.promptCentsPer1K,v.completionCentsPer1K,v.imageCents,v.videoCents].every(x => Number.isFinite(x) && x >= 0 && x <= GATEWAY_MAX_COST_CENTS) ||
    !whole(v.requestedCount,10) || v.requestedCount < 1 || !whole(v.maxOutputTokens,1_000_000) || !whole(v.inputTokensEstimate) ||
    !/^[a-f0-9]{64}$/.test(digest) || hash(base) !== digest) return fail();
  return v;
}
export function freezeGatewayLocalPricing(model: GatewayModel, endpoint: string, body: Record<string, unknown>): GatewayLocalPricing {
  const base: Omit<GatewayLocalPricing,"hash"> = {
    schema:"SANJIE_LOCAL_PRICING_V1",version:1,model:model.id,endpoint,
    promptCentsPer1K:model.promptCentsPer1K ?? 1,completionCentsPer1K:model.completionCentsPer1K ?? 2,
    imageCents:model.imageCents ?? 50,videoCents:model.videoCents ?? 0,
    requestedCount:endpoint.startsWith("images.") ? Number(body.n ?? 1) : 1,
    maxOutputTokens:endpoint === "chat.completions" ? Number(body.max_completion_tokens ?? body.max_tokens) : 0,
    inputTokensEstimate:Math.max(1,Math.ceil(Buffer.byteLength(JSON.stringify({messages:body.messages,tools:body.tools,functions:body.functions,response_format:body.response_format}),"utf8") / 4)),
    rounding:"ceil_per_component_min_one"
  };
  return validateGatewayLocalPricing({...base,hash:hash(base)});
}
export function validateGatewayLocalChargeEvidence(value: unknown): GatewayLocalChargeEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v=value as GatewayLocalChargeEvidence;
  if (Object.keys(v).sort().join() !== ["schema","pricingHash","outcomeHash","promptTokens","completionTokens","quantity","tokenSource","success"].sort().join() ||
    v.schema!=="SANJIE_LOCAL_CHARGE_V1" || v.success!==true || !/^[a-f0-9]{64}$/.test(v.pricingHash) || !/^[a-f0-9]{64}$/.test(v.outcomeHash) ||
    !whole(v.promptTokens) || !whole(v.completionTokens) || !whole(v.quantity,10) || !["reported","estimated"].includes(v.tokenSource)) return fail();
  return {...v};
}
export function localGatewayCharge(pricing: GatewayLocalPricing, evidence: GatewayLocalChargeEvidence) {
  validateGatewayLocalPricing(pricing);validateGatewayLocalChargeEvidence(evidence);
  if (evidence.pricingHash!==pricing.hash) return fail();
  let cents:number;
  if (pricing.endpoint==="chat.completions") {
    if (evidence.quantity!==1 || evidence.tokenSource!=="reported" || evidence.completionTokens>pricing.maxOutputTokens) return fail();
    cents=Math.max(1,Math.ceil(evidence.promptTokens/1000*pricing.promptCentsPer1K)+Math.ceil(evidence.completionTokens/1000*pricing.completionCentsPer1K));
  } else if (pricing.endpoint==="videos") {
    if (evidence.quantity!==1 || pricing.videoCents<=0) return fail();cents=pricing.videoCents;
  } else {
    if (evidence.quantity<1 || evidence.quantity>pricing.requestedCount) return fail();cents=Math.max(1,Math.ceil(evidence.quantity*pricing.imageCents));
  }
  if (!whole(cents,GATEWAY_MAX_COST_CENTS) || cents<1) return fail();return cents;
}
