import "server-only";
import { prisma } from "@/lib/db";
import { findGatewayVideoJob, reconcileGatewayVideoTerminal } from "./video-jobs";
import { getUserSupplyCredential } from "./user-supply";
import { getGatewaySharedVideoSupplyBinding } from "./billing-hold";
import { getGatewaySharedPlatformRuntime } from "./shared-wallet-source";
import { getRelayRuntime } from "./relay-config";
import { relayFetch } from "./relay-network";

type Pending = { eventId: string; userId: string; requestId: string };
export type GatewayVideoReconcileOptions = { limit?: number; concurrency?: number; minAgeMs?: number };
function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}`);
  return result;
}

/** One pass over original accepted compatibility tasks. No create/retry or POST. */
export async function reconcileGatewayVideoJobs(options: GatewayVideoReconcileOptions = {}) {
  const limit = bounded(options.limit, 20, 1, 100, "limit");
  const concurrency = bounded(options.concurrency, 2, 1, 4, "concurrency");
  const minAgeMs = bounded(options.minAgeMs, 30_000, 1_000, 86_400_000, "minAgeMs");
  const cutoff = new Date(Date.now() - minAgeMs);
  const jobs = await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Pending[]>`SELECT h."eventId", h."userId", u."requestId"
      FROM "GatewayBillingHold" h JOIN "GatewayUsage" u ON u."id" = h."usageId" AND u."userId" = h."userId"
      WHERE h."billingMode" = 'prepaid_quote' AND h."endpoint" = 'videos' AND h."status" = 'settled'
        AND h."refundedCents" = 0 AND h."cancelledAt" IS NULL AND u."status" = 'ok' AND u."requestId" <> ''
        AND h."updatedAt" <= ${cutoff} AND NOT EXISTS (SELECT 1 FROM "GatewayBillingHoldEvent" e
          WHERE e."eventId" = h."eventId" AND e."userId" = h."userId" AND e."reason" = 'legacy_video_succeeded')
      ORDER BY h."updatedAt", h."eventId" LIMIT ${limit} FOR UPDATE OF h SKIP LOCKED`;
    for (const row of rows) await tx.$executeRaw`UPDATE "GatewayBillingHold" SET "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      WHERE "eventId" = ${row.eventId} AND "userId" = ${row.userId}`;
    return rows;
  }, { maxWait: 5_000, timeout: 10_000 });
  const result = { claimed: jobs.length, completed: 0, failed: 0, cancelled: 0, pending: 0, settled: 0, errors: 0, errorCodes: {} as Record<string, number> };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const row = jobs[next++];
      try {
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(row.requestId)) throw new Error("Invalid original task");
        const job = await findGatewayVideoJob(row.userId, row.requestId);
        if (!job || job.billingEventId !== row.eventId || job.provider !== "shaozhuang") throw new Error("Original binding unavailable");
        let supply;
        if (job.credentialId) supply = await getUserSupplyCredential(row.userId, job.credentialId);
        else {
          const binding = await getGatewaySharedVideoSupplyBinding(row.userId, row.requestId);
          if (binding) {
            const runtime = await getGatewaySharedPlatformRuntime();
            if (runtime.baseUrl !== binding.providerBaseUrl || runtime.credentialFingerprint !== binding.credentialFingerprint ||
                runtime.configVersion !== binding.configVersion || runtime.epoch && runtime.epoch.id !== binding.epochId) throw new Error("Original shared binding changed");
            supply = runtime;
          } else supply = await getRelayRuntime();
        }
        if (!supply.apiKey || supply.baseUrl.replace(/\/+$/, "") !== job.baseUrl.replace(/\/+$/, "")) throw new Error("Original binding changed");
        const response = await relayFetch(`${job.baseUrl}/videos/${encodeURIComponent(row.requestId)}`, {
          method: "GET", cache: "no-store", headers: { Authorization: `Bearer ${supply.apiKey}` }, signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok || !response.body) throw new Error("Receipt unavailable");
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
        while (true) {
          const item = await reader.read(); if (item.done) break;
          length += item.value.byteLength;
          if (length > 512 * 1024) { await reader.cancel(); throw new Error("Receipt too large"); }
          chunks.push(item.value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid receipt");
        const state = await reconcileGatewayVideoTerminal(row.userId, row.requestId, job, data as Record<string, unknown>);
        result.settled++;
        if (state === "succeeded") result.completed++;
        else if (state === "failed") result.failed++;
        else if (state === "cancelled") result.cancelled++;
        else result.pending++;
      } catch { result.errors++; result.errorCodes.GATEWAY_VIDEO_RECEIPT_UNAVAILABLE = (result.errorCodes.GATEWAY_VIDEO_RECEIPT_UNAVAILABLE ?? 0) + 1; } // Counts only: no private provider messages, URLs, or credentials.
    }
  }));
  return result;
}
