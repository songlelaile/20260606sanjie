import "server-only";
import type { Prisma } from "@prisma/client";
import { GatewayBillingError } from "./billing-contract";
import type { GiftPlanView } from "./credit-gift-plans-contract";
export type GiftPlanRow = Omit<GiftPlanView, "expiresAt" | "executedAt" | "cancelledAt" | "createdAt" | "status"> & {
  status: "pending" | "blocked" | "completed" | "cancelled"; expiresAt: Date; executedAt: Date | null; cancelledAt: Date | null; createdAt: Date; updatedAt: Date };
export function giftPlanView(row: GiftPlanRow): GiftPlanView {
  return { id: row.id, requestKey: row.requestKey, adminId: row.adminId, userId: row.userId, amountCents: row.amountCents, reason: row.reason,
    status: ["pending", "blocked"].includes(row.status) && row.expiresAt.getTime() <= Date.now() ? "expired" : row.status,
    lastCode: row.lastCode, expiresAt: row.expiresAt.toISOString(), executedAt: row.executedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}
/** Called under the ordinary gift identity/pool locks, before touching the wallet. */
export async function lockGiftPlanForExecution(tx: Prisma.TransactionClient, adminId: string,
  gift: { requestKey: string; userId: string; amountCents: number; reason: string }, planId?: string) {
  const rows = await tx.$queryRaw<GiftPlanRow[]>`SELECT * FROM "GatewayCreditGiftPlan" WHERE "requestKey"=${gift.requestKey} FOR UPDATE`;
  const row = rows[0];
  // A normal gift endpoint cannot bypass a cancelled/expired queued authorization.
  if (row && row.id !== planId || planId && !row) throw new GatewayBillingError("GIFT_PLAN_CONFLICT", "此请求标识属于预设赠送，请核对预设记录", 409);
  if (!row) return null;
  if (row.adminId !== adminId || row.userId !== gift.userId || row.amountCents !== gift.amountCents || row.reason !== gift.reason) {
    throw new GatewayBillingError("GIFT_PLAN_CONFLICT", "预设赠送内容不一致", 409);
  }
  if (row.status === "cancelled" || row.status !== "completed" && row.expiresAt.getTime() <= Date.now()) {
    throw new GatewayBillingError("GIFT_PLAN_INACTIVE", "预设赠送已取消或超过截止时间", 409);
  }
  return row;
}
export async function completeGiftPlan(tx: Prisma.TransactionClient, row: GiftPlanRow | null) {
  if (!row || row.status === "completed") return;
  await tx.$executeRaw`UPDATE "GatewayCreditGiftPlan" SET "status"='completed',"lastCode"=NULL,
    "executedAt"=(clock_timestamp() AT TIME ZONE 'UTC'),"updatedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "id"=${row.id} AND "status" IN ('pending','blocked')`;
}
