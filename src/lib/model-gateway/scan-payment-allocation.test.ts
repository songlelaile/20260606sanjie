import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({ first: vi.fn(), unique: vi.fn(), createOrder: vi.fn(), updateOrder: vi.fn(),
  lock: vi.fn(), resume: vi.fn(), settle: vi.fn(), providerCreate: vi.fn(), providerQuery: vi.fn(),
  availability: vi.fn(), cashier: vi.fn(), qr: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: (work: (tx: unknown) => unknown) => work({
  $queryRaw: mocks.lock, gatewayOrder: { findFirst: mocks.first, findUniqueOrThrow: mocks.unique,
    create: mocks.createOrder, updateMany: mocks.updateOrder }
}), gatewayOrder: { findFirst: mocks.first } } }));
vi.mock("./store", () => ({ resumeGatewayOrderAllocation: mocks.resume, settleVerifiedScanPayment: mocks.settle }));
vi.mock("./scan-payment-providers", () => ({ createScanPayment: mocks.providerCreate, queryScanPayment: mocks.providerQuery,
  verifyScanNotification: vi.fn(), getScanProviderAvailability: mocks.availability, getAlipayPageCheckout: mocks.cashier }));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.qr } }));
import { checkoutOrderView, createCheckout, getCheckout } from "./scan-payment";

type Order = Prisma.GatewayOrderGetPayload<object>;
const funded = () => ({ id: "funded-original", userId: "owner", planCode: "starter", planName: "体验版",
  amountCents: 9900, creditCents: 12000, paymentProvider: "alipay", status: "pending",
  creditAllocationState: "awaiting_capacity", paymentUrl: "https://qr.alipay.com/old-code",
  paymentReceipt: "alipay:private-original-receipt", receivedAmountCents: 9900, confirmedBy: null,
  confirmationNote: "private-note", paidAt: null, createdAt: new Date("2020-01-01T00:00:00Z") } satisfies Order);

beforeEach(() => {
  vi.resetAllMocks(); mocks.lock.mockResolvedValue([]); mocks.first.mockResolvedValue(funded());
  mocks.resume.mockResolvedValue(funded()); mocks.availability.mockReturnValue([{ provider: "alipay", available: false }]);
});
describe("verified funded order checkout recovery without another provider payment", () => {
  it("clears every payment entry and lifetime for a funded order without constructing a QR or cashier", async () => {
    const view = await checkoutOrderView(funded());
    expect(view).toMatchObject({ status: "awaiting_capacity", creditAllocationState: "awaiting_capacity",
      paymentUrl: "", qrCodeDataUrl: null, expiresAt: null, paidAt: null });
    expect(view).not.toHaveProperty("cashierUrl"); expect(view).not.toHaveProperty("fallbackCashierUrl");
    expect(JSON.stringify(view)).not.toContain("private-original-receipt");
    expect(JSON.stringify(view)).not.toContain("private-note");
    expect(mocks.qr).not.toHaveBeenCalled(); expect(mocks.cashier).not.toHaveBeenCalled();
  });
  it("reuses the original funded order after checkout expiry or provider unavailability, without creating anything", async () => {
    const view = await createCheckout("owner", "starter", "alipay");
    expect(view.id).toBe("funded-original"); expect(view.status).toBe("awaiting_capacity");
    expect(mocks.first.mock.calls[0][0].where).toMatchObject({ userId: "owner", planCode: "starter",
      paymentProvider: "alipay", status: "pending", creditAllocationState: "awaiting_capacity" });
    expect(mocks.resume).toHaveBeenCalledWith("owner", "funded-original");
    expect(mocks.createOrder).not.toHaveBeenCalled(); expect(mocks.providerCreate).not.toHaveBeenCalled();
    expect(mocks.providerQuery).not.toHaveBeenCalled(); expect(mocks.availability).not.toHaveBeenCalled();
  });
  it("getCheckout uses the server-owned original receipt recovery, not another provider query", async () => {
    expect((await getCheckout("owner", "funded-original")).status).toBe("awaiting_capacity");
    expect(mocks.resume).toHaveBeenCalledWith("owner", "funded-original");
    expect(mocks.providerQuery).not.toHaveBeenCalled(); expect(mocks.providerCreate).not.toHaveBeenCalled();
  });
  it("shows paid only after the core returns the original credited order", async () => {
    mocks.resume.mockResolvedValue({ ...funded(), status: "paid", creditAllocationState: "credited", paidAt: new Date() });
    const view = await getCheckout("owner", "funded-original");
    expect(view.status).toBe("paid"); expect(view.paymentUrl).toBe(""); expect(view.qrCodeDataUrl).toBeNull();
    expect(mocks.providerQuery).not.toHaveBeenCalled();
  });
  it("a notify that funds the order between checkout transactions prevents provider creation", async () => {
    mocks.first.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...funded(), creditAllocationState: "legacy", createdAt: new Date() });
    mocks.availability.mockReturnValue([{ provider: "alipay", available: true }]);
    mocks.unique.mockResolvedValue(funded());
    expect((await createCheckout("owner", "starter", "alipay")).status).toBe("awaiting_capacity");
    expect(mocks.resume).toHaveBeenCalledWith("owner", "funded-original");
    expect(mocks.providerCreate).not.toHaveBeenCalled(); expect(mocks.updateOrder).not.toHaveBeenCalled();
  });
  it("a missing owner's order or invalid persisted evidence cannot fall through to a new provider payment", async () => {
    mocks.first.mockResolvedValueOnce(null);
    await expect(getCheckout("foreign", "funded-original")).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    mocks.resume.mockRejectedValueOnce(new Error("persisted evidence mismatch"));
    await expect(createCheckout("owner", "starter", "alipay")).rejects.toThrow("persisted evidence mismatch");
    expect(mocks.providerQuery).not.toHaveBeenCalled(); expect(mocks.providerCreate).not.toHaveBeenCalled();
    expect(mocks.createOrder).not.toHaveBeenCalled();
  });
});
