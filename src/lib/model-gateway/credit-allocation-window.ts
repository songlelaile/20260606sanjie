import "server-only";
import { randomUUID } from "node:crypto";
import type { GatewayCreditPool, Prisma } from "@prisma/client";
import { GatewayBillingError, GATEWAY_MAX_COST_CENTS } from "./billing-contract";
import { contractHash } from "./source-quote.mjs";

type WindowRow = { id: string; poolId: string; sourceSnapshotId: string; observationHash: string; identityHash: string;
  policyHash: string; epochId: string; poolRevision: number; baselineCents: number; limitCents: number; createdAt: Date };
export type AllocationBudgetView = { state: "not_applicable" | "required" | "ready" | "changed";
  windowId: string | null; verifiedAt: string | null; baselineCents: number | null; limitCents: number | null;
  allocatedCents: number | null; remainingCents: number | null; ratioBps: 5000 };
const shared = (pool: GatewayCreditPool | null) => pool?.accountingVersion === 1 && pool.sourceScope === "shared_user_lifetime_wallet";
const empty = (state: AllocationBudgetView["state"]): AllocationBudgetView => ({ state, windowId: null, verifiedAt: null,
  baselineCents: null, limitCents: null, allocatedCents: null, remainingCents: null, ratioBps: 5000 });
function fail(code: string, message: string): never { throw new GatewayBillingError(code, message, 409); }

/** Called only after an explicit administrator verification/adoption has committed
 * its full inventory checks in this SAME transaction. Ordinary source refreshes
 * and read-only observations never enter this function. Pool lock is required. */
export async function openGatewayAllocationWindow(tx: Prisma.TransactionClient, pool: GatewayCreditPool) {
  if (!shared(pool)) return;
  if (pool.status !== "ready" || pool.deficitCents !== 0n || !pool.sourceSnapshotId || !pool.accountingEpochId ||
      !Number.isSafeInteger(pool.balanceCents) || pool.balanceCents < 0 || pool.balanceCents > GATEWAY_MAX_COST_CENTS) {
    fail("ALLOCATION_WINDOW_UNVERIFIED", "完整核验尚未通过，不能建立新的分配额度");
  }
  const snapshot = await tx.gatewayCreditSourceSnapshot.findUniqueOrThrow({ where: { id: pool.sourceSnapshotId } });
  if (snapshot.status !== "verified" || snapshot.expiresAt.getTime() <= Date.now() || !snapshot.conversionPolicyHash ||
      snapshot.accountingEpochId !== pool.accountingEpochId) fail("ALLOCATION_WINDOW_UNVERIFIED", "核验依据已失效，请重新核验分配额度");
  const source = (snapshot.proof as { source?: { evidenceHash?: unknown } }).source;
  if (typeof source?.evidenceHash !== "string" || !/^[a-f0-9]{64}$/.test(source.evidenceHash)) fail("ALLOCATION_WINDOW_UNVERIFIED", "来源观测缺少完整核验凭证");
  const observationHash = contractHash({ source: source.evidenceHash, identity: snapshot.identityHash,
    policy: snapshot.conversionPolicyHash, epoch: pool.accountingEpochId });
  const existing = await tx.$queryRaw<WindowRow[]>`SELECT * FROM "GatewayCreditAllocationWindow" WHERE "observationHash"=${observationHash}`;
  // Replaying the same verified source cannot replenish a partially spent window.
  if (existing.length) return existing[0];
  const rows = await tx.$queryRaw<WindowRow[]>`INSERT INTO "GatewayCreditAllocationWindow"
    ("id","poolId","sourceSnapshotId","observationHash","identityHash","policyHash","epochId","poolRevision","baselineCents","limitCents")
    VALUES (${randomUUID()},${pool.id},${snapshot.id},${observationHash},${snapshot.identityHash},${snapshot.conversionPolicyHash},${pool.accountingEpochId},
      ${pool.revision},${pool.balanceCents},${Math.floor(pool.balanceCents / 2)}) RETURNING *`;
  return rows[0];
}

export async function getGatewayVerificationReceipt(tx: Prisma.TransactionClient, adminId: string, requestKey?: string) {
  if (!requestKey) return null;
  const rows = await tx.$queryRaw<{ adminId: string; snapshotId: string; snapshotHash: string; baselineCents: number; capacityCents: bigint }[]>`
    SELECT r."adminId",w."sourceSnapshotId" AS "snapshotId",s."snapshotHash",w."baselineCents",s."capacityCents"
    FROM "GatewayCreditVerification" r JOIN "GatewayCreditAllocationWindow" w ON w."id"=r."windowId"
    JOIN "GatewayCreditSourceSnapshot" s ON s."id"=w."sourceSnapshotId" WHERE r."requestKey"=${requestKey}`;
  if (!rows[0]) return null;
  if (rows[0].adminId !== adminId) fail("POOL_REQUEST_CONFLICT", "此核验标识已被其他操作采用");
  const row = rows[0];
  return { ready: true, replayed: true, snapshotId: row.snapshotId, snapshotHash: row.snapshotHash,
    capacityCents: String(row.capacityCents), deficitCents: "0", allocatableCents: row.baselineCents };
}

export async function recordGatewayVerification(tx: Prisma.TransactionClient, adminId: string, requestKey: string | undefined, windowId: string) {
  if (requestKey) await tx.$executeRaw`INSERT INTO "GatewayCreditVerification" ("requestKey","adminId","windowId")
    VALUES (${requestKey},${adminId},${windowId})`;
}

/** Read-only. Positive allocations are summed from immutable events; spending or
 * refunds cannot reduce that sum. The financial caller still validates fresh source. */
export async function getGatewayAllocationBudget(tx: Prisma.TransactionClient, pool: GatewayCreditPool | null): Promise<AllocationBudgetView> {
  if (!shared(pool)) return empty("not_applicable");
  const rows = await tx.$queryRaw<WindowRow[]>`SELECT * FROM "GatewayCreditAllocationWindow" WHERE "poolId"=${pool!.id}
    ORDER BY "poolRevision" DESC LIMIT 1`;
  const window = rows[0];
  if (!window) return empty("required");
  const snapshot = pool!.sourceSnapshotId ? await tx.gatewayCreditSourceSnapshot.findUnique({ where: { id: pool!.sourceSnapshotId } }) : null;
  const totals = await tx.$queryRaw<{ allocated: bigint }[]>`SELECT COALESCE(SUM("amountCents"),0)::bigint AS allocated
    FROM "GatewayCreditAllocation" WHERE "windowId"=${window.id}`;
  const allocated = totals[0]?.allocated;
  if (allocated === undefined || allocated < 0n || allocated > BigInt(window.limitCents) || window.limitCents !== Math.floor(window.baselineCents / 2)) {
    fail("ALLOCATION_WINDOW_INVALID", "分配额度记录不一致，请核对账本");
  }
  const matches = snapshot?.identityHash === window.identityHash && snapshot.conversionPolicyHash === window.policyHash &&
    pool!.accountingEpochId === window.epochId;
  return { state: matches ? "ready" : "changed", windowId: window.id, verifiedAt: window.createdAt.toISOString(),
    baselineCents: window.baselineCents, limitCents: window.limitCents, allocatedCents: Number(allocated),
    remainingCents: window.limitCents - Number(allocated), ratioBps: 5000 };
}

/** Preflight for both gifts and already-paid recharge callbacks under pool lock. */
export async function assertGatewayAllocationBudget(tx: Prisma.TransactionClient, pool: GatewayCreditPool, amountCents: number) {
  const budget = await getGatewayAllocationBudget(tx, pool);
  if (budget.state === "not_applicable") return budget;
  if (budget.state !== "ready") fail("ALLOCATION_WINDOW_REQUIRED", "请先完整核验分配额度，建立本次 50% 分配上限");
  if (amountCents > budget.remainingCents!) fail("ALLOCATION_WINDOW_EXHAUSTED", "自上次成功核验后的累计新增分配将超过 50%，请重新核验额度");
  return budget;
}

export async function recordGatewayAllocation(tx: Prisma.TransactionClient, pool: GatewayCreditPool,
  input: { eventId: string; kind: "gift" | "recharge"; amountCents: number }) {
  const budget = await assertGatewayAllocationBudget(tx, pool, input.amountCents);
  if (budget.state === "not_applicable") return;
  await tx.$executeRaw`INSERT INTO "GatewayCreditAllocation" ("eventId","windowId","kind","amountCents")
    VALUES (${input.eventId},${budget.windowId},${input.kind},${input.amountCents})`;
}
