import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { GatewayBillingSnapshot } from "./billing-contract";
import { digest, NativeVideoError, type NativeVideoOwner, type NativeVideoTariff } from "./native-video-contract";

export type NativeVideoJob = {
  id: string; userId: string; tenantId: string; eventId: string; idempotencyHash: string;
  requestFingerprint: string; bindingFingerprint: string; model: string; upstreamModel: string;
  tariff: NativeVideoTariff; providerTaskId: string | null;
  state: "reserved" | "submitting" | "unknown" | "processing" | "succeeded" | "failed";
  resultUrl: string | null; completionTokens: number | null; errorCode: string;
  quoteCents: number; heldCents: number; settledCents: number | null; holdStatus: string; billingSnapshot: GatewayBillingSnapshot;
  billingMode?: "reservation" | "direct_usage" | "prepaid_quote"; amountDueCents?: number;
  chargedCents?: number; refundedCents?: number; cancelledAt?: Date | null; usageId?: string | null;
  credentialId?: string | null;
};
type Client = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;
type NewJob = Pick<NativeVideoJob, "id" | "userId" | "tenantId" | "eventId" | "idempotencyHash" | "requestFingerprint" | "bindingFingerprint" | "model" | "upstreamModel" | "tariff" | "credentialId">;

export async function findNativeVideoJob(owner: NativeVideoOwner, key: { id: string } | { idempotencyKey: string }, db: Client = prisma) {
  const rows = "id" in key
    ? await db.$queryRaw<NativeVideoJob[]>`SELECT j.*, h."quoteCents", h."heldCents", h."settledCents", h."status" AS "holdStatus", h."billingSnapshot", h."billingMode", h."amountDueCents", h."chargedCents", h."refundedCents", h."cancelledAt", h."usageId"
        FROM "GatewayNativeVideoJob" j JOIN "GatewayBillingHold" h ON h."eventId" = j."eventId" AND h."userId" = j."userId" AND h."tenantId" = j."tenantId"
        WHERE j."id" = ${key.id} AND j."userId" = ${owner.id} AND j."tenantId" = ${owner.tenantId}`
    : await db.$queryRaw<NativeVideoJob[]>`SELECT j.*, h."quoteCents", h."heldCents", h."settledCents", h."status" AS "holdStatus", h."billingSnapshot", h."billingMode", h."amountDueCents", h."chargedCents", h."refundedCents", h."cancelledAt", h."usageId"
        FROM "GatewayNativeVideoJob" j JOIN "GatewayBillingHold" h ON h."eventId" = j."eventId" AND h."userId" = j."userId" AND h."tenantId" = j."tenantId"
        WHERE j."idempotencyHash" = ${digest(key.idempotencyKey)} AND j."userId" = ${owner.id} AND j."tenantId" = ${owner.tenantId}`;
  return rows[0] || null;
}
export async function requireNativeVideoJob(owner: NativeVideoOwner, id: string) {
  const job = await findNativeVideoJob(owner, { id });
  if (!job) throw new NativeVideoError("NATIVE_VIDEO_NOT_FOUND", "当前账号不存在该视频任务", 404);
  return job;
}
export async function findActiveNativeVideoJob(owner: NativeVideoOwner, fingerprint: string, db: Client = prisma) {
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "GatewayNativeVideoJob"
    WHERE "userId" = ${owner.id} AND "tenantId" = ${owner.tenantId} AND "requestFingerprint" = ${fingerprint}
      AND "state" IN ('reserved','submitting','unknown','processing') ORDER BY "createdAt" LIMIT 1`;
  return rows[0] ? findNativeVideoJob(owner, { id: rows[0].id }, db) : null;
}
/** Called inside the existing wallet lock / reservation transaction. */
export async function insertNativeVideoJob(db: Client, row: NewJob) {
  if (await findActiveNativeVideoJob({ id: row.userId, tenantId: row.tenantId, username: "" }, row.requestFingerprint, db)) {
    throw new NativeVideoError("NATIVE_VIDEO_ALREADY_ACTIVE", "同一视频方案已有处理中任务", 409);
  }
  await db.$executeRaw`INSERT INTO "GatewayNativeVideoJob" ("id","userId","tenantId","eventId","idempotencyHash","requestFingerprint","bindingFingerprint","model","upstreamModel","tariff","credentialId")
    VALUES (${row.id},${row.userId},${row.tenantId},${row.eventId},${row.idempotencyHash},${row.requestFingerprint},${row.bindingFingerprint},${row.model},${row.upstreamModel},${JSON.stringify(row.tariff)}::JSONB,${row.credentialId ?? null})`;
}
/** Terminal states are immutable. Stale concurrent polling cannot erase delivery. */
export async function updateNativeVideoJob(owner: NativeVideoOwner, id: string, patch: {
  state: NativeVideoJob["state"]; providerTaskId?: string; resultUrl?: string; completionTokens?: number; errorCode?: string;
  credentialId?: string; bindingFingerprint?: string;
}, db: Client = prisma) {
  await db.$executeRaw`UPDATE "GatewayNativeVideoJob" SET "state"=${patch.state},
    "providerTaskId"=COALESCE(${patch.providerTaskId ?? null},"providerTaskId"),
    "resultUrl"=COALESCE(${patch.resultUrl ?? null},"resultUrl"),
    "completionTokens"=COALESCE(${patch.completionTokens ?? null},"completionTokens"),
    "credentialId"=COALESCE(${patch.credentialId ?? null},"credentialId"),
    "bindingFingerprint"=COALESCE(${patch.bindingFingerprint ?? null},"bindingFingerprint"),
    "errorCode"=${patch.errorCode || ""}, "updatedAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    WHERE "id"=${id} AND "userId"=${owner.id} AND "tenantId"=${owner.tenantId} AND "state" NOT IN ('succeeded','failed')
      AND (${patch.completionTokens ?? null}::INTEGER IS NULL OR "completionTokens" IS NULL OR "completionTokens" = ${patch.completionTokens ?? null})`;
}
