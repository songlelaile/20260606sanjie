import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { GatewayBillingError } from "./billing-contract";
import { lockGatewayAccountingIdentities, lockGatewayAccountingPool } from "./accounting-coordination";
import { getGatewayAllocationBudget } from "./credit-allocation-window";
import { giftGatewayCredits } from "./credit-gifts";
import { parseGiftPlanInput } from "./credit-gift-plans-contract";
import { giftPlanView, type GiftPlanRow } from "./credit-gift-plan-store";

async function activeAdmin(tx: Prisma.TransactionClient, adminId: string) {
  const admin = await tx.user.findUnique({ where: { id: adminId } });
  if (!admin || admin.authRole !== "admin" || admin.status !== "active") throw new GatewayBillingError("ADMIN_REQUIRED", "仅启用中的管理员可管理预设赠送", 403);
}
export async function getGiftPlansOverview(adminId: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await activeAdmin(tx, adminId);
    const pool = await tx.gatewayCreditPool.findUnique({ where: { id: "total" } });
    const plans = await tx.$queryRaw<GiftPlanRow[]>`SELECT * FROM "GatewayCreditGiftPlan" WHERE "adminId"=${adminId}
      ORDER BY CASE WHEN "status" IN ('pending','blocked') AND "expiresAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') THEN 0 ELSE 1 END,"createdAt" DESC LIMIT 100`;
    return { budget: await getGatewayAllocationBudget(tx, pool), plans: plans.map(giftPlanView) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function saveGiftPlan(adminId: string, value: unknown) {
  const input = parseGiftPlanInput(value);
  const row = await prisma.$transaction(async tx => {
    await lockGatewayAccountingIdentities(tx, [adminId, input.userId]);
    await activeAdmin(tx, adminId);
    await lockGatewayAccountingPool(tx);
    // Serialize same-key creation, including when no pool has been initialized.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gift-plan:${input.requestKey}`},0))::text`;
    const existing = await tx.$queryRaw<GiftPlanRow[]>`SELECT * FROM "GatewayCreditGiftPlan" WHERE "requestKey"=${input.requestKey} FOR UPDATE`;
    if (existing[0]) {
      const old = existing[0];
      if (old.adminId !== adminId || old.userId !== input.userId || old.amountCents !== input.amountCents || old.reason !== input.reason || old.expiresAt.toISOString() !== input.expiresAt) {
        throw new GatewayBillingError("GIFT_PLAN_CONFLICT", "此请求标识已经用于其他预设赠送", 409);
      }
      return old;
    }
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 30 * 86400_000) {
      throw new GatewayBillingError("GIFT_PLAN_EXPIRY_INVALID", "截止时间需在未来 30 天内", 400);
    }
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user || user.status !== "active") throw new GatewayBillingError("ACCOUNT_UNAVAILABLE", "赠送账号不存在或已停用", 404);
    if (await tx.gatewayCreditGift.findUnique({ where: { requestKey: input.requestKey } }) ||
        await tx.gatewayBillingLedger.findUnique({ where: { billingEventId: `gift:${input.requestKey}` } })) {
      throw new GatewayBillingError("GIFT_PLAN_CONFLICT", "此请求标识已有赠送记录", 409);
    }
    const rows = await tx.$queryRaw<GiftPlanRow[]>`INSERT INTO "GatewayCreditGiftPlan"
      ("id","requestKey","adminId","userId","amountCents","reason","expiresAt")
      VALUES (${randomUUID()},${input.requestKey},${adminId},${input.userId},${input.amountCents},${input.reason},
        (${input.expiresAt}::timestamptz AT TIME ZONE 'UTC')) RETURNING *`;
    return rows[0];
  }, { timeout: 20_000 });
  if (["pending", "blocked"].includes(row.status) && row.expiresAt.getTime() > Date.now()) await runGiftPlan(row);
  const current = await prisma.$queryRaw<GiftPlanRow[]>`SELECT * FROM "GatewayCreditGiftPlan" WHERE "id"=${row.id}`;
  return giftPlanView(current[0]);
}

async function runGiftPlan(row: GiftPlanRow) {
  try {
    await giftGatewayCredits(row.adminId, { userId: row.userId, points: `${Math.floor(row.amountCents / 10)}.${row.amountCents % 10}`,
      reason: row.reason, requestKey: row.requestKey }, { presetPlanId: row.id });
  } catch (error) {
    const code = error instanceof GatewayBillingError && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : "GIFT_PLAN_RETRY_REQUIRED";
    // A slow failure cannot overwrite another worker's committed gift/cancellation.
    await prisma.$executeRaw`UPDATE "GatewayCreditGiftPlan" SET "status"='blocked',"lastCode"=${code},"updatedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE "id"=${row.id} AND "status" IN ('pending','blocked')`;
  }
}

/** Only explicit financial POSTs call this; GETs never execute gifts. Durable rows
 * remain retryable after restart; every worker rechecks original authorization in
 * the same transaction as budget, pool, wallet and gift journals. */
export async function processPendingGiftPlans() {
  const startedAt = Date.now();
  const rows = await prisma.$queryRaw<GiftPlanRow[]>`SELECT * FROM "GatewayCreditGiftPlan"
    WHERE "status" IN ('pending','blocked') AND "expiresAt">(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ORDER BY "updatedAt","createdAt","id" LIMIT 20`;
  let attempted = 0;
  for (const row of rows) {
    // One in-flight attempt has the existing source timeout; do not start an
    // unbounded sequence after verification. Failures rotate to the queue tail.
    if (attempted && Date.now() - startedAt >= 15_000) break;
    await runGiftPlan(row); attempted += 1;
  }
  return { attempted };
}

/** The source verification has already committed. Failure of subsequent gift
 * processing must not make that committed operation appear to have failed. */
export async function tryProcessPendingGiftPlans(): Promise<{ state: "checked" | "retry_required"; attempted?: number }> {
  try { const result = await processPendingGiftPlans(); return { state: "checked", ...result }; }
  catch { return { state: "retry_required" }; }
}

export async function cancelGiftPlan(adminId: string, id: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new GatewayBillingError("GIFT_PLAN_NOT_FOUND", "预设赠送不存在", 404);
  return prisma.$transaction(async tx => {
    await lockGatewayAccountingIdentities(tx, [adminId]);
    await activeAdmin(tx, adminId);
    await lockGatewayAccountingPool(tx);
    const rows = await tx.$queryRaw<GiftPlanRow[]>`SELECT * FROM "GatewayCreditGiftPlan" WHERE "id"=${id} AND "adminId"=${adminId} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new GatewayBillingError("GIFT_PLAN_NOT_FOUND", "预设赠送不存在", 404);
    if (row.status === "completed") throw new GatewayBillingError("GIFT_PLAN_COMPLETED", "赠送已完成，请核对原赠送记录", 409);
    if (row.status === "cancelled") return giftPlanView(row);
    const changed = await tx.$queryRaw<GiftPlanRow[]>`UPDATE "GatewayCreditGiftPlan" SET "status"='cancelled',"lastCode"=NULL,
      "cancelledAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),"updatedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "id"=${id} RETURNING *`;
    return giftPlanView(changed[0]);
  }, { timeout: 20_000 });
}
