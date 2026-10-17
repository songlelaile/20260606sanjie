import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const harness = vi.hoisted(() => {
  type Row = { id: string; userId: string; slot: string; name: string; sealedKey: string; status: string; attempts: number; leaseToken: string | null; leaseUntil: Date | null; retryAfter: Date | null; lastErrorCode: string; providerKeyId: string | null; providerOwnerId: string | null; providerGroupId: string | null };
  const rows = new Map<string, Row>();
  const users: Array<{ id: string; username: string; name: string; status: string }> = [];
  const state = { due: [] as string[], cooldown: null as string | null, loseLease: false, rejectCommit: false, failures: [] as Array<{ code: string; delay: number }>, renewals: 0 };
  class IssuerError extends Error { constructor(readonly code: string) { super("fixed test issuer error"); } }
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes('SELECT "lastErrorCode"')) return state.cooldown ? [{ lastErrorCode: state.cooldown }] : [];
    if (sql.includes('SELECT u."id"')) return state.due.map((id) => ({ id }));
    if (sql.includes("RETURNING *")) {
      const [leaseToken, id] = values.map(String);
      const row = rows.get(id);
      if (!row || row.status === "ready" || (row.leaseUntil && row.leaseUntil.getTime() >= Date.now()) || (row.retryAfter && row.retryAfter.getTime() > Date.now())) return [];
      row.status = "provisioning"; row.leaseToken = leaseToken; row.leaseUntil = new Date(Date.now() + 90_000); row.attempts++;
      return [{ ...row }];
    }
    if (sql.includes('WHERE "userId"')) return [...rows.values()].filter((row) => row.userId === String(values[0])).sort((a) => a.slot === "primary" ? -1 : a.slot === "backup" ? 1 : 0).map((row) => ({ ...row }));
    return [...rows.values()].map((row) => ({ ...row }));
  });
  const execute = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("INSERT INTO")) {
      const [id, userId, slot, name, sealedKey] = values.map(String);
      if ([...rows.values()].some((row) => row.userId === userId && row.slot === slot)) return 0;
      rows.set(id, { id, userId, slot, name, sealedKey, status: "pending", attempts: 0, leaseToken: null, leaseUntil: null, retryAfter: null, lastErrorCode: "", providerKeyId: null, providerOwnerId: null, providerGroupId: null });
      return 1;
    }
    if (sql.includes('SET "retryAfter" = NULL')) {
      for (const row of rows.values()) if (row.status === "failed" && row.lastErrorCode !== "supply_provisioning_rate_limited") row.retryAfter = null;
      if (state.cooldown !== "supply_provisioning_rate_limited") state.cooldown = null;
      return 1;
    }
    if (sql.includes('SET "status" = \'ready\'')) {
      const [providerKeyId, providerOwnerId, providerGroupId, id, , leaseToken] = values.map(String);
      const row = rows.get(id);
      if (state.rejectCommit || !row || row.leaseToken !== leaseToken || row.status !== "provisioning" || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now()) return 0;
      Object.assign(row, { status: "ready", providerKeyId, providerOwnerId, providerGroupId, leaseToken: null, leaseUntil: null, retryAfter: null });
      return 1;
    }
    if (sql.includes('SET "status" = \'failed\'')) {
      const [code, delay, id, , leaseToken] = values;
      state.failures.push({ code: String(code), delay: Number(delay) });
      const row = rows.get(String(id));
      if (!row || row.leaseToken !== String(leaseToken)) return 0;
      Object.assign(row, { status: "failed", lastErrorCode: String(code), retryAfter: new Date(Date.now() + Number(delay) * 1000), leaseToken: null, leaseUntil: null });
      if (["supply_provisioning_rate_limited", "supply_provisioning_key_count_exceeded"].includes(String(code))) state.cooldown = String(code);
      return 1;
    }
    state.renewals++;
    const row = rows.get(String(values[0]));
    if (state.loseLease) { if (row) row.leaseToken = "different-worker"; return 0; }
    if (!row || row.leaseToken !== String(values[2]) || row.status !== "provisioning") return 0;
    row.leaseUntil = new Date(Date.now() + 90_000);
    return 1;
  });
  const issue = vi.fn(async (input: { name: string; customKey: string; idempotencyKey: string }) => ({ id: String(issue.mock.calls.length), key: input.customKey, ownerId: "7", groupId: "8" }));
  const providerView = vi.fn(async () => ({ configured: true, missing: [] }));
  const prisma = { $queryRaw: query, $executeRaw: execute, $transaction: async (operation: (tx: { $executeRaw: typeof execute }) => Promise<void>) => operation({ $executeRaw: execute }), user: {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; username?: string } }) => users.find((user) => where.id ? user.id === where.id : user.username === where.username) || null),
    findMany: vi.fn(async () => users)
  } };
  return { rows, users, state, query, execute, issue, providerView, prisma, IssuerError };
});
vi.mock("@/lib/db", () => ({ prisma: harness.prisma }));
vi.mock("./sub2api-provisioner", () => ({ getSub2ApiProvisioningView: harness.providerView, provisionSub2ApiKey: harness.issue, Sub2ApiProvisionError: harness.IssuerError }));
vi.mock("./relay-config", () => ({ getRelayRuntime: async () => ({ usdCnyRate: 7 }) }));

import { backfillUserSupplyKeys, ensureUserSupplyKeys, getUserSupplyRuntime, queueUserSupplyKeys, resetUserSupplyProvisioningFailures } from "./user-supply";

describe("durable user supply scheduling and leases", () => {
  beforeEach(() => {
    vi.stubEnv("AI_API_ENCRYPTION_KEY", "test-only-independent-user-supply-key-0123456789");
    harness.rows.clear(); harness.users.splice(0); harness.state.due = []; harness.state.cooldown = null;
    harness.state.loseLease = false; harness.state.rejectCommit = false; harness.state.failures = []; harness.state.renewals = 0;
    harness.query.mockClear(); harness.execute.mockClear(); harness.issue.mockReset(); harness.providerView.mockReset().mockResolvedValue({ configured: true, missing: [] });
    harness.issue.mockImplementation(async (input) => ({ id: String(harness.issue.mock.calls.length), key: input.customKey, ownerId: "7", groupId: "8" }));
    harness.users.push({ id: "user-a", username: "user-a", name: "用户 A", status: "active" });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

  it("works on database-selected due users instead of repeatedly taking the first ten accounts", async () => {
    for (let index = 0; index < 10; index++) harness.users.unshift({ id: `older-${index}`, username: `older-${index}`, name: "旧失败用户", status: "active" });
    harness.state.due = ["user-a"];
    const result = await backfillUserSupplyKeys();
    expect(result).toMatchObject({ processed: 1, ready: 1, failed: 0, remaining: 10 });
    expect(harness.issue).toHaveBeenCalledTimes(2);
    expect([...harness.rows.values()].every((row) => row.userId === "user-a")).toBe(true);
    const dueQuery = harness.query.mock.calls.find(([parts]) => parts.join("").includes('SELECT u."id"'))![0].join("");
    expect(dueQuery).toContain('"retryAfter" <= CURRENT_TIMESTAMP');
    expect(dueQuery).toContain('"leaseUntil" < CURRENT_TIMESTAMP');
    expect(dueQuery).toContain('COALESCE(MAX(c."attempts"), 0) ASC');
  });

  it("stops the batch at the first rate limit and prevents later users from bypassing the issuer cooldown", async () => {
    harness.users.push({ id: "user-b", username: "user-b", name: "用户 B", status: "active" });
    harness.state.due = ["user-a", "user-b"];
    harness.issue.mockRejectedValueOnce(new harness.IssuerError("supply_provisioning_rate_limited"));
    expect(await backfillUserSupplyKeys()).toMatchObject({ processed: 1, ready: 0, failed: 1, remaining: 2 });
    expect(harness.issue).toHaveBeenCalledTimes(1);
    expect(harness.state.failures[0]).toEqual({ code: "supply_provisioning_rate_limited", delay: 3600 });
    expect(await backfillUserSupplyKeys()).toMatchObject({ processed: 0, ready: 0, failed: 0, remaining: 2, errors: [{ userId: "", code: "supply_provisioning_rate_limited" }] });
    await expect(ensureUserSupplyKeys("user-b")).rejects.toMatchObject({ code: "supply_provisioning_rate_limited" });
    expect(harness.issue).toHaveBeenCalledTimes(1);
  });

  it("backs off account key-count exhaustion instead of trying every remaining account", async () => {
    harness.state.due = ["user-a"];
    harness.issue.mockRejectedValueOnce(new harness.IssuerError("supply_provisioning_key_count_exceeded"));
    await backfillUserSupplyKeys();
    expect(harness.state.failures[0]).toEqual({ code: "supply_provisioning_key_count_exceeded", delay: 86400 });
    await expect(ensureUserSupplyKeys("user-a")).rejects.toMatchObject({ code: "supply_provisioning_key_count_exceeded" });
    expect(harness.issue).toHaveBeenCalledTimes(1);
  });

  it("issues the primary first and preserves it when the standby hits a global rate limit", async () => {
    harness.issue.mockImplementationOnce(async (input) => ({ id: "primary-provider", key: input.customKey, ownerId: "7", groupId: "8" }))
      .mockRejectedValueOnce(new harness.IssuerError("supply_provisioning_rate_limited"));
    await expect(ensureUserSupplyKeys("user-a")).rejects.toMatchObject({ code: "supply_provisioning_rate_limited" });
    expect(harness.issue.mock.calls[0][0].name).toMatch(/-primary$/);
    const runtime = await getUserSupplyRuntime("user-a");
    expect(runtime.primary.id).toBe([...harness.rows.values()].find((row) => row.slot === "primary")?.id);
    expect(runtime.backup).toBeNull();
    expect(harness.issue).toHaveBeenCalledTimes(2);
    expect(harness.providerView).toHaveBeenCalledTimes(1);
  });

  it("uses increasing bounded backoff and preserves the durable custom key across attempts", async () => {
    await queueUserSupplyKeys("user-a");
    harness.issue.mockRejectedValue(new harness.IssuerError("supply_provisioning_network_failed"));
    const row = [...harness.rows.values()].find((entry) => entry.slot === "primary")!;
    for (let attempt = 0; attempt < 8; attempt++) {
      row.retryAfter = null;
      await expect(ensureUserSupplyKeys("user-a")).rejects.toMatchObject({ code: "supply_provisioning_network_failed" });
    }
    expect(harness.state.failures.map((failure) => failure.delay)).toEqual([60, 120, 240, 480, 960, 1800, 1800, 1800]);
    expect(new Set(harness.issue.mock.calls.map(([input]) => input.customKey)).size).toBe(1);
    expect(new Set(harness.issue.mock.calls.map(([input]) => input.idempotencyKey)).size).toBe(1);
  });

  it("serves the first request when primary issuance succeeds and standby issuance is limited", async () => {
    harness.issue.mockImplementationOnce(async (input) => ({ id: "primary-provider", key: input.customKey, ownerId: "7", groupId: "8" }))
      .mockRejectedValueOnce(new harness.IssuerError("supply_provisioning_rate_limited"));
    const runtime = await getUserSupplyRuntime("user-a");
    expect(runtime.primary.id).toBe([...harness.rows.values()].find((row) => row.slot === "primary")?.id);
    expect(runtime.backup).toBeNull();
    expect(harness.issue).toHaveBeenCalledTimes(2);
  });

  it("renews a lease while the provider is still processing, then commits only its own token", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    harness.issue.mockImplementationOnce(async (input) => { await new Promise<void>((resolve) => { release = resolve; }); return { id: "1", key: input.customKey, ownerId: "7", groupId: "8" }; });
    const task = ensureUserSupplyKeys("user-a");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.state.renewals).toBe(2);
    release!(); await task;
    expect([...harness.rows.values()].every((row) => row.status === "ready")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overwrite another worker after losing a lease", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    harness.issue.mockImplementationOnce(async (input) => { await new Promise<void>((resolve) => { release = resolve; }); return { id: "1", key: input.customKey, ownerId: "7", groupId: "8" }; });
    const task = ensureUserSupplyKeys("user-a");
    const assertion = expect(task).rejects.toMatchObject({ code: "USER_SUPPLY_LEASE_LOST" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    harness.state.loseLease = true;
    await vi.advanceTimersByTimeAsync(30_000);
    release!(); await assertion;
    expect([...harness.rows.values()].some((row) => row.status === "ready")).toBe(false);
    expect([...harness.rows.values()].find((row) => row.slot === "primary")?.leaseToken).toBe("different-worker");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed when ready commit affects no row", async () => {
    harness.state.rejectCommit = true;
    await expect(ensureUserSupplyKeys("user-a")).rejects.toMatchObject({ code: "USER_SUPPLY_LEASE_LOST" });
    expect([...harness.rows.values()].some((row) => row.status === "ready")).toBe(false);
  });

  it("allows repaired administrator setup to retry identity failures while preserving rate cooldown", async () => {
    await queueUserSupplyKeys("user-a");
    const row = [...harness.rows.values()].find((entry) => entry.slot === "primary")!;
    Object.assign(row, { status: "failed", lastErrorCode: "supply_provisioning_auth_rejected", retryAfter: new Date(Date.now() + 600_000) });
    await resetUserSupplyProvisioningFailures();
    expect(row.retryAfter).toBeNull();
    Object.assign(row, { lastErrorCode: "supply_provisioning_rate_limited", retryAfter: new Date(Date.now() + 3_600_000) });
    harness.state.cooldown = "supply_provisioning_rate_limited";
    await resetUserSupplyProvisioningFailures();
    expect(row.retryAfter).not.toBeNull();
    expect(harness.state.cooldown).toBe("supply_provisioning_rate_limited");
  });
});
