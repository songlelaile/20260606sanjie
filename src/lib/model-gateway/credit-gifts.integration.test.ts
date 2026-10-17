import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createPaymentUatDatabase } from "../../../scripts/payment-uat-db.mjs";

const sandbox = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ get prisma() { return sandbox.client; } }));

describe.skipIf(process.env.CREDIT_GIFT_INTEGRATION !== "1")("isolated PostgreSQL credit gifts", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let gifts: typeof import("./credit-gifts");
  let billing: typeof import("./billing");
  let store: typeof import("./store");
  let creative: typeof import("../creative-credit");
  let tenantId: string, recipientTenantId: string, adminId: string, otherAdminId: string, ordinaryId: string, legacyId: string;
  let sequence = 0;
  const client = () => sandbox.client!;
  const input = (userId: string, points = "10.3", requestKey = randomUUID()) => ({ userId, points, reason: "隔离赠送测试", requestKey });

  async function account(balanceCents = 1003, withWallet = true) {
    const user = await client().user.create({ data: { tenantId: recipientTenantId, username: `gift-case-${++sequence}`, password: "unused-uat-password", name: "赠送目标" } });
    if (withWallet) await client().gatewayWallet.create({ data: {
      userId: user.id, balanceCents, planCode: "starter", planName: "体验版", monthlyQuotaCents: 4321,
      periodStart: new Date("2026-09-20T00:00:00.000Z"), periodEnd: new Date("2026-10-20T00:00:00.000Z")
    } });
    return user;
  }

  async function pool(balanceCents = 1000, status = "ready") {
    return client().gatewayCreditPool.upsert({ where: { id: "total" }, update: { status, balanceCents }, create: { id: "total", status, balanceCents } });
  }

  async function runMigration(path: string) {
    let sql = (await readFile(path, "utf8")).replace(/^\s*--[^\n]*$/gm, "");
    const bodies: string[] = [];
    sql = sql.replace(/\$\$[\s\S]*?\$\$/g, (body) => { bodies.push(body); return `__GIFT_SQL_BODY_${bodies.length - 1}__`; });
    for (const part of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
      await client().$executeRawUnsafe(part.replace(/__GIFT_SQL_BODY_(\d+)__/g, (_, index) => bodies[Number(index)]));
    }
  }

  beforeAll(async () => {
    const db = await createPaymentUatDatabase();
    cleanup = db.cleanup;
    sandbox.client = new PrismaClient({ datasources: { db: { url: db.url } }, log: [] });
    const tenants = await Promise.all(["管理员租户", "赠送目标租户"].map((name, index) => client().tenant.create({ data: { name, slug: `gift-uat-${Date.now()}-${index}` } })));
    tenantId = tenants[0].id; recipientTenantId = tenants[1].id;
    const users = await Promise.all(["admin", "other-admin", "ordinary", "legacy"].map((name) => client().user.create({ data: {
      tenantId: name === "legacy" ? recipientTenantId : tenantId, username: `gift-${name}`, password: "unused-uat-password", name,
      authRole: name.includes("admin") ? "admin" : "tenant", role: name === "ordinary" ? "admin" : "operator"
    } })));
    [adminId, otherAdminId, ordinaryId, legacyId] = users.map((user) => user.id);
    await client().gatewayWallet.create({ data: { userId: legacyId, balanceCents: 1003, planCode: "starter", planName: "体验版", monthlyQuotaCents: 4321 } });
    await client().gatewayUsage.create({ data: { userId: legacyId, endpoint: "images.generations", provider: "legacy", model: "legacy-image", costCents: 77 } });
    // Exercise the deployed SQL evolution against historical cents and usages, within this disposable schema only.
    for (const table of ["GatewayCreditGift", "GatewayCreditPool", "GatewayBillingLedger", "GatewayBillingRuleAudit", "GatewayBillingRule"]) {
      await client().$executeRawUnsafe(`DROP TABLE "${table}"`);
    }
    await client().$executeRawUnsafe('ALTER TABLE "GatewayUsage" DROP COLUMN "billingEventId"');
    await runMigration("prisma/migrations/20261002120000_gateway_billing_ledger/migration.sql");
    await runMigration("prisma/migrations/20261003120000_gateway_credit_gifts/migration.sql");
    await runMigration("prisma/migrations/20261003043000_gateway_billing_utc_defaults/migration.sql");
    // db push does not record migrations. The current ledger reader still needs
    // the standard metadata table, with no invented history in this disposable schema.
    await client().$executeRawUnsafe(`CREATE TABLE "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY, "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ, "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )`);
    vi.stubEnv("MODEL_GATEWAY_PAYMENT_PROVIDER", "manual");
    vi.stubEnv("MODEL_GATEWAY_MANUAL_PAY_URL", "");
    gifts = await import("./credit-gifts"); billing = await import("./billing"); store = await import("./store"); creative = await import("../creative-credit");
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sandbox.client?.$disconnect();
    await cleanup?.();
  });

  it("never seeds capacity and fails closed for missing/pending pools", async () => {
    expect(await client().gatewayCreditPool.count()).toBe(0);
    expect(await gifts.getGatewayCreditGiftOverview()).toEqual({ pool: { ready: false, balanceCents: null, balancePoints: null }, gifts: [] });
    const user = await account(0, false), request = input(user.id);
    await expect(gifts.giftGatewayCredits(adminId, request)).rejects.toMatchObject({ code: "CREDIT_POOL_NOT_READY" });
    expect(await client().gatewayCreditPool.count()).toBe(0);
    expect(await client().gatewayWallet.findUnique({ where: { userId: user.id } })).toBeNull();
    await client().gatewayCreditPool.create({ data: { id: "total" } });
    expect((await gifts.getGatewayCreditGiftOverview()).pool).toEqual({ ready: false, balanceCents: null, balancePoints: null });
    await expect(gifts.giftGatewayCredits(adminId, request)).rejects.toMatchObject({ code: "CREDIT_POOL_NOT_READY" });
    expect(await client().gatewayCreditGift.count()).toBe(0);
  });

  it("checks server admin role/status and active recipient, not management display role", async () => {
    await pool();
    const user = await account(0, false), request = input(user.id);
    await expect(gifts.giftGatewayCredits(ordinaryId, request)).rejects.toMatchObject({ code: "ADMIN_REQUIRED", status: 403 });
    await expect(gifts.giftGatewayCredits("missing-admin", request)).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await client().user.update({ where: { id: otherAdminId }, data: { status: "disabled" } });
    await expect(gifts.giftGatewayCredits(otherAdminId, request)).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await client().user.update({ where: { id: otherAdminId }, data: { status: "active" } });
    await client().user.update({ where: { id: user.id }, data: { status: "disabled" } });
    await expect(gifts.giftGatewayCredits(adminId, request)).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    await expect(gifts.giftGatewayCredits(adminId, input("missing-recipient"))).rejects.toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    expect((await client().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).balanceCents).toBe(1000);
    expect(await client().gatewayWallet.findUnique({ where: { userId: user.id } })).toBeNull();
  });

  it("transfers exact cents with snapshots and keeps plan, quota, expiry and access unchanged", async () => {
    await pool(2000);
    const user = await account(), before = await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } });
    const orderCount = await client().gatewayOrder.count(), grantCount = await client().aIAccessGrant.count(), entitlementCount = await client().toolEntitlement.count();
    const gift = await gifts.giftGatewayCredits(adminId, input(user.id));
    expect(gift).toMatchObject({ amountCents: 103, amountPoints: 10.3, poolBeforeCents: 2000, poolAfterCents: 1897, walletBeforeCents: 1003, walletAfterCents: 1106,
      adminId, adminTenantId: tenantId, adminTenantName: "管理员租户", tenantId: recipientTenantId, tenantName: "赠送目标租户", username: user.username });
    const after = await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } });
    expect(after).toMatchObject({ planCode: before.planCode, planName: before.planName, monthlyQuotaCents: before.monthlyQuotaCents, periodStart: before.periodStart, periodEnd: before.periodEnd, balanceCents: 1106 });
    expect(await client().gatewayOrder.count()).toBe(orderCount); expect(await client().aIAccessGrant.count()).toBe(grantCount); expect(await client().toolEntitlement.count()).toBe(entitlementCount);
    expect(await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: `opening:${user.id}` } })).toMatchObject({ deltaCents: 1003, balanceAfterCents: 1003 });
    expect(await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: gift.billingEventId } })).toMatchObject({ kind: "gift", deltaCents: 103, actorId: adminId, balanceBeforeCents: 1003, balanceAfterCents: 1106, orderId: null, usageId: null });
    expect((await billing.listGatewayBillingLedger({ userId: user.id, kind: "gift" })).items[0]).toMatchObject({ billingEventId: gift.billingEventId, deltaCents: 103 });
    expect((await creative.getCreativeCreditLedger(user.id)).items.find((row) => row.kind === "gift")).toMatchObject({ billingEventId: gift.billingEventId, deltaPoints: 10.3 });
  });

  it("preserves historical wallet/usage cents across migration and first gift", async () => {
    await pool();
    expect(await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: `opening:${legacyId}` } })).toMatchObject({ deltaCents: 1003, balanceBeforeCents: 0, balanceAfterCents: 1003 });
    await gifts.giftGatewayCredits(adminId, input(legacyId, "0.1"));
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: legacyId } })).balanceCents).toBe(1004);
    expect(await client().gatewayUsage.findFirstOrThrow({ where: { model: "legacy-image" } })).toMatchObject({ costCents: 77, billingEventId: null });
  });

  it("serializes concurrent different recipients against the same limited pool", async () => {
    await pool(100);
    const users = await Promise.all([account(0, false), account(0, false)]);
    const requests = users.map((user) => input(user.id, "8"));
    const outcomes = await Promise.allSettled(requests.map((request) => gifts.giftGatewayCredits(adminId, request)));
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect((outcomes.find((row) => row.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "INSUFFICIENT_POOL_BALANCE" });
    expect((await client().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).balanceCents).toBe(20);
    expect(await client().gatewayCreditGift.count({ where: { requestKey: { in: requests.map((request) => request.requestKey) } } })).toBe(1);
    expect((await client().gatewayWallet.findMany({ where: { userId: { in: users.map((user) => user.id) } } })).map((row) => row.balanceCents)).toEqual([80]);
  });

  it("returns one journal for concurrent same-key retries and rejects changed payload/actor", async () => {
    await pool();
    const user = await account(), other = await account(), request = input(user.id);
    const results = await Promise.all(Array.from({ length: 10 }, () => gifts.giftGatewayCredits(adminId, request)));
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(await client().gatewayBillingLedger.count({ where: { billingEventId: results[0].billingEventId } })).toBe(1);
    expect((await client().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).balanceCents).toBe(897);
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(1106);
    for (const changed of [{ ...request, points: "10.4" }, { ...request, reason: "不同理由" }, { ...request, userId: other.id }]) {
      await expect(gifts.giftGatewayCredits(adminId, changed)).rejects.toMatchObject({ code: "GIFT_REQUEST_CONFLICT" });
    }
    await expect(gifts.giftGatewayCredits(otherAdminId, request)).rejects.toMatchObject({ code: "GIFT_REQUEST_CONFLICT" });
    await expect(gifts.giftGatewayCredits(adminId, { ...request, amountCents: 1 })).rejects.toMatchObject({ code: "INVALID_GIFT_INPUT" });
  });

  it("confirms committed same-key results after recipient disable or deletion without granting again", async () => {
    await pool();
    const user = await account(), request = input(user.id), saved = await gifts.giftGatewayCredits(adminId, request);
    await client().user.update({ where: { id: user.id }, data: { status: "disabled" } });
    expect(await gifts.giftGatewayCredits(adminId, request)).toEqual(saved);
    await client().user.delete({ where: { id: user.id } });
    expect(await gifts.giftGatewayCredits(adminId, request)).toEqual(saved);
    await pool(897, "pending");
    expect(await gifts.giftGatewayCredits(adminId, request)).toEqual(saved);
    expect((await gifts.getGatewayCreditGiftOverview()).pool).toEqual({ ready: false, balanceCents: null, balancePoints: null });
    await expect(gifts.giftGatewayCredits(adminId, input(legacyId))).rejects.toMatchObject({ code: "CREDIT_POOL_NOT_READY" });
    expect((await client().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).balanceCents).toBe(897);
    expect(await client().gatewayCreditGift.count({ where: { requestKey: request.requestKey } })).toBe(1);
  });

  it("rolls back pool, wallet and opening if a gift ledger cannot be written", async () => {
    await pool();
    const user = await account(0, false), request = input(user.id);
    await client().$executeRawUnsafe('ALTER TABLE "GatewayBillingLedger" ADD CONSTRAINT "gift_uat_reject_ledger" CHECK ("kind" <> \'gift\') NOT VALID');
    try {
      await expect(gifts.giftGatewayCredits(adminId, request)).rejects.toBeTruthy();
      expect((await client().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).balanceCents).toBe(1000);
      expect(await client().gatewayWallet.findUnique({ where: { userId: user.id } })).toBeNull();
      expect(await client().gatewayBillingLedger.count({ where: { userId: user.id } })).toBe(0);
      expect(await client().gatewayCreditGift.findUnique({ where: { requestKey: request.requestKey } })).toBeNull();
    } finally { await client().$executeRawUnsafe('ALTER TABLE "GatewayBillingLedger" DROP CONSTRAINT "gift_uat_reject_ledger"'); }
    expect((await gifts.giftGatewayCredits(adminId, request)).amountCents).toBe(103);
  });

  it("rolls back the pool if wallet credit fails", async () => {
    await pool();
    const user = await account(), request = input(user.id);
    await client().$executeRawUnsafe('ALTER TABLE "GatewayWallet" ADD CONSTRAINT "gift_uat_reject_wallet" CHECK ("balanceCents" < 0) NOT VALID');
    try {
      await expect(gifts.giftGatewayCredits(adminId, request)).rejects.toBeTruthy();
      expect((await client().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).balanceCents).toBe(1000);
      expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(1003);
      expect(await client().gatewayCreditGift.findUnique({ where: { requestKey: request.requestKey } })).toBeNull();
      expect(await client().gatewayBillingLedger.count({ where: { userId: user.id } })).toBe(0);
    } finally { await client().$executeRawUnsafe('ALTER TABLE "GatewayWallet" DROP CONSTRAINT "gift_uat_reject_wallet"'); }
  });

  it("rolls back both balances and the ledger if the gift journal fails", async () => {
    await pool();
    const user = await account(), request = input(user.id);
    await client().$executeRawUnsafe('ALTER TABLE "GatewayCreditGift" ADD CONSTRAINT "gift_uat_reject_journal" CHECK ("amountCents" < 0) NOT VALID');
    try {
      await expect(gifts.giftGatewayCredits(adminId, request)).rejects.toBeTruthy();
      expect((await client().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).balanceCents).toBe(1000);
      expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(1003);
      expect(await client().gatewayBillingLedger.count({ where: { userId: user.id } })).toBe(0);
    } finally { await client().$executeRawUnsafe('ALTER TABLE "GatewayCreditGift" DROP CONSTRAINT "gift_uat_reject_journal"'); }
  });

  it("rejects overflow and an occupied ledger event before any allocation", async () => {
    await pool();
    const user = await account(2147483647), request = input(user.id, "0.1");
    await expect(gifts.giftGatewayCredits(adminId, request)).rejects.toMatchObject({ code: "WALLET_OVERFLOW" });
    const normal = await account(), occupied = input(normal.id);
    await client().gatewayBillingLedger.create({ data: {
      billingEventId: `gift:${occupied.requestKey}`, kind: "opening", userId: normal.id, tenantId: normal.tenantId,
      username: normal.username, userName: normal.name, planCode: "free", planName: "体验版", deltaCents: 0, balanceBeforeCents: 0, balanceAfterCents: 0, status: "ok"
    } });
    await expect(gifts.giftGatewayCredits(adminId, occupied)).rejects.toMatchObject({ code: "GIFT_REQUEST_CONFLICT" });
    expect((await client().gatewayCreditPool.findUniqueOrThrow({ where: { id: "total" } })).balanceCents).toBe(1000);
  });

  it("uses the same wallet lock as real payment credit and model usage debit", async () => {
    await pool(1000);
    const user = await account(), snapshot = await billing.getGatewayBillingSnapshot(user.id), order = await store.createGatewayOrder(user.id, "starter"), request = input(user.id);
    const debitEvent = randomUUID();
    await Promise.all([
      gifts.giftGatewayCredits(adminId, request),
      store.markGatewayOrderPaidByOrderId(order.id, { receipt: `gift-receipt-${randomUUID()}`, receivedAmountCents: 9900, note: "隔离真实收款确认", confirmedBy: adminId }),
      store.recordGatewayUsage({ auth: { userId: user.id, username: user.username, apiKeyId: null, keyPrefix: "" }, endpoint: "images.generations", provider: "shaozhuang", model: "image2", costCents: 11, baseCostCents: 11, status: "ok", billingSnapshot: snapshot, billingEventId: debitEvent })
    ]);
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(1003 + 103 + 12000 - 11);
    const rows = await client().gatewayBillingLedger.findMany({ where: { userId: user.id, kind: { not: "opening" } } });
    expect(rows).toHaveLength(3);
    let balance = 1003;
    const remaining = [...rows];
    while (remaining.length) {
      const next = remaining.findIndex((row) => row.balanceBeforeCents === balance);
      expect(next).toBeGreaterThanOrEqual(0);
      const [row] = remaining.splice(next, 1);
      balance += row.deltaCents;
      expect(row.balanceAfterCents).toBe(balance);
    }
    expect(balance).toBe(13095);
  });

  it("prevents model calls from reserving a gift business event", async () => {
    const user = await account(), snapshot = await billing.getGatewayBillingSnapshot(user.id), event = `gift:${randomUUID()}`;
    await expect(store.recordGatewayUsage({ auth: { userId: user.id, username: user.username, apiKeyId: null, keyPrefix: "" }, endpoint: "images.generations", provider: "shaozhuang", model: "image2", costCents: 1, status: "ok", billingSnapshot: snapshot, billingEventId: event })).rejects.toMatchObject({ code: "INVALID_BILLING_EVENT" });
    expect(await client().gatewayBillingLedger.findUnique({ where: { billingEventId: event } })).toBeNull();
  });

  it("makes gift history immutable in PostgreSQL and returns ready pool snapshots", async () => {
    const gift = await client().gatewayCreditGift.findFirstOrThrow();
    await expect(client().$executeRaw`UPDATE "GatewayCreditGift" SET "reason" = '改写记录' WHERE "id" = ${gift.id}`).rejects.toBeTruthy();
    await expect(client().$executeRaw`DELETE FROM "GatewayCreditGift" WHERE "id" = ${gift.id}`).rejects.toBeTruthy();
    const overview = await gifts.getGatewayCreditGiftOverview();
    expect(overview.pool).toEqual({ ready: true, balanceCents: 897, balancePoints: 89.7 });
    expect(overview.gifts.length).toBeLessThanOrEqual(50);
    expect(overview.gifts[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(client().gatewayCreditPool.create({ data: { id: "second-pool", status: "ready", balanceCents: 999 } })).rejects.toBeTruthy();
  });

  it("keeps a ready empty pool truthful and limits recent history to fifty journals", async () => {
    await pool(0);
    expect((await gifts.getGatewayCreditGiftOverview()).pool).toEqual({ ready: true, balanceCents: 0, balancePoints: 0 });
    const user = await account(0, false);
    await expect(gifts.giftGatewayCredits(adminId, input(user.id, "0.1"))).rejects.toMatchObject({ code: "INSUFFICIENT_POOL_BALANCE" });
    expect(await client().gatewayWallet.findUnique({ where: { userId: user.id } })).toBeNull();
    await pool(1000);
    for (let index = 0; index < 55; index++) await gifts.giftGatewayCredits(adminId, input(user.id, "0.1"));
    const overview = await gifts.getGatewayCreditGiftOverview();
    expect(overview.gifts).toHaveLength(50);
    expect(new Set(overview.gifts.map((row) => row.id)).size).toBe(50);
    expect(overview.gifts.every((row) => row.userId === user.id)).toBe(true);
    expect(overview.pool).toEqual({ ready: true, balanceCents: 945, balancePoints: 94.5 });
  });
});
