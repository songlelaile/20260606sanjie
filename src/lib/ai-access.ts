import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Session } from "@/lib/auth";

export type AIAccessScope = "read" | "action";
export type AIAccessActor = Pick<Session, "username" | "tenantId" | "role">;
export type AIAccessAuthorization = {
  grantId: string; userId: string; username: string; tenantId: string;
  scope: AIAccessScope; activeShopId: string | null;
};
export type AIAccessGrantView = {
  id: string; name: string; scope: AIAccessScope; activeShopId: string | null;
  createdAt: string; expiresAt: string | null; enabled: boolean;
  revokedAt: string | null; lastUsedAt: string | null;
};
export type AIAccessEventView = {
  id: string; type: string; grantName: string | null; method: string | null;
  path: string | null; status: number | null; createdAt: string;
};
export class AIAccessError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) { super(message); }
}
type Tx = Prisma.TransactionClient;
type Owner = { id: string; username: string; tenantId: string };
type Grant = {
  id: string; userId: string; username: string; tenantId: string; name: string;
  scope: AIAccessScope; activeShopId: string | null; createdAt: Date; expiresAt: Date;
  manualControl: boolean; disabledAt: Date | null;
  revokedAt: Date | null; lastUsedAt: Date | null;
  revokedByAudit?: boolean;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^sja_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const iso = (value: Date | null) => value ? value.toISOString() : null;
const view = (grant: Grant): AIAccessGrantView => ({
  id: grant.id, name: grant.name, scope: grant.scope, activeShopId: grant.activeShopId,
  createdAt: grant.createdAt.toISOString(),
  expiresAt: grant.manualControl ? null : grant.expiresAt.toISOString(),
  enabled: !grant.revokedByAudit && grant.revokedAt === null && grant.disabledAt === null,
  revokedAt: grant.disabledAt === null || grant.revokedByAudit ? iso(grant.revokedAt) : null,
  lastUsedAt: iso(grant.lastUsedAt)
});
const authorization = (grant: Grant): AIAccessAuthorization => ({
  grantId: grant.id, userId: grant.userId, username: grant.username, tenantId: grant.tenantId,
  scope: grant.scope, activeShopId: grant.activeShopId
});

async function transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
  try { return await prisma.$transaction(operation); }
  catch (error) {
    if (error instanceof AIAccessError) throw error;
    // Audit/database failures close the channel without serializing credentials.
    throw new AIAccessError("AI_ACCESS_UNAVAILABLE", "AI 授权服务暂不可用，请稍后重试");
  }
}

async function admin(tx: Tx, actor: AIAccessActor): Promise<Owner> {
  if (!actor || actor.role !== "admin" || !actor.username || !actor.tenantId ||
      actor.username.length > 256 || actor.tenantId.length > 256) {
    throw new AIAccessError("ADMIN_REQUIRED", "仅有效管理账号可以使用 AI 授权通道", 403);
  }
  const users = await tx.$queryRaw<Owner[]>`
    SELECT "id", "username", "tenantId" FROM "User"
    WHERE "username" = ${actor.username} AND "tenantId" = ${actor.tenantId}
      AND "authRole" = 'admin' AND "status" = 'active' FOR SHARE
  `;
  if (!users[0]) throw new AIAccessError("ADMIN_REQUIRED", "管理账号已失效或归属已变化", 403);
  return users[0];
}

async function event(tx: Tx, userId: string, grantId: string | null, type: string,
  metadata: { method?: string; path?: string; status?: number } = {}) {
  await tx.$executeRaw`
    INSERT INTO "AIAccessEvent" ("id", "userId", "grantId", "type", "method", "path", "status")
    VALUES (${randomUUID()}::uuid, ${userId}, ${grantId}::uuid, ${type},
      ${metadata.method ?? null}, ${metadata.path ?? null}, ${metadata.status ?? null})
  `;
}

/** Management calls require the current signed administrator cookie identity. */
export async function listAIAccessGrants(actor: AIAccessActor): Promise<AIAccessGrantView[]> {
  return transaction(async tx => {
    const owner = await admin(tx, actor);
    const grants = await tx.$queryRaw<Grant[]>`
      SELECT "id", "userId", "username", "tenantId", "name", "scope", "activeShopId", "createdAt", "expiresAt", "manualControl", "disabledAt", "revokedAt", "lastUsedAt",
        EXISTS (SELECT 1 FROM "AIAccessEvent" e WHERE e."grantId" = "AIAccessGrant"."id" AND e."type" = 'revoke') AS "revokedByAudit"
      FROM "AIAccessGrant" WHERE "userId" = ${owner.id} ORDER BY "createdAt" DESC LIMIT 50
    `;
    await event(tx, owner.id, null, "list");
    return grants.map(view);
  });
}

export async function createAIAccessGrant(actor: AIAccessActor, input: {
  name?: string; scope: AIAccessScope; activeShopId?: string | null;
}): Promise<{ grant: AIAccessGrantView; token: string }> {
  const name = typeof input?.name === "string" ? input.name.trim() : "AI 访问通道";
  if (!input || !["read", "action"].includes(input.scope) || !name || name.length > 80 ||
      /[\u0000-\u001f\u007f]/.test(name) || Object.hasOwn(input, "durationMinutes") ||
      (input.name !== undefined && typeof input.name !== "string") ||
      (input.activeShopId !== undefined && input.activeShopId !== null &&
        (typeof input.activeShopId !== "string" || !input.activeShopId || input.activeShopId.length > 256))) {
    throw new AIAccessError("INVALID_GRANT", "授权范围或名称无效", 400);
  }
  return transaction(async tx => {
    const owner = await admin(tx, actor);
    const activeShopId = input.activeShopId ?? null;
    if (activeShopId) {
      const shops = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Shop" WHERE "id" = ${activeShopId} AND "tenantId" = ${owner.tenantId} FOR SHARE
      `;
      if (!shops[0]) throw new AIAccessError("SHOP_NOT_FOUND", "当前店铺不存在或不属于管理账号", 404);
    }
    const id = randomUUID();
    const token = `sja_${id}.${randomBytes(32).toString("base64url")}`;
    // The finite database value is retained solely for old-version rollback
    // compatibility. Manual grants never use it as an authorization deadline.
    // Mirror the initial closed state in revokedAt so old code also denies it.
    const grants = await tx.$queryRaw<Grant[]>`
      INSERT INTO "AIAccessGrant" ("id", "userId", "username", "tenantId", "name", "scope", "tokenHash", "activeShopId", "expiresAt", "manualControl", "disabledAt", "revokedAt")
      VALUES (${id}::uuid, ${owner.id}, ${owner.username}, ${owner.tenantId}, ${name}, ${input.scope},
        ${tokenHash(token)}, ${activeShopId}, CURRENT_TIMESTAMP + INTERVAL '30 minutes', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING "id", "userId", "username", "tenantId", "name", "scope", "activeShopId", "createdAt", "expiresAt", "manualControl", "disabledAt", "revokedAt", "lastUsedAt"
    `;
    if (!grants[0]) throw new Error("missing grant receipt");
    await event(tx, owner.id, id, "create");
    // A secret is returned once, only after both grant and audit commit.
    return { grant: view(grants[0]), token };
  });
}

/** A manual channel stays enabled until its owner explicitly closes it. */
export async function setAIAccessGrantEnabled(actor: AIAccessActor, grantId: string,
  enabled: boolean): Promise<AIAccessGrantView> {
  if (!UUID.test(grantId) || typeof enabled !== "boolean") {
    throw new AIAccessError("INVALID_GRANT", "授权编号或开关状态无效", 400);
  }
  return transaction(async tx => {
    const owner = await admin(tx, actor);
    // Acquire the row lock before a separate UPDATE statement so its snapshot
    // also sees any revoke audit committed by an older app while we waited.
    const owned = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "AIAccessGrant"
      WHERE "id" = ${grantId}::uuid AND "userId" = ${owner.id}
        AND "username" = ${owner.username} AND "tenantId" = ${owner.tenantId}
        AND "manualControl" = TRUE FOR UPDATE
    `;
    if (!owned[0]) throw new AIAccessError("GRANT_NOT_CONTROLLABLE", "通道不存在、属于旧版或账号归属已变化", 409);
    // Match paused state in SQL at full timestamp precision. A permanently
    // revoked grant has no disabledAt and can never be reactivated here.
    const grants = enabled ? await tx.$queryRaw<Grant[]>`
      UPDATE "AIAccessGrant" SET "disabledAt" = NULL, "revokedAt" = NULL
      WHERE "id" = ${grantId}::uuid AND "userId" = ${owner.id}
        AND "username" = ${owner.username} AND "tenantId" = ${owner.tenantId}
        AND "manualControl" = TRUE
        AND NOT EXISTS (SELECT 1 FROM "AIAccessEvent" e
          WHERE e."grantId" = ${grantId}::uuid AND e."type" = 'revoke')
        AND (("disabledAt" IS NOT NULL AND "revokedAt" = "disabledAt")
          OR ("disabledAt" IS NULL AND "revokedAt" IS NULL))
      RETURNING "id", "userId", "username", "tenantId", "name", "scope", "activeShopId", "createdAt", "expiresAt", "manualControl", "disabledAt", "revokedAt", "lastUsedAt"
    ` : await tx.$queryRaw<Grant[]>`
      UPDATE "AIAccessGrant" SET "disabledAt" = COALESCE("disabledAt", CURRENT_TIMESTAMP),
        "revokedAt" = COALESCE("disabledAt", CURRENT_TIMESTAMP)
      WHERE "id" = ${grantId}::uuid AND "userId" = ${owner.id}
        AND "username" = ${owner.username} AND "tenantId" = ${owner.tenantId}
        AND "manualControl" = TRUE
        AND NOT EXISTS (SELECT 1 FROM "AIAccessEvent" e
          WHERE e."grantId" = ${grantId}::uuid AND e."type" = 'revoke')
        AND (("disabledAt" IS NOT NULL AND "revokedAt" = "disabledAt")
          OR ("disabledAt" IS NULL AND "revokedAt" IS NULL))
      RETURNING "id", "userId", "username", "tenantId", "name", "scope", "activeShopId", "createdAt", "expiresAt", "manualControl", "disabledAt", "revokedAt", "lastUsedAt"
    `;
    if (!grants[0]) throw new AIAccessError("GRANT_NOT_CONTROLLABLE", "通道不存在、已撤销、属于旧版或账号归属已变化", 409);
    await event(tx, owner.id, grantId, enabled ? "enable" : "disable");
    return view(grants[0]);
  });
}

export async function revokeAIAccessGrant(actor: AIAccessActor, grantId: string): Promise<{ revoked: boolean }> {
  if (!UUID.test(grantId)) throw new AIAccessError("INVALID_GRANT", "授权编号无效", 400);
  return transaction(async tx => {
    const owner = await admin(tx, actor);
    const grants = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "AIAccessGrant" SET "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP), "disabledAt" = NULL
      WHERE "id" = ${grantId}::uuid AND "userId" = ${owner.id} RETURNING "id"
    `;
    if (!grants[0]) throw new AIAccessError("GRANT_NOT_FOUND", "授权不存在或不属于当前管理账号", 404);
    await event(tx, owner.id, grantId, "revoke");
    return { revoked: true };
  });
}

/** An opaque bearer works only while its original administrator remains valid. */
export async function authorizeAIAccessToken(rawToken: string | null, requiredScope: AIAccessScope,
  actor?: AIAccessActor): Promise<AIAccessAuthorization | null> {
  if (!["read", "action"].includes(requiredScope)) throw new AIAccessError("INVALID_SCOPE", "AI 操作范围无效", 400);
  const match = typeof rawToken === "string" ? TOKEN.exec(rawToken) : null;
  if (!match || !rawToken) return null;
  return transaction(async tx => {
    if (actor) await admin(tx, actor);
    const grants = await tx.$queryRaw<Grant[]>`
      SELECT g."id", g."userId", g."username", g."tenantId", g."name", g."scope", g."activeShopId", g."createdAt", g."expiresAt", g."manualControl", g."disabledAt", g."revokedAt", g."lastUsedAt"
      FROM "AIAccessGrant" g JOIN "User" u ON u."id" = g."userId"
      WHERE g."id" = ${match[1]}::uuid AND g."tokenHash" = ${tokenHash(rawToken)}
        AND g."revokedAt" IS NULL AND g."disabledAt" IS NULL
        AND (g."manualControl" = TRUE OR g."expiresAt" > CURRENT_TIMESTAMP)
        AND u."status" = 'active' AND u."authRole" = 'admin'
        AND u."username" = g."username" AND u."tenantId" = g."tenantId"
        AND (${requiredScope} = 'read' OR g."scope" = 'action')
        AND (${actor?.username ?? null}::text IS NULL OR g."username" = ${actor?.username ?? null})
        AND (${actor?.tenantId ?? null}::text IS NULL OR g."tenantId" = ${actor?.tenantId ?? null})
      FOR UPDATE OF g FOR SHARE OF u
    `;
    const grant = grants[0];
    if (!grant) return null;
    await tx.$executeRaw`UPDATE "AIAccessGrant" SET "lastUsedAt" = CURRENT_TIMESTAMP WHERE "id" = ${grant.id}::uuid`;
    await event(tx, grant.userId, grant.id, "authorize");
    return authorization(grant);
  });
}

async function liveGrant(tx: Tx, auth: AIAccessAuthorization): Promise<Grant> {
  if (!auth || !UUID.test(auth.grantId) || !auth.userId || !auth.username || !auth.tenantId) {
    throw new AIAccessError("GRANT_INVALID", "AI 授权已失效", 401);
  }
  const grants = await tx.$queryRaw<Grant[]>`
    SELECT g."id", g."userId", g."username", g."tenantId", g."name", g."scope", g."activeShopId", g."createdAt", g."expiresAt", g."manualControl", g."disabledAt", g."revokedAt", g."lastUsedAt"
    FROM "AIAccessGrant" g JOIN "User" u ON u."id" = g."userId"
    WHERE g."id" = ${auth.grantId}::uuid AND g."userId" = ${auth.userId}
      AND g."username" = ${auth.username} AND g."tenantId" = ${auth.tenantId}
      AND g."scope" = ${auth.scope} AND g."revokedAt" IS NULL AND g."disabledAt" IS NULL
      AND (g."manualControl" = TRUE OR g."expiresAt" > CURRENT_TIMESTAMP)
      AND u."status" = 'active' AND u."authRole" = 'admin'
      AND u."username" = g."username" AND u."tenantId" = g."tenantId"
    FOR UPDATE OF g FOR SHARE OF u
  `;
  if (!grants[0]) throw new AIAccessError("GRANT_INVALID", "AI 授权已失效", 401);
  return grants[0];
}

export async function setAIAccessActiveShop(auth: AIAccessAuthorization, shopId: string): Promise<AIAccessAuthorization> {
  if (auth.scope !== "action") throw new AIAccessError("ACTION_REQUIRED", "此 AI 授权仅允许读取", 403);
  if (typeof shopId !== "string" || !shopId || shopId.length > 256) throw new AIAccessError("INVALID_SHOP", "店铺编号无效", 400);
  return transaction(async tx => {
    const grant = await liveGrant(tx, auth);
    const shops = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Shop" WHERE "id" = ${shopId} AND "tenantId" = ${grant.tenantId} FOR SHARE
    `;
    if (!shops[0]) throw new AIAccessError("SHOP_NOT_FOUND", "店铺不存在或不属于授权账号", 404);
    await tx.$executeRaw`UPDATE "AIAccessGrant" SET "activeShopId" = ${shopId} WHERE "id" = ${grant.id}::uuid`;
    await event(tx, grant.userId, grant.id, "context", { method: "PATCH", path: "/api/shops/active", status: 200 });
    return { ...authorization(grant), activeShopId: shopId };
  });
}

// Only known static routes enter audit records; identifiers, tokens, query
// strings and unknown path segments are redacted before persistence.
export function sanitizeAIAccessAuditPath(path: string): string {
  if (typeof path !== "string" || path.length > 2048) return "/:redacted";
  const pathname = path.split(/[?#]/, 1)[0];
  if (["/", "/api/auth/me", "/api/auth/creative-access", "/api/shops", "/api/shops/active",
    "/api/dmp-reports", "/api/v1/models", "/v1/models", "/api/ai-access/execute", "/api/ai-access/grants",
    "/api/ai-access/events"].includes(pathname)) return pathname;
  if (/^\/api\/dmp-reports\/[^/]+$/.test(pathname)) return "/api/dmp-reports/:id";
  if (/^\/api\/ai-access\/grants\/[^/]+$/.test(pathname)) return "/api/ai-access/grants/:id";
  return "/:redacted";
}

export async function recordAIAccessEvent(auth: AIAccessAuthorization, metadata: {
  method: string; path: string; status?: number;
}): Promise<void> {
  if (!metadata || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(metadata.method) ||
      (metadata.status !== undefined && (!Number.isInteger(metadata.status) || metadata.status < 100 || metadata.status > 599))) {
    throw new AIAccessError("INVALID_AUDIT", "AI 操作审计信息无效", 400);
  }
  return transaction(async tx => {
    const grant = await liveGrant(tx, auth);
    await event(tx, grant.userId, grant.id, "request", {
      method: metadata.method, path: sanitizeAIAccessAuditPath(metadata.path), status: metadata.status
    });
  });
}

export async function listAIAccessEvents(actor: AIAccessActor): Promise<AIAccessEventView[]> {
  return transaction(async tx => {
    const owner = await admin(tx, actor);
    const rows = await tx.$queryRaw<Array<Omit<AIAccessEventView, "createdAt"> & { createdAt: Date }>>`
      SELECT e."id", e."type", g."name" AS "grantName", e."method", e."path", e."status", e."createdAt"
      FROM "AIAccessEvent" e LEFT JOIN "AIAccessGrant" g ON g."id" = e."grantId"
      WHERE e."userId" = ${owner.id} ORDER BY e."createdAt" DESC LIMIT 100
    `;
    await event(tx, owner.id, null, "events");
    return rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
  });
}
