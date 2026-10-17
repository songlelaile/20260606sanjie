import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBillingError } from "./billing-contract";

const mocks = vi.hoisted(() => ({ pool: vi.fn(), gifts: vi.fn(), ready: vi.fn(), mutation: vi.fn(), tx: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {
  gatewayCreditPool: { findUnique: mocks.pool, create: mocks.mutation, update: mocks.mutation },
  gatewayCreditGift: { findMany: mocks.gifts }, $transaction: mocks.tx
} }));
vi.mock("./billing", () => ({ ensureGatewayBillingOpening: mocks.mutation, lockGatewayBillingWallet: mocks.mutation }));
vi.mock("./accounting-coordination", () => ({ lockGatewayAccountingIdentities: mocks.mutation }));
vi.mock("./credit-pool-accounting", () => ({ assertGatewayPoolReady: mocks.ready, refreshGatewaySharedPoolFromSource: vi.fn(async()=>{}), moveGatewayPool: mocks.mutation }));
import { getGatewayCreditGiftOverview } from "./credit-gifts";

beforeEach(() => {
  vi.resetAllMocks(); mocks.pool.mockResolvedValue(null); mocks.gifts.mockResolvedValue([]);
  mocks.ready.mockResolvedValue(undefined); mocks.tx.mockImplementation((read: (tx: object) => unknown) => read({}));
});
describe("gift overview uses real pool and verified-source states without creating capacity", () => {
  it.each([
    [null, "uninitialized", false, null, null],
    [{ status: "pending", balanceCents: 0 }, "pending", false, null, null],
    [{ status: "pending", balanceCents: 1000 }, "pending", false, null, null],
    [{ status: "ready", balanceCents: 0 }, "ready", true, 0, 0],
    [{ status: "ready", balanceCents: 1005 }, "ready", true, 1005, 100.5],
    [{ status: "ready", balanceCents: -1 }, "invalid", false, null, null],
    [{ status: "pending", balanceCents: -1 }, "invalid", false, null, null],
    [{ status: "ready", balanceCents: "1000" }, "invalid", false, null, null],
    [{ status: "ready", balanceCents: 1.1 }, "invalid", false, null, null],
    [{ status: "ready", balanceCents: 2147483648 }, "invalid", false, null, null],
    [{ status: "paused", balanceCents: 1000 }, "invalid", false, null, null]
  ])("maps %j to %s with the source guard mocked verified only for legal ready cases", async (pool, state, ready, balanceCents, balancePoints) => {
    mocks.pool.mockResolvedValue(pool);
    expect(await getGatewayCreditGiftOverview()).toEqual({ pool: { state, ready, balanceCents, balancePoints, refreshOnSubmitAvailable: false }, gifts: [] });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.ready).toHaveBeenCalledTimes(ready ? 1 : 0);
  });
  it.each(["CREDIT_POOL_NOT_READY", "POOL_SOURCE_UNVERIFIED", "POOL_SOURCE_SUPERSEDED", "POOL_PRICING_CHANGED", "POOL_FX_CHANGED"])("a stored ready flag with %s never produces a known allocatable balance", async code => {
    mocks.pool.mockResolvedValue({ status: "ready", balanceCents: 1000 });
    mocks.ready.mockRejectedValue(new GatewayBillingError(code, "safe pending source", 409));
    expect((await getGatewayCreditGiftOverview()).pool).toEqual({ state: "pending", ready: false, balanceCents: null, balancePoints: null, refreshOnSubmitAvailable: false });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it("a failed accounting invariant is invalid rather than uninitialized", async () => {
    mocks.pool.mockResolvedValue({ status: "ready", balanceCents: 1000 });
    mocks.ready.mockRejectedValue(new GatewayBillingError("CREDIT_POOL_INVALID", "safe invalid accounting", 409));
    expect((await getGatewayCreditGiftOverview()).pool.state).toBe("invalid");
  });
  it("an adopted shared pool can refresh on explicit gift submission without GET renewing the source or inventing a balance", async () => {
    mocks.pool.mockResolvedValue({ status: "ready", balanceCents: 1000, accountingVersion: 1,
      sourceScope: "shared_user_lifetime_wallet", sourceSnapshotId: "saved-source" });
    mocks.ready.mockRejectedValue(new GatewayBillingError("POOL_SOURCE_UNVERIFIED", "expired source", 409));
    expect((await getGatewayCreditGiftOverview()).pool).toEqual({ state: "pending", ready: false,
      balanceCents: null, balancePoints: null, refreshOnSubmitAvailable: true });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.tx).toHaveBeenCalledOnce();
  });
  it.each([
    { accountingVersion: 0, sourceScope: "shared_user_lifetime_wallet", sourceSnapshotId: "saved-source" },
    { accountingVersion: 1, sourceScope: "independent_usd", sourceSnapshotId: "saved-source" },
    { accountingVersion: 1, sourceScope: "shared_user_lifetime_wallet", sourceSnapshotId: null }
  ])("does not offer automatic gift refresh for an unadopted or independent pool (%j)", async fields => {
    mocks.pool.mockResolvedValue({ status: "pending", balanceCents: 1000, ...fields });
    expect((await getGatewayCreditGiftOverview()).pool.refreshOnSubmitAvailable).toBe(false);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it("an invalid adopted shared pool never offers a refresh-and-gift shortcut", async () => {
    mocks.pool.mockResolvedValue({ status: "ready", balanceCents: 1000, accountingVersion: 1,
      sourceScope: "shared_user_lifetime_wallet", sourceSnapshotId: "saved-source" });
    mocks.ready.mockRejectedValue(new GatewayBillingError("CREDIT_POOL_INVALID", "invalid accounting", 409));
    expect((await getGatewayCreditGiftOverview()).pool).toMatchObject({ state: "invalid", ready: false, refreshOnSubmitAvailable: false });
  });
  it.each(["pool", "ready"])("a non-domain %s read failure propagates for a safe unavailable API response", async layer => {
    const failure = new Error("private mocked database address");
    if (layer === "pool") mocks.pool.mockRejectedValueOnce(failure);
    else { mocks.pool.mockResolvedValue({ status: "ready", balanceCents: 1000 }); mocks.ready.mockRejectedValueOnce(failure); }
    await expect(getGatewayCreditGiftOverview()).rejects.toBe(failure);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
