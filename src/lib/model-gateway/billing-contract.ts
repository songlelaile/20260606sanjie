import type { GatewayLocalPricing } from "./local-pricing";
/** Client-safe billing units. Wallet storage remains in integer RMB cents. */
export const GATEWAY_CENTS_PER_POINT = 10;
export const GATEWAY_DEFAULT_MULTIPLIER_BPS = 10_000;
export const GATEWAY_MIN_MULTIPLIER_BPS = 100;
export const GATEWAY_MAX_MULTIPLIER_BPS = 1_000_000;
export const GATEWAY_MAX_COST_CENTS = 2_147_483_647;

export type GatewayFxSnapshot = {
  rate: number;
  source: "ecb" | "manual";
  referenceDate: string | null;
  fetchedAt: string | null;
  id: string | null;
};

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
  fxSnapshot?: GatewayFxSnapshot;
  localPricing?: GatewayLocalPricing;
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
  excludeSupplierUsage?: boolean;
  kind?: "opening" | "recharge" | "gift" | "debit" | "error" | "generation_charge" | "generation_refund" | "usage";
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

/** Historical snapshots are validated without applying live cache freshness rules. */
export function sanitizeGatewayFxSnapshot(value: unknown): GatewayFxSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayBillingError("INVALID_FX_SNAPSHOT", "汇率快照无效");
  const row = value as Record<string, unknown>;
  const rate = row.rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1000 ||
      Math.abs(rate * 1_000_000 - Math.round(rate * 1_000_000)) > 0.001) throw new GatewayBillingError("INVALID_FX_SNAPSHOT", "汇率快照数值无效");
  if (row.source === "manual") {
    if (row.referenceDate !== null || row.fetchedAt !== null || row.id !== null) throw new GatewayBillingError("INVALID_FX_SNAPSHOT", "手动汇率来源无效");
    return { rate, source: "manual", referenceDate: null, fetchedAt: null, id: null };
  }
  if (row.source !== "ecb" || typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(row.id) ||
      typeof row.referenceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.referenceDate) ||
      !Number.isFinite(Date.parse(row.referenceDate + "T00:00:00.000Z")) || new Date(row.referenceDate + "T00:00:00.000Z").toISOString().slice(0, 10) !== row.referenceDate ||
      typeof row.fetchedAt !== "string" || !Number.isFinite(Date.parse(row.fetchedAt)) || new Date(row.fetchedAt).toISOString() !== row.fetchedAt) {
    throw new GatewayBillingError("INVALID_FX_SNAPSHOT", "自动汇率来源快照无效");
  }
  return { rate, source: "ecb", referenceDate: row.referenceDate, fetchedAt: row.fetchedAt, id: row.id };
}
