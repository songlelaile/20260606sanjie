export const USD_SCALE: bigint;
export const FX_SCALE: bigint;
export const BPS_SCALE: bigint;
export const MAX_CENTS: bigint;
export class SourceQuoteError extends Error { code: string; constructor(code: string, message: string); }
export function parseFixed(value: string, decimals: number): bigint;
export function formatFixed(value: bigint, decimals: number): string;
export function contractHash(value: unknown): string;
export type BillingRule = { planCode: string; version: number; multiplierBps: number };
export function billingRulesHash(rules: BillingRule[], fallbackMultiplierBps: number): string;
export function quoteGatewayCharge(input: { actualUsd: string; fxRate: string; multiplierBps: number }): {
  actualUsd: string; baseCents: number; chargedCents: number; chargedPoints: string;
};
export type SourceQuoteInput = {
  now: string;
  expected: {
    configVersion: string; upstreamIdentityHash: string; issuerUserId: string; groupId: string;
    capacityPolicy: 'independent_usd' | 'balance_only_proven'; capacityPolicyEvidenceHash: string;
    billingRulesHash: string; pricingEnvelopeEvidenceHash: string; fxSnapshotHash: string; fxSource: 'ecb' | 'manual';
    cycleId: string; cycleStartedAt: string; cycleEndsAt: string; poolVersion: number;
    maxSourceAgeMs: number; maxFxAgeMs: number; reserveBps: number;
  };
  source: {
    configVersion: string; upstreamIdentityHash: string; cycleId: string; capturedAt: string; evidenceHash: string;
    issuer: {
      userId: string; status: 'active'; dedicated: true; scopeEvidenceHash: string;
      balanceUnit: 'USD'; balanceMeaning: 'remaining_total'; balanceUsd: string; upstreamFrozenUsd: string;
      externalCommittedUsd: string; commitmentEvidenceHash: string; cycleAccountedUsd: string; accountedEvidenceHash: string;
    };
    group: { id: string; issuerUserId: string; status: 'active'; billingType: 'standard_balance'; issuerAccess: 'proven'; costBasis: 'actual_cost'; evidenceHash: string; effectiveRateEvidenceHash: string };
    capacity: {
      kind: 'balance_only_proven'; constraintInventoryComplete: true; noIndependentCapacityConstraint: true; policyEvidenceHash: string;
    } | {
      kind: 'bounded_usd'; budgetBasis: 'remaining_plus_local_accounted_current_cycle'; policyEvidenceHash: string;
      platformReservedAccountId: string;
      accounts: { id: string; capacityScopeId: string; groupId: string; status: 'active'; unit: 'USD'; bounded: true;
        cycleId: string; validFrom: string; validUntil: string; budgetUsd: string; evidenceHash: string }[];
    };
  };
  pricing: {
    fx: { rate: string; source: 'ecb' | 'manual'; quoteId: string | null; fetchedAt: string | null; referenceDate: string | null };
    rules: BillingRule[]; rulesComplete: true; fallbackMultiplierBps: number;
    costCoverage: 'actual_usd_required' | 'catalog_lower_bound_proven'; envelopeEvidenceHash: string;
  };
  liabilities: {
    capturedAt: string; evidenceHash: string; complete: true; consistent: true; poolVersion: number; cycleId: string;
    cycleAccountedUsd: string; accountedEvidenceHash: string; consumedCents: number;
    wallets: { userId: string; balanceCents: number; ledgerBalanceCents: number }[];
    holds: { eventId: string; userId: string; status: 'reserved' | 'dispatched' | 'unknown'; heldCents: number; fxRate: string; multiplierBps: number }[];
    pendingReservations: { orderId: string; status: 'reserved'; amountCents: number }[];
  };
};
export type BlockedReason = { code: string; path: string; message: string };
export type SourceQuote = {
  version: 1; configVersion: string; poolVersion: number; cycleId: string; cycleStartedAt: string; cycleEndsAt: string;
  sourceEvidenceHash: string; liabilityEvidenceHash: string; upstreamIdentityHash: string; issuerUserId: string; groupId: string;
  capturedAt: string; sourceExpiresAt: string; proposalExpiresAt: string; quoteHash: string;
  pricing: { fxRate: string; fxSource: 'ecb' | 'manual'; fxQuoteId: string | null; billingRulesHash: string;
    minimumMultiplierBps: number; valuationProduct: string; reserveBps: number; envelopeEvidenceHash: string };
  usd: { issuerBalanceUsd: string; cycleAccountedUsd: string; externalCommittedUsd: string; issuerBudgetUsd: string;
    groupCapacityUsd: string | null; effectiveBudgetUsd: string; capacityPolicy: 'independent_usd' | 'balance_only_proven' };
  points: { totalCents: number; availableCents: number; walletCents: number; pendingCents: number; consumedCents: number; heldCents: number; availablePoints: string };
};
export function evaluateGatewayPoolSource(input: unknown):
  | { ready: false; blockedReasons: BlockedReason[] }
  | { ready: true; blockedReasons: []; quote: SourceQuote };
