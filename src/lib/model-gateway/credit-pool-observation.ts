import "server-only";
import { GatewayBillingError } from "./billing-contract";
import { getCreditPoolManagementOverview } from "./credit-pool-management-view";
import { isCreditPoolManagementOverview, type CreditPoolManagementOverview } from "./credit-pool-management-contract";
import { isCreditPoolWalletObservation, isRelaySupplyObservation, type CreditPoolObservation } from "./credit-pool-observation-contract";
import { readGatewaySharedWalletSource } from "./shared-wallet-source";
import { readRelayAdminSupplyObservation } from "./relay-admin-source";

const SAFE_CODES = new Set([
  "HOLD_PRICE_UNPROVEN", "CREDIT_POOL_INVALID", "CREDIT_POOL_NOT_READY", "POOL_SOURCE_UNVERIFIED", "POOL_SOURCE_EXPIRED", "BACKING_SHORTFALL",
  "SHARED_SOURCE_NOT_CONFIGURED", "SHARED_SOURCE_CONFIG_INVALID", "SHARED_SOURCE_CONFIG_UNAVAILABLE", "SHARED_SOURCE_PRIVATE_FILE_INVALID",
  "SHARED_SOURCE_KEY_UNAVAILABLE", "SHARED_SOURCE_KEY_INVALID", "SHARED_SOURCE_KEY_CHANGED", "SHARED_SOURCE_EPOCH_INVALID",
  "SOURCE_AUTH_REQUIRED", "SOURCE_ACCESS_DENIED", "SOURCE_RATE_LIMITED", "SOURCE_UNAVAILABLE", "SOURCE_RESPONSE_STATUS_INVALID",
  "SOURCE_CONTENT_TYPE_INVALID", "SOURCE_RESPONSE_TOO_LARGE", "SOURCE_RESPONSE_INVALID", "SOURCE_REDIRECT_REJECTED",
  "SOURCE_TIMEOUT", "SOURCE_TRANSPORT_FAILED", "SOURCE_JSON_INVALID", "SOURCE_JSON_DUPLICATE_KEY", "SOURCE_USD_INVALID",
  "SOURCE_WALLET_SCOPE_CHANGED", "SOURCE_BALANCE_INCONSISTENT", "FX_RATE_STALE", "FX_RATE_UNAVAILABLE", "WALLET_OBSERVATION_INVALID"
]);
function failureCode(error: unknown, fallback: string) {
  return error instanceof GatewayBillingError && SAFE_CODES.has(error.code) ? error.code : fallback;
}
function publicWallet(value: unknown): CreditPoolObservation["wallet"] {
  const source = value && typeof value === "object" && "source" in value && value.source && typeof value.source === "object"
    ? value.source as Record<string, unknown> : {};
  const wallet = { status: "ok", balanceUsd: source.balanceUsd, remainingUsd: source.remainingUsd, observedAt: source.capturedAt,
    unit: "USD", scope: "sub2api_internal_user_wallet", code: null };
  if (!isCreditPoolWalletObservation(wallet)) throw new GatewayBillingError("WALLET_OBSERVATION_INVALID", "余额观察格式无效", 503);
  return wallet;
}
/** Copy the existing read-only projection; never return unlisted private fields added by another source. */
function publicOverview(value: unknown): CreditPoolManagementOverview {
  if (!isCreditPoolManagementOverview(value)) throw new Error("Invalid ledger observation");
  const { pool: p, source: s, liabilities: l } = value;
  return {
    pool: { state: p.state, ready: p.ready, balanceCents: p.balanceCents, accountingVersion: p.accountingVersion,
      revision: p.revision, capacityCents: p.capacityCents, allocatedCents: p.allocatedCents, consumedCents: p.consumedCents, deficitCents: p.deficitCents },
    source: { state: s.state, snapshotId: s.snapshotId, snapshotHash: s.snapshotHash, identityHash: s.identityHash,
      groupId: s.groupId, nativeUnit: s.nativeUnit, rawRemaining: s.rawRemaining, observedAt: s.observedAt, expiresAt: s.expiresAt,
      readAvailable: s.readAvailable, scope: s.scope, externalCommitmentsState: s.externalCommitmentsState, costCoverage: s.costCoverage,
      candidateSnapshot: s.candidateSnapshot ? { snapshotId: s.candidateSnapshot.snapshotId, snapshotHash: s.candidateSnapshot.snapshotHash } : null,
      blockers: s.blockers.map(item => ({ code: item.code, message: item.message })) },
    liabilities: { walletTotalCents: l.walletTotalCents, heldSubsetCents: l.heldSubsetCents,
      awaitingAllocationCents: l.awaitingAllocationCents, awaitingOrders: l.awaitingOrders },
    observedAt: value.observedAt
  };
}

/** No source persistence, lazy wallet creation, baseline changes, gift or settlement actions. */
export async function observeCreditPool(): Promise<CreditPoolObservation> {
  const observedAt = new Date().toISOString();
  const [walletResult, ledgerResult, supplyResult] = await Promise.allSettled([
    Promise.resolve().then(() => readGatewaySharedWalletSource()).then(publicWallet),
    Promise.resolve().then(() => getCreditPoolManagementOverview()).then(publicOverview),
    Promise.resolve().then(() => readRelayAdminSupplyObservation())
  ]);
  const wallet: CreditPoolObservation["wallet"] = walletResult.status === "fulfilled" ? walletResult.value
    : { status: "unavailable", balanceUsd: null, remainingUsd: null, observedAt: null, unit: "USD",
    scope: "sub2api_internal_user_wallet", code: failureCode(walletResult.reason, "WALLET_OBSERVATION_UNAVAILABLE") };
  const ledger: CreditPoolObservation["ledger"] = ledgerResult.status === "fulfilled"
    ? { status: "ok", overview: ledgerResult.value, code: null }
    : { status: "unavailable", overview: null, code: failureCode(ledgerResult.reason, "LEDGER_OBSERVATION_UNAVAILABLE") };
  const supply: CreditPoolObservation["supply"] = supplyResult.status === "fulfilled" && isRelaySupplyObservation(supplyResult.value)
    ? supplyResult.value : { status: "unavailable", observedAt: null, groups: [], code: "RELAY_OBSERVATION_UNAVAILABLE", referenceOnly: true };
  return { observedAt, readOnly: true, wallet, ledger, supply };
}
