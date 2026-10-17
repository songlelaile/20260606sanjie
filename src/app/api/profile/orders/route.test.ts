import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), orders: vi.fn(), count: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/db", () => ({ prisma: { gatewayOrder: { findMany: mocks.orders, count: mocks.count } } }));
import { GET } from "./route";

const request = (query = "") => new Request(`https://app.example/api/profile/orders${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "current-user", tenantId: "current-tenant", status: "active", authRole: "tenant" });
  mocks.orders.mockResolvedValue([{ id: "order-1", status: "pending", amountCents: 9900 }]);
  mocks.count.mockResolvedValue(23);
});

describe("personal recharge order history", () => {
  it("reads only the current user's orders with stable pagination and a public field whitelist", async () => {
    const response = await GET(request("?page=2"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.orders).toHaveBeenCalledWith({
      where: { userId: "current-user" }, skip: 20, take: 20,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, planName: true, amountCents: true, creditCents: true,
        status: true, creditAllocationState: true, paymentProvider: true, createdAt: true, paidAt: true }
    });
    expect(mocks.count).toHaveBeenCalledWith({ where: { userId: "current-user" } });
    expect(await response.json()).toEqual({ data: { items: [{ id: "order-1", status: "pending", amountCents: 9900 }], total: 23, page: 2, pageSize: 20 } });
  });

  it("保留已收款待分配显示字段，不把它改为paid或选择付款凭证", async () => {
    mocks.orders.mockResolvedValue([{ id: "funded-1", status: "pending", creditAllocationState: "awaiting_capacity", amountCents: 9900 }]);
    const response = await GET(request());
    expect((await response.json()).data.items[0]).toMatchObject({ status: "pending", creditAllocationState: "awaiting_capacity" });
    expect(mocks.orders.mock.calls[0][0].select).not.toHaveProperty("paymentReceipt");
    expect(mocks.orders.mock.calls[0][0].select).not.toHaveProperty("confirmationNote");
  });

  it("does not widen scope for an administrator's own profile", async () => {
    mocks.user.mockResolvedValue({ id: "admin-user", status: "active", authRole: "admin" });
    expect((await GET(request())).status).toBe(200);
    expect(mocks.orders.mock.calls[0][0].where).toEqual({ userId: "admin-user" });
  });

  it.each(["?userId=foreign", "?tenantId=foreign", "?pageSize=999", "?page=2&page=1", "?page=0", "?page=-1", "?page=1.5", "?page=1000000"])("rejects identity overrides and invalid pagination: %s", async query => {
    expect((await GET(request(query))).status).toBe(400);
    expect(mocks.orders).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it.each([null, { id: "disabled", status: "disabled" }])("rejects unauthenticated or disabled accounts", async user => {
    mocks.user.mockResolvedValue(user);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.orders).not.toHaveBeenCalled();
  });

  it("returns an unavailable response without inventing empty history or exposing database errors", async () => {
    mocks.orders.mockRejectedValue(new Error("private database credential"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain("充值订单暂不可用");
    expect(body).not.toHaveProperty("data");
    expect(JSON.stringify(body)).not.toContain("private");
  });
});
