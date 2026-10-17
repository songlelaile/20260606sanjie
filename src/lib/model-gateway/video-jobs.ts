import "server-only";
import { refundGatewayBillingHold, cancelGatewayBillingHold, getGatewayBillingHoldPricing } from "./billing-hold";
import { gatewayOutcomeFingerprint } from "./billing-request";
import { GatewayBillingError } from "./billing-contract";
import { lockGatewayBillingWallet } from "./billing";
import { prisma } from "@/lib/db";

/** Video ownership uses existing gateway usage rows; no schema or credentials are added. */
export async function findGatewayVideoJob(userId: string, requestId: string) {
  const usage = await prisma.gatewayUsage.findFirst({
    where: { userId, requestId, endpoint: "videos", status: "ok" },
    orderBy: { createdAt: "desc" },
    select: { model: true, provider: true, metadata: true, billingEventId: true }
  });
  if (!usage || !usage.metadata || typeof usage.metadata !== "object" || Array.isArray(usage.metadata)) return null;
  const metadata = usage.metadata as Record<string, unknown>;
  if (typeof metadata.baseUrl !== "string" || typeof metadata.upstreamModel !== "string") return null;
  if (metadata.credentialId !== undefined && (typeof metadata.credentialId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(metadata.credentialId))) return null;
  return {
    billingEventId: usage.billingEventId,
    model: usage.model,
    provider: usage.provider,
    baseUrl: metadata.baseUrl,
    upstreamModel: metadata.upstreamModel,
    ...(typeof metadata.credentialId === "string" ? { credentialId: metadata.credentialId } : {})
  };
}

/** Only a terminal receipt for the original bound task can change its customer charge. */
export async function reconcileGatewayVideoTerminal(userId: string, taskId: string,
  job: { billingEventId?: string | null }, data: Record<string, unknown>) {
  if (!job.billingEventId) return; // Pre-billing legacy rows cannot invent a refund.
  const objects = [data, data.data, data.video].filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  const states = objects.flatMap(item => [item.status, item.state]).filter((value): value is string => typeof value === "string").map(value => value.toLowerCase());
  const failed = states.includes("failed");
  const cancelled = states.includes("cancelled") || states.includes("canceled");
  const succeeded = states.some(state => ["succeeded", "completed", "success"].includes(state));
  if (!failed && !cancelled && !succeeded) return;
  const ids = objects.flatMap(item => [item.id, item.request_id, item.task_id]).filter(value => typeof value === "string");
  if (!ids.includes(taskId)) throw new GatewayBillingError("VIDEO_RECEIPT_MISMATCH", "视频回执与原任务不一致", 502);
  const hold = await getGatewayBillingHoldPricing(userId, job.billingEventId);
  if (hold.billingMode !== "prepaid_quote") return; // Historical reservation records keep their original policy.
  if ([failed, cancelled, succeeded].filter(Boolean).length > 1) {
    throw new GatewayBillingError("VIDEO_RECEIPT_MISMATCH", "视频回执状态矛盾，保留原任务核对", 502);
  }
  const marker = "legacy-video-terminal:" + gatewayOutcomeFingerprint({ eventId: job.billingEventId });
  if (succeeded) {
    await prisma.$transaction(async tx => {
      await lockGatewayBillingWallet(tx, userId);
      const rows = await tx.$queryRaw<{refundedCents: number}[]>`SELECT "refundedCents" FROM "GatewayBillingHold"
        WHERE "eventId" = ${job.billingEventId} AND "userId" = ${userId} FOR UPDATE`;
      if (!rows[0] || rows[0].refundedCents > 0) throw new GatewayBillingError("VIDEO_RECEIPT_MISMATCH", "原任务已退款，保留矛盾成功回执待核对", 502);
      await tx.$executeRaw`INSERT INTO "GatewayBillingHoldEvent" ("id", "eventId", "userId", "transition", "reason", "evidenceFingerprint")
        VALUES (${marker}, ${job.billingEventId}, ${userId}, 'settled', 'legacy_video_succeeded',
          ${gatewayOutcomeFingerprint({taskId, status: "succeeded"})}) ON CONFLICT ("id") DO NOTHING`;
    });
    return "succeeded";
  }
  const terminal = await prisma.$queryRaw<{id: string}[]>`SELECT "id" FROM "GatewayBillingHoldEvent"
    WHERE "id" = ${marker} AND "eventId" = ${job.billingEventId} AND "userId" = ${userId}`;
  if (terminal.length) throw new GatewayBillingError("VIDEO_RECEIPT_MISMATCH", "原视频已确认成功，保留矛盾回执待核对", 502);
  if (cancelled) { await cancelGatewayBillingHold({ userId, eventId: job.billingEventId }); return "cancelled"; }
  await refundGatewayBillingHold({ userId, eventId: job.billingEventId, reason: "confirmed_failed",
    evidenceFingerprint: gatewayOutcomeFingerprint({ taskId, status: "failed" }) });
  return "failed";
}
