import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ensure: vi.fn(), wallet: vi.fn(), keys: vi.fn(), orders: vi.fn(), usages: vi.fn(), transaction: vi.fn(), available: vi.fn(), query: vi.fn(), pool: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { gatewayWallet: { upsert: mocks.ensure }, gatewayApiKey: { findMany: mocks.keys },
  gatewayOrder: { findMany: mocks.orders }, gatewayUsage: { findMany: mocks.usages }, $transaction: mocks.transaction } }));
vi.mock("@/lib/model-gateway/billing-hold", () => ({ getGatewayAvailableBalance: mocks.available, isGatewayBillingHoldSettlement: vi.fn() }));
import { getGatewayOverview } from "./store";

describe("purchase credit overview balance snapshot", () => {
  const transactionClient = () => ({
    $queryRaw: mocks.query,
    gatewayCreditPool: { findUnique: mocks.pool },
    gatewayWallet: { upsert: mocks.ensure, findUniqueOrThrow: mocks.wallet }
  });
  beforeEach(() => { vi.clearAllMocks(); mocks.keys.mockResolvedValue([]); mocks.orders.mockResolvedValue([]); mocks.usages.mockResolvedValue([]); mocks.query.mockResolvedValue([]); mocks.pool.mockResolvedValue(null); });
  it("reads total and active reservations together without returning the preceding wallet ensure result", async () => {
    const tx = transactionClient();
    mocks.ensure.mockResolvedValue({ balanceCents: 1000 });
    mocks.wallet.mockResolvedValueOnce({ userId: "owner", balanceCents: 1000, planCode: "growth", planName: "增长版" })
      .mockResolvedValueOnce({ userId: "owner", balanceCents: 800, planCode: "growth", planName: "增长版" });
    mocks.available.mockResolvedValue({ balanceCents: 800, reservedCents: 200, availableCents: 600 });
    mocks.transaction.mockImplementation(async work => work(tx));
    const result = await getGatewayOverview("owner");
    expect(result.wallet).toMatchObject({ userId: "owner", balanceCents: 800, reservedCents: 200, availableCents: 600, planCode: "growth" });
    expect(mocks.transaction).toHaveBeenNthCalledWith(2, expect.any(Function), { isolationLevel: "RepeatableRead" });
    expect(mocks.wallet).toHaveBeenCalledTimes(2);
    expect(mocks.wallet).toHaveBeenCalledWith({ where: { userId: "owner" } });
    expect(mocks.available).toHaveBeenCalledWith(tx, "owner");
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensure.mock.invocationCallOrder[0]);
    expect(mocks.ensure.mock.invocationCallOrder[0]).toBeLessThan(mocks.transaction.mock.invocationCallOrder[1]);
    expect(mocks.keys).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "owner" } }));
    expect(mocks.orders).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "owner" } }));
    expect(mocks.usages).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "owner" } }));
  });
  it("does not present a total as an available balance when reservation lookup fails", async () => {
    mocks.ensure.mockResolvedValue({ balanceCents: 1000 });
    mocks.wallet.mockResolvedValue({ balanceCents: 1000 });
    mocks.available.mockRejectedValue(new Error("reservation unavailable"));
    const tx = transactionClient();
    mocks.transaction.mockImplementation(async work => work(tx));
    await expect(getGatewayOverview("owner")).rejects.toThrow("reservation unavailable");
    expect(mocks.available).toHaveBeenCalledWith(tx, "owner");
    expect(mocks.wallet).toHaveBeenCalledTimes(2);
  });
});
