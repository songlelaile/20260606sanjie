import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), session: vi.fn(), order: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user, getCurrentSession: mocks.session }));
vi.mock("@/lib/model-gateway/store", () => ({ getGatewayOrder: mocks.order }));
import { GET } from "./route";
const params = { params: Promise.resolve({ id: "order-1" }) };
const request = new Request("http://localhost/api/model-gateway/orders/order-1");

describe("gateway own-order polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "user-1", status: "active", authRole: "tenant" });
    mocks.session.mockResolvedValue({ role: "tenant" });
    mocks.order.mockResolvedValue({ id: "order-1", status: "pending" });
  });
  it("scopes tenant polling to current user and disables cache", async () => {
    const response = await GET(request, params);
    expect(response.status).toBe(200);
    expect(mocks.order).toHaveBeenCalledWith("user-1", "order-1", false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("allows current database admin and rejects stale admin cookie elevation", async () => {
    mocks.session.mockResolvedValue({ role: "admin" });
    await GET(request, params);
    expect(mocks.order).toHaveBeenLastCalledWith("user-1", "order-1", false);
    mocks.user.mockResolvedValue({ id: "admin-1", status: "active", authRole: "admin" });
    await GET(request, params);
    expect(mocks.order).toHaveBeenLastCalledWith("admin-1", "order-1", true);
  });
  it("uses identical not-found response for missing and foreign orders", async () => {
    mocks.order.mockResolvedValue(null);
    const response = await GET(request, params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "订单不存在", code: "ORDER_NOT_FOUND" });
  });
  it("blocks disabled accounts and hides service exceptions", async () => {
    mocks.user.mockResolvedValue({ id: "user-1", status: "disabled", authRole: "tenant" });
    expect((await GET(request, params)).status).toBe(401);
    mocks.user.mockResolvedValue({ id: "user-1", status: "active", authRole: "tenant" });
    mocks.order.mockRejectedValue(new Error("internal secret"));
    const response = await GET(request, params);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
  it("hides authentication storage exceptions", async () => {
    mocks.user.mockRejectedValue(new Error("private authentication secret"));
    const response = await GET(request, params);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
