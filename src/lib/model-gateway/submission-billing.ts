import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { ensureGatewayBillingOpening, lockGatewayBillingWallet } from "./billing";
import { GatewayBillingError, GATEWAY_MAX_COST_CENTS, type GatewayBillingSnapshot } from "./billing-contract";
import { moveGatewayPool } from "./credit-pool-accounting";

export function submissionLedgerEvent(eventId: string, refund = false) {
  return (refund ? "refund:" : "charge:") + createHash("sha256").update(eventId).digest("hex");
}
export type SubmissionHold = { eventId: string; userId: string; tenantId: string; apiKeyId: string | null;
  endpoint: string; provider: string; model: string; quoteCents: number; billingSnapshot: GatewayBillingSnapshot;
  requestFingerprint: string; chargedCents: number; refundedCents: number; cancelledAt: Date | null };

/** A customer purchase, not supplier consumption. No fake usage/source receipt is created. */
export async function postSubmissionMoney(tx: Prisma.TransactionClient, row: SubmissionHold, refund = false) {
  const amount = refund ? row.chargedCents : row.quoteCents;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > GATEWAY_MAX_COST_CENTS) throw new GatewayBillingError("INVALID_SUBMISSION_PRICE", "本次报价无效", 503);
  const eventId = submissionLedgerEvent(row.eventId, refund), kind = refund ? "generation_refund" : "generation_charge";
  const previous = await tx.gatewayBillingLedger.findUnique({ where: { billingEventId: eventId } });
  if (previous) {
    if (previous.userId !== row.userId || previous.kind !== kind || previous.deltaCents !== (refund ? amount : -amount)) throw new GatewayBillingError("BILLING_EVENT_CONFLICT", "提交收费流水不一致", 409);
    return;
  }
  const before = await lockGatewayBillingWallet(tx, row.userId);
  const user = await tx.user.findUniqueOrThrow({ where: { id: row.userId }, include: { tenant: { select: { name: true } } } });
  await ensureGatewayBillingOpening(tx, user, before);
  const next = before.balanceCents + (refund ? amount : -amount);
  if (!Number.isSafeInteger(next) || next < 0 || next > GATEWAY_MAX_COST_CENTS) throw new GatewayBillingError("INSUFFICIENT_BALANCE", "积分不足，请先购买积分", 402);
  await tx.gatewayWallet.update({ where: { userId: row.userId }, data: { balanceCents: next } });
  await moveGatewayPool(tx, { eventId, kind, userId: row.userId, actorId: row.userId, amountCents: amount });
  const s = row.billingSnapshot;
  await tx.gatewayBillingLedger.create({ data: { billingEventId: eventId, kind, userId: row.userId, tenantId: row.tenantId,
    tenantName: s.tenantName || user.tenant.name, username: s.username, userName: s.userName,
    planCode: s.planCode, planName: s.planName, multiplierBps: s.multiplierBps, ruleVersion: s.ruleVersion,
    deltaCents: refund ? amount : -amount, balanceBeforeCents: before.balanceCents, balanceAfterCents: next,
    baseCostCents: 0, chargedCostCents: refund ? 0 : amount, endpoint: row.endpoint, provider: row.provider, model: row.model,
    apiKeyId: row.apiKeyId, status: "ok", actorId: row.userId, actorUsername: s.username, actorName: s.userName,
    reason: refund ? "生成失败，退回本次报价" : "按提交时本次固定报价扣积分",
    metadata: { schema: "SANJIE_SUBMISSION_CHARGE_V1", originalEventId: row.eventId, requestFingerprint: row.requestFingerprint,
      quoteCents: row.quoteCents, quoteHash: createHash("sha256").update(canonical(s)).digest("hex") } } });
}

/** Each customer charge/refund is proved by its frozen request, not a fabricated supplier receipt. */
export async function assertGatewaySubmissionCharge(tx: Prisma.TransactionClient, eventId: string) {
  const rows = await tx.$queryRaw<Array<SubmissionHold & {billingMode:string}>>`SELECT * FROM "GatewayBillingHold" WHERE "eventId"=${eventId}`;
  const row = rows[0];
  const bad = (): never => {throw new GatewayBillingError("POOL_SOURCE_USAGE_UNPROVEN", "提交收费凭据需核对", 409);};
  if (!row || row.billingMode !== "prepaid_quote" || row.quoteCents <= 0 || row.chargedCents !== row.quoteCents || ![0,row.chargedCents].includes(row.refundedCents) || (row.cancelledAt && row.refundedCents)) return bad();
  const charge = await tx.gatewayBillingLedger.findUnique({where:{billingEventId:submissionLedgerEvent(eventId)}});
  const expected = {schema:"SANJIE_SUBMISSION_CHARGE_V1",originalEventId:row.eventId,requestFingerprint:row.requestFingerprint,quoteCents:row.quoteCents,
    quoteHash:createHash("sha256").update(canonical(row.billingSnapshot)).digest("hex")};
  // Canonical snapshot hashes survive JSONB object-key ordering.
  const check = (entry: typeof charge, refund: boolean) => entry && entry.userId === row.userId && entry.tenantId === row.tenantId && entry.apiKeyId === row.apiKeyId &&
    entry.planCode === row.billingSnapshot.planCode && entry.planName === row.billingSnapshot.planName && entry.multiplierBps === row.billingSnapshot.multiplierBps && entry.ruleVersion === row.billingSnapshot.ruleVersion &&
    entry.kind === (refund ? "generation_refund" : "generation_charge") && entry.endpoint === row.endpoint && entry.model === row.model && entry.provider === row.provider &&
    entry.deltaCents === (refund ? row.chargedCents : -row.chargedCents) && entry.chargedCostCents === (refund ? 0 : row.chargedCents) && entry.baseCostCents === 0 && entry.usageId === null &&
    entry.balanceAfterCents-entry.balanceBeforeCents === entry.deltaCents && canonical(entry.metadata) === canonical(expected);
  if (!check(charge,false)) return bad();
  const refund = await tx.gatewayBillingLedger.findUnique({where:{billingEventId:submissionLedgerEvent(eventId,true)}});
  if (row.refundedCents ? !check(refund,true) : !!refund) return bad();
  const pool = await tx.gatewayCreditPool.findUnique({where:{id:"total"}});
  if (pool?.accountingVersion === 1) {
    for (const reversed of [false,true]) {
      const movement = await tx.gatewayCreditPoolLedger.findUnique({where:{eventId:submissionLedgerEvent(eventId,reversed)}});
      if (reversed && !row.refundedCents) {if (movement) return bad(); continue;}
      const delta=BigInt(row.chargedCents)*(reversed ? 1n : -1n);
      if (!movement || movement.userId !== row.userId || movement.kind !== (reversed ? "generation_refund" : "generation_charge") || movement.deltaAllocatedCents !== delta || movement.deltaConsumedCents !== -delta || movement.capacityBeforeCents !== movement.capacityCents) return bad();
    }
  }
  return row;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return value === undefined ? "null" : JSON.stringify(value);
}
