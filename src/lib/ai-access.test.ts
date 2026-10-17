import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), transaction: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: mocks.transaction } }));
import {
  AIAccessError, authorizeAIAccessToken, createAIAccessGrant, listAIAccessEvents,
  listAIAccessGrants, recordAIAccessEvent, revokeAIAccessGrant, sanitizeAIAccessAuditPath,
  setAIAccessActiveShop, setAIAccessGrantEnabled
} from "./ai-access";

const id = "3f5ecdbd-c75b-4bc3-93f2-9bc7886e53a0";
const actor = { username: "fixture-admin", tenantId: "tenant-a", role: "admin" as const };
const owner = { id: "user-a", username: actor.username, tenantId: actor.tenantId };
const grant = {
  id, userId: owner.id, username: owner.username, tenantId: owner.tenantId, name: "AI 通道",
  scope: "action" as const, activeShopId: null, createdAt: new Date("2026-10-02T01:00:00Z"),
  expiresAt: new Date("2026-10-02T01:30:00Z"), manualControl: true,
  disabledAt: null, revokedAt: null, lastUsedAt: null
};
const pausedAt = new Date("2026-10-02T01:01:00Z");
const pausedGrant = { ...grant, disabledAt: pausedAt, revokedAt: pausedAt };
const auth = { grantId: id, userId: owner.id, username: owner.username, tenantId: owner.tenantId, scope: "action" as const, activeShopId: null };
const token = `sja_${id}.${"a".repeat(43)}`;
const sql = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?");

describe("administrator AI access channel", () => {
  beforeEach(() => {
    mocks.query.mockReset(); mocks.execute.mockReset().mockResolvedValue(1); mocks.transaction.mockReset();
    mocks.transaction.mockImplementation(async operation => operation({ $queryRaw: mocks.query, $executeRaw: mocks.execute }));
  });

  it("creates a closed manual grant with a one-time opaque token and rollback-only physical expiry", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([pausedGrant]);
    const created = await createAIAccessGrant(actor, { scope: "action" });
    expect(created.token).toMatch(/^sja_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    const parameters = mocks.query.mock.calls[1].slice(1);
    expect(parameters).toContain(createHash("sha256").update(created.token).digest("hex"));
    expect(sql(mocks.query.mock.calls[1])).toContain("CURRENT_TIMESTAMP + INTERVAL '30 minutes', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP");
    expect(parameters).not.toContain(created.token);
    expect(created.grant).not.toHaveProperty("tokenHash");
    expect(created.grant).toMatchObject({ enabled: false, expiresAt: null, revokedAt: null });
    expect(created.grant).not.toHaveProperty("manualControl");
    expect(created.grant).not.toHaveProperty("disabledAt");
    expect(mocks.execute.mock.calls[0].slice(1)).toContain("create");
    expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain(created.token);
  });

  it("binds the trusted creation shop only after checking the administrator tenant", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([{ id: "shop-a" }]).mockResolvedValueOnce([{ ...grant, activeShopId: "shop-a", scope: "read" }]);
    const created = await createAIAccessGrant(actor, { scope: "read", activeShopId: "shop-a" });
    expect(created.grant.activeShopId).toBe("shop-a");
    expect(sql(mocks.query.mock.calls[1])).toContain('"tenantId" = ?');
    expect(mocks.query.mock.calls[1].slice(1)).toEqual(["shop-a", "tenant-a"]);
  });

  it("rejects a foreign creation shop without inserting a grant or audit", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([]);
    await expect(createAIAccessGrant(actor, { scope: "read", activeShopId: "foreign-shop" })).rejects.toMatchObject({ status: 404 });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0, 30, 61, 1.5])("rejects any supplied duration rather than extending legacy or manual grants: %s", async durationMinutes => {
    await expect(createAIAccessGrant(actor, { scope: "read", durationMinutes } as never)).rejects.toMatchObject({ status: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a tenant actor before it can read or create administrator grants", async () => {
    await expect(listAIAccessGrants({ ...actor, role: "tenant" })).rejects.toMatchObject({ status: 403 });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rechecks active/admin/tenant in the database for every management operation", async () => {
    mocks.query.mockResolvedValue([]);
    await expect(listAIAccessGrants(actor)).rejects.toMatchObject({ status: 403 });
    expect(sql(mocks.query.mock.calls[0])).toContain('"authRole" = \'admin\' AND "status" = \'active\'');
    expect(mocks.query.mock.calls[0].slice(1)).toEqual([actor.username, actor.tenantId]);
  });

  it("lists only owner grants and never returns secret, hash or account identity", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([{ ...grant, tokenHash: "not-public", token: "never-return" }]);
    const result = await listAIAccessGrants(actor);
    expect(JSON.stringify(result)).not.toMatch(/not-public|never-return|fixture-admin|user-a|tenant-a/);
    expect(sql(mocks.query.mock.calls[1])).toContain('WHERE "userId" = ?');
    expect(mocks.execute.mock.calls[0].slice(1)).toContain("list");
  });

  it("returns manual enabled/closed state and preserves the original deadline for finite legacy grants", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([
      grant, pausedGrant, { ...grant, manualControl: false }, { ...grant, revokedAt: pausedAt },
      { ...pausedGrant, revokedByAudit: true }
    ]);
    const rows = await listAIAccessGrants(actor);
    expect(rows.map(row => ({ enabled: row.enabled, expiresAt: row.expiresAt, revokedAt: row.revokedAt }))).toEqual([
      { enabled: true, expiresAt: null, revokedAt: null },
      { enabled: false, expiresAt: null, revokedAt: null },
      { enabled: true, expiresAt: grant.expiresAt.toISOString(), revokedAt: null },
      { enabled: false, expiresAt: null, revokedAt: pausedAt.toISOString() },
      { enabled: false, expiresAt: null, revokedAt: pausedAt.toISOString() }
    ]);
    expect(sql(mocks.query.mock.calls[1])).toContain('e."type" = \'revoke\'');
    expect(mocks.execute.mock.calls.every(call => !sql(call).includes('UPDATE "AIAccessGrant"'))).toBe(true);
  });

  it("authorizes a manual action grant past physical expiry while retaining the finite legacy deadline branch", async () => {
    mocks.query.mockResolvedValue([grant]);
    expect(await authorizeAIAccessToken(token, "read")).toEqual(auth);
    const query = sql(mocks.query.mock.calls[0]);
    expect(query).toContain('g."expiresAt" > CURRENT_TIMESTAMP');
    expect(query).toContain('(g."manualControl" = TRUE OR g."expiresAt" > CURRENT_TIMESTAMP)');
    expect(query).toContain('g."revokedAt" IS NULL');
    expect(query).toContain('g."disabledAt" IS NULL');
    expect(query).toContain("FOR UPDATE OF g FOR SHARE OF u");
    expect(query).toContain('u."status" = \'active\' AND u."authRole" = \'admin\'');
    expect(query).toContain('u."username" = g."username" AND u."tenantId" = g."tenantId"');
    expect(mocks.query.mock.calls[0].slice(1)).not.toContain(token);
    expect(mocks.execute.mock.calls[1].slice(1)).toContain("authorize");
  });

  it("requires action scope in the database and returns null for an expired, revoked or denied grant", async () => {
    mocks.query.mockResolvedValue([]);
    expect(await authorizeAIAccessToken(token, "action")).toBeNull();
    expect(mocks.query.mock.calls[0].slice(1)).toContain("action");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("binds bearer to a supplied current administrator actor", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([grant]);
    await authorizeAIAccessToken(token, "read", actor);
    expect(mocks.query.mock.calls[1].slice(1).filter(value => value === actor.username)).toHaveLength(2);
    expect(mocks.query.mock.calls[1].slice(1).filter(value => value === actor.tenantId)).toHaveLength(2);
  });

  it.each([null, "", "Bearer bad", `sja_${id}.short`, `sja_${id}.${"a".repeat(200)}`])("rejects malformed credentials before database access", async invalid => {
    expect(await authorizeAIAccessToken(invalid, "read")).toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("revokes only an owned grant and audits revocation in the same transaction", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([{ id }]);
    await expect(revokeAIAccessGrant(actor, id)).resolves.toEqual({ revoked: true });
    expect(sql(mocks.query.mock.calls[1])).toContain('"userId" = ?');
    expect(sql(mocks.query.mock.calls[1])).toContain('"disabledAt" = NULL');
    expect(mocks.execute.mock.calls[0].slice(1)).toContain("revoke");
  });

  it.each([true, false])("toggles a manual grant to %s with owner/identity and full-precision paused-state SQL guards", async enabled => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([{ id }]).mockResolvedValueOnce([enabled ? grant : pausedGrant]);
    const result = await setAIAccessGrantEnabled(actor, id, enabled);
    expect(result).toMatchObject({ enabled, expiresAt: null, revokedAt: null });
    expect(result).not.toHaveProperty("token");
    const lock = sql(mocks.query.mock.calls[1]);
    expect(lock).toContain('"manualControl" = TRUE FOR UPDATE');
    const query = sql(mocks.query.mock.calls[2]);
    expect(query).toContain('"manualControl" = TRUE');
    expect(query).toContain('"disabledAt" IS NOT NULL AND "revokedAt" = "disabledAt"');
    expect(query).toContain('"disabledAt" IS NULL AND "revokedAt" IS NULL');
    expect(query).toContain('"username" = ? AND "tenantId" = ?');
    expect(mocks.query.mock.calls[1].slice(1)).toEqual([id, owner.id, owner.username, owner.tenantId]);
    expect(mocks.query.mock.calls[2].slice(1)).toEqual([id, owner.id, owner.username, owner.tenantId, id]);
    expect(query).toContain('NOT EXISTS (SELECT 1 FROM "AIAccessEvent" e');
    expect(query).toContain('e."type" = \'revoke\'');
    expect(query).not.toMatch(/SET "expiresAt"|SET "createdAt"|SET "tokenHash"/);
    expect(query).toContain(enabled ? 'SET "disabledAt" = NULL, "revokedAt" = NULL' : '"revokedAt" = COALESCE("disabledAt", CURRENT_TIMESTAMP)');
    expect(mocks.execute.mock.calls[0].slice(1)).toContain(enabled ? "enable" : "disable");
  });

  it.each(["foreign owner", "changed identity", "finite legacy", "permanently revoked"])("never reopens a %s grant on a guarded update miss", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([]);
    await expect(setAIAccessGrantEnabled(actor, id, true)).rejects.toMatchObject({ status: 409, code: "GRANT_NOT_CONTROLLABLE" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects a locked paused grant whose committed old-version revoke audit makes it permanent", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([{ id }]).mockResolvedValueOnce([]);
    await expect(setAIAccessGrantEnabled(actor, id, true)).rejects.toMatchObject({ status: 409, code: "GRANT_NOT_CONTROLLABLE" });
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([["not-a-uuid", true], [id, "true"], [id, null], [id, 1]])("rejects invalid manual controls before transactions: %s/%s", async (grantId, enabled) => {
    await expect(setAIAccessGrantEnabled(actor, grantId as string, enabled as boolean)).rejects.toMatchObject({ status: 400 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not revoke a grant owned by another administrator", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([]);
    await expect(revokeAIAccessGrant(actor, id)).rejects.toMatchObject({ status: 404 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps shop switching in the grant context and its audit only", async () => {
    mocks.query.mockResolvedValueOnce([grant]).mockResolvedValueOnce([{ id: "shop-a" }]);
    await expect(setAIAccessActiveShop(auth, "shop-a")).resolves.toEqual({ ...auth, activeShopId: "shop-a" });
    expect(mocks.query.mock.calls[1].slice(1)).toEqual(["shop-a", "tenant-a"]);
    expect(sql(mocks.execute.mock.calls[0])).toContain('UPDATE "AIAccessGrant" SET "activeShopId"');
    expect(sql(mocks.execute.mock.calls[0])).not.toMatch(/Cookie|User|Shop" SET/);
    expect(mocks.execute.mock.calls[1].slice(1)).toContain("context");
  });

  it("read grants cannot switch shop or widen their scope", async () => {
    await expect(setAIAccessActiveShop({ ...auth, scope: "read" }, "shop-a")).rejects.toMatchObject({ status: 403 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses audit/context operations if their grant became invalid", async () => {
    mocks.query.mockResolvedValue([]);
    await expect(recordAIAccessEvent(auth, { method: "GET", path: "/api/shops", status: 200 })).rejects.toMatchObject({ status: 401 });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(sql(mocks.query.mock.calls[0])).toContain('g."disabledAt" IS NULL');
    expect(sql(mocks.query.mock.calls[0])).toContain('(g."manualControl" = TRUE OR g."expiresAt" > CURRENT_TIMESTAMP)');
  });

  it.each(["create", "authorize", "context", "request", "list", "events", "revoke", "enable", "disable"])("fails closed when %s audit persistence fails", async operation => {
    mocks.execute.mockImplementation(async (template: TemplateStringsArray) => {
      if (template.join("").includes('INSERT INTO "AIAccessEvent"')) throw new Error("private postgres credential");
      return 1;
    });
    mocks.query.mockResolvedValue([grant]);
    if (["create", "list", "events", "revoke", "enable", "disable"].includes(operation)) {
      mocks.query.mockReset().mockResolvedValueOnce([owner]).mockResolvedValueOnce(operation === "events" ? [] : [grant]);
      if (operation === "enable" || operation === "disable") mocks.query.mockResolvedValueOnce([grant]);
    }
    if (operation === "context") mocks.query.mockReset().mockResolvedValueOnce([grant]).mockResolvedValueOnce([{ id: "shop-a" }]);
    const task = operation === "create" ? createAIAccessGrant(actor, { scope: "read" })
      : operation === "authorize" ? authorizeAIAccessToken(token, "read")
        : operation === "context" ? setAIAccessActiveShop(auth, "shop-a")
          : operation === "list" ? listAIAccessGrants(actor)
            : operation === "events" ? listAIAccessEvents(actor)
              : operation === "revoke" ? revokeAIAccessGrant(actor, id)
                : operation === "enable" || operation === "disable" ? setAIAccessGrantEnabled(actor, id, operation === "enable")
                : recordAIAccessEvent(auth, { method: "GET", path: "/api/shops", status: 200 });
    await expect(task).rejects.toMatchObject({ status: 503, code: "AI_ACCESS_UNAVAILABLE" });
    await expect(task).rejects.not.toThrow(/private|postgres|credential/);
  });

  it("whitelists audit fields and redacts queries, dynamic identifiers and unknown PII paths", async () => {
    mocks.query.mockResolvedValue([grant]);
    await recordAIAccessEvent(auth, { method: "GET", path: "/api/shops?token=secret", status: 200, cookie: "private-cookie", body: "private-body" } as never);
    expect(JSON.stringify(mocks.execute.mock.calls)).not.toMatch(/secret|private-cookie|private-body|\?token/);
    expect(mocks.execute.mock.calls[0].slice(1)).toContain("/api/shops");
    expect(sanitizeAIAccessAuditPath("/api/dmp-reports/secret-token?user=John")).toBe("/api/dmp-reports/:id");
    expect(sanitizeAIAccessAuditPath("/user/john@example.test")).toBe("/:redacted");
  });

  it("lists the owner's bounded audit metadata without returning grant secrets", async () => {
    mocks.query.mockResolvedValueOnce([owner]).mockResolvedValueOnce([{ id, type: "request", grantName: "AI 通道", method: "GET", path: "/api/shops", status: 200, createdAt: grant.createdAt }]);
    const rows = await listAIAccessEvents(actor);
    expect(rows[0].createdAt).toBe(grant.createdAt.toISOString());
    expect(sql(mocks.query.mock.calls[1])).toContain('WHERE e."userId" = ?');
    expect(sql(mocks.query.mock.calls[1])).toContain("LIMIT 100");
    expect(JSON.stringify(rows)).not.toMatch(/token|username|tenantId/);
  });

  it("never leaks arbitrary database failures", async () => {
    mocks.transaction.mockRejectedValue(new Error("password=private-token"));
    await expect(listAIAccessGrants(actor)).rejects.toMatchObject({ code: "AI_ACCESS_UNAVAILABLE", status: 503 });
    expect(new AIAccessError("CODE", "safe", 400)).toMatchObject({ code: "CODE", message: "safe", status: 400 });
  });
});
