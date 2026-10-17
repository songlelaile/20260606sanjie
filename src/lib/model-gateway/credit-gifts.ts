import "server-only";
import { type GatewayCreditGift } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ensureGatewayBillingOpening, lockGatewayBillingWallet } from "./billing";
import { centsToPoints, GATEWAY_MAX_COST_CENTS, GatewayBillingError } from "./billing-contract";
import { parseGatewayCreditGiftInput, type GatewayCreditGiftOverview, type GatewayCreditGiftView } from "./credit-gifts-contract";
import { lockGatewayAccountingIdentities } from "./accounting-coordination";
import { assertGatewayPoolReady, moveGatewayPool, refreshGatewaySharedPoolFromSource } from "./credit-pool-accounting";
import { completeGiftPlan, lockGiftPlanForExecution } from "./credit-gift-plan-store";

export { parseGatewayCreditGiftInput } from "./credit-gifts-contract";
const TOTAL_POOL_ID = "total";

function validBalance(balance: number) {
  return Number.isSafeInteger(balance) && balance >= 0 && balance <= GATEWAY_MAX_COST_CENTS;
}

function giftView(gift: GatewayCreditGift): GatewayCreditGiftView {
  return {
    ...gift, createdAt: gift.createdAt.toISOString(), amountPoints: centsToPoints(gift.amountCents),
    poolBeforePoints: centsToPoints(gift.poolBeforeCents), poolAfterPoints: centsToPoints(gift.poolAfterCents),
    walletBeforePoints: centsToPoints(gift.walletBeforeCents), walletAfterPoints: centsToPoints(gift.walletAfterCents)
  };
}

/** Read-only: missing or pending pool has no known allocatable balance. Never lazily seed it. */
export async function getGatewayCreditGiftOverview(): Promise<GatewayCreditGiftOverview> {
  const [pool, gifts] = await Promise.all([
    prisma.gatewayCreditPool.findUnique({ where: { id: TOTAL_POOL_ID } }),
    prisma.gatewayCreditGift.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 })
  ]);
  let state: "uninitialized" | "pending" | "invalid" | "ready" = !pool ? "uninitialized"
    : !validBalance(pool.balanceCents) || !["pending", "ready", "blocked"].includes(pool.status) ? "invalid" : "pending";
  if (pool?.status === "ready" && validBalance(pool.balanceCents)) {
    try { await prisma.$transaction(tx => assertGatewayPoolReady(tx, pool)); state = "ready"; }
    catch (error) { if (!(error instanceof GatewayBillingError)) throw error; if (error.code === "CREDIT_POOL_INVALID") state = "invalid"; }
  }
  const ready = state === "ready";
  // This describes the existing POST's refresh capability, never a known balance.
  // The POST still reads a trusted source and verifies coverage under its locks.
  const refreshOnSubmitAvailable = state === "pending" && pool?.accountingVersion === 1
    && pool.sourceScope === "shared_user_lifetime_wallet" && !!pool.sourceSnapshotId;
  return {
    pool: { state, ready, balanceCents: ready ? pool!.balanceCents : null, balancePoints: ready ? centsToPoints(pool!.balanceCents) : null, refreshOnSubmitAvailable },
    gifts: gifts.map(giftView)
  };
}

/** Atomic allocation only: no paid order, plan renewal, quota change or creative access grant. */
export async function giftGatewayCredits(adminId: string, value: unknown, options: { presetPlanId?: string } = {}): Promise<GatewayCreditGiftView> {
  const input = parseGatewayCreditGiftInput(value);
  if (typeof adminId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(adminId)) {
    throw new GatewayBillingError("ADMIN_REQUIRED", "仅有效管理员可赠送积分", 403);
  }
  const billingEventId = `gift:${input.requestKey}`;
  // A receipt replay must work even when the upstream is temporarily unreachable.
  // The transaction below still verifies actor, immutable payload and both journals.
  if (!await prisma.gatewayCreditGift.findUnique({ where: { requestKey: input.requestKey } })) await refreshGatewaySharedPoolFromSource();
  const commit = () => prisma.$transaction(async (tx) => {
    // SHARE blocks status/role changes while remaining compatible with wallet FK KEY SHARE.
    // All gift paths lock identities in sorted order, then shared pool, then existing wallet lock.
    const identities = [...new Set([adminId, input.userId])].sort();
    await lockGatewayAccountingIdentities(tx, identities);
    const admin = await tx.user.findUnique({ where: { id: adminId }, include: { tenant: { select: { name: true } } } });
    if (!admin || admin.authRole !== "admin" || admin.status !== "active") {
      throw new GatewayBillingError("ADMIN_REQUIRED", "仅有效管理员可赠送积分", 403);
    }
    await tx.$queryRaw`SELECT "id" FROM "GatewayCreditPool" WHERE "id" = ${TOTAL_POOL_ID} FOR UPDATE`;
    const pool = await tx.gatewayCreditPool.findUnique({ where: { id: TOTAL_POOL_ID } });
    if (!pool) throw new GatewayBillingError("CREDIT_POOL_NOT_READY", "总积分池尚未接入统一记账系统", 409);
    const plan = await lockGiftPlanForExecution(tx, adminId, input, options.presetPlanId);

    // Check replay while the shared pool lock is held, including cross-user/admin conflicts.
    const existing = await tx.gatewayCreditGift.findUnique({ where: { requestKey: input.requestKey } });
    if (existing) {
      if (existing.adminId !== admin.id || existing.userId !== input.userId || existing.amountCents !== input.amountCents || existing.reason !== input.reason) {
        throw new GatewayBillingError("GIFT_REQUEST_CONFLICT", "此赠送请求已用于其他操作", 409);
      }
      const entry = await tx.gatewayBillingLedger.findUnique({ where: { billingEventId: existing.billingEventId } });
      if (existing.billingEventId !== billingEventId || !entry || entry.kind !== "gift" || entry.userId !== existing.userId ||
        entry.actorId !== existing.adminId || entry.deltaCents !== existing.amountCents || entry.reason !== existing.reason ||
        entry.balanceBeforeCents !== existing.walletBeforeCents || entry.balanceAfterCents !== existing.walletAfterCents) {
        throw new GatewayBillingError("GIFT_REQUEST_CONFLICT", "此赠送请求的记账记录不完整，请核对账本", 409);
      }
      await completeGiftPlan(tx, plan);
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      return giftView(existing);
    }
    if (plan?.status === "completed") throw new GatewayBillingError("GIFT_PLAN_CONFLICT", "预设赠送的记账记录不完整，请核对账本", 409);
    const user = await tx.user.findUnique({ where: { id: input.userId }, include: { tenant: { select: { name: true } } } });
    if (!user || user.status !== "active") {
      throw new GatewayBillingError("ACCOUNT_UNAVAILABLE", "赠送账号不存在或已停用", 404);
    }
    await assertGatewayPoolReady(tx, pool);
    if (!validBalance(pool.balanceCents)) throw new GatewayBillingError("CREDIT_POOL_INVALID", "总积分池余额状态异常", 409);
    if (pool.balanceCents < input.amountCents) throw new GatewayBillingError("INSUFFICIENT_POOL_BALANCE", "总积分池可分配积分不足", 409);
    if (await tx.gatewayBillingLedger.findUnique({ where: { billingEventId } })) {
      throw new GatewayBillingError("GIFT_REQUEST_CONFLICT", "此赠送请求的记账标识已被占用", 409);
    }
    const before = await lockGatewayBillingWallet(tx, user.id);
    if (!validBalance(before.balanceCents) || before.balanceCents > GATEWAY_MAX_COST_CENTS - input.amountCents) {
      throw new GatewayBillingError("WALLET_OVERFLOW", "目标账号钱包余额超过允许范围", 409);
    }
    await ensureGatewayBillingOpening(tx, user, before);
    await moveGatewayPool(tx, { eventId: billingEventId, kind: "gift", userId: user.id, actorId: admin.id, amountCents: input.amountCents });
    const wallet = await tx.gatewayWallet.update({ where: { userId: user.id }, data: { balanceCents: { increment: input.amountCents } } });
    const rule = await tx.gatewayBillingRule.findUnique({ where: { planCode: before.planCode } });
    await tx.gatewayBillingLedger.create({ data: {
      billingEventId, kind: "gift", userId: user.id, tenantId: user.tenantId, tenantName: user.tenant.name,
      username: user.username, userName: user.name, planCode: before.planCode, planName: before.planName,
      multiplierBps: rule?.multiplierBps ?? 10_000, ruleVersion: rule?.version ?? 0,
      deltaCents: input.amountCents, balanceBeforeCents: before.balanceCents, balanceAfterCents: wallet.balanceCents,
      status: "ok", actorId: admin.id, actorUsername: admin.username, actorName: admin.name, reason: input.reason,
      metadata: { creditPoolId: TOTAL_POOL_ID, giftRequestKey: input.requestKey }
    } });
    const gift = await tx.gatewayCreditGift.create({ data: {
      requestKey: input.requestKey, billingEventId, adminId: admin.id, adminUsername: admin.username, adminName: admin.name,
      adminTenantId: admin.tenantId, adminTenantName: admin.tenant.name, userId: user.id, username: user.username, userName: user.name,
      tenantId: user.tenantId, tenantName: user.tenant.name, amountCents: input.amountCents,
      poolBeforeCents: pool.balanceCents, poolAfterCents: pool.balanceCents - input.amountCents,
      walletBeforeCents: before.balanceCents, walletAfterCents: wallet.balanceCents, reason: input.reason
    } });
    await completeGiftPlan(tx, plan);
    // Surface deferred PostgreSQL errors before COMMIT: older Prisma engines may
    // not propagate a COMMIT-time constraint exception even though PG rolls back.
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    return giftView(gift);
  });
  try { return await commit(); }
  catch (error) {
    // A conflicting out-of-band writer still cannot leave partial credits. Re-enter the locks
    // once to return a committed identical journal, or expose a safe conflict without retrying money.
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") throw error;
    try { return await commit(); }
    catch (retryError) {
      if (retryError && typeof retryError === "object" && "code" in retryError && retryError.code === "P2002") {
        throw new GatewayBillingError("GIFT_REQUEST_CONFLICT", "此赠送请求的记账标识已被占用", 409);
      }
      throw retryError;
    }
  }
}
