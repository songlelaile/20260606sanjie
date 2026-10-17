import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createPaymentUatDatabase } from "../../../scripts/payment-uat-db.mjs";
import type { GatewayBillingSnapshot } from "./billing-contract";

const sandbox = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ get prisma() { return sandbox.client; } }));

describe.skipIf(process.env.BILLING_CORE_INTEGRATION !== "1")("isolated PostgreSQL billing journal", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let billing: typeof import("./billing");
  let store: typeof import("./store");
  let tenantId: string, otherTenantId: string, adminId: string, ownerId: string, otherId: string;
  let sequence = 0;
  const client = () => sandbox.client!;

  async function fundedAccount(balanceCents = 1003) {
    const user = await client().user.create({ data: { tenantId, username: `billing-case-${++sequence}`, password: "unused-uat-password", name: "计费用户" } });
    await client().gatewayWallet.create({ data: { userId: user.id, balanceCents, planCode: "starter", planName: "体验版" } });
    return user;
  }

  function callInput(userId: string, snapshot: GatewayBillingSnapshot, costCents = 50, event = randomUUID()) {
    return {
      auth: { userId, username: snapshot.username, apiKeyId: null, keyPrefix: "" }, endpoint: "images.generations", provider: "shaozhuang", model: "image2",
      costCents, baseCostCents: costCents, billingSnapshot: snapshot, billingEventId: event, imageCount: 1,
      status: "ok" as const, requestId: "upstream-reused-id", metadata: { size: "1024x1024", requestedImageCount: 1 }, audit: { durationMs: 125, upstreamStatus: 200 }
    };
  }

  beforeAll(async () => {
    const db = await createPaymentUatDatabase();
    cleanup = db.cleanup;
    sandbox.client = new PrismaClient({ datasources: { db: { url: db.url } }, log: [] });
    const tenant = await client().tenant.create({ data: { name: "积分隔离租户", slug: `billing-${Date.now()}` } });
    const otherTenant = await client().tenant.create({ data: { name: "另一隔离租户", slug: `billing-other-${Date.now()}` } });
    tenantId = tenant.id; otherTenantId = otherTenant.id;
    const users = await Promise.all(["admin", "owner", "other"].map((name) => client().user.create({ data: {
      tenantId: name === "other" ? otherTenantId : tenantId, username: `billing-${name}`, password: "unused-uat-password", name,
      authRole: name === "admin" ? "admin" : "tenant"
    } })));
    [adminId, ownerId, otherId] = users.map((user) => user.id);
    await client().gatewayWallet.create({ data: { userId: ownerId, balanceCents: 1003, planCode: "starter", planName: "体验版" } });
    await client().gatewayUsage.create({ data: { userId: ownerId, endpoint: "images.generations", provider: "legacy", model: "legacy-image", costCents: 77, status: "ok" } });
    // Recreate only the new schema pieces so the actual SQL migration is exercised against an existing wallet/usage.
    for (const table of ["GatewayCreditGift", "GatewayCreditPool", "GatewayBillingLedger", "GatewayBillingRuleAudit", "GatewayBillingRule"]) await client().$executeRawUnsafe(`DROP TABLE "${table}"`);
    await client().$executeRawUnsafe('ALTER TABLE "GatewayUsage" DROP COLUMN "billingEventId"');
    for (const migration of ["20261002120000_gateway_billing_ledger", "20261003120000_gateway_credit_gifts"]) {
      let sql = await readFile(`prisma/migrations/${migration}/migration.sql`, "utf8");
      const bodies: string[] = [];
      sql = sql.replace(/\$\$[\s\S]*?\$\$/g, (body) => { bodies.push(body); return `__BILLING_SQL_BODY_${bodies.length - 1}__`; });
      for (const part of sql.split(";").map((value) => value.trim()).filter(Boolean)) {
        const statement = part.replace(/__BILLING_SQL_BODY_(\d+)__/g, (_, index) => bodies[Number(index)]);
        await client().$executeRawUnsafe(statement);
      }
    }
    vi.stubEnv("MODEL_GATEWAY_PAYMENT_PROVIDER", "manual");
    vi.stubEnv("MODEL_GATEWAY_MANUAL_PAY_URL", "");
    billing = await import("./billing"); store = await import("./store");
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sandbox.client?.$disconnect();
    await cleanup?.();
  });

  it("opens exact historical cents without altering or repricing old usages", async () => {
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: ownerId } })).balanceCents).toBe(1003);
    const opening = await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: `opening:${ownerId}` } });
    expect(opening).toMatchObject({ deltaCents: 1003, balanceBeforeCents: 0, balanceAfterCents: 1003, tenantId, tenantName: "积分隔离租户", model: "", actorId: null });
    const legacy = await client().gatewayUsage.findFirstOrThrow({ where: { model: "legacy-image" } });
    expect(legacy).toMatchObject({ costCents: 77, status: "ok", billingEventId: null });
    const accounts = await billing.listGatewayBillingAccounts({ userId: ownerId });
    expect(accounts.items[0]).toMatchObject({ balanceCents: 1003, balancePoints: 100.3, multiplierBps: 10000, ruleVersion: 0 });
  });

  it("lists accounts/rules without lazily opening wallets or inventing historical call detail", async () => {
    const before = await client().gatewayWallet.count();
    const ledgerCount = await client().gatewayBillingLedger.count();
    expect((await billing.listGatewayBillingAccounts({ userId: otherId })).items[0].balancePoints).toBe(0);
    expect((await billing.getGatewayBillingRules()).rules.map((rule) => rule.multiplierBps)).toEqual([10000, 10000, 10000, 10000]);
    expect(await client().gatewayWallet.count()).toBe(before);
    expect(await client().gatewayBillingLedger.count()).toBe(ledgerCount);
  });

  it("requires a real active administrator, reason, bounded multiplier and expected version", async () => {
    const input = { planCode: "starter", multiplierBps: 5000, reason: "测试调整", expectedVersion: 0 };
    await expect(billing.updateGatewayBillingRule(ownerId, input)).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await expect(billing.updateGatewayBillingRule(adminId, { ...input, expectedVersion: undefined })).rejects.toMatchObject({ code: "INVALID_VERSION" });
    await expect(billing.updateGatewayBillingRule(adminId, { ...input, reason: "单" })).rejects.toMatchObject({ code: "INVALID_REASON" });
    await expect(billing.updateGatewayBillingRule(adminId, { ...input, multiplierBps: 99 })).rejects.toMatchObject({ code: "INVALID_MULTIPLIER" });
  });

  it("freezes quote multiplier/version while the administrator changes the rule", async () => {
    const user = await fundedAccount();
    const snapshot = await billing.getGatewayBillingSnapshot(user.id);
    const updated = await billing.updateGatewayBillingRule(adminId, { planCode: "starter", multiplierBps: 5000, reason: "测试半价", expectedVersion: 0 });
    expect(updated.rule).toMatchObject({ multiplierBps: 5000, version: 1, updatedBy: adminId });
    expect(updated.audit).toMatchObject({ previousMultiplierBps: 10000, multiplierBps: 5000, previousVersion: 0, version: 1, updatedByUsername: "billing-admin" });
    const oldCall = await store.recordGatewayUsage(callInput(user.id, snapshot));
    const newCall = await store.recordGatewayUsage(callInput(user.id, await billing.getGatewayBillingSnapshot(user.id)));
    expect(oldCall.costCents).toBe(50); expect(newCall.costCents).toBe(25);
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(928);
    const entries = await client().gatewayBillingLedger.findMany({ where: { userId: user.id, kind: "debit" }, orderBy: { createdAt: "asc" } });
    expect(entries.map((row) => [row.baseCostCents, row.chargedCostCents, row.ruleVersion])).toEqual([[50, 50, 0], [50, 25, 1]]);
    await expect(billing.updateGatewayBillingRule(adminId, { planCode: "starter", multiplierBps: 7500, reason: "旧版本覆盖", expectedVersion: 0 })).rejects.toMatchObject({ code: "RULE_VERSION_CONFLICT" });
  });

  it("permits only one writer for concurrent edits with the same rule version", async () => {
    const results = await Promise.allSettled([10000, 12000].map((multiplierBps) => billing.updateGatewayBillingRule(adminId, { planCode: "starter", multiplierBps, reason: "并发规则调整", expectedVersion: 1 })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rule = (await billing.getGatewayBillingRules()).rules.find((row) => row.planCode === "starter")!;
    if (rule.multiplierBps !== 10000) await billing.updateGatewayBillingRule(adminId, { planCode: "starter", multiplierBps: 10000, reason: "恢复基准测试", expectedVersion: rule.version });
  });

  it("records exactly one debit for concurrent identical business events", async () => {
    const user = await fundedAccount();
    const snapshot = await billing.getGatewayBillingSnapshot(user.id);
    const input = callInput(user.id, snapshot);
    const results = await Promise.all(Array.from({ length: 12 }, () => store.recordGatewayUsage(input)));
    expect(new Set(results.map((row) => row.id)).size).toBe(1);
    expect(await client().gatewayBillingLedger.count({ where: { billingEventId: input.billingEventId } })).toBe(1);
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(953);
    await expect(store.recordGatewayUsage({ ...input, imageCount: 2 })).rejects.toMatchObject({ code: "BILLING_EVENT_CONFLICT" });
    await expect(store.recordGatewayUsage({ ...input, billingSnapshot: { ...snapshot, multiplierBps: 12000 } })).rejects.toMatchObject({ code: "BILLING_EVENT_CONFLICT" });
    await expect(store.recordGatewayUsage({ ...input, metadata: { size: "2048x2048", requestedImageCount: 1 } })).rejects.toMatchObject({ code: "BILLING_EVENT_CONFLICT" });
  });

  it("uses a business event key so reused/missing upstream IDs do not suppress distinct charges", async () => {
    const user = await fundedAccount();
    const snapshot = await billing.getGatewayBillingSnapshot(user.id);
    await store.recordGatewayUsage(callInput(user.id, snapshot));
    await store.recordGatewayUsage(callInput(user.id, snapshot));
    await store.recordGatewayUsage({ ...callInput(user.id, snapshot), requestId: "" });
    expect(await client().gatewayBillingLedger.count({ where: { userId: user.id, kind: "debit" } })).toBe(3);
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(853);
  });

  it("prevents concurrent overdraft and commits a truthful zero-debit settlement failure", async () => {
    const user = await fundedAccount(100);
    const snapshot = await billing.getGatewayBillingSnapshot(user.id);
    const inputs = [callInput(user.id, snapshot, 80), callInput(user.id, snapshot, 80)];
    const results = await Promise.allSettled(inputs.map((input) => store.recordGatewayUsage(input)));
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect((results.find((row) => row.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "INSUFFICIENT_BALANCE", status: 402 });
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(20);
    const events = await client().gatewayBillingLedger.findMany({ where: { userId: user.id, kind: { in: ["debit", "error"] } } });
    expect(events.find((row) => row.kind === "debit")).toMatchObject({ balanceBeforeCents: 100, balanceAfterCents: 20, deltaCents: -80 });
    expect(events.find((row) => row.kind === "error")).toMatchObject({ balanceBeforeCents: 20, balanceAfterCents: 20, deltaCents: 0, chargedCostCents: 0, status: "settlement_rejected" });
  });

  it("keeps failed calls at zero cost and strips prompt/key/request material from audit", async () => {
    const user = await fundedAccount();
    const snapshot = await billing.getGatewayBillingSnapshot(user.id);
    const input = { ...callInput(user.id, snapshot), status: "error" as const, error: "provider leaked sk-private-test-key", metadata: { size: "1024x1024", prompt: "private prompt", apiKey: "private key", response: { raw: "private" } } };
    const usage = await store.recordGatewayUsage(input);
    expect(usage).toMatchObject({ costCents: 0, error: "upstream_error", metadata: { size: "1024x1024", outcome: "" } });
    const ledger = await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: input.billingEventId } });
    expect(ledger).toMatchObject({ kind: "error", deltaCents: 0, chargedCostCents: 0, baseCostCents: 50, durationMs: 125, upstreamStatus: 200 });
    expect(JSON.stringify(ledger)).not.toContain("private");
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(1003);
  });

  it("distinguishes preflight rejection from an upstream success awaiting settlement", async () => {
    const user = await fundedAccount(1);
    const snapshot = await billing.getGatewayBillingSnapshot(user.id);
    const rejected = { ...callInput(user.id, snapshot), status: "error" as const, error: "INSUFFICIENT_BALANCE", imageCount: 0, audit: { outcome: "balance_rejected", durationMs: 10 } };
    const usage = await store.recordGatewayUsage(rejected);
    expect((await store.recordGatewayUsage(rejected)).id).toBe(usage.id);
    expect(await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: rejected.billingEventId } })).toMatchObject({ status: "preflight_rejected", baseCostCents: 50, chargedCostCents: 0 });
    const settlement = { ...callInput(user.id, snapshot), status: "error" as const, error: "settlement_failed", audit: { outcome: "settlement_failed", upstreamStatus: 200 } };
    await store.recordGatewayUsage(settlement);
    expect(await client().gatewayBillingLedger.findUniqueOrThrow({ where: { billingEventId: settlement.billingEventId } })).toMatchObject({ status: "settlement_failed", baseCostCents: 50, chargedCostCents: 0, imageCount: 1, upstreamStatus: 200 });
    expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(1);
  });

  it("writes recharge and wallet credit in one transaction with the real administrator actor", async () => {
    const order = await store.createGatewayOrder(otherId, "starter");
    const confirmation = { receipt: "billing-real-receipt-001", receivedAmountCents: 9900, note: "隔离收款确认", confirmedBy: adminId };
    await store.markGatewayOrderPaidByOrderId(order.id, confirmation);
    await store.markGatewayOrderPaidByOrderId(order.id, confirmation);
    const entries = await client().gatewayBillingLedger.findMany({ where: { orderId: order.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "recharge", deltaCents: 12000, balanceBeforeCents: 0, balanceAfterCents: 12000, actorId: adminId, actorUsername: "billing-admin", tenantId: otherTenantId });
    expect((await billing.listGatewayBillingLedger({ tenantId, userId: otherId })).total).toBe(0);
    expect((await billing.listGatewayBillingLedger({ search: "另一隔离租户", kind: "recharge" })).items).toHaveLength(1);
  });

  it("rolls back the debit and usage if ledger writing fails", async () => {
    const user = await fundedAccount();
    const snapshot = await billing.getGatewayBillingSnapshot(user.id);
    const input = callInput(user.id, snapshot);
    await client().$executeRawUnsafe('ALTER TABLE "GatewayBillingLedger" ADD CONSTRAINT "uat_reject_debit" CHECK ("kind" <> \'debit\') NOT VALID');
    try {
      await expect(store.recordGatewayUsage(input)).rejects.toBeTruthy();
      expect((await client().gatewayWallet.findUniqueOrThrow({ where: { userId: user.id } })).balanceCents).toBe(1003);
      expect(await client().gatewayUsage.findUnique({ where: { billingEventId: input.billingEventId } })).toBeNull();
    } finally { await client().$executeRawUnsafe('ALTER TABLE "GatewayBillingLedger" DROP CONSTRAINT "uat_reject_debit"'); }
  });

  it("rejects mutation/deletion of billing and rule audit rows in PostgreSQL", async () => {
    await expect(client().$executeRaw`UPDATE "GatewayBillingLedger" SET "deltaCents" = 0 WHERE "billingEventId" = ${`opening:${ownerId}`}`).rejects.toBeTruthy();
    await expect(client().$executeRaw`DELETE FROM "GatewayBillingLedger" WHERE "billingEventId" = ${`opening:${ownerId}`}`).rejects.toBeTruthy();
    const audit = await client().gatewayBillingRuleAudit.findFirstOrThrow();
    await expect(client().$executeRaw`UPDATE "GatewayBillingRuleAudit" SET "reason" = '改写' WHERE "id" = ${audit.id}`).rejects.toBeTruthy();
    await expect(client().$executeRaw`DELETE FROM "GatewayBillingRuleAudit" WHERE "id" = ${audit.id}`).rejects.toBeTruthy();
  });
});
