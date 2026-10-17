import "server-only";
import { Prisma, type GatewayCreditPoolLedger } from "@prisma/client";
import { prisma } from "@/lib/db";
import { GatewayBillingError, GATEWAY_MAX_COST_CENTS } from "./billing-contract";
import { assertGatewayPoolReady } from "./credit-pool-accounting";
import { readGatewaySharedWalletSourceConfiguration } from "./shared-wallet-source";
import { contractHash } from "./source-quote.mjs";
import { evaluateSharedWalletSource } from "./shared-wallet-quote.mjs";
import { accountingCents, parseCreditPoolId, parseCreditPoolOperation, parseCreditPoolRequestKey,
  type CreditPoolBlocker, type CreditPoolManagementOverview, type CreditPoolOperation,
  type CreditPoolOperationReceipt, type CreditPoolProposalView } from "./credit-pool-management-contract";
const HASH = /^[a-f0-9]{64}$/;
const sourceMissing: CreditPoolBlocker = { code: "SOURCE_READ_NOT_CONNECTED", message: "未接通上游少壮专属分组额度读取" };
const conversionMissing: CreditPoolBlocker = { code: "SOURCE_CONVERSION_UNPROVEN", message: "原生额度与本站积分尚未核对" };
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown, max = 128): string | null { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null; }
const digest = (value: unknown) => typeof value === "string" && HASH.test(value) ? value : null;
async function readOnly<T>(read: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => { await tx.$executeRaw`SET TRANSACTION READ ONLY`; return read(tx); }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
/** Only persisted, allowlisted source facts. No provider call, source insertion or lazy pool/wallet. */
export async function getCreditPoolManagementOverview(): Promise<CreditPoolManagementOverview> {
  let configured: Awaited<ReturnType<typeof readGatewaySharedWalletSourceConfiguration>> | null = null;
  let connectionBlocker: CreditPoolBlocker | null = null;
  try { configured = await readGatewaySharedWalletSourceConfiguration(); }
  catch (error) {
    if (!(error instanceof GatewayBillingError)) throw error;
    connectionBlocker = { code: error.code, message: error.code === "SHARED_SOURCE_NOT_CONFIGURED" ? "共用钱包上游余额读取尚未配置" : "共用钱包来源连接配置暂时不可用，请核对后重试" };
  }
  const configuredIdentity = configured ? contractHash({ origin: configured.origin, credentialFingerprint: configured.credentialFingerprint,
    ownerSubject: configured.ownerSubject, routeGroupBinding: configured.routeGroupBinding, approvalEvidenceHash: configured.approvalEvidenceHash,
    approvedExposure: configured.approvedExposure, approvedCredentialFingerprints: configured.approvedCredentialFingerprints ?? [] }) : null;
  return readOnly(async tx => {
    const pool = await tx.gatewayCreditPool.findUnique({ where: { id: "total" } });
    const sourceFields = { id: true, snapshotHash: true, identityHash: true, nativeUnit: true, status: true, proof: true, observedAt: true, expiresAt: true } as const;
    // The active pool and its source must be shown together. Another identity
    // may have a newer observational record without changing this pool backing.
    const latestShared = configuredIdentity ? await tx.gatewayCreditSourceSnapshot.findFirst({ where: { identityHash: configuredIdentity }, orderBy: [{ observedAt: "desc" }, { id: "desc" }], select: sourceFields }) : null;
    const source = pool?.sourceSnapshotId
      ? await tx.gatewayCreditSourceSnapshot.findUnique({ where: { id: pool.sourceSnapshotId }, select: sourceFields })
      : configuredIdentity ? latestShared : await tx.gatewayCreditSourceSnapshot.findFirst({ orderBy: [{ observedAt: "desc" }, { id: "desc" }], select: sourceFields });
    // SQL sums remain exact decimal strings even beyond JS safe-integer range.
    const sums = await tx.$queryRaw<{ walletTotalCents: string; heldSubsetCents: string; awaitingAllocationCents: string; awaitingOrders: string }[]>`
      SELECT (SELECT COALESCE(SUM("balanceCents"),0)::text FROM "GatewayWallet") AS "walletTotalCents",
       (SELECT COALESCE(SUM("heldCents"),0)::text FROM "GatewayBillingHold" WHERE "status" IN ('reserved','dispatched','unknown')) AS "heldSubsetCents",
       (SELECT COALESCE(SUM("creditCents"),0)::text FROM "GatewayOrder" WHERE "creditAllocationState"='awaiting_capacity') AS "awaitingAllocationCents",
       (SELECT COUNT(*)::text FROM "GatewayOrder" WHERE "creditAllocationState"='awaiting_capacity') AS "awaitingOrders"`;
    if (sums.length !== 1) throw new Error("Missing accounting inventory");
    const wallet = accountingCents(sums[0].walletTotalCents), held = accountingCents(sums[0].heldSubsetCents);
    const awaiting = accountingCents(sums[0].awaitingAllocationCents), count = accountingCents(sums[0].awaitingOrders);
    if (BigInt(held) > BigInt(wallet) || BigInt(count) > BigInt(Number.MAX_SAFE_INTEGER)) throw new GatewayBillingError("CREDIT_POOL_INVALID", "会计清单异常", 409);
    let poolState: CreditPoolManagementOverview["pool"]["state"] = !pool ? "uninitialized" : "pending";
    let guardBlocker: CreditPoolBlocker | null = null;
    if (pool) {
      if (!Number.isSafeInteger(pool.balanceCents) || pool.balanceCents < 0 || pool.balanceCents > GATEWAY_MAX_COST_CENTS || !["pending", "ready", "blocked"].includes(pool.status)) poolState = "invalid";
      else if (pool.status === "blocked") guardBlocker = { code: pool.deficitCents > 0n ? "BACKING_SHORTFALL" : "SOURCE_READ_REQUIRED", message: pool.deficitCents > 0n ? "上游余额出现覆盖缺口，新的分配已停止；用户余额与冻结保持不变" : "当前来源读取尚未完成核验，暂时不能分配积分" };
      else if (pool.status === "ready") {
        try { await assertGatewayPoolReady(tx, pool); poolState = "ready"; }
        catch (error) { if (!(error instanceof GatewayBillingError)) throw error;
          poolState = error.code === "CREDIT_POOL_INVALID" ? "invalid" : "pending";
          guardBlocker = { code: error.code, message: "现有来源或积分账本需重新核对，当前不能分配积分" };
        }
      }
    }
    if (poolState === "ready" && pool && pool.allocatedCents !== BigInt(wallet)) {
      poolState = "invalid"; guardBlocker = { code: "CREDIT_POOL_INVALID", message: "总池已分配积分与实际钱包合计不一致，请核对账本" };
    }
    const expected = record(record(source?.proof).expected);
    const issuer = record(record(record(source?.proof).source).issuer);
    const shared = record(source?.proof).scope === "shared_user_lifetime_wallet";
    const sharedPolicy = record(record(source?.proof).policy);
    const sharedBinding = record(record(source?.proof).binding);
    const coverage = record(record(source?.proof).pricing).costCoverage;
    const costCoverage: CreditPoolManagementOverview["source"]["costCoverage"] = shared && (coverage === "actual_usd_required" || coverage === "local_catalog_or_actual_usd") ? coverage : null;
    if (shared && source?.status === "verified" && !costCoverage && poolState === "ready") poolState = "invalid";
    let sourceState: CreditPoolManagementOverview["source"]["state"] = !source ? "unconfigured" : "recorded";
    const blockers: CreditPoolBlocker[] = [];
    if (!source) {
      if (connectionBlocker && connectionBlocker.code !== "SHARED_SOURCE_NOT_CONFIGURED") { sourceState = "invalid"; blockers.push(connectionBlocker); }
      else blockers.push(...(configured ? [{ code: "SOURCE_READ_REQUIRED", message: "服务端已配置共用钱包来源，请读取上游余额后审阅采用" }] : [sourceMissing, conversionMissing]));
    }
    else if (!digest(source.snapshotHash) || !digest(source.identityHash) || !["pending", "verified"].includes(source.status)) {
      sourceState = "invalid"; blockers.push({ code: "POOL_SOURCE_UNVERIFIED", message: "来源记录无法核验" });
    } else if (shared && source.status === "verified" && !costCoverage) {
      sourceState = "invalid"; blockers.push({ code: "SHARED_PRICING_UNPROVEN", message: "本站消费计价依据尚未核验" });
    } else if (source.expiresAt.getTime() <= Date.now()) {
      sourceState = "stale"; blockers.push({ code: "POOL_SOURCE_EXPIRED", message: "已保存的上游额度记录已过期" });
    } else if (source.status !== "verified") {
      sourceState = "pending"; blockers.push(conversionMissing);
    } else if (source.nativeUnit !== "USD" || (shared ? !configured || sharedPolicy.configVersion !== contractHash({ ...configured, privateKeyRef: undefined }) : !digest(process.env.GATEWAY_CREDIT_SOURCE_CONFIG_HASH))) {
      sourceState = "blocked"; blockers.push(conversionMissing);
    } else if (poolState === "ready" && pool?.sourceSnapshotId === source.id) sourceState = "ready";
    else blockers.push({ code: "POOL_SOURCE_REVIEW_REQUIRED", message: "来源记录尚需结合当前账本完成核对" });
    if (guardBlocker) blockers.push(guardBlocker);
    if (connectionBlocker && shared) blockers.push(connectionBlocker);
    const remaining = shared ? record(record(source?.proof).source).balanceUsd : issuer.balanceUsd;
    const rawRemaining = source?.nativeUnit === "USD" && typeof remaining === "string" && /^(0|[1-9]\d*)(\.\d+)?$/.test(remaining) ? remaining : null;
    const candidateSnapshot = latestShared && latestShared.status === "verified" && latestShared.expiresAt.getTime() > Date.now() && digest(latestShared.snapshotHash) &&
      record(record(latestShared.proof).policy).configVersion === contractHash({ ...configured, privateKeyRef: undefined }) &&
      evaluateSharedWalletSource({ ...record(latestShared.proof), now: new Date().toISOString() }).ready
      ? { snapshotId: latestShared.id, snapshotHash: latestShared.snapshotHash } : null;
    return {
      pool: { state: poolState, ready: poolState === "ready", balanceCents: poolState === "ready" ? pool!.balanceCents : null,
        accountingVersion: (pool?.accountingVersion ?? 0) as 0 | 1, revision: pool?.revision ?? null, capacityCents: pool ? accountingCents(pool.capacityCents) : null,
        allocatedCents: pool ? accountingCents(pool.allocatedCents) : null, consumedCents: pool ? accountingCents(pool.consumedCents) : null,
        deficitCents: pool ? accountingCents(pool.deficitCents) : null },
      source: { state: sourceState, snapshotId: source?.id ?? null, snapshotHash: digest(source?.snapshotHash), identityHash: digest(source?.identityHash),
        groupId: text(shared ? record(sharedBinding.routeGroupBinding).groupId : expected.groupId), nativeUnit: text(source?.nativeUnit, 80), rawRemaining,
        observedAt: source?.observedAt.toISOString() ?? null, expiresAt: source?.expiresAt.toISOString() ?? null,
        readAvailable: !!configured, scope: shared ? "shared_user_lifetime_wallet" : null,
        externalCommitmentsState: shared ? record(record(source?.proof).externalCommitments).state as "proven" | "unobservable" : null,
        costCoverage, candidateSnapshot, blockers },
      liabilities: { walletTotalCents: wallet, heldSubsetCents: held, awaitingAllocationCents: awaiting, awaitingOrders: Number(count) },
      observedAt: new Date().toISOString()
    };
  });
}
function operationReceipt(row: GatewayCreditPoolLedger): CreditPoolOperationReceipt {
  const operation = parseCreditPoolOperation(row.kind);
  const prefix = operation === "adoption" ? "adoption:" : "source-refresh:";
  if (!row.proposalId || !row.eventId.startsWith(prefix)) throw new GatewayBillingError("CREDIT_POOL_INVALID", "会计记录异常", 409);
  return { eventId: row.eventId, operation, proposalId: row.proposalId, requestKey: parseCreditPoolRequestKey(row.eventId.slice(prefix.length)),
    createdAt: row.createdAt.toISOString(), capacityCents: accountingCents(row.capacityCents),
    allocatedAfterCents: accountingCents(row.allocatedAfterCents), consumedAfterCents: accountingCents(row.consumedAfterCents),
    allocatableAfterCents: accountingCents(row.allocatableAfterCents), deficitAfterCents: accountingCents(row.deficitAfterCents) };
}
export async function getCreditPoolOperationReceipt(adminId: string, operation: CreditPoolOperation, key: string): Promise<CreditPoolOperationReceipt | null> {
  parseCreditPoolId(adminId); parseCreditPoolOperation(operation); parseCreditPoolRequestKey(key);
  return readOnly(async tx => {
    const row = await tx.gatewayCreditPoolLedger.findFirst({ where: { eventId: `${operation === "adoption" ? "adoption" : "source-refresh"}:${key}`, actorId: adminId, kind: operation } });
    return row ? operationReceipt(row) : null;
  });
}
export async function getCreditPoolProposalView(adminId: string, proposalId: string): Promise<CreditPoolProposalView> {
  parseCreditPoolId(adminId); parseCreditPoolId(proposalId);
  return readOnly(async tx => {
    const proposal = await tx.gatewayCreditPoolProposal.findFirst({ where: { id: proposalId, adminId } });
    if (!proposal) throw new GatewayBillingError("POOL_PROPOSAL_NOT_FOUND", "方案不存在", 404);
    const operation = parseCreditPoolOperation(proposal.kind);
    const entry = await tx.gatewayCreditPoolLedger.findFirst({ where: { proposalId, actorId: adminId, kind: operation } });
    const pool = await tx.gatewayCreditPool.findUnique({ where: { id: "total" } });
    const snapshot = await tx.gatewayCreditSourceSnapshot.findUnique({ where: { id: proposal.snapshotId },
      select: { id: true, status: true, snapshotHash: true, identityHash: true, expiresAt: true } });
    const capacity = accountingCents(proposal.capacityCents), wallet = accountingCents(proposal.walletTotalCents), consumed = accountingCents(proposal.consumedCents), held = accountingCents(proposal.heldSubsetCents);
    const available = BigInt(capacity) - BigInt(wallet) - BigInt(consumed);
    if (available < 0n || BigInt(held) > BigInt(wallet)) throw new GatewayBillingError("CREDIT_POOL_INVALID", "方案数额异常", 409);
    let state: CreditPoolProposalView["state"] = "reviewable";
    const blockers: CreditPoolBlocker[] = [];
    if (entry) state = "applied";
    else if (proposal.expiresAt.getTime() <= Date.now() || (snapshot && snapshot.expiresAt.getTime() <= Date.now())) state = "expired";
    else if ((pool?.revision ?? 0) + 1 !== proposal.version) state = "stale";
    else if (!snapshot || snapshot.status !== "verified" || snapshot.snapshotHash !== proposal.snapshotHash || snapshot.identityHash !== proposal.identityHash ||
      (operation === "adoption" ? !!pool && (pool.accountingVersion !== 0 || pool.status !== "pending" || pool.balanceCents !== 0) : pool?.accountingVersion !== 1)) state = "blocked";
    if (state !== "reviewable" && state !== "applied") blockers.push({ code: `POOL_PROPOSAL_${state.toUpperCase()}`, message: "方案需要重新核对，不能直接批准" });
    return { id: proposal.id, operation, version: proposal.version, snapshotId: proposal.snapshotId, snapshotHash: proposal.snapshotHash,
      identityHash: proposal.identityHash, conversionPolicyHash: proposal.conversionPolicyHash, walletStateHash: proposal.walletStateHash,
      capacityCents: capacity, walletTotalCents: wallet, consumedCents: consumed, heldSubsetCents: held, allocatableCents: String(available),
      createdAt: proposal.createdAt.toISOString(), expiresAt: proposal.expiresAt.toISOString(), state, requiresServerRevalidation: true, blockers, receipt: entry ? operationReceipt(entry) : null };
  });
}
