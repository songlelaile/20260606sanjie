import { GatewayBillingError, GATEWAY_MAX_COST_CENTS } from "./billing-contract";
import { nativeTokenCost, type NativeVideoTariff } from "./native-video-contract";
import { contractHash } from "./source-quote.mjs";

export type NativeDispatchBinding = { jobId: string; provider: "volc" | "shaozhuang"; endpoint: string;
  keyFingerprint: string; bindingFingerprint: string; tariffHash: string; credentialId: string | null };
export type NativeChargeEvidence = { schema: "SANJIE_NATIVE_CHARGE_V1"; jobId: string; taskId: string;
  provider: "volc" | "shaozhuang"; endpoint: string; keyFingerprint: string; bindingFingerprint: string;
  tariffHash: string; priceVersion: string; completionTokens: number; outcomeHash: string; status?: "succeeded" | "failed" };
const HEX=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9_.:-]{1,200}$/;
const fail=():never=>{throw new GatewayBillingError("POOL_SOURCE_USAGE_UNPROVEN","原生视频冻结价格或原供应绑定需核对",409);};
export function validateNativeChargeEvidence(value: unknown): NativeChargeEvidence {
  if (!value || typeof value!=="object" || Array.isArray(value)) return fail();
  const v=value as NativeChargeEvidence;
  if (Object.keys(v).sort().join()!==["schema","jobId","taskId","provider","endpoint","keyFingerprint","bindingFingerprint","tariffHash","priceVersion","completionTokens","outcomeHash", ...(v.status === undefined ? [] : ["status"])].sort().join() ||
    (v.status !== undefined && !["succeeded","failed"].includes(v.status)) || v.schema!=="SANJIE_NATIVE_CHARGE_V1" || !ID.test(v.jobId) || !ID.test(v.taskId) || !ID.test(v.priceVersion) ||
    !["volc","shaozhuang"].includes(v.provider) || !Number.isSafeInteger(v.completionTokens) || v.completionTokens<0 || v.completionTokens>GATEWAY_MAX_COST_CENTS ||
    ![v.keyFingerprint,v.bindingFingerprint,v.tariffHash,v.outcomeHash].every(x=>typeof x==="string"&&HEX.test(x)) ||
    v.endpoint!==(v.provider==="volc" ? "https://ark.cn-beijing.volces.com" : "https://sub.shaozhuangai.com")+"/api/v3/contents/generations/tasks") return fail();
  return {...v};
}
export function nativeCoverageCost(tariff: unknown, evidence: NativeChargeEvidence) {
  validateNativeChargeEvidence(evidence);
  if (!tariff || typeof tariff!=="object" || Array.isArray(tariff)) return fail();
  const t=tariff as NativeVideoTariff;
  if (Object.keys(t).sort().join()!==["priceVersion","completionCentsPerMillion","reservationCents","mediaHosts"].sort().join() ||
    t.priceVersion!==evidence.priceVersion || !Number.isSafeInteger(t.reservationCents) || t.reservationCents<=0 ||
    !Array.isArray(t.mediaHosts) || t.mediaHosts.some(x=>typeof x!=="string") || contractHash(t)!==evidence.tariffHash) return fail();
  try {return nativeTokenCost(evidence.completionTokens,t);} catch {return fail();}
}
