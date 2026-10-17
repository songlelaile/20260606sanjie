import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/billing-hold", () => ({ listGatewayBillingHoldsPendingReconciliation: mocks.list }));
import { GET } from "./route";
beforeEach(() => { vi.resetAllMocks(); });
describe("admin hold reconciliation inventory", () => {
  it.each([null, { id: "tenant", authRole: "user", status: "active" }, { id: "admin", authRole: "admin", status: "disabled" }])("does not read pending tenant holds without an active admin (%j)", async user => {
    mocks.user.mockResolvedValue(user);
    const response = await GET();
    expect(response.status).toBe(user ? 403 : 401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("lists a bounded read-only inventory and safely reports database failures", async () => {
    mocks.user.mockResolvedValue({ id: "admin", authRole: "admin", status: "active" });
    mocks.list.mockResolvedValue([{ eventId: "event", heldCents: 50, status: "unknown" }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({ limit: 50 });
    expect((await response.json()).data.limit).toBe(50);
    mocks.list.mockRejectedValue(new Error("private DB secret"));
    const failed = await GET(); expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private");
  });
});
