/** Client-safe billing units. Wallet storage remains in integer RMB cents. */
export const GATEWAY_CENTS_PER_POINT = 10;
export const GATEWAY_DEFAULT_MULTIPLIER_BPS = 10_000;
export const GATEWAY_MIN_MULTIPLIER_BPS = 100;
export const GATEWAY_MAX_MULTIPLIER_BPS = 1_000_000;
export const GATEWAY_MAX_COST_CENTS = 2_147_483_647;

export type GatewayBillingSnapshot = {
  userId: string;
  tenantId: string;
  tenantName?: string;
  username: string;
  userName: string;
  planCode: string;
  planName: string;
  multiplierBps: number;
  ruleVersion: number;
  quotedAt: string;
};

export type GatewayBillingRuleView = {
  planCode: string;
  planName: string;
  multiplierBps: number;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type UpdateGatewayBillingRuleInput = {
  planCode: string;
  multiplierBps: number;
  reason: string;
  expectedVersion?: number;
};

export type GatewayBillingQuery = {
  tenantId?: string;
  userId?: string;
  planCode?: string;
  search?: string;
  page?: number;
  pageSize?: number;
};

export type GatewayBillingLedgerQuery = GatewayBillingQuery & {
  kind?: "opening" | "recharge" | "gift" | "debit" | "error";
  from?: string;
  to?: string;
  model?: string;
  endpoint?: string;
};

export type GatewayBillingAudit = {
  durationMs?: number;
  upstreamStatus?: number;
  outcome?: string;
};

export type GatewayBillingRuleAuditView = {
  id: string;
  planCode: string;
  planName: string;
  previousMultiplierBps: number;
  multiplierBps: number;
  previousVersion: number;
  version: number;
  updatedBy: string;
  updatedByUsername: string;
  updatedByName: string;
  reason: string;
  createdAt: string;
};

export type GatewayBillingAccountView = {
  userId: string;
  tenantId: string;
  tenantName: string;
  username: string;
  userName: string;
  status: string;
  planCode: string;
  planName: string;
  balanceCents: number;
  balancePoints: number;
  monthlyQuotaCents: number;
  monthlyQuotaPoints: number;
  multiplierBps: number;
  ruleVersion: number;
  periodStart: string;
  periodEnd: string;
  updatedAt: string;
};

export class GatewayBillingError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "GatewayBillingError";
  }
}

export function centsToPoints(cents: number) {
  return cents / GATEWAY_CENTS_PER_POINT;
}

export function applyGatewayBillingCost(baseCostCents: number, snapshot: Pick<GatewayBillingSnapshot, "multiplierBps">) {
  if (!Number.isSafeInteger(baseCostCents) || baseCostCents < 0 || baseCostCents > GATEWAY_MAX_COST_CENTS) {
    throw new GatewayBillingError("INVALID_BASE_COST", "基础扣费必须是有效的非负整数人民币分");
  }
  if (!Number.isSafeInteger(snapshot.multiplierBps) || snapshot.multiplierBps < GATEWAY_MIN_MULTIPLIER_BPS || snapshot.multiplierBps > GATEWAY_MAX_MULTIPLIER_BPS) {
    throw new GatewayBillingError("INVALID_MULTIPLIER", "扣费倍率必须在 0.01 至 100 之间，最多四位小数");
  }
  // BigInt guarantees upward cent rounding without floating-point drift.
  const charged = Number((BigInt(baseCostCents) * BigInt(snapshot.multiplierBps) + 9_999n) / 10_000n);
  if (charged > GATEWAY_MAX_COST_CENTS) throw new GatewayBillingError("COST_OVERFLOW", "扣费金额超过钱包存储上限");
  return charged;
}
