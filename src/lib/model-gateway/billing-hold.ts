import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { lockGatewayBillingWallet } from "@/lib/model-gateway/billing";
import { applyGatewayBillingCost, GatewayBillingError, GATEWAY_MAX_COST_CENTS, sanitizeGatewayFxSnapshot, type GatewayBillingSnapshot } from "@/lib/model-gateway/billing-contract";
import { postSubmissionMoney, assertGatewaySubmissionCharge } from "./submission-billing";
import type { GatewayAuth } from "@/lib/model-gateway/store";
import { getGatewaySharedSourceConfigVersion } from "./shared-wallet-source";
import type { NativeDispatchBinding } from "./native-credit-coverage";
import { getUserSupplyCredential } from "./user-supply";
import { validateGatewayLocalPricing } from "./local-pricing";
import { contractHash } from "./source-quote.mjs";
import { lockGatewayAccountingIdentities } from "./accounting-coordination";
import { NATIVE_VIDEO_ENDPOINT } from "./native-video-contract";
import { assertGatewayPoolNewQuote, assertGatewayPoolCredential, bindGatewayNativePoolFunding, gatewaySharedHoldBinding, refreshGatewaySharedPoolFromSource, type SharedHoldBinding } from "./credit-pool-accounting";

export type GatewayBillingHoldStatus = "reserved" | "dispatched" | "unknown" | "settled" | "released";
export type GatewayBillingHold = {
  eventId: string; userId: string; tenantId: string; apiKeyId: string | null;
  requestFingerprint: string; endpoint: string; provider: string; model: string;
  quoteCents: number; heldCents: number; settledCents: number | null; status: GatewayBillingHoldStatus;
  billingMode: "reservation" | "direct_usage" | "prepaid_quote"; amountDueCents: number;
  chargedCents: number; refundedCents: number; cancelledAt: Date | null; refundFingerprint: string | null;
  billingSnapshot: GatewayBillingSnapshot; outcomeFingerprint: string | null;
  usageId: string | null; reason: string; createdAt: Date; updatedAt: Date; dispatchedAt: Date | null;
  credentialId?: string | null; sourceBinding?: SharedHoldBinding | null;
};
type HoldRow = GatewayBillingHold & { idempotencyHash: string | null };
type Tx = Prisma.TransactionClient;
const HEX = /^[a-f0-9]{64}$/;
const ACTIVE = new Set<GatewayBillingHoldStatus>(["reserved", "dispatched", "unknown"]);
const settlementContexts = new WeakMap<object, string>();
const settlementOutcomes = new WeakMap<object, string>();
export function gatewayBillingSettlementOutcome(tx: Tx) { return settlementOutcomes.get(tx) ?? null; }

/** Only a callback inside this module's locked settlement transaction may exclude its own hold. */
export function isGatewayBillingHoldSettlement(tx: Tx, eventId: string) {
  return settlementContexts.get(tx) === eventId;
}

function validIdentifier(value: unknown, name: string, max = 160): asserts value is string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GatewayBillingError("INVALID_BILLING_HOLD", `${name}无效`);
  }
}
function money(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > GATEWAY_MAX_COST_CENTS) {
    throw new GatewayBillingError("INVALID_HOLD_COST", "冻结或结算金额必须是有效非负整数");
  }
}
function event(value: string) {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value) || /^(opening|recharge|gift):/.test(value)) {
    throw new GatewayBillingError("INVALID_BILLING_EVENT", "调用计费事件标识无效");
  }
}
function fingerprint(value: string) {
  if (!HEX.test(value)) throw new GatewayBillingError("INVALID_REQUEST_FINGERPRINT", "请求或结果摘要必须是 SHA256");
}
function snapshot(input: GatewayBillingSnapshot, userId: string) {
  if (!input || input.userId !== userId || !Number.isSafeInteger(input.ruleVersion) || input.ruleVersion < 0 ||
      !Number.isFinite(Date.parse(input.quotedAt))) throw new GatewayBillingError("INVALID_BILLING_SNAPSHOT", "计费快照不属于当前账号");
  applyGatewayBillingCost(0, input);
  for (const key of ["userId", "tenantId", "username", "planCode"] as const) validIdentifier(input[key], key, 200);
  for (const key of ["userName", "planName", "tenantName"] as const) {
    const value = input[key] ?? "";
    if (typeof value !== "string" || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new GatewayBillingError("INVALID_BILLING_SNAPSHOT", "计费身份快照无效");
  }
  // Whitelist fields: request bodies, credentials and arbitrary caller metadata never reach storage.
  return { userId: input.userId, tenantId: input.tenantId, tenantName: input.tenantName || "", username: input.username,
    userName: input.userName, planCode: input.planCode, planName: input.planName, multiplierBps: input.multiplierBps,
    ruleVersion: input.ruleVersion, quotedAt: input.quotedAt,
    ...(input.localPricing === undefined ? {} : {localPricing: validateGatewayLocalPricing(input.localPricing)}),
    ...(input.fxSnapshot === undefined ? {} : { fxSnapshot: sanitizeGatewayFxSnapshot(input.fxSnapshot) }) } satisfies GatewayBillingSnapshot;
}
function view(row: HoldRow): GatewayBillingHold {
  return { eventId: row.eventId, userId: row.userId, tenantId: row.tenantId, apiKeyId: row.apiKeyId,
    requestFingerprint: row.requestFingerprint, endpoint: row.endpoint, provider: row.provider, model: row.model,
    quoteCents: row.quoteCents, heldCents: row.heldCents, settledCents: row.settledCents, status: row.status,
    billingMode: row.billingMode ?? "reservation", amountDueCents: row.amountDueCents ?? 0,
    chargedCents: row.chargedCents ?? 0, refundedCents: row.refundedCents ?? 0, cancelledAt: row.cancelledAt ?? null, refundFingerprint: row.refundFingerprint ?? null,
    billingSnapshot: row.billingSnapshot, outcomeFingerprint: row.outcomeFingerprint, usageId: row.usageId,
    reason: row.reason, createdAt: row.createdAt, updatedAt: row.updatedAt, dispatchedAt: row.dispatchedAt,
    credentialId: row.credentialId ?? null, sourceBinding: row.sourceBinding ?? null };
}
async function load(tx: Tx, userId: string, eventId: string) {
  const rows = await tx.$queryRaw<HoldRow[]>`SELECT * FROM "GatewayBillingHold" WHERE "eventId" = ${eventId} AND "userId" = ${userId}`;
  if (!rows[0]) throw new GatewayBillingError("BILLING_HOLD_NOT_FOUND", "冻结记录不存在", 404);
  return rows[0];
}
async function journal(tx: Tx, row: HoldRow, transition: string, reason = "", evidence: string | null = null) {
  await tx.$executeRaw`INSERT INTO "GatewayBillingHoldEvent" ("id", "eventId", "userId", "transition", "reason", "evidenceFingerprint")
    VALUES (${randomUUID()}, ${row.eventId}, ${row.userId}, ${transition}, ${reason}, ${evidence})`;
}
async function update(tx: Tx, row: HoldRow, status: GatewayBillingHoldStatus, reason: string, evidence: string | null = null) {
  await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "status" = ${status}, "reason" = ${reason}, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    WHERE "eventId" = ${row.eventId} AND "userId" = ${row.userId}`;
  await journal(tx, row, status, reason, evidence);
  return load(tx, row.userId, row.eventId);
}

/** Caller must hold the wallet lock before using this result for a financial write. No hold expires automatically. */
export async function getGatewayAvailableBalance(tx: Tx, userId: string, excludeEventId?: string) {
  const rows = await tx.$queryRaw<{ balanceCents: number; reservedCents: bigint; outstandingCents: bigint }[]>`SELECT w."balanceCents",
    COALESCE((SELECT SUM(h."heldCents") FROM "GatewayBillingHold" h WHERE h."userId" = w."userId"
      AND h."status" IN ('reserved', 'dispatched', 'unknown') AND (${excludeEventId ?? null}::TEXT IS NULL OR h."eventId" <> ${excludeEventId ?? null})), 0)::BIGINT AS "reservedCents",
    COALESCE((SELECT SUM(h."amountDueCents") FROM "GatewayBillingHold" h WHERE h."userId" = w."userId"
      AND h."billingMode" = 'direct_usage' AND h."status" IN ('dispatched', 'unknown')
      AND (${excludeEventId ?? null}::TEXT IS NULL OR h."eventId" <> ${excludeEventId ?? null})), 0)::BIGINT AS "outstandingCents"
    FROM "GatewayWallet" w WHERE w."userId" = ${userId}`;
  const balanceCents = rows[0]?.balanceCents ?? 0, reservedCents = Number(rows[0]?.reservedCents ?? 0);
  const outstandingCents = Number(rows[0]?.outstandingCents ?? 0);
  if (!Number.isSafeInteger(reservedCents) || reservedCents < 0) throw new GatewayBillingError("HOLD_ACCOUNTING_INVALID", "冻结余额计算失败", 503);
  if (!Number.isSafeInteger(outstandingCents) || outstandingCents < 0) throw new GatewayBillingError("HOLD_ACCOUNTING_INVALID", "已确认消费计算失败", 503);
  return { balanceCents, reservedCents, outstandingCents, availableCents: Math.max(0, balanceCents - reservedCents - outstandingCents) };
}

export async function reserveGatewayBillingHold(input: {
  auth: GatewayAuth; billingSnapshot: GatewayBillingSnapshot; eventId: string; quoteCents: number;
  requestFingerprint: string; endpoint: string; provider: string; model: string; idempotencyKey?: string;
  billingMode?: "reservation" | "direct_usage" | "prepaid_quote";
  // Optional durable job binding, committed atomically with the first reservation.
  // Throwing rolls back both records; replays never recreate or reprice a job.
  onReserved?: (tx: Tx, hold: GatewayBillingHold) => Promise<void>;
}) {
  event(input.eventId); money(input.quoteCents); fingerprint(input.requestFingerprint);
  const billingMode = input.billingMode ?? "reservation";
  if (!["reservation", "direct_usage", "prepaid_quote"].includes(billingMode)) throw new GatewayBillingError("INVALID_BILLING_MODE", "计费方式无效");
  if (billingMode === "prepaid_quote" && input.quoteCents <= 0) throw new GatewayBillingError("INVALID_SUBMISSION_PRICE", "本次报价必须大于零", 503);
  validIdentifier(input.auth.userId, "账号");
  for (const key of ["endpoint", "provider", "model"] as const) validIdentifier(input[key], key, 256);
  const frozen = snapshot(input.billingSnapshot, input.auth.userId);
  if (input.idempotencyKey !== undefined) validIdentifier(input.idempotencyKey, "幂等标识", 200);
  const idempotencyHash = input.idempotencyKey === undefined ? null : createHash("sha256").update(input.idempotencyKey).digest("hex");
  await refreshGatewaySharedPoolFromSource();
  return prisma.$transaction(async tx => {
    await lockGatewayAccountingIdentities(tx, [input.auth.userId]);
    const user = await tx.user.findUnique({ where: { id: input.auth.userId } });
    if (!user || user.status !== "active" || user.tenantId !== frozen.tenantId || user.username !== frozen.username || input.auth.username !== user.username) {
      throw new GatewayBillingError("ACCOUNT_UNAVAILABLE", "当前计费账号已失效", 401);
    }
    if (input.auth.apiKeyId) {
      const key = await tx.gatewayApiKey.findUnique({ where: { id: input.auth.apiKeyId } });
      if (!key || key.userId !== user.id || key.status !== "active") throw new GatewayBillingError("ACCOUNT_UNAVAILABLE", "当前调用凭证已失效", 401);
    }
    await lockGatewayBillingWallet(tx, user.id);
    const previous = await tx.$queryRaw<HoldRow[]>`SELECT * FROM "GatewayBillingHold" WHERE "eventId" = ${input.eventId}
      OR ("userId" = ${user.id} AND "idempotencyHash" = ${idempotencyHash})`;
    if (previous.length) {
      const row = previous[0];
      if (previous.length !== 1 || row.userId !== user.id || row.apiKeyId !== input.auth.apiKeyId || row.requestFingerprint !== input.requestFingerprint ||
          row.endpoint !== input.endpoint || row.provider !== input.provider || row.model !== input.model || row.idempotencyHash !== idempotencyHash) {
        throw new GatewayBillingError("BILLING_EVENT_CONFLICT", "幂等标识已用于其他请求", 409);
      }
      // Replay returns the original quote/snapshot even when live plan rules have changed.
      return { hold: view(row), replayed: true, shouldDispatch: false };
    }
    if (idempotencyHash && (await tx.$queryRaw<Array<{userId:string}>>`SELECT "userId" FROM "GatewayBillingCancellation" WHERE "userId"=${user.id} AND "idempotencyHash"=${idempotencyHash}`).length) throw new GatewayBillingError("REQUEST_CANCELLED", "本次请求已取消", 409);
    await assertGatewayPoolNewQuote(tx, frozen);
    const available = await getGatewayAvailableBalance(tx, user.id);
    const requiredCents = billingMode === "direct_usage" ? 1 : input.quoteCents;
    if (available.availableCents < requiredCents) throw new GatewayBillingError("INSUFFICIENT_BALANCE", "可用积分不足，请先购买积分", 402);
    await tx.$executeRaw`INSERT INTO "GatewayBillingHold" ("eventId", "userId", "tenantId", "apiKeyId", "idempotencyHash", "requestFingerprint", "endpoint", "provider", "model", "quoteCents", "heldCents", "billingMode", "chargedCents", "billingSnapshot")
      VALUES (${input.eventId}, ${user.id}, ${frozen.tenantId}, ${input.auth.apiKeyId}, ${idempotencyHash}, ${input.requestFingerprint}, ${input.endpoint}, ${input.provider}, ${input.model}, ${input.quoteCents}, ${billingMode === "reservation" ? input.quoteCents : 0}, ${billingMode}, ${billingMode === "prepaid_quote" ? input.quoteCents : 0}, ${JSON.stringify(frozen)}::JSONB)`;
    const row = await load(tx, user.id, input.eventId);
    if (billingMode === "prepaid_quote") await postSubmissionMoney(tx, row);
    await journal(tx, row, "reserved", billingMode === "prepaid_quote" ? "prepaid_quote_charged" : billingMode === "direct_usage" ? "direct_usage_no_reservation" : "");
    if (input.onReserved) await input.onReserved(tx, view(row));
    return { hold: view(row), replayed: false, shouldDispatch: true };
  }, { maxWait: 10_000, timeout: 20_000 });
}

/** Persist before the network request. A second worker never receives permission to dispatch again. */
export async function markGatewayBillingHoldDispatched(input: { userId: string; eventId: string }) {
  event(input.eventId);
  await refreshGatewaySharedPoolFromSource();
  const result = await prisma.$transaction(async tx => {
    await lockGatewayBillingWallet(tx, input.userId);
    const row = await load(tx, input.userId, input.eventId);
    if (row.status !== "reserved" || row.cancelledAt) return { hold: view(row), shouldDispatch: false };
    await assertGatewayPoolNewQuote(tx, row.billingSnapshot);
    if (row.billingMode === "direct_usage" && (await getGatewayAvailableBalance(tx, input.userId)).availableCents <= 0) {
      return { hold: view(await update(tx, row, "released", "pre_dispatch")), shouldDispatch: false, balanceRejected: true };
    }
    await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "status" = 'dispatched', "dispatchedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "eventId" = ${row.eventId}`;
    await journal(tx, row, "dispatched");
    return { hold: view(await load(tx, input.userId, input.eventId)), shouldDispatch: true };
  });
  if ("balanceRejected" in result && result.balanceRejected) throw new GatewayBillingError("INSUFFICIENT_BALANCE", "可用积分不足，本次未提交生成，请先购买积分", 402);
  return result;
}

/** Bind the actual provider credential before each permitted POST without changing the hold or frozen quote. */
export async function bindGatewayBillingHoldCredential(input: { userId: string; eventId: string; credentialId: string; nativeDispatch?: Omit<NativeDispatchBinding,"tariffHash"|"credentialId"> }) {
  event(input.eventId); validIdentifier(input.userId, "账号");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.credentialId)) throw new GatewayBillingError("INVALID_SUPPLY_CREDENTIAL", "供应凭据标识无效");
  await refreshGatewaySharedPoolFromSource();
  return prisma.$transaction(async tx => {
    await lockGatewayBillingWallet(tx, input.userId);
    const row = await load(tx, input.userId, input.eventId);
    if (row.status !== "dispatched" || row.cancelledAt) throw new GatewayBillingError("HOLD_NOT_DISPATCHED", "当前冻结记录不能变更供应凭据", 409);
    await assertGatewayPoolNewQuote(tx, row.billingSnapshot);
    const credentials = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "GatewaySupplyCredential"
      WHERE "id" = ${input.credentialId} AND "userId" = ${input.userId} AND "status" = 'ready'`;
    if (!credentials.length) throw new GatewayBillingError("SUPPLY_CREDENTIAL_MISMATCH", "供应凭据不属于当前账号或尚未就绪", 403);
    let sourceBinding: SharedHoldBinding | undefined | null;
    const previous=row.sourceBinding as SharedHoldBinding | null;
    if (previous?.bindingPurpose==="native_funding") {
      const d=input.nativeDispatch;
      if (!d || d.jobId!==previous.nativeDispatch?.jobId) throw new GatewayBillingError("POOL_SOURCE_USAGE_UNPROVEN","原视频供应绑定需核对",409);
      const runtime=await getUserSupplyCredential(input.userId,input.credentialId);
      if (createHash("sha256").update(runtime.apiKey).digest("hex")!==d.keyFingerprint) throw new GatewayBillingError("POOL_SOURCE_USAGE_UNPROVEN","原视频供应绑定需核对",409);
      const changed=await tx.gatewayNativeVideoJob.updateMany({where:{id:d.jobId,userId:input.userId,eventId:row.eventId,providerTaskId:null,state:{in:["reserved","submitting"]}},data:{credentialId:input.credentialId,bindingFingerprint:d.bindingFingerprint}});
      if (changed.count!==1) throw new GatewayBillingError("POOL_SOURCE_USAGE_UNPROVEN","原视频已受理，不能变更供应绑定",409);
      sourceBinding=await bindGatewayNativePoolFunding(tx,row.eventId,d);
    } else sourceBinding = await assertGatewayPoolCredential(tx, input.userId, input.credentialId);
    if (row.sourceBinding && previous?.bindingPurpose!=="native_funding" && (row.credentialId !== input.credentialId || contractHash(row.sourceBinding) !== contractHash(sourceBinding))) throw new GatewayBillingError("SUPPLY_CREDENTIAL_MISMATCH", "供应绑定已固定", 409);
    await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "credentialId" = ${input.credentialId}, "sourceBinding" = ${sourceBinding ? JSON.stringify(sourceBinding) : null}::JSONB, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE "eventId" = ${input.eventId} AND "userId" = ${input.userId} AND "status" = 'dispatched'`;
    return { hold: view(await load(tx, input.userId, input.eventId)) };
  });
}

/** Explicit local platform binding. Fingerprints are operator-approved references, never provider IDs. */
export async function bindGatewayBillingHoldSharedSource(input: { userId: string; eventId: string; credentialFingerprint: string }) {
  event(input.eventId); validIdentifier(input.userId, "账号"); fingerprint(input.credentialFingerprint);
  await refreshGatewaySharedPoolFromSource();
  return prisma.$transaction(async tx => {
    await lockGatewayBillingWallet(tx, input.userId);
    const user = await tx.user.findUnique({where:{id:input.userId}});
    if (!user || user.status !== "active") throw new GatewayBillingError("ACCOUNT_UNAVAILABLE", "当前计费账号已失效", 401);
    const row = await load(tx,input.userId,input.eventId);
    if (row.cancelledAt || !["reserved","dispatched"].includes(row.status) || row.provider !== "shaozhuang" || row.credentialId) throw new GatewayBillingError("POOL_SHARED_CREDENTIAL_BINDING_REQUIRED", "当前冻结不能绑定共享供应",409);
    const binding = await gatewaySharedHoldBinding(tx,input.credentialFingerprint);
    if (row.sourceBinding && contractHash(row.sourceBinding) !== contractHash(binding)) throw new GatewayBillingError("SUPPLY_CREDENTIAL_MISMATCH", "供应绑定已固定",409);
    await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "sourceBinding" = ${JSON.stringify(binding)}::JSONB, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "eventId" = ${input.eventId}`;
    return {hold:view(await load(tx,input.userId,input.eventId))};
  },{maxWait:10_000,timeout:20_000});
}

/** Internal durable settlement quote; no request body or credential is returned. */
export async function getGatewayBillingHoldPricing(userId: string, eventId: string) {
  const row = await prisma.gatewayBillingHold.findUnique({where:{eventId},select:{userId:true,billingSnapshot:true,endpoint:true,model:true,billingMode:true}});
  if (!row || row.userId !== userId) throw new GatewayBillingError("BILLING_HOLD_NOT_FOUND","冻结记录不存在",404);
  return {billingSnapshot:row.billingSnapshot as unknown as GatewayBillingSnapshot,endpoint:row.endpoint,model:row.model,billingMode:row.billingMode};
}

/** Internal settlement scope lookup; no credential values leave this method. */
export async function isGatewaySharedBillingHold(userId: string, eventId: string) {
  const row = await prisma.gatewayBillingHold.findUnique({where:{eventId},select:{userId:true,sourceBinding:true}});
  return row?.userId === userId && !!row.sourceBinding && (row.sourceBinding as unknown as SharedHoldBinding).scope === "shared_user_lifetime_wallet";
}

/** Poll the same server platform credential that created this user's video. No provider call or financial write. */
export async function getGatewaySharedVideoSupplyBinding(userId: string, requestId: string): Promise<SharedHoldBinding | null> {
  validIdentifier(userId,"账号");
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(requestId)) throw new GatewayBillingError("VIDEO_JOB_INVALID","视频任务标识无效",400);
  const usage = await prisma.gatewayUsage.findFirst({where:{userId,requestId,endpoint:"videos",status:"ok"},orderBy:{createdAt:"desc"},select:{billingEventId:true}});
  if (!usage?.billingEventId) return null;
  const hold = await prisma.gatewayBillingHold.findUnique({where:{eventId:usage.billingEventId},select:{userId:true,sourceBinding:true}});
  const binding = hold?.sourceBinding as unknown as SharedHoldBinding | null;
  if (!binding || binding.scope !== "shared_user_lifetime_wallet") return null;
  const [user,pool] = await Promise.all([prisma.user.findUnique({where:{id:userId},select:{status:true}}),prisma.gatewayCreditPool.findUnique({where:{id:"total"}})]);
  const source = pool?.sourceSnapshotId ? await prisma.gatewayCreditSourceSnapshot.findUnique({where:{id:pool.sourceSnapshotId},select:{identityHash:true}}) : null;
  if (hold?.userId !== userId || user?.status !== "active" || pool?.sourceScope !== "shared_user_lifetime_wallet" ||
    pool.accountingEpochId !== binding.epochId || source?.identityHash !== binding.sourceIdentityHash ||
    binding.configVersion !== await getGatewaySharedSourceConfigVersion()) throw new GatewayBillingError("POOL_SHARED_POLL_BINDING_CHANGED","原共享供应绑定已变化，请保留任务待核对",409);
  return binding;
}

/** Timeout, disconnect or ambiguous upstream errors retain the reservation until reconciliation. */
export async function markGatewayBillingHoldUnknown(input: { userId: string; eventId: string; reason: "timeout" | "disconnect" | "ambiguous_response" | "settlement_failed" }) {
  event(input.eventId);
  if (!["timeout", "disconnect", "ambiguous_response", "settlement_failed"].includes(input.reason)) throw new GatewayBillingError("INVALID_HOLD_REASON", "未知状态原因无效");
  return prisma.$transaction(async tx => {
    await lockGatewayBillingWallet(tx, input.userId);
    const row = await load(tx, input.userId, input.eventId);
    if (!ACTIVE.has(row.status)) return { hold: view(row), replayed: true };
    if (row.amountDueCents > 0) return { hold: view(row), replayed: true };
    if (row.status === "reserved") throw new GatewayBillingError("HOLD_NOT_DISPATCHED", "请求尚未发送，不能标为供应结果未知", 409);
    if (row.status === "unknown" && row.reason === input.reason) return { hold: view(row), replayed: true };
    return { hold: view(await update(tx, row, "unknown", input.reason)), replayed: false };
  });
}

async function refundInTransaction(tx: Tx, row: HoldRow, input: { reason: "pre_dispatch" | "confirmed_failed"; evidenceFingerprint?: string }) {
  if (row.billingMode !== "prepaid_quote") throw new GatewayBillingError("BILLING_MODE_CONFLICT", "历史计费记录不能按提交收费退款", 409);
  if (row.refundedCents || row.cancelledAt) return { hold: view(row), replayed: true };
  if (input.reason === "confirmed_failed" && (await tx.$queryRaw<Array<{id:string}>>`SELECT "id" FROM "GatewayBillingHoldEvent" WHERE "eventId"=${row.eventId} AND "userId"=${row.userId} AND "reason"='legacy_video_succeeded' LIMIT 1`).length) throw new GatewayBillingError("VIDEO_RECEIPT_MISMATCH", "原视频已确认成功，失败回执需核对", 409);
  if (input.reason === "confirmed_failed" && row.endpoint === NATIVE_VIDEO_ENDPOINT && row.usageId && (await tx.gatewayUsage.findUnique({where:{id:row.usageId},select:{status:true}}))?.status === "ok") throw new GatewayBillingError("VIDEO_RECEIPT_MISMATCH", "原视频已确认成功，失败回执需核对", 409);
  if (input.reason === "pre_dispatch" && row.status !== "reserved") throw new GatewayBillingError("HOLD_RELEASE_UNSAFE", "请求已提交，需确认失败证据", 409);
  await assertGatewaySubmissionCharge(tx, row.eventId);
  const evidence = input.evidenceFingerprint ?? createHash("sha256").update(`pre_dispatch:${row.eventId}`).digest("hex");
  await postSubmissionMoney(tx, row, true);
  await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "refundedCents"="chargedCents", "refundFingerprint"=${evidence}, "status"='released', "reason"=${input.reason}, "updatedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "eventId"=${row.eventId}`;
  await journal(tx, row, "released", "prepaid_quote_refunded", evidence);
  return { hold: view(await load(tx, row.userId, row.eventId)), replayed: false };
}

/** A confirmed failure refunds the fixed customer price, independently of supplier consumption. */
export async function refundGatewayBillingHold(input: { userId: string; eventId: string; reason: "pre_dispatch" | "confirmed_failed"; evidenceFingerprint?: string }) {
  event(input.eventId); validIdentifier(input.userId, "账号");
  if (!["pre_dispatch", "confirmed_failed"].includes(input.reason)) throw new GatewayBillingError("INVALID_HOLD_REASON", "退款原因无效");
  if (input.reason === "confirmed_failed" || input.evidenceFingerprint !== undefined) fingerprint(input.evidenceFingerprint || "");
  return prisma.$transaction(async tx => { await lockGatewayBillingWallet(tx, input.userId); return refundInTransaction(tx, await load(tx, input.userId, input.eventId), input); }, {maxWait:10_000,timeout:20_000});
}

async function cancelInTransaction(tx: Tx, row: HoldRow) {
  if (row.billingMode !== "prepaid_quote") throw new GatewayBillingError("BILLING_MODE_CONFLICT", "历史请求不适用本次取消规则", 409);
  if (row.cancelledAt || row.refundedCents) return {hold:view(row),replayed:true};
  await assertGatewaySubmissionCharge(tx, row.eventId);
  await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "cancelledAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'), "status"=CASE WHEN "status"='reserved' THEN 'released' ELSE "status" END, "updatedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "eventId"=${row.eventId}`;
  await journal(tx,row,row.status,"prepaid_quote_cancelled_no_refund");
  return {hold:view(await load(tx,row.userId,row.eventId)),replayed:false};
}
export async function cancelGatewayBillingHold(input: {userId:string;eventId:string}) {
  event(input.eventId); validIdentifier(input.userId,"账号");
  return prisma.$transaction(async tx => { await lockGatewayBillingWallet(tx,input.userId); return cancelInTransaction(tx,await load(tx,input.userId,input.eventId)); },{maxWait:10_000,timeout:20_000});
}
/** A durable early cancellation is checked under the same wallet lock before registration. */
export async function cancelGatewayBillingRequest(input: {userId:string;idempotencyKey:string}) {
  validIdentifier(input.userId,"账号"); validIdentifier(input.idempotencyKey,"幂等标识",200);
  const hash=createHash("sha256").update(input.idempotencyKey).digest("hex");
  return prisma.$transaction(async tx=>{
    await lockGatewayBillingWallet(tx,input.userId);
    const rows=await tx.$queryRaw<HoldRow[]>`SELECT * FROM "GatewayBillingHold" WHERE "userId"=${input.userId} AND "idempotencyHash"=${hash}`;
    if (rows[0]) return cancelInTransaction(tx,rows[0]);
    const n=await tx.$executeRaw`INSERT INTO "GatewayBillingCancellation" ("userId","idempotencyHash") VALUES (${input.userId},${hash}) ON CONFLICT DO NOTHING`;
    return {hold:null,replayed:n===0};
  },{maxWait:10_000,timeout:20_000});
}

/** A dispatched hold requires explicit authoritative evidence of no consumption, never a timer or HTTP status alone. */
export async function releaseGatewayBillingHold(input: { userId: string; eventId: string; reason: "pre_dispatch" | "confirmed_not_consumed"; evidenceFingerprint?: string }) {
  event(input.eventId);
  if (!["pre_dispatch", "confirmed_not_consumed"].includes(input.reason)) throw new GatewayBillingError("INVALID_HOLD_REASON", "释放原因无效");
  if (input.reason === "confirmed_not_consumed") fingerprint(input.evidenceFingerprint || "");
  return prisma.$transaction(async tx => {
    await lockGatewayBillingWallet(tx, input.userId);
    const row = await load(tx, input.userId, input.eventId);
    if (row.billingMode === "prepaid_quote") return refundInTransaction(tx, row, { reason: input.reason === "pre_dispatch" ? "pre_dispatch" : "confirmed_failed", evidenceFingerprint: input.evidenceFingerprint });
    if (row.status === "released") return { hold: view(row), replayed: true };
    if (row.status === "settled" || row.amountDueCents > 0 || (input.reason === "pre_dispatch" && row.status !== "reserved")) throw new GatewayBillingError("HOLD_RELEASE_UNSAFE", "原请求已有消费或仍待核对，不能撤销计费记录", 409);
    await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "amountDueCents" = 0 WHERE "eventId" = ${row.eventId}`;
    return { hold: view(await update(tx, row, "released", input.reason, input.evidenceFingerprint ?? null)), replayed: false };
  });
}

/** The callback writes the existing usage/debit ledger in this transaction; this module never creates a second debit. */
export async function settleGatewayBillingHold(input: {
  userId: string; eventId: string; finalCostCents: number; outcomeFingerprint: string;
  writeUsage: (tx: Tx, frozen: { billingSnapshot: GatewayBillingSnapshot; eventId: string }) => Promise<unknown>;
}) {
  event(input.eventId); money(input.finalCostCents); fingerprint(input.outcomeFingerprint);
  const result = await prisma.$transaction(async tx => {
    await lockGatewayBillingWallet(tx, input.userId);
    const row = await load(tx, input.userId, input.eventId);
    const prepaid = row.billingMode === "prepaid_quote";
    if (row.status === "settled" || (prepaid && row.usageId)) {
      if (row.settledCents !== input.finalCostCents || row.outcomeFingerprint !== input.outcomeFingerprint) throw new GatewayBillingError("BILLING_EVENT_CONFLICT", "结算事件已用于不同结果", 409);
      return { hold: view(row), replayed: true, insufficient: false };
    }
    if (!["dispatched", "unknown"].includes(row.status) && !(prepaid && row.status === "released" && row.dispatchedAt)) throw new GatewayBillingError("HOLD_NOT_SETTLEABLE", "冻结状态不能结算", 409);
    if (row.amountDueCents > 0 && (row.amountDueCents !== input.finalCostCents || row.outcomeFingerprint !== input.outcomeFingerprint)) {
      throw new GatewayBillingError("BILLING_EVENT_CONFLICT", "已确认消费不能改为不同结果", 409);
    }
    const available = await getGatewayAvailableBalance(tx, input.userId, row.eventId);
    if (!prepaid && available.availableCents < input.finalCostCents) {
      // A known larger charge is a liability, even when the original quote was smaller. Preserve the original quote separately.
      if (row.billingMode === "direct_usage") {
        await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "amountDueCents" = ${input.finalCostCents}, "outcomeFingerprint" = ${input.outcomeFingerprint}, "status" = 'unknown', "reason" = 'insufficient_settlement', "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "eventId" = ${row.eventId}`;
      } else {
        await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "heldCents" = GREATEST("heldCents", ${input.finalCostCents}), "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "eventId" = ${row.eventId}`;
      }
      const changed = await update(tx, row, "unknown", "insufficient_settlement", input.outcomeFingerprint);
      return { hold: view(changed), replayed: false, insufficient: true };
    }
    await tx.$executeRawUnsafe("SAVEPOINT gateway_hold_usage");
    settlementContexts.set(tx, row.eventId);
    settlementOutcomes.set(tx, input.outcomeFingerprint);
    try { await input.writeUsage(tx, { billingSnapshot: row.billingSnapshot, eventId: row.eventId }); await tx.$executeRawUnsafe("RELEASE SAVEPOINT gateway_hold_usage"); }
    catch (error) {
      if (!(error instanceof GatewayBillingError) || error.code !== "POOL_SOURCE_USAGE_UNPROVEN") throw error;
      // A late evidence failure must not commit wallet/journals written earlier in the callback.
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT gateway_hold_usage");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT gateway_hold_usage");
      const changed = await update(tx, row, prepaid && row.status === "released" ? "released" : "unknown", "source_usage_unproven", input.outcomeFingerprint);
      return { hold: view(changed), replayed: false, insufficient: false, sourceUnproven: true };
    }
    finally { settlementContexts.delete(tx); settlementOutcomes.delete(tx); }
    const after = await getGatewayAvailableBalance(tx, input.userId, row.eventId);
    const entries = await tx.$queryRaw<{ userId: string; chargedCostCents: number; baseCostCents: number; usageId: string | null; kind: string }[]>`SELECT "userId", "chargedCostCents", "baseCostCents", "usageId", "kind" FROM "GatewayBillingLedger" WHERE "billingEventId" = ${row.eventId}`;
    const entry = entries[0];
    if (after.balanceCents !== available.balanceCents - (prepaid ? 0 : input.finalCostCents) || !entry || entry.userId !== row.userId ||
        entry.chargedCostCents !== (prepaid ? 0 : input.finalCostCents) || !entry.usageId ||
        !(prepaid ? entry.kind === "usage" && applyGatewayBillingCost(entry.baseCostCents, row.billingSnapshot) === input.finalCostCents : ["debit", "error"].includes(entry.kind))) {
      throw new GatewayBillingError("HOLD_SETTLEMENT_INVALID", "结算与现有扣费账本不一致，事务已回退", 503);
    }
    if (prepaid) await assertGatewaySubmissionCharge(tx, row.eventId);
    await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "status" = ${prepaid && row.status === "released" ? "released" : "settled"}, "heldCents" = CASE WHEN "billingMode" IN ('direct_usage','prepaid_quote') THEN 0 ELSE GREATEST("heldCents", ${input.finalCostCents}) END, "amountDueCents" = 0, "settledCents" = ${input.finalCostCents}, "outcomeFingerprint" = ${input.outcomeFingerprint}, "usageId" = ${entry.usageId}, "reason" = ${prepaid && row.status === "released" ? row.reason : ""}, "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "eventId" = ${row.eventId}`;
    await journal(tx, row, "settled", "", input.outcomeFingerprint);
    return { hold: view(await load(tx, input.userId, input.eventId)), replayed: false, insufficient: false };
  }, { maxWait: 10_000, timeout: 20_000 });
  if (result.insufficient) throw new GatewayBillingError("INSUFFICIENT_BALANCE", "实际消费已确认，积分不足，请补足积分后继续结算", 402);
  if ("sourceUnproven" in result && result.sourceUnproven) throw new GatewayBillingError("POOL_SOURCE_USAGE_UNPROVEN",
    result.hold.billingMode === "prepaid_quote" ? result.hold.refundedCents ? "本次已退款，供应用量仍待核对" : "供应用量仍待核对，积分已按提交时报价记录" : "供应计费依据尚待核对，本次未扣积分", 409);
  return { hold: result.hold, replayed: result.replayed };
}

/** Apply the user's no-reservation policy to an unpriced legacy native request.
 * The unknown task, quote and binding remain intact. This is not a refund or
 * evidence of success/failure and creates no wallet or consumption ledger entry.
 */
export async function adoptDirectNativeBillingHold(input: { userId: string; eventId: string; expectedHeldCents: number }) {
  event(input.eventId); validIdentifier(input.userId, "账号"); money(input.expectedHeldCents);
  return prisma.$transaction(async tx => {
    await lockGatewayBillingWallet(tx, input.userId);
    const row = await load(tx, input.userId, input.eventId);
    if (row.billingMode === "direct_usage") return { hold: view(row), replayed: true };
    if (row.endpoint !== NATIVE_VIDEO_ENDPOINT || !ACTIVE.has(row.status) || row.heldCents !== input.expectedHeldCents ||
        row.reason === "insufficient_settlement") throw new GatewayBillingError("DIRECT_BILLING_POLICY_CONFLICT", "原视频记录已变化，未调整积分占用", 409);
    const jobs = await tx.$queryRaw<{ completionTokens: number | null }[]>`SELECT "completionTokens" FROM "GatewayNativeVideoJob"
      WHERE "eventId" = ${row.eventId} AND "userId" = ${row.userId} AND "tenantId" = ${row.tenantId}`;
    if (jobs.length !== 1 || jobs[0].completionTokens !== null) throw new GatewayBillingError("DIRECT_BILLING_POLICY_CONFLICT", "原视频已有消费依据，请先按实际用量结算", 409);
    const evidence = createHash("sha256").update(JSON.stringify({ policy: "direct_usage_v1", eventId: row.eventId,
      userId: row.userId, previousHeldCents: row.heldCents, quoteCents: row.quoteCents, status: row.status })).digest("hex");
    await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "billingMode" = 'direct_usage', "heldCents" = 0,
      "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "eventId" = ${row.eventId} AND "userId" = ${row.userId}`;
    await journal(tx, row, row.status, "direct_usage_policy_applied", evidence);
    return { hold: view(await load(tx, input.userId, input.eventId)), replayed: false };
  }, { maxWait: 10_000, timeout: 20_000 });
}

/** Read-only reconciliation inventory. Authorization belongs to the caller's admin/session boundary. Never auto-releases. */
export async function listGatewayBillingHoldsPendingReconciliation(input: { userId?: string; limit?: number } = {}) {
  if (input.userId !== undefined) validIdentifier(input.userId, "账号");
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GatewayBillingError("INVALID_QUERY", "核账列表数量须为 1 至 100");
  return prisma.$queryRaw<Array<{
    eventId: string; userId: string; tenantId: string; endpoint: string; provider: string; model: string;
    quoteCents: number; heldCents: number; status: "reserved" | "dispatched" | "unknown"; reason: string;
    createdAt: Date; updatedAt: Date; dispatchedAt: Date | null;
  }>>`SELECT "eventId", "userId", "tenantId", "endpoint", "provider", "model", "quoteCents", "heldCents", "status", "reason", "createdAt", "updatedAt", "dispatchedAt"
    FROM "GatewayBillingHold" WHERE "status" IN ('reserved', 'dispatched', 'unknown') AND (${input.userId ?? null}::TEXT IS NULL OR "userId" = ${input.userId ?? null})
    ORDER BY "updatedAt" ASC, "eventId" ASC LIMIT ${limit}`;
}
