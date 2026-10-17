import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { createPaymentUatDatabase } from "../../../scripts/payment-uat-db.mjs";

const sandbox = vi.hoisted(() => ({ client: null as PrismaClient | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ get prisma() { return sandbox.client; } }));

describe.skipIf(process.env.PAYMENT_CORE_INTEGRATION !== "1")("real PostgreSQL payment transaction UAT", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let store: typeof import("./store");
  let adminId: string;
  let ownerId: string;
  let otherId: string;
  const confirmation = (receipt: string, amount = 9900) => ({ receipt, receivedAmountCents: amount, note: "UAT 人工到账核对", confirmedBy: adminId });

  beforeAll(async () => {
    const db = await createPaymentUatDatabase();
    cleanup = db.cleanup;
    sandbox.client = new PrismaClient({ datasources: { db: { url: db.url } }, log: [] });
    const tenant = await sandbox.client.tenant.create({ data: { name: "Payment UAT", slug: `payment-uat-${Date.now()}` } });
    const users = await Promise.all(["admin", "owner", "other"].map((name) => sandbox.client!.user.create({
      data: { tenantId: tenant.id, username: `uat-${name}`, password: "uat-unused-password", name, authRole: name === "admin" ? "admin" : "tenant" }
    })));
    [adminId, ownerId, otherId] = users.map((row) => row.id);
    vi.stubEnv("MODEL_GATEWAY_PAYMENT_PROVIDER", "manual");
    vi.stubEnv("MODEL_GATEWAY_MANUAL_PAY_URL", "");
    store = await import("./store");
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sandbox.client?.$disconnect();
    await cleanup?.();
  });

  it("does not credit a new order even when legacy AUTO_PAY is enabled", async () => {
    vi.stubEnv("MODEL_GATEWAY_AUTO_PAY", "1");
    const order = await store.createGatewayOrder(ownerId, "starter");
    expect(order.status).toBe("pending");
    expect(order.paidAt).toBeNull();
    expect(await sandbox.client!.gatewayWallet.findUnique({ where: { userId: ownerId } })).toBeNull();
  });

  it("concurrent confirmation credits once and keeps receipt/admin/amount audit", async () => {
    const order = await store.createGatewayOrder(ownerId, "starter");
    const confirmations = await Promise.all(Array.from({ length: 24 }, () => store.markGatewayOrderPaidByOrderId(order.id, confirmation("flow-concurrent-001"))));
    expect(confirmations.every((row) => row.status === "paid")).toBe(true);
    const saved = await sandbox.client!.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved).toMatchObject({ paymentReceipt: "flow-concurrent-001", confirmedBy: adminId, receivedAmountCents: 9900, confirmationNote: "UAT 人工到账核对" });
    expect(saved.paidAt).toBeInstanceOf(Date);
    const wallet = await sandbox.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: ownerId } });
    expect(wallet.balanceCents).toBe(12000);
    await store.markGatewayOrderPaidByOrderId(order.id, confirmation("flow-concurrent-001"));
    expect((await sandbox.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: ownerId } })).balanceCents).toBe(12000);
  });

  it("rejects duplicate receipt across orders without changing pending order or balance", async () => {
    const order = await store.createGatewayOrder(ownerId, "starter");
    await expect(store.markGatewayOrderPaidByOrderId(order.id, confirmation("flow-concurrent-001")))
      .rejects.toMatchObject({ code: "RECEIPT_ALREADY_USED", status: 409 });
    expect((await sandbox.client!.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("pending");
    expect((await sandbox.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: ownerId } })).balanceCents).toBe(12000);
  });

  it("rejects wrong amounts, failed orders, foreign owner and tenant confirmation", async () => {
    const order = await store.createGatewayOrder(ownerId, "starter");
    await expect(store.markGatewayOrderPaidByOrderId(order.id, confirmation("flow-mismatch-001", 9899)))
      .rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
    expect(await store.getGatewayOrder(otherId, order.id)).toBeNull();
    await expect(store.markGatewayOrderPaid(otherId, order.id, confirmation("flow-foreign-001")))
      .rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    await expect(store.markGatewayOrderPaidByOrderId(order.id, { ...confirmation("flow-tenant-001"), confirmedBy: otherId }))
      .rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await sandbox.client!.gatewayOrder.update({ where: { id: order.id }, data: { status: "failed" } });
    await expect(store.markGatewayOrderPaidByOrderId(order.id, confirmation("flow-failed-001")))
      .rejects.toMatchObject({ code: "ORDER_NOT_PAYABLE" });
  });

  it("rolls back claimed order if wallet update fails", async () => {
    const order = await store.createGatewayOrder(otherId, "starter");
    await sandbox.client!.$executeRawUnsafe('ALTER TABLE "GatewayWallet" ADD CONSTRAINT "uat_reject_credit" CHECK ("balanceCents" < 0) NOT VALID');
    try {
      await expect(store.markGatewayOrderPaidByOrderId(order.id, confirmation("flow-rollback-001"))).rejects.toBeTruthy();
      expect((await sandbox.client!.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("pending");
      expect((await sandbox.client!.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } })).paymentReceipt).toBeNull();
      expect(await sandbox.client!.gatewayWallet.findUnique({ where: { userId: otherId } })).toBeNull();
    } finally {
      await sandbox.client!.$executeRawUnsafe('ALTER TABLE "GatewayWallet" DROP CONSTRAINT "uat_reject_credit"');
    }
  });

  it("fails closed for non-manual order/provider and invalid plan", async () => {
    await expect(store.createGatewayOrder(ownerId, "does-not-exist")).rejects.toMatchObject({ code: "INVALID_PLAN" });
    const order = await store.createGatewayOrder(ownerId, "starter");
    await sandbox.client!.gatewayOrder.update({ where: { id: order.id }, data: { paymentProvider: "stripe" } });
    await expect(store.markGatewayOrderPaidByOrderId(order.id, confirmation("flow-provider-001")))
      .rejects.toMatchObject({ code: "MANUAL_CONFIRMATION_NOT_ALLOWED" });
    vi.stubEnv("MODEL_GATEWAY_PAYMENT_PROVIDER", "stripe");
    await expect(store.createGatewayOrder(ownerId, "starter")).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_UNAVAILABLE" });
    vi.stubEnv("MODEL_GATEWAY_PAYMENT_PROVIDER", "manual");
  });

  it("allows one winner when different receipts concurrently confirm one order", async () => {
    const before = (await sandbox.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: ownerId } })).balanceCents;
    const order = await store.createGatewayOrder(ownerId, "starter");
    const results = await Promise.allSettled(["flow-race-left", "flow-race-right"].map((receipt) =>
      store.markGatewayOrderPaidByOrderId(order.id, confirmation(receipt))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await sandbox.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: ownerId } })).balanceCents).toBe(before + 12000);
  });

  it("allows one winner when one receipt concurrently confirms different orders", async () => {
    const before = (await sandbox.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: ownerId } })).balanceCents;
    const orders = await Promise.all([store.createGatewayOrder(ownerId, "starter"), store.createGatewayOrder(ownerId, "starter")]);
    const results = await Promise.allSettled(orders.map((order) => store.markGatewayOrderPaidByOrderId(order.id, confirmation("flow-cross-order-race"))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "RECEIPT_ALREADY_USED" });
    const saved = await sandbox.client!.gatewayOrder.findMany({ where: { id: { in: orders.map((order) => order.id) } } });
    expect(saved.filter((order) => order.status === "paid")).toHaveLength(1);
    expect(saved.filter((order) => order.status === "pending")).toHaveLength(1);
    expect((await sandbox.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: ownerId } })).balanceCents).toBe(before + 12000);
  });

  it("applies audit migration to existing pending/paid orders without changing their business fields", async () => {
    const select = { id: true, userId: true, amountCents: true, creditCents: true, status: true, paidAt: true } as const;
    const before = await sandbox.client!.gatewayOrder.findMany({ select, orderBy: { id: "asc" } });
    await sandbox.client!.$executeRawUnsafe('DROP INDEX "GatewayOrder_paymentReceipt_key"');
    await sandbox.client!.$executeRawUnsafe('ALTER TABLE "GatewayOrder" DROP COLUMN "paymentReceipt", DROP COLUMN "confirmedBy", DROP COLUMN "confirmationNote", DROP COLUMN "receivedAmountCents"');
    const sql = await readFile("prisma/migrations/20261001150000_gateway_payment_audit/migration.sql", "utf8");
    for (const statement of sql.split(";").map((text) => text.trim()).filter(Boolean)) {
      await sandbox.client!.$executeRawUnsafe(statement);
    }
    expect(await sandbox.client!.gatewayOrder.findMany({ select, orderBy: { id: "asc" } })).toEqual(before);
    const receipts = await sandbox.client!.gatewayOrder.findMany({ select: { paymentReceipt: true } });
    expect(receipts.every((row) => row.paymentReceipt === null)).toBe(true);
  });
});
