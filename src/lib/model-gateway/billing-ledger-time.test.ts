import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const gatewayDb = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: gatewayDb }));
import { listGatewayBillingLedger } from "./billing";
import { markGatewayBillingHoldDispatched, markGatewayBillingHoldUnknown, settleGatewayBillingHold } from "./billing-hold";

type ReadClient = Parameters<typeof listGatewayBillingLedger>[1];
const checksum = "44c6867ce5ca19a6e7aeac537ca4317b2039a14b09031d7cbdc7609827d8a2b7";
const foundationName = "20261002120000_gateway_billing_ledger";
const fixedInstant = "2026-10-02T19:03:58.944694Z";

function capture(rows: unknown[] = [], total = 0n) {
  const queries: Prisma.Sql[] = [];
  const client = { $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
    queries.push(sql);
    return queries.length % 2 ? rows : [{ total }];
  }) } as unknown as ReadClient;
  return { client, queries };
}

describe("ledger UTC read contract", () => {
  it.each([
    { page: 0 }, { from: "invalid-date" }, { kind: "unknown" },
    { from: "2026-10-03T00:00:00Z", to: "2026-10-02T00:00:00Z" }
  ])("rejects invalid query %j before reading any ledger", async query => {
    const h = capture();
    await expect(listGatewayBillingLedger(query as Parameters<typeof listGatewayBillingLedger>[0], h.client)).rejects.toMatchObject({ code: "INVALID_QUERY" });
    expect(h.queries).toHaveLength(0);
  });
  it("serializes the effective time while retaining amounts and original row fields", async () => {
    const h = capture([{ id: "opening-user", createdAt: new Date("2026-10-03T03:03:58.945Z"),
      effectiveCreatedAt: new Date("2026-10-02T19:03:58.945Z"), deltaCents: 103,
      balanceAfterCents: 103, metadata: { source: "fixture" } }], 1n);
    expect(await listGatewayBillingLedger({}, h.client)).toEqual({ items: [{ id: "opening-user",
      createdAt: "2026-10-02T19:03:58.945Z", deltaCents: 103, balanceAfterCents: 103,
      metadata: { source: "fixture" } }], total: 1, page: 1, pageSize: 25 });
  });
  it("uses the same guarded effective expression for page and count", async () => {
    const h = capture();
    await listGatewayBillingLedger({ page: 3, pageSize: 2, kind: "opening", userId: "fixture" }, h.client);
    expect(h.queries).toHaveLength(2);
    for (const query of h.queries) {
      expect(query.values).toContain(foundationName);
      expect(query.values).toContain(checksum);
      expect(query.values).toContain("fixture");
      expect(query.values).toContain("opening");
      expect(query.sql).toContain('"rolled_back_at" IS NULL');
      expect(query.sql).toContain('"effectiveCreatedAt"');
    }
    expect(h.queries[0].sql).toContain('ORDER BY "effectiveCreatedAt" DESC, "id" DESC');
    expect(h.queries[0].values.slice(-2)).toEqual([2, 4]);
  });
  it("normalizes offset date bounds to explicit UTC instant parameters", async () => {
    const h = capture();
    await listGatewayBillingLedger({ from: "2026-10-03T03:03:58.944+08:00", to: "2026-10-03T03:03:58.946+08:00" }, h.client);
    for (const query of h.queries) {
      expect(query.values).toContain("2026-10-02T19:03:58.944Z");
      expect(query.values).toContain("2026-10-02T19:03:58.946Z");
      expect(query.sql).toContain("AS TIMESTAMPTZ) AT TIME ZONE 'UTC'");
      expect(query.values.some(value => value instanceof Date)).toBe(false);
    }
  });
  it("binds literal search escapes and never interpolates user SQL", async () => {
    const h = capture();
    await listGatewayBillingLedger({ search: "50%_\\' OR 1=1 --" }, h.client);
    for (const query of h.queries) {
      expect(query.values).toContain("%50\\%\\_\\\\' OR 1=1 --%");
      expect(query.sql).not.toContain("OR 1=1");
      expect(query.sql).toContain("ESCAPE '\\'");
    }
  });
  it("keeps the legacy empty page/count DTO", async () => {
    expect(await listGatewayBillingLedger({ page: 2, pageSize: 10 }, capture().client))
      .toEqual({ items: [], total: 0, page: 2, pageSize: 10 });
  });
  it("binds every existing non-date filter to both queries", async () => {
    const h = capture();
    await listGatewayBillingLedger({ tenantId: "t", userId: "u", planCode: "p", kind: "error", model: "m", endpoint: "e" }, h.client);
    for (const query of h.queries) expect(query.values).toEqual(expect.arrayContaining(["t", "u", "p", "error", "m", "e"]));
  });
});

// Enabled only by the local test harness after it has verified a loopback URL.
// Each case creates and removes its own schema; no live wallet or merchant call exists.
const integration = process.env.GATEWAY_TIMESTAMP_INTEGRATION === "1";
function splitSql(sql: string) {
  const statements: string[] = [];
  let start = 0, quote = "", dollar = "", comment = "";
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i], next = sql[i + 1];
    if (comment === "line") { if (char === "\n") comment = ""; continue; }
    if (comment === "block") { if (char === "*" && next === "/") { comment = ""; i++; } continue; }
    if (dollar) { if (sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = ""; } continue; }
    if (quote) { if (char === quote) { if (next === quote) i++; else quote = ""; } continue; }
    if (char === "-" && next === "-") { comment = "line"; i++; continue; }
    if (char === "/" && next === "*") { comment = "block"; i++; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "$") { const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/); if (match) { dollar = match[0]; i += dollar.length - 1; continue; } }
    if (char === ";") { const statement = sql.slice(start, i).trim(); if (statement) statements.push(statement); start = i + 1; }
  }
  const tail = sql.slice(start).trim(); if (tail) statements.push(tail);
  return statements;
}
function migration(name: string) { return readFileSync(resolve("prisma/migrations", name, "migration.sql"), "utf8"); }
async function fixture(zone: string, run: (db: PrismaClient) => Promise<void>) {
  const source = new URL(process.env.GATEWAY_TIMESTAMP_DATABASE_URL || "");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(source.hostname) || !["postgres:", "postgresql:"].includes(source.protocol)) throw new Error("LOOPBACK_ONLY");
  source.searchParams.set("connection_limit", "1");
  const root = new PrismaClient({ datasources: { db: { url: source.toString() } }, log: [] });
  const schema = `gateway_timestamp_${randomUUID().replace(/-/g, "")}`;
  let db: PrismaClient | undefined;
  try {
    await root.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    source.searchParams.set("schema", schema);
    db = new PrismaClient({ datasources: { db: { url: source.toString() } }, log: [] });
    await db.$executeRaw`SELECT set_config('TimeZone', ${zone}, false)`;
    for (const sql of [
      'CREATE TABLE "Tenant" (id TEXT PRIMARY KEY,name TEXT NOT NULL)',
      'CREATE TABLE "User" (id TEXT PRIMARY KEY,"tenantId" TEXT NOT NULL,username TEXT NOT NULL,name TEXT NOT NULL)',
      'CREATE TABLE "GatewayWallet" ("userId" TEXT PRIMARY KEY,"balanceCents" INTEGER NOT NULL,"planCode" TEXT NOT NULL,"planName" TEXT NOT NULL)',
      'CREATE TABLE "GatewayUsage" (id TEXT PRIMARY KEY)',
      'CREATE TABLE "_prisma_migrations" (id TEXT PRIMARY KEY,checksum TEXT NOT NULL,migration_name TEXT NOT NULL,finished_at TIMESTAMPTZ,rolled_back_at TIMESTAMPTZ)',
      ...splitSql(migration(foundationName)), ...splitSql(migration("20261003013000_gateway_billing_hold"))
    ]) await db.$executeRawUnsafe(sql);
    await db.$executeRaw`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at) VALUES ('foundation', ${checksum}, ${foundationName}, CAST(${fixedInstant} AS TIMESTAMPTZ))`;
    await run(db);
  } finally {
    await db?.$disconnect();
    await root.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await root.$disconnect();
  }
}
async function ledger(db: Pick<PrismaClient, "$executeRaw">, input: { userId: string; createdAt?: string; localOpening?: boolean; id?: string; event?: string; kind?: string; tenant?: string; username?: string }) {
  const user = input.userId;
  const created = input.localOpening
    ? Prisma.sql`CAST(CAST(${fixedInstant} AS TIMESTAMPTZ) AT TIME ZONE 'Asia/Shanghai' AS TIMESTAMP(3))`
    : input.createdAt ? Prisma.sql`CAST(${input.createdAt} AS TIMESTAMPTZ) AT TIME ZONE 'UTC'` : Prisma.sql`DEFAULT`;
  await db.$executeRaw(Prisma.sql`INSERT INTO "GatewayBillingLedger"
    ("id", "billingEventId", "kind", "userId", "tenantId", "username", "userName", "planCode", "planName", "deltaCents", "balanceBeforeCents", "balanceAfterCents", "status", "createdAt")
    VALUES (${input.id || `opening-${user}`}, ${input.event || `opening:${user}`}, ${input.kind || "opening"}, ${user}, ${input.tenant || "fixture"}, ${input.username || user}, ${user}, 'free', 'Fixture', 0, 0, 0, 'ok', ${created})`);
}

describe.skipIf(!integration)("real PostgreSQL billing timestamp regression", () => {
  it.each(["UTC", "Asia/Shanghai", "America/New_York"])("keeps six future defaults UTC and immutable history unchanged in %s", async zone => {
    await fixture(zone, async db => {
      await ledger(db, { userId: "historical", localOpening: true });
      const before = await db.$queryRaw`SELECT row_to_json(ledger) AS value FROM "GatewayBillingLedger" ledger`;
      for (const sql of splitSql(migration("20261003043000_gateway_billing_utc_defaults"))) await db.$executeRawUnsafe(sql);
      expect(await db.$queryRaw`SELECT row_to_json(ledger) AS value FROM "GatewayBillingLedger" ledger`).toEqual(before);
      await expect(db.$executeRaw`UPDATE "GatewayBillingLedger" SET "reason" = 'tampered'`).rejects.toThrow();
      await db.$transaction(async tx => {
        await tx.$executeRaw`INSERT INTO "GatewayBillingRule" ("planCode", "planName") VALUES ('p', 'Fixture')`;
        await tx.$executeRaw`INSERT INTO "GatewayBillingRuleAudit" ("id", "planCode", "planName", "previousMultiplierBps", "multiplierBps", "previousVersion", "version", "updatedBy", "updatedByUsername", "updatedByName", "reason") VALUES ('audit', 'p', 'Fixture', 10000, 10000, 0, 1, 'a', 'a', 'a', 'Fixture')`;
        await ledger(tx, { userId: "future" });
        await tx.$executeRaw`INSERT INTO "GatewayBillingHold" ("eventId", "userId", "tenantId", "requestFingerprint", "endpoint", "provider", "model", "quoteCents", "heldCents", "billingSnapshot") VALUES ('hold', 'future', 'fixture', ${"a".repeat(64)}, '/v1/chat', 'fixture', 'fixture', 0, 0, '{}')`;
        await tx.$executeRaw`INSERT INTO "GatewayBillingHoldEvent" ("id", "eventId", "userId", "transition") VALUES ('event', 'hold', 'future', 'reserved')`;
        const diffs = await tx.$queryRaw<{ delta: number }[]>`SELECT ABS(EXTRACT(EPOCH FROM (time - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))::FLOAT AS delta FROM (
          SELECT "updatedAt" AS time FROM "GatewayBillingRule" UNION ALL SELECT "createdAt" FROM "GatewayBillingRuleAudit"
          UNION ALL SELECT "createdAt" FROM "GatewayBillingLedger" WHERE "userId"='future'
          UNION ALL SELECT "createdAt" FROM "GatewayBillingHold" UNION ALL SELECT "updatedAt" FROM "GatewayBillingHold"
          UNION ALL SELECT "createdAt" FROM "GatewayBillingHoldEvent") times`;
        expect(diffs).toHaveLength(6); for (const value of diffs) expect(value.delta).toBeLessThan(0.001);
      });
    });
  }, 30_000);

  it("corrects only the exact cohort; uses that same time for filters, pagination and counts", async () => {
    await fixture("Asia/Shanghai", async db => {
      await ledger(db, { userId: "historical", localOpening: true, tenant: "chronology" });
      await ledger(db, { userId: "later", id: "later-cuid", createdAt: "2026-10-02T19:03:58.946Z", tenant: "chronology" });
      await ledger(db, { userId: "utc", createdAt: "2026-10-02T19:03:58.945Z" });
      await ledger(db, { userId: "other-id", id: "cuid-opening", localOpening: true });
      await ledger(db, { userId: "other-event", event: "other-event", localOpening: true });
      await ledger(db, { userId: "other-kind", kind: "error", localOpening: true });
      await ledger(db, { userId: "other-ms", createdAt: "2026-10-03T03:03:58.946Z" });
      const all = await listGatewayBillingLedger({}, db);
      const byUser = Object.fromEntries(all.items.map(row => [row.userId, row.createdAt]));
      expect(byUser.historical).toBe("2026-10-02T19:03:58.945Z");
      expect(byUser.utc).toBe("2026-10-02T19:03:58.945Z");
      for (const user of ["other-id", "other-event", "other-kind"]) expect(byUser[user]).toBe("2026-10-03T03:03:58.945Z");
      expect(byUser["other-ms"]).toBe("2026-10-03T03:03:58.946Z");
      const first = await listGatewayBillingLedger({ tenantId: "chronology", pageSize: 1 }, db);
      const second = await listGatewayBillingLedger({ tenantId: "chronology", pageSize: 1, page: 2 }, db);
      expect(first.total).toBe(2); expect(first.items[0].userId).toBe("later"); expect(second.items[0].userId).toBe("historical");
      for (const zone of ["UTC", "Asia/Shanghai", "America/New_York"]) {
        await db.$executeRaw`SELECT set_config('TimeZone', ${zone}, false)`;
        const at = await listGatewayBillingLedger({ tenantId: "chronology", from: "2026-10-03T03:03:58.945+08:00", to: "2026-10-02T19:03:58.945Z" }, db);
        expect(at.total).toBe(1); expect(at.items[0].userId).toBe("historical");
        expect((await listGatewayBillingLedger({ tenantId: "chronology", to: "2026-10-02T19:03:58.944Z" }, db)).total).toBe(0);
        expect((await listGatewayBillingLedger({ tenantId: "chronology", from: "2026-10-02T19:03:58.946Z" }, db)).items.map(row => row.userId)).toEqual(["later"]);
      }
      expect((await listGatewayBillingLedger({ tenantId: "chronology", from: "2026-10-02T00:00:00Z", to: "2026-10-02T23:59:59.999Z" }, db)).total).toBe(2);
      for (const changes of [
        Prisma.sql`UPDATE "_prisma_migrations" SET "checksum"='invalid'`,
        Prisma.sql`UPDATE "_prisma_migrations" SET "rolled_back_at"=CURRENT_TIMESTAMP`,
        Prisma.sql`UPDATE "_prisma_migrations" SET "finished_at"=NULL`,
        Prisma.sql`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at) VALUES ('duplicate', 'invalid', ${foundationName}, CAST(${fixedInstant} AS TIMESTAMPTZ))`,
        Prisma.sql`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at) VALUES ('duplicate', 'invalid', ${foundationName}, NULL)`,
        Prisma.sql`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, rolled_back_at) VALUES ('duplicate', 'invalid', ${foundationName}, CAST(${fixedInstant} AS TIMESTAMPTZ), CURRENT_TIMESTAMP)`
      ]) {
        await db.$executeRaw(changes);
        expect((await listGatewayBillingLedger({ userId: "historical" }, db)).items[0].createdAt).toBe("2026-10-03T03:03:58.945Z");
        await db.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id='duplicate'`;
        await db.$executeRaw`UPDATE "_prisma_migrations" SET "checksum"=${checksum}, "rolled_back_at"=NULL, "finished_at"=CAST(${fixedInstant} AS TIMESTAMPTZ)`;
      }
      await expect(db.$executeRaw`UPDATE "GatewayBillingLedger" SET "createdAt"=CURRENT_TIMESTAMP`).rejects.toThrow();
    });
  }, 30_000);

  it("matches literal percent, underscore, slash and quotes without wildcard or SQL expansion", async () => {
    await fixture("Asia/Shanghai", async db => {
      for (const [userId, username] of [["percent", "value%exact"], ["underscore", "value_exact"], ["slash", "value\\exact"], ["quote", "value'exact"], ["plain", "valueZexact"]]) await ledger(db, { userId, username });
      for (const [search, expected] of [["%", "percent"], ["_", "underscore"], ["\\", "slash"], ["'", "quote"]]) {
        const found = await listGatewayBillingLedger({ search }, db);
        expect(found.total).toBe(1); expect(found.items.map(row => row.userId)).toEqual([expected]);
      }
      expect((await listGatewayBillingLedger({ search: "' OR 1=1 --" }, db)).total).toBe(0);
    });
  }, 30_000);

  it("executes all four hold transition updates as UTC in a Shanghai session", async () => {
    await fixture("Asia/Shanghai", async db => {
      for (const sql of splitSql(migration("20261003043000_gateway_billing_utc_defaults"))) await db.$executeRawUnsafe(sql);
      await db.$executeRaw`INSERT INTO "GatewayWallet" ("userId", "balanceCents", "planCode", "planName") VALUES ('future', 1000, 'free', 'Fixture')`;
      await db.$executeRaw`INSERT INTO "GatewayBillingHold" ("eventId", "userId", "tenantId", "requestFingerprint", "endpoint", "provider", "model", "quoteCents", "heldCents", "billingSnapshot") VALUES ('event-hold', 'future', 'fixture', ${"a".repeat(64)}, '/v1/chat', 'fixture', 'fixture', 10, 10, '{}')`;
      gatewayDb.$transaction.mockImplementation((action: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => action({
        ...tx,
        $queryRaw: tx.$queryRaw.bind(tx),
        $executeRaw: tx.$executeRaw.bind(tx),
        // Isolate the wallet ORM lock metadata, retaining the real SQL wallet row,
        // hold SQL, transitions, ledger, journals and transaction boundaries.
        gatewayWallet: {
          ...tx.gatewayWallet,
          upsert: vi.fn().mockResolvedValue({ userId: "future", balanceCents: 1000 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ userId: "future", balanceCents: 1000 })
        }
      } as Prisma.TransactionClient)));
      async function checkTimes() {
        const values = await db.$queryRaw<{ delta: number }[]>`SELECT ABS(EXTRACT(EPOCH FROM (time - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))::FLOAT AS delta FROM (
          SELECT "createdAt" AS time FROM "GatewayBillingHold" UNION ALL SELECT "updatedAt" FROM "GatewayBillingHold"
          UNION ALL SELECT "dispatchedAt" FROM "GatewayBillingHold" WHERE "dispatchedAt" IS NOT NULL
          UNION ALL SELECT "createdAt" FROM "GatewayBillingHoldEvent") times`;
        for (const value of values) expect(value.delta).toBeLessThan(2);
      }
      try {
        expect((await markGatewayBillingHoldDispatched({ userId: "future", eventId: "event-hold" })).shouldDispatch).toBe(true);
        await checkTimes();
        await markGatewayBillingHoldUnknown({ userId: "future", eventId: "event-hold", reason: "timeout" });
        await checkTimes();
        await expect(settleGatewayBillingHold({ userId: "future", eventId: "event-hold", finalCostCents: 2000,
          outcomeFingerprint: "b".repeat(64), writeUsage: async () => { throw new Error("SHOULD_NOT_WRITE"); } }))
          .rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
        await checkTimes();
        expect((await db.$queryRaw<{ heldCents: number }[]>`SELECT "heldCents" FROM "GatewayBillingHold"`)[0].heldCents).toBe(2000);
        const settled = await settleGatewayBillingHold({ userId: "future", eventId: "event-hold", finalCostCents: 0,
          outcomeFingerprint: "c".repeat(64), writeUsage: async tx => {
            await tx.$executeRaw`INSERT INTO "GatewayBillingLedger" ("id", "billingEventId", "kind", "userId", "tenantId", "username", "userName", "planCode", "planName", "deltaCents", "balanceBeforeCents", "balanceAfterCents", "status", "usageId")
              VALUES ('debit-fixture', 'event-hold', 'debit', 'future', 'fixture', 'future', 'future', 'free', 'Fixture', 0, 1000, 1000, 'ok', 'usage-fixture')`;
          } });
        expect(settled.hold.status).toBe("settled");
        await checkTimes();
        expect((await db.$queryRaw<{ balanceCents: number }[]>`SELECT "balanceCents" FROM "GatewayWallet"`)[0].balanceCents).toBe(1000);
      } finally { gatewayDb.$transaction.mockReset(); }
    });
  }, 30_000);
});
