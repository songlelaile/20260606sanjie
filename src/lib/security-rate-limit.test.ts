import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { $queryRaw: mocks.queryRaw } }));
import { consumeSecurityRateLimit } from "./security-rate-limit";

describe("shared PostgreSQL security rate limits", () => {
  beforeEach(() => { mocks.queryRaw.mockReset(); });

  it("consumes atomically with only a fixed hash and expires old buckets in the same query", async () => {
    mocks.queryRaw.mockResolvedValue([{ hits: 2 }]);
    await expect(consumeSecurityRateLimit("auth.login.account", "Alice", 10, 300, 305_500))
      .resolves.toEqual({ allowed: true, remaining: 8, retryAfterSeconds: 0 });
    const [template, ...parameters] = mocks.queryRaw.mock.calls[0];
    const sql = template.join("?");
    expect(sql).toContain('DELETE FROM "SecurityRateBucket" WHERE "expiresAt" <= ?');
    expect(sql).toContain('ON CONFLICT ("bucketKey", "windowStart")');
    expect(sql).toContain('RETURNING "hits"');
    expect(parameters).toEqual([
      new Date(305_500), createHash("sha256").update("auth.login.account\0Alice").digest("hex"),
      new Date(300_000), new Date(600_000)
    ]);
    expect(JSON.stringify(parameters)).not.toContain("Alice");
  });

  it("denies an over-limit counter and gives seconds until the next window", async () => {
    mocks.queryRaw.mockResolvedValue([{ hits: 11 }]);
    await expect(consumeSecurityRateLimit("login", "identity", 10, 300, 599_001))
      .resolves.toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 1, reason: "rate_limited" });
  });

  it("starts a separate fixed window and isolates namespaces", async () => {
    mocks.queryRaw.mockResolvedValue([{ hits: 1 }]);
    await consumeSecurityRateLimit("login", "same", 10, 300, 299_999);
    await consumeSecurityRateLimit("login", "same", 10, 300, 300_000);
    await consumeSecurityRateLimit("generate", "same", 10, 300, 300_000);
    expect(mocks.queryRaw.mock.calls[0][2]).toBe(mocks.queryRaw.mock.calls[1][2]);
    expect(mocks.queryRaw.mock.calls[1][2]).not.toBe(mocks.queryRaw.mock.calls[2][2]);
    expect(mocks.queryRaw.mock.calls[0][3]).toEqual(new Date(0));
    expect(mocks.queryRaw.mock.calls[1][3]).toEqual(new Date(300_000));
  });

  it("uses the database receipt for concurrent callers instead of a worker-local Map", async () => {
    let hits = 0;
    mocks.queryRaw.mockImplementation(async () => [{ hits: ++hits }]);
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      consumeSecurityRateLimit("login", "same", 10, 300, 1_000)));
    expect(results.filter(result => result.allowed)).toHaveLength(10);
    expect(results.filter(result => result.reason === "rate_limited")).toHaveLength(2);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(12);
  });

  it("fails closed without exposing database errors or connection credentials", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("postgres password=private-token"));
    const result = await consumeSecurityRateLimit("login", "same", 10, 300, 1_000);
    expect(result).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 30, reason: "unavailable" });
    expect(JSON.stringify(result)).not.toMatch(/postgres|password|private-token/);
  });

  it.each([
    { rows: [] }, { rows: [{ hits: null }] }, { rows: [{ hits: 0 }] }, { rows: [{ hits: "1" }] }
  ])("fails closed for a malformed database receipt $rows", async ({ rows }) => {
    mocks.queryRaw.mockResolvedValue(rows);
    expect((await consumeSecurityRateLimit("login", "same", 10, 300, 1_000)).reason).toBe("unavailable");
  });

  it.each([
    ["x".repeat(65), "a", 10, 300, 1_000],
    ["bad namespace", "a", 10, 300, 1_000],
    ["login", "", 10, 300, 1_000],
    ["login", "x".repeat(513), 10, 300, 1_000],
    ["login", "a", 0, 300, 1_000],
    ["login", "a", 10, 0, 1_000],
    ["login", "a", 10, 300, NaN]
  ])("rejects unsafe parameters before any database access", async (namespace, identity, limit, windowSeconds, now) => {
    await expect(consumeSecurityRateLimit(namespace as string, identity as string, limit as number, windowSeconds as number, now as number))
      .rejects.toThrow(TypeError);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});
