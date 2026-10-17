import { GatewayBillingError } from "./billing-contract";

const INTERNAL_CREDIT_CODES = /^(?:POOL_|CREDIT_POOL_|SHARED_SOURCE_|SHARED_EPOCH_|SOURCE_|FX_|HOLD_|BACKING_|LIABILIT(?:Y|IES)_|ACCOUNTED_|BILLING_RULES_|PRICING_|NATIVE_FUNDING_|WALLET_LEDGER_|CYCLE_LEDGER_|UPSTREAM_FROZEN_|BALANCE_SEMANTICS_|GROUP_PROOF_|CAPACITY_|ALLOCATION_|EVIDENCE_)/;

/** Public callers receive an actionable state; source/accounting diagnostics stay in the server. */
export function publicCreditServiceFailure(error: unknown) {
  if (!(error instanceof GatewayBillingError) ||
    !(INTERNAL_CREDIT_CODES.test(error.code) || ["INVALID_FX_SNAPSHOT", "INSUFFICIENT_POOL_BALANCE", "VIDEO_PRICE_MISSING"].includes(error.code))) return null;
  return {
    message: "生成服务暂时繁忙，请稍后重试。",
    status: 503,
    code: "CREDIT_SERVICE_UNAVAILABLE"
  } as const;
}
