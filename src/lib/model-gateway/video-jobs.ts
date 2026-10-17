import "server-only";
import { prisma } from "@/lib/db";

/** Video ownership uses existing gateway usage rows; no schema or credentials are added. */
export async function findGatewayVideoJob(userId: string, requestId: string) {
  const usage = await prisma.gatewayUsage.findFirst({
    where: { userId, requestId, endpoint: "videos", status: "ok" },
    orderBy: { createdAt: "desc" },
    select: { model: true, provider: true, metadata: true }
  });
  if (!usage || !usage.metadata || typeof usage.metadata !== "object" || Array.isArray(usage.metadata)) return null;
  const metadata = usage.metadata as Record<string, unknown>;
  if (typeof metadata.baseUrl !== "string" || typeof metadata.upstreamModel !== "string") return null;
  if (metadata.credentialId !== undefined &&
    (typeof metadata.credentialId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(metadata.credentialId))) return null;
  return {
    model: usage.model,
    provider: usage.provider,
    baseUrl: metadata.baseUrl,
    upstreamModel: metadata.upstreamModel,
    ...(typeof metadata.credentialId === "string" ? { credentialId: metadata.credentialId } : {})
  };
}
