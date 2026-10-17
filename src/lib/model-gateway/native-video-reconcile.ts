import "server-only";
import { prisma } from "@/lib/db";
import { pollNativeVideo } from "./native-video";

type PendingJob = { id: string; userId: string; tenantId: string; username: string };
export type NativeVideoReconcileOptions = { limit?: number; concurrency?: number; minAgeMs?: number };

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`Invalid ${name}`);
  return result;
}

/** One bounded pass over accepted original tasks. Never creates or retries a POST.
 * The timestamp claim throttles provider GETs across concurrent processes; it
 * changes no financial amounts or terminal task state. Lost claims become
 * eligible again after minAgeMs, using the same original provider binding.
 */
export async function reconcileNativeVideoJobs(options: NativeVideoReconcileOptions = {}) {
  const limit = bounded(options.limit, 20, 1, 100, "limit");
  const concurrency = bounded(options.concurrency, 2, 1, 4, "concurrency");
  const minAgeMs = bounded(options.minAgeMs, 30_000, 1_000, 86_400_000, "minAgeMs");
  const cutoff = new Date(Date.now() - minAgeMs);
  const jobs = await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<PendingJob[]>`SELECT j."id", j."userId", j."tenantId", u."username"
      FROM "GatewayNativeVideoJob" j
      JOIN "GatewayBillingHold" h ON h."eventId" = j."eventId" AND h."userId" = j."userId" AND h."tenantId" = j."tenantId"
      JOIN "User" u ON u."id" = j."userId" AND u."tenantId" = j."tenantId"
      WHERE (j."state" IN ('processing', 'unknown') OR
          (j."state" = 'failed' AND h."billingMode" = 'prepaid_quote' AND j."completionTokens" IS NOT NULL AND h."usageId" IS NULL))
        AND j."providerTaskId" IS NOT NULL
        AND (h."status" IN ('dispatched', 'unknown', 'settled') OR
          (h."status" = 'released' AND h."billingMode" = 'prepaid_quote'))
        AND (u."status" = 'active' OR h."billingMode" = 'prepaid_quote') AND j."updatedAt" <= ${cutoff}
      ORDER BY j."updatedAt", j."id" LIMIT ${limit} FOR UPDATE OF j SKIP LOCKED`;
    for (const row of rows) await tx.$executeRaw`UPDATE "GatewayNativeVideoJob"
      SET "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE "id" = ${row.id}
        AND "userId" = ${row.userId} AND "tenantId" = ${row.tenantId}`;
    return rows;
  }, { maxWait: 5_000, timeout: 10_000 });

  const result = { claimed: jobs.length, completed: 0, failed: 0, pending: 0, settled: 0, errors: 0, errorCodes: {} as Record<string, number> };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const row = jobs[next++];
      try {
        const job = await pollNativeVideo({ id: row.userId, tenantId: row.tenantId, username: row.username }, row.id);
        if (job.status === "succeeded") result.completed++;
        else if (job.status === "failed") result.failed++;
        else result.pending++;
        if (job.billing.settledCents !== null) result.settled++;
      } catch (error) {
        result.errors++;
        // Private provider messages, URLs and credentials never reach CLI logs.
        const raw = error && typeof error === "object" && "code" in error ? error.code : "NATIVE_VIDEO_RECONCILE_ERROR";
        const code = typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(raw) ? raw : "NATIVE_VIDEO_RECONCILE_ERROR";
        result.errorCodes[code] = (result.errorCodes[code] ?? 0) + 1;
      }
    }
  }));
  return result;
}
