import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { generateKeyPairSync } from "node:crypto";
import { createPaymentUatDatabase } from "../../../scripts/payment-uat-db.mjs";
const mocks = vi.hoisted(() => ({ client: null as PrismaClient | null, create: vi.fn(), query: vi.fn(), notify: vi.fn(), availability: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ get prisma() { return mocks.client; } }));
vi.mock("./scan-payment-providers", async importOriginal => ({
  ...await importOriginal<typeof import("./scan-payment-providers")>(),
  createScanPayment: mocks.create, queryScanPayment: mocks.query,
  verifyScanNotification: mocks.notify, getScanProviderAvailability: mocks.availability
}));

describe.skipIf(process.env.PAYMENT_CORE_INTEGRATION !== "1")("scan checkout PostgreSQL settlement and retry isolation", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let checkout: typeof import("./scan-payment");
  let store: typeof import("./store");
  let owner: string, other: string, tenantId: string;
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  beforeAll(async () => {
    const db = await createPaymentUatDatabase(); cleanup = db.cleanup;
    mocks.client = new PrismaClient({ datasources: { db: { url: db.url } }, log: [] });
    const tenant = await mocks.client.tenant.create({ data: { name: "Scan UAT", slug: `scan-uat-${Date.now()}` } });
    tenantId = tenant.id;
    checkout = await import("./scan-payment"); store = await import("./store");
  }, 60_000);
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // Synthetic credentials only, including when page-pay verification is called for malformed URLs.
    vi.stubEnv("ALIPAY_APP_ID", "2021000000000001"); vi.stubEnv("ALIPAY_SELLER_ID", "2088000000000001");
    vi.stubEnv("ALIPAY_PRIVATE_KEY", merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    vi.stubEnv("ALIPAY_PUBLIC_KEY", platform.publicKey.export({ type: "spki", format: "pem" }).toString());
    vi.stubEnv("ALIPAY_PAYMENT_PRODUCT", "precreate"); vi.stubEnv("SCAN_PAYMENT_NOTIFY_BASE_URL", "https://shaozhuangai.com");
    mocks.availability.mockReturnValue([{ provider: "alipay", available: true }, { provider: "wechat", available: true }]);
    mocks.create.mockImplementation(async ({ provider }) => ({ paymentUrl: provider === "wechat" ? "weixin://wxpay/bizpayurl/up?pr=NwY5Mz9&groupid=00" : "https://qr.alipay.com/trusted" }));
    mocks.query.mockResolvedValue(null); mocks.notify.mockResolvedValue(null);
    const users = await Promise.all(["owner", "other"].map(name => mocks.client!.user.create({ data: { tenantId, username: `scan-${name}-${crypto.randomUUID()}`, password: "unused", name } })));
    [owner, other] = users.map(user => user.id);
  });
  afterAll(async () => { vi.unstubAllEnvs(); await mocks.client?.$disconnect(); await cleanup?.(); });
  const evidence = (id: string, receipt: string, provider: "alipay" | "wechat" = "alipay", amountCents = 9900) => ({ provider, orderId: id, receipt, amountCents });
  async function rawOrder(userId = owner, provider = "alipay", amountCents = 9900) {
    return mocks.client!.gatewayOrder.create({ data: { userId, planCode: "starter", planName: "体验版", amountCents, creditCents: 12000, paymentProvider: provider } });
  }
  it("deduplicates concurrent creation and calls the provider once using server pricing", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => checkout.createCheckout(owner, "growth", "wechat")));
    expect(new Set(results.map(order => order.id)).size).toBe(1); expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ amountCents: 29900, orderId: results[0].id });
    expect(results[0]).toMatchObject({ amountCents: 29900, creditCents: 38000, status: "pending" });
    expect(results[0].qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(await mocks.client!.gatewayWallet.findUnique({ where: { userId: owner } })).toBeNull();
  });
  it("keeps ambiguous create failures pending and retries the same merchant order", async () => {
    mocks.create.mockRejectedValueOnce(new Error("upstream timeout"));
    await expect(checkout.createCheckout(other, "growth", "alipay")).rejects.toThrow("timeout");
    const failed = await mocks.client!.gatewayOrder.findFirstOrThrow({ where: { userId: other, planCode: "growth" } });
    expect(failed).toMatchObject({ status: "pending", paymentUrl: "", paidAt: null });
    const retried = await checkout.createCheckout(other, "growth", "alipay");
    expect(retried.id).toBe(failed.id); expect(mocks.create.mock.calls.every(call => call[0].orderId === failed.id)).toBe(true);
  });
  it("reuses one persisted page-pay order, never renders a page URL as QR, and settles only on verified evidence", async () => {
    vi.stubEnv("ALIPAY_PAYMENT_PRODUCT", "page_pay");
    const actual = await vi.importActual<typeof import("./scan-payment-providers")>("./scan-payment-providers");
    mocks.create.mockImplementation(actual.createScanPayment);
    const results = await Promise.all(Array.from({ length: 8 }, () => checkout.createCheckout(owner, "starter", "alipay")));
    expect(new Set(results.map(order => order.id)).size).toBe(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const view = results[0];
    expect(view).toMatchObject({ status: "pending", checkoutMode: "alipay_page", paymentUrl: "", qrCodeDataUrl: null });
    expect(view.cashierUrl).toMatch(/^https:\/\/openapi\.alipay\.com\/gateway\.do\?/);
    expect(view.fallbackCashierUrl).not.toBe(view.cashierUrl);
    const saved = await mocks.client!.gatewayOrder.findUniqueOrThrow({ where: { id: view.id } });
    expect(saved.paymentUrl).toBe(view.cashierUrl);
    expect(await mocks.client!.gatewayWallet.findUnique({ where: { userId: owner } })).toBeNull();
    expect(await checkout.getCheckout(owner, view.id)).toEqual(view);
    expect(await checkout.checkoutOrderView(saved, new Date(saved.createdAt.getTime() + 16 * 60_000))).toMatchObject({ status: "expired", qrCodeDataUrl: null, paymentUrl: "" });
    expect((await checkout.checkoutOrderView(saved, new Date(saved.createdAt.getTime() + 16 * 60_000))).cashierUrl).toBeUndefined();
    const invalid = await checkout.checkoutOrderView({ ...saved, amountCents: 1 });
    expect(invalid.cashierUrl).toBeUndefined(); expect(invalid.qrCodeDataUrl).toBeNull();
    mocks.query.mockResolvedValue(evidence(view.id, "page-pay-verified"));
    mocks.notify.mockResolvedValue(evidence(view.id, "page-pay-verified"));
    await Promise.all(Array.from({ length: 12 }, (_, index) => index % 2 ? checkout.getCheckout(owner, view.id)
      : checkout.receiveScanNotification("alipay", new Request("http://localhost/notify", { method: "POST" }))));
    expect((await mocks.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: owner } })).balanceCents).toBe(12000);
    expect(await mocks.client!.gatewayBillingLedger.count({ where: { orderId: view.id } })).toBe(1);
    const paid = await checkout.getCheckout(owner, view.id);
    expect(paid).toMatchObject({ status: "paid", checkoutMode: "alipay_page", qrCodeDataUrl: null, paymentUrl: "" });
    expect(paid.cashierUrl).toBeUndefined(); expect(paid.fallbackCashierUrl).toBeUndefined();
  });
  it("renders both official WeChat URL shapes while rejecting lookalike or credential-bearing URLs", async () => {
    const order = await rawOrder(owner, "wechat");
    for (const paymentUrl of ["weixin://wxpay/bizpayurl?pr=trusted", "weixin://wxpay/bizpayurl/up?pr=NwY5Mz9&groupid=00"]) {
      expect((await checkout.checkoutOrderView({ ...order, paymentUrl })).qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    }
    for (const paymentUrl of ["weixin://wxpay.evil.example/bizpayurl/up?pr=x", "weixin://user@wxpay/bizpayurl?pr=x", "weixin://wxpay:443/bizpayurl?pr=x", "weixin://wxpay/bizpayurl/up?pr=x#fragment", "weixin://wxpay/bizpayurl/up"]) {
      expect(await checkout.checkoutOrderView({ ...order, paymentUrl })).toMatchObject({ qrCodeDataUrl: null, paymentUrl: "" });
    }
  });
  it("cannot poll another owner or settle a mismatched returned order", async () => {
    const order = await rawOrder();
    await expect(checkout.getCheckout(other, order.id)).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    expect(mocks.query).not.toHaveBeenCalled();
    mocks.query.mockResolvedValue(evidence("foreign-order", "wrong"));
    await expect(checkout.getCheckout(owner, order.id)).rejects.toMatchObject({ code: "PAYMENT_ORDER_MISMATCH" });
    expect((await mocks.client!.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("pending");
  });
  it("credits only once when polling and duplicate notifications race, without a fake admin", async () => {
    const order = await rawOrder(); const verified = evidence(order.id, "race-verified");
    mocks.query.mockResolvedValue(verified); mocks.notify.mockResolvedValue(verified);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => index % 2
      ? checkout.getCheckout(owner, order.id)
      : checkout.receiveScanNotification("alipay", new Request("http://localhost/notify", { method: "POST" }))));
    expect(results.filter(Boolean).every(result => result!.status === "paid")).toBe(true);
    const saved = await mocks.client!.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved).toMatchObject({ status: "paid", paymentReceipt: "alipay:race-verified", confirmedBy: null, receivedAmountCents: 9900 });
    expect((await mocks.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: owner } })).balanceCents).toBe(12000);
    const ledger = await mocks.client!.gatewayBillingLedger.findMany({ where: { orderId: order.id } });
    expect(ledger).toHaveLength(1); expect(ledger[0]).toMatchObject({ provider: "alipay", actorId: null, deltaCents: 12000 });
  });
  it("rejects wrong amounts, wrong channels, reused receipts, unsigned events and cross-channel events", async () => {
    const order = await rawOrder();
    for (const value of [evidence(order.id, "wrong-amount", "alipay", 1), evidence(order.id, "wrong-channel", "wechat")]) {
      await expect(store.settleVerifiedScanPayment(value)).rejects.toMatchObject({ status: 409 });
    }
    const previous = await rawOrder();
    await store.settleVerifiedScanPayment(evidence(previous.id, "duplicate-receipt"));
    await expect(store.settleVerifiedScanPayment(evidence(order.id, "duplicate-receipt"))).rejects.toMatchObject({ code: "RECEIPT_ALREADY_USED" });
    mocks.notify.mockResolvedValue(null); await checkout.receiveScanNotification("alipay", new Request("http://localhost/notify"));
    mocks.notify.mockResolvedValue(evidence(order.id, "forged-channel", "wechat"));
    await expect(checkout.receiveScanNotification("alipay", new Request("http://localhost/notify"))).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_MISMATCH" });
    expect((await mocks.client!.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("pending");
    expect((await mocks.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: owner } })).balanceCents).toBe(12000);
  });
  it("allows only one winner when the same provider receipt races across two orders", async () => {
    const orders = await Promise.all([rawOrder(), rawOrder()]);
    const results = await Promise.allSettled(orders.map(order => store.settleVerifiedScanPayment(evidence(order.id, "cross-order-race"))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "RECEIPT_ALREADY_USED" });
    expect(await mocks.client!.gatewayBillingLedger.count({ where: { userId: owner, kind: "recharge" } })).toBe(1);
    expect((await mocks.client!.gatewayWallet.findUniqueOrThrow({ where: { userId: owner } })).balanceCents).toBe(12000);
  });
  it("hides expired QR codes but accepts a valid delayed payment", async () => {
    const order = await rawOrder(other, "wechat");
    const expired = await mocks.client!.gatewayOrder.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 20 * 60 * 1000), paymentUrl: "weixin://wxpay/bizpayurl?pr=trusted" } });
    expect(await checkout.checkoutOrderView(expired)).toMatchObject({ status: "expired", qrCodeDataUrl: null, paymentUrl: "" });
    await store.settleVerifiedScanPayment(evidence(order.id, "delayed-paid", "wechat"));
    expect(await checkout.getCheckout(other, order.id)).toMatchObject({ status: "paid", qrCodeDataUrl: null, paymentUrl: "" });
  });
  it("does not expose arbitrary provider URLs or create orders for unavailable channels", async () => {
    const order = await rawOrder();
    expect(await checkout.checkoutOrderView({ ...order, paymentUrl: "javascript:alert(1)" })).toMatchObject({ qrCodeDataUrl: null, paymentUrl: "" });
    mocks.availability.mockReturnValue([{ provider: "wechat", available: false }]);
    await expect(checkout.createCheckout(owner, "starter", "wechat")).rejects.toMatchObject({ code: "PAYMENT_PROVIDER_UNAVAILABLE" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rolls back the payment claim and receipt if crediting fails", async () => {
    const order = await rawOrder(other);
    await mocks.client!.$executeRawUnsafe('ALTER TABLE "GatewayWallet" ADD CONSTRAINT "scan_reject_credit" CHECK ("balanceCents" < 0) NOT VALID');
    try {
      await expect(store.settleVerifiedScanPayment(evidence(order.id, "rollback-credit"))).rejects.toBeTruthy();
      expect(await mocks.client!.gatewayOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "pending", paymentReceipt: null });
      expect(await mocks.client!.gatewayBillingLedger.count({ where: { orderId: order.id } })).toBe(0);
    } finally { await mocks.client!.$executeRawUnsafe('ALTER TABLE "GatewayWallet" DROP CONSTRAINT "scan_reject_credit"'); }
  });
});
