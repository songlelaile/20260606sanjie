import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), checkout: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/scan-payment", () => ({ getCheckout: mocks.checkout }));
import { GET } from "./route";
import { GatewayPaymentError } from "@/lib/model-gateway/payment";
const call = (id = "scan-order") => GET(new Request("http://localhost/api/model-gateway/checkout/" + id), { params: Promise.resolve({ id }) });
describe("scan order polling", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: "owner", status: "active", authRole: "admin" }); mocks.checkout.mockResolvedValue({ id: "scan-order", status: "pending" }); });
  it("always scopes even administrator requests to their own account", async () => {
    expect((await call()).status).toBe(200); expect(mocks.checkout).toHaveBeenCalledWith("owner", "scan-order");
    expect((await call()).headers.get("cache-control")).toBe("private, no-store");
  });
  it("rejects disabled, anonymous and invalid-ID requests", async () => {
    expect((await call("bad.id")).status).toBe(404);
    for (const user of [null, { status: "disabled" }]) { mocks.user.mockResolvedValue(user); expect((await call()).status).toBe(401); }
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("preserves ownership not-found responses and conceals internal failures", async () => {
    mocks.checkout.mockRejectedValueOnce(new GatewayPaymentError("ORDER_NOT_FOUND", "订单不存在", 404));
    expect((await call()).status).toBe(404);
    mocks.checkout.mockRejectedValueOnce(new Error("private merchant credential"));
    const response = await call(); expect(response.status).toBe(503); expect(await response.text()).not.toContain("credential");
  });
});
