import { GatewayBillingError } from "./billing-contract";

export type CreditPoolOperation = "adoption" | "source_refresh";
export type CreditPoolPrepareInput = { operation: CreditPoolOperation; snapshotId: string; snapshotHash: string };
export type CreditPoolApplyInput = { proposalId: string; version: number; snapshotHash: string; requestKey: string };
export type CreditPoolBlocker = { code: string; message: string };
export type CreditPoolManagementOverview = {
  pool: { state: "uninitialized" | "pending" | "invalid" | "ready"; ready: boolean; balanceCents: number | null;
    accountingVersion?: 0 | 1;
    revision: number | null; capacityCents: string | null; allocatedCents: string | null; consumedCents: string | null; deficitCents: string | null };
  source: { state: "unconfigured" | "pending" | "stale" | "invalid" | "blocked" | "recorded" | "ready";
    snapshotId: string | null; snapshotHash: string | null; identityHash: string | null; groupId: string | null;
    nativeUnit: string | null; rawRemaining: string | null; observedAt: string | null; expiresAt: string | null;
    readAvailable: boolean; scope?: "shared_user_lifetime_wallet" | null; externalCommitmentsState?: "proven" | "unobservable" | null;
    costCoverage?: "actual_usd_required" | "local_catalog_or_actual_usd" | null;
    candidateSnapshot?: { snapshotId: string; snapshotHash: string } | null; blockers: CreditPoolBlocker[] };
  liabilities: { walletTotalCents: string; heldSubsetCents: string; awaitingAllocationCents: string; awaitingOrders: number };
  observedAt: string;
};
export type CreditPoolProposalView = {
  id: string; operation: CreditPoolOperation; version: number; snapshotId: string; snapshotHash: string;
  identityHash: string; conversionPolicyHash: string; walletStateHash: string;
  capacityCents: string; walletTotalCents: string; consumedCents: string; heldSubsetCents: string; allocatableCents: string;
  createdAt: string; expiresAt: string; state: "reviewable" | "applied" | "expired" | "stale" | "blocked";
  requiresServerRevalidation: true; blockers: CreditPoolBlocker[]; receipt: CreditPoolOperationReceipt | null;
};
export type CreditPoolOperationReceipt = { eventId: string; operation: CreditPoolOperation; proposalId: string;
  requestKey: string; createdAt: string; capacityCents: string; allocatedAfterCents: string; consumedAfterCents: string;
  allocatableAfterCents: string; deficitAfterCents: string };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function invalid(): never { throw new GatewayBillingError("POOL_INPUT_INVALID", "请提交有效的来源或方案引用，不能填写预算或验真字段", 400); }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) invalid();
  return value as Record<string, unknown>;
}
export function parseCreditPoolId(value: unknown): string { if (typeof value !== "string" || !ID.test(value)) invalid(); return value; }
export function parseCreditPoolOperation(value: unknown): CreditPoolOperation {
  if (value !== "adoption" && value !== "source_refresh") invalid(); return value;
}
export function parseCreditPoolRequestKey(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid(); return value.toLowerCase();
}
export function parseCreditPoolVerificationInput(value: unknown): { requestKey: string } {
  const row = exact(value, ["requestKey"]);
  return { requestKey: parseCreditPoolRequestKey(row.requestKey) };
}
export function parseCreditPoolPrepareInput(value: unknown): CreditPoolPrepareInput {
  const row = exact(value, ["operation", "snapshotId", "snapshotHash"]);
  if (typeof row.snapshotHash !== "string" || !HASH.test(row.snapshotHash)) invalid();
  return { operation: parseCreditPoolOperation(row.operation), snapshotId: parseCreditPoolId(row.snapshotId), snapshotHash: row.snapshotHash };
}
export function parseCreditPoolSourceReadInput(value: unknown): Record<string, never> { exact(value, []); return {}; }
export function parseCreditPoolApplyInput(value: unknown): CreditPoolApplyInput {
  const row = exact(value, ["proposalId", "version", "snapshotHash", "requestKey"]);
  if (!Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.snapshotHash !== "string" || !HASH.test(row.snapshotHash)) invalid();
  return { proposalId: parseCreditPoolId(row.proposalId), version: Number(row.version), snapshotHash: row.snapshotHash, requestKey: parseCreditPoolRequestKey(row.requestKey) };
}
/** Exact JSON representation: aggregated BigInt cents are decimal strings, never rounded numbers. */
export function accountingCents(value: bigint | number | string | null): string {
  if (value === null) return "0"; // An aggregate over an empty, actually read inventory is exactly zero.
  if (typeof value === "string") {
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new GatewayBillingError("CREDIT_POOL_INVALID", "总积分池或账本数额异常", 409);
    return value;
  }
  if ((typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) || value < 0) {
    throw new GatewayBillingError("CREDIT_POOL_INVALID", "总积分池或账本数额异常", 409);
  }
  return String(value);
}
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Accept only the display contract. An invalid response cannot enable a financial action. */
export function isCreditPoolManagementOverview(value: unknown): value is CreditPoolManagementOverview {
  if (!isObject(value) || !isObject(value.pool) || !isObject(value.source) || !isObject(value.liabilities)) return false;
  const { pool, source, liabilities } = value;
  if (pool.accountingVersion !== undefined && pool.accountingVersion !== 0 && pool.accountingVersion !== 1) return false;
  if (typeof pool.state !== "string" || !["uninitialized", "pending", "invalid", "ready"].includes(pool.state) || pool.ready !== (pool.state === "ready")) return false;
  if (pool.ready ? !Number.isSafeInteger(pool.balanceCents) || Number(pool.balanceCents) < 0 : pool.balanceCents !== null) return false;
  if (typeof source.state !== "string" || !["unconfigured", "pending", "stale", "invalid", "blocked", "recorded", "ready"].includes(source.state) || typeof source.readAvailable !== "boolean" || !Array.isArray(source.blockers)) return false;
  if (source.scope !== undefined && source.scope !== null && source.scope !== "shared_user_lifetime_wallet" || source.externalCommitmentsState !== undefined && source.externalCommitmentsState !== null && !["proven", "unobservable"].includes(source.externalCommitmentsState as string)) return false;
  if (source.costCoverage !== undefined && source.costCoverage !== null && (typeof source.costCoverage !== "string" || !["actual_usd_required", "local_catalog_or_actual_usd"].includes(source.costCoverage))) return false;
  if (source.costCoverage !== undefined && source.costCoverage !== null && source.scope !== "shared_user_lifetime_wallet") return false;
  if (source.candidateSnapshot !== undefined && source.candidateSnapshot !== null && (!isObject(source.candidateSnapshot) || typeof source.candidateSnapshot.snapshotId !== "string" || !ID.test(source.candidateSnapshot.snapshotId) || typeof source.candidateSnapshot.snapshotHash !== "string" || !HASH.test(source.candidateSnapshot.snapshotHash))) return false;
  if (source.state === "ready" && pool.ready !== true) return false;
  if (!source.blockers.every(item => isObject(item) && typeof item.code === "string" && typeof item.message === "string")) return false;
  for (const key of ["snapshotId", "snapshotHash", "identityHash", "groupId", "nativeUnit", "rawRemaining", "observedAt", "expiresAt"]) {
    if (source[key] !== null && typeof source[key] !== "string") return false;
  }
  for (const key of ["capacityCents", "allocatedCents", "consumedCents", "deficitCents"]) {
    if (pool[key] !== null && (typeof pool[key] !== "string" || !/^(0|[1-9]\d*)$/.test(pool[key]))) return false;
  }
  for (const key of ["walletTotalCents", "heldSubsetCents", "awaitingAllocationCents"]) {
    if (typeof liabilities[key] !== "string" || !/^(0|[1-9]\d*)$/.test(liabilities[key])) return false;
  }
  if (BigInt(liabilities.heldSubsetCents as string) > BigInt(liabilities.walletTotalCents as string)) return false;
  if (pool.ready) {
    if (source.scope === "shared_user_lifetime_wallet" && source.costCoverage === null) return false;
    if (pool.accountingVersion !== undefined && pool.accountingVersion !== 1) return false;
    if (source.state !== "ready" || !source.snapshotId || !source.snapshotHash || !source.identityHash || source.nativeUnit !== "USD" ||
      !HASH.test(source.snapshotHash as string) || !HASH.test(source.identityHash as string) ||
      [pool.capacityCents, pool.allocatedCents, pool.consumedCents, pool.deficitCents].some(item => item === null) || pool.deficitCents !== "0" ||
      Number(pool.balanceCents) > 2_147_483_647) return false;
    if (BigInt(pool.balanceCents as number) + BigInt(pool.allocatedCents as string) + BigInt(pool.consumedCents as string) !== BigInt(pool.capacityCents as string) ||
      pool.allocatedCents !== liabilities.walletTotalCents) return false;
  }
  return Number.isSafeInteger(liabilities.awaitingOrders) && Number(liabilities.awaitingOrders) >= 0 && typeof value.observedAt === "string";
}
export function isCreditPoolProposalView(value: unknown): value is CreditPoolProposalView {
  if (!isObject(value) || typeof value.id !== "string" || !ID.test(value.id) || !["adoption", "source_refresh"].includes(value.operation as string) ||
      !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.snapshotId !== "string" || !ID.test(value.snapshotId) ||
      value.requiresServerRevalidation !== true || !["reviewable", "applied", "expired", "stale", "blocked"].includes(value.state as string) || !Array.isArray(value.blockers)) return false;
  for (const key of ["snapshotHash", "identityHash", "conversionPolicyHash", "walletStateHash"]) if (typeof value[key] !== "string" || !HASH.test(value[key])) return false;
  for (const key of ["capacityCents", "walletTotalCents", "consumedCents", "heldSubsetCents", "allocatableCents"]) if (typeof value[key] !== "string" || !/^(0|[1-9]\d*)$/.test(value[key])) return false;
  if (BigInt(value.heldSubsetCents as string) > BigInt(value.walletTotalCents as string) || BigInt(value.walletTotalCents as string) + BigInt(value.consumedCents as string) + BigInt(value.allocatableCents as string) !== BigInt(value.capacityCents as string)) return false;
  return typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt));
}
export function isCreditPoolOperationReceipt(value: unknown): value is CreditPoolOperationReceipt {
  if (!isObject(value) || (value.operation !== "adoption" && value.operation !== "source_refresh") || typeof value.proposalId !== "string" || !ID.test(value.proposalId) ||
      typeof value.requestKey !== "string" || !UUID.test(value.requestKey) || value.requestKey !== value.requestKey.toLowerCase() ||
      value.eventId !== `${value.operation === "adoption" ? "adoption" : "source-refresh"}:${value.requestKey}` || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return false;
  return ["capacityCents", "allocatedAfterCents", "consumedAfterCents", "allocatableAfterCents", "deficitAfterCents"].every(key => typeof value[key] === "string" && /^(0|[1-9]\d*)$/.test(value[key]));
}
