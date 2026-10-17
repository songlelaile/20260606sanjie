import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";

export type SecurityRateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  reason?: "rate_limited" | "unavailable";
};

/**
 * PostgreSQL supplies one atomic counter shared by all application workers.
 * Only a fixed-size hash of namespace + identity is persisted; credentials,
 * request bodies, account names and IP addresses never enter the rate table.
 * Deploy the isolated SecurityRateBucket SQL before enabling this caller.
 */
export async function consumeSecurityRateLimit(
  namespace: string,
  identity: string,
  limit: number,
  windowSeconds: number,
  now = Date.now()
): Promise<SecurityRateLimitResult> {
  if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(namespace) ||
      typeof identity !== "string" || !identity || identity.length > 512 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100_000 ||
      !Number.isSafeInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400 ||
      !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - windowSeconds * 1000) {
    throw new TypeError("安全限流参数无效");
  }
  const windowMilliseconds = windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMilliseconds) * windowMilliseconds;
  const expiresAt = windowStart + windowMilliseconds;
  const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt - now) / 1000));
  const bucketKey = createHash("sha256").update(`${namespace}\0${identity}`).digest("hex");
  try {
    // Cleanup and consume are one statement. Expired buckets cannot overlap the
    // current window; ON CONFLICT serializes concurrent increments for this key.
    const rows = await prisma.$queryRaw<Array<{ hits: number }>>`
      WITH expired AS (
        DELETE FROM "SecurityRateBucket" WHERE "expiresAt" <= ${new Date(now)}
      )
      INSERT INTO "SecurityRateBucket" ("bucketKey", "windowStart", "expiresAt", "hits")
      VALUES (${bucketKey}, ${new Date(windowStart)}, ${new Date(expiresAt)}, 1)
      ON CONFLICT ("bucketKey", "windowStart")
      DO UPDATE SET "hits" = CASE WHEN "SecurityRateBucket"."hits" < 2147483647
        THEN "SecurityRateBucket"."hits" + 1 ELSE "SecurityRateBucket"."hits" END
      RETURNING "hits"
    `;
    const hits = rows[0]?.hits;
    if (!Number.isSafeInteger(hits) || hits < 1) {
      return { allowed: false, remaining: 0, retryAfterSeconds: 30, reason: "unavailable" };
    }
    return hits <= limit
      ? { allowed: true, remaining: limit - hits, retryAfterSeconds: 0 }
      : { allowed: false, remaining: 0, retryAfterSeconds, reason: "rate_limited" };
  } catch {
    // Missing migration, database failure and malformed receipts all fail closed.
    // Do not return/log an exception that may include connection credentials.
    return { allowed: false, remaining: 0, retryAfterSeconds: 30, reason: "unavailable" };
  }
}
