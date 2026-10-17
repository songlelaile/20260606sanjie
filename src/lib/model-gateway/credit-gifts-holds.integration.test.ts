import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createPaymentUatDatabase } from "../../../scripts/payment-uat-db.mjs";
import type { GatewayBillingSnapshot } from "./billing-contract";

const sandbox = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ get prisma() { return sandbox.client; } }));

describe.skipIf(process.env.CREDIT_GIFT_INTEGRATION !== "1")("isolated PostgreSQL gifts with production billing holds", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let gifts: typeof import("./credit-gifts");
  let billing: typeof import("./billing");
  let holds: typeof import("./billing-hold");
  let store: typeof import("./store");
  let tenantId: string, adminId: string;
  let sequence = 0;
  const client = () => sandbox.client!;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const giftInput = (userId: string, points = "10.3") => ({ userId, points, reason: "冻结期间赠送回归", requestKey: randomUUID() });

  async function account(balanceCents = 1003, withWallet = true) {
    const user = await client().user.create({ data: {
      tenantId, username: `gift-hold-case-${++sequence}`, password: "unused-uat-password", name: "冻结期间赠送目标"
    } });
    if (withWallet) await client().gatewayWallet.create({ data: {
      userId: user.id, balanceCents, monthlyQuotaCents: 4321, planCode: "starter", planName: "体验版",
      periodStart: new Date("2026-10-01T00:00:00.000Z"), periodEnd: new Date("2026-10-31T00:00:00.000Z")
    } });
    return user;
  }

  async function pool(balanceCents = 1000, status = "ready") {
    return client().gatewayCreditPool.upsert({ where: { id: "total" }, update: { balanceCents, status }, create: { id: "total", balanceCents, status } });
  }

  async function quote(user: { id: string; username: string }, quoteCents: number, eventId: string = randomUUID()) {
    const billingSnapshot: GatewayBillingSnapshot = {
      ...await billing.getGatewayBillingSnapshot(user.id),
      fxSnapshot: { rate: 7.2, source: "manual", referenceDate: null, fetchedAt: null, id: null }
    };
    const auth = { userId: user.id, username: user.username, apiKeyId: null, keyPrefix: "isolated-hold" };
    const request = { auth, billingSnapshot, eventId, quoteCents, requestFingerprint: digest(eventId), endpoint: "images.generations", provider: "shaozhuang", model: "image2" };
    return { request, auth, billingSnapshot, eventId };
  }

  async function reserve(user: { id: string; username: string }, quoteCents: number, phase: "reserved" | "dispatched" | "unknown" = "reserved") {
    const frozen = await quote(user, quoteCents);
    await holds.reserveGatewayBillingHold(frozen.request);
    if (phase !== "reserved") await holds.markGatewayBillingHoldDispatched({ userId: user.id, eventId: frozen.eventId });
    if (phase === "unknown") await holds.markGatewayBillingHoldUnknown({ userId: user.id, eventId: frozen.eventId, reason: "timeout" });
    return frozen;
  }

  async function available(userId: string) {
    return client().$transaction(async (tx) => {
      await billing.lockGatewayBillingWallet(tx, userId);
      return holds.getGatewayAvailableBalance(tx, userId);
    });
  }

  function settlement(userId: string, frozen: Awaited<ReturnType<typeof quote>>, finalCostCents: number) {
    return {
      userId, eventId: frozen.eventId, finalCostCents, outcomeFingerprint: digest(`outcome:${frozen.eventId}:${finalCostCents}`),
      writeUsage: async (tx: Parameters<typeof holds.getGatewayAvailableBalance>[0], context: { billingSnapshot: GatewayBillingSnapshot; eventId: string }) => {
        await store.recordGatewayUsage({
          auth: frozen.auth, billingSnapshot: context.billingSnapshot, billingEventId: context.eventId,
          endpoint: "images.generations", provider: "shaozhuang", model: "image2", costCents: finalCostCents,
          baseCostCents: finalCostCents, status: "ok", imageCount: 1, requestId: `fixture-${frozen.eventId}`
        }, tx);
      }
    };
  }

  async function runMigration(path: string) {
    let sql = await readFile(path, "utf8");
    const bodies: string[] = [];
    sql = sql.replace(/\$\$[\s\S]*?\$\$/g, (body) => { bodies.push(body); return `__GIFT_HOLD_BODY_${bodies.length - 1}__`; });
    // Migration comments can contain semicolons; they must not become SQL statements.
    sql = sql.replace(/--[^\n]*/g, "");
    for (const part of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
      await client().$executeRawUnsafe(part.replace(/__GIFT_HOLD_BODY_(\d+)__/g, (_, index) => bodies[Number(index)]));
    }
  }

  beforeAll(async () => {
    // The shared helper rejects every non-local PostgreSQL host and creates a disposable schema.
    // No supplier request, existing database row, production configuration or real allocation is touched.
    const db = await createPaymentUatDatabase();
    cleanup = db.cleanup;
    sandbox.client = new PrismaClient({ datasources: { db: { url: db.url } }, log: [] });
    // Keep the candidate's hold/native-video/supply schema intact; exercise the exact gift and ledger DDL.
    for (const table of ["GatewayCreditGift", "GatewayCreditPool", "GatewayBillingLedger", "GatewayBillingRuleAudit", "GatewayBillingRule"]) {
      await client().$executeRawUnsafe(`DROP TABLE "${table}"`);
    }
    await client().$executeRawUnsafe('ALTER TABLE "GatewayUsage" DROP COLUMN "billingEventId"');
    await runMigration("prisma/migrations/20261002120000_gateway_billing_ledger/migration.sql");
    await runMigration("prisma/migrations/20261003120000_gateway_credit_gifts/migration.sql");
    await runMigration("prisma/migrations/20261003043000_gateway_billing_utc_defaults/migration.sql");
    const tenant = await client().tenant.create({ data: { name: "冻结赠送本机隔离租户", slug: `gift-hold-${randomUUID()}` } });
    tenantId = tenant.id;
    const admin = await client().user.create({ data: { tenantId, username: `gift-hold-admin-${randomUUID()}`, password: "unused-uat-password", name: "隔离管理员", authRole: "admin" } });
    adminId = admin.id;
    gifts = await import("./credit-gifts"); billing = await import("./billing"); holds = await import("./billing-hold"); store = await import("./store");
  }, 60_000);

  afterAll(async () => {
    await sandbox.client?.$disconnect();
    await cleanup?.();
  });

  it.each(["reserved", "dispatched", "unknown"] as const)("credits total balance without releasing or repricing a %s hold", async (phase) => {
    await pool();
    const user = await account(), frozen = await reserve(user, 800, phase);
    const before = await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: frozen.eventId } });
    const beforeEvents = await client().gatewayBillingHoldEvent.count({ where: { eventId: frozen.eventId } });
    expect(await available(user.id)).toEqual({ balanceCents: 1003, reservedCents: 800, availableCents: 203 });
    const gifted = await gifts.giftGatewayCredits(adminId, giftInput(user.id));
    expect(gifted).toMatchObject({ amountCents: 103, walletBeforeCents: 1003, walletAfterCents: 1106 });
    expect(await available(user.id)).toEqual({ balanceCents: 1106, reservedCents: 800, availableCents: 306 });
    expect(await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: frozen.eventId } })).toEqual(before);
    expect(await client().gatewayBillingHoldEvent.count({ where: { eventId: frozen.eventId } })).toBe(beforeEvents);
    expect(await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: `opening:${user.id}` } })).toMatchObject({ deltaCents: 1003, balanceAfterCents: 1003 });
    expect(await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ monthlyQuotaCents: 4321, periodEnd: new Date("2026-10-31T00:00:00.000Z"), planCode: "starter" });
  });

  it("keeps all prior held cents unavailable to a new unreserved call after a small gift", async () => {
    await pool();
    const user = await account(), frozen = await reserve(user, 1003, "dispatched");
    const request = giftInput(user.id, "1");
    await gifts.giftGatewayCredits(adminId, request);
    expect(await available(user.id)).toEqual({ balanceCents: 1013, reservedCents: 1003, availableCents: 10 });
    const event = randomUUID();
    await expect(store.recordGatewayUsage({
      auth: frozen.auth, billingSnapshot: frozen.billingSnapshot, billingEventId: event,
      endpoint: "images.generations", provider: "shaozhuang", model: "image2", costCents: 11, baseCostCents: 11, status: "ok"
    })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: event } })).toMatchObject({ deltaCents: 0, chargedCostCents: 0, balanceBeforeCents: 1013, balanceAfterCents: 1013, status: "settlement_rejected" });
    expect(await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: frozen.eventId } })).toMatchObject({ status: "dispatched", heldCents: 1003, settledCents: null });
    expect(await client().gatewayBillingHoldEvent.count({ where: { eventId: frozen.eventId, transition: "released" } })).toBe(0);
  });

  it("serializes duplicate gifts and an active hold settlement with one continuous wallet journal", async () => {
    await pool();
    const user = await account(), settled = await reserve(user, 600, "dispatched"), other = await reserve(user, 300, "unknown");
    const otherBefore = await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: other.eventId } });
    const request = giftInput(user.id), settle = settlement(user.id, settled, 550);
    const outcomes = await Promise.all([
      ...Array.from({ length: 10 }, () => gifts.giftGatewayCredits(adminId, request)),
      holds.settleGatewayBillingHold(settle)
    ]);
    expect(new Set(outcomes.slice(0, 10).map((value) => "id" in value ? value.id : "unexpected")).size).toBe(1);
    expect(await available(user.id)).toEqual({ balanceCents: 556, reservedCents: 300, availableCents: 256 });
    expect(await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: other.eventId } })).toEqual(otherBefore);
    expect(await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: settled.eventId } })).toMatchObject({ status: "settled", quoteCents: 600, heldCents: 600, settledCents: 550 });
    expect(await client().gatewayBillingHoldEvent.count({ where: { eventId: settled.eventId, transition: "settled" } })).toBe(1);
    expect(await client().gatewayBillingHoldEvent.count({ where: { userId: user.id, transition: "released" } })).toBe(0);
    expect(await client().gatewayCreditGift.count({ where: { requestKey: request.requestKey } })).toBe(1);
    expect((await client().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).balanceCents).toBe(897);
    expect(await client().gatewayBillingLedger.count({ where: { billingEventId: `opening:${user.id}` } })).toBe(1);
    const entries = await client().gatewayBillingLedger.findMany({ where: { userId: user.id, kind: { not: "opening" } } });
    expect(entries).toHaveLength(2);
    expect(entries.map((row) => row.kind).sort()).toEqual(["debit", "gift"]);
    let balance = 1003;
    const remaining = [...entries];
    while (remaining.length) {
      const index = remaining.findIndex((row) => row.balanceBeforeCents === balance);
      expect(index).toBeGreaterThanOrEqual(0);
      const [row] = remaining.splice(index, 1);
      balance += row.deltaCents;
      expect(row.balanceAfterCents).toBe(balance);
    }
    expect(balance).toBe(556);
    expect((await holds.settleGatewayBillingHold(settle)).replayed).toBe(true);
    await gifts.giftGatewayCredits(adminId, request);
    expect(await available(user.id)).toEqual({ balanceCents: 556, reservedCents: 300, availableCents: 256 });
    expect(await client().gatewayUsage.count({ where: { billingEventId: settled.eventId } })).toBe(1);
  });

  it("retains an unknown oversized liability while gifting funds and then settles it exactly once", async () => {
    await pool(2000);
    const user = await account(), frozen = await reserve(user, 500, "dispatched"), settle = settlement(user.id, frozen, 1500);
    await expect(holds.settleGatewayBillingHold(settle)).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    const unknown = await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: frozen.eventId } });
    expect(unknown).toMatchObject({ status: "unknown", quoteCents: 500, heldCents: 1500, settledCents: null, reason: "insufficient_settlement" });
    await gifts.giftGatewayCredits(adminId, giftInput(user.id));
    expect(await available(user.id)).toEqual({ balanceCents: 1106, reservedCents: 1500, availableCents: 0 });
    expect(await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: frozen.eventId } })).toEqual(unknown);
    expect(await client().gatewayUsage.count({ where: { billingEventId: frozen.eventId } })).toBe(0);
    await gifts.giftGatewayCredits(adminId, giftInput(user.id, "50"));
    expect(await available(user.id)).toEqual({ balanceCents: 1606, reservedCents: 1500, availableCents: 106 });
    await holds.settleGatewayBillingHold(settle);
    expect(await available(user.id)).toEqual({ balanceCents: 106, reservedCents: 0, availableCents: 106 });
    expect(await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: frozen.eventId } })).toMatchObject({ kind: "debit", deltaCents: -1500, balanceBeforeCents: 1606, balanceAfterCents: 106 });
    expect(await client().gatewayBillingHoldEvent.count({ where: { eventId: frozen.eventId, transition: "released" } })).toBe(0);
    expect((await holds.settleGatewayBillingHold(settle)).replayed).toBe(true);
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(106);
  });

  it("blocks pending or missing pool without writing a wallet, hold, opening or gift journal", async () => {
    const user = await account(), frozen = await reserve(user, 700, "unknown"), request = giftInput(user.id);
    await pool(1000, "pending");
    const beforeWallet = await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } });
    const beforeHold = await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: frozen.eventId } });
    const beforeEvents = await client().gatewayBillingHoldEvent.count({ where: { eventId: frozen.eventId } });
    for (const state of ["pending", "missing"] as const) {
      if (state === "missing") await client().gatewayCreditPool.delete({ where: { id: "total" } });
      await expect(gifts.giftGatewayCredits(adminId, request)).rejects.toMatchObject({ code: "CREDIT_POOL_NOT_READY" });
      expect(await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).toEqual(beforeWallet);
      expect(await client().gatewayBillingHold.findUniqueOrThrow({ where: { eventId: frozen.eventId } })).toEqual(beforeHold);
      expect(await client().gatewayBillingHoldEvent.count({ where: { eventId: frozen.eventId } })).toBe(beforeEvents);
      expect(await client().gatewayBillingLedger.count({ where: { userId: user.id } })).toBe(0);
      expect(await client().gatewayCreditGift.count({ where: { requestKey: request.requestKey } })).toBe(0);
    }
    expect(await client().gatewayCreditPool.count()).toBe(0);
    expect(await available(user.id)).toEqual({ balanceCents: 1003, reservedCents: 700, availableCents: 303 });
  });

  it("rejects gift event namespace before a hold or usage can create money state", async () => {
    const user = await account(0, false), eventId = `gift:${randomUUID()}`, frozen = await quote(user, 10, eventId);
    await expect(holds.reserveGatewayBillingHold(frozen.request)).rejects.toMatchObject({ code: "INVALID_BILLING_EVENT" });
    await expect(store.recordGatewayUsage({
      auth: frozen.auth, billingSnapshot: frozen.billingSnapshot, billingEventId: eventId,
      endpoint: "images.generations", provider: "shaozhuang", model: "image2", costCents: 1, status: "ok"
    })).rejects.toMatchObject({ code: "INVALID_BILLING_EVENT" });
    expect(await client().gatewayWallet.findUnique({ where: { userId: user.id } })).toBeNull();
    expect(await client().gatewayBillingHold.findUnique({ where: { eventId } })).toBeNull();
    expect(await client().gatewayBillingHoldEvent.count({ where: { eventId } })).toBe(0);
    expect(await client().gatewayBillingLedger.count({ where: { userId: user.id } })).toBe(0);
    expect(await client().gatewayUsage.count({ where: { userId: user.id } })).toBe(0);
  });
});
