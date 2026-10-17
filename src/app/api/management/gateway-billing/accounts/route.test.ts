import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/billing", () => ({ listGatewayBillingAccounts: mocks.list }));
import { GET } from "./route";

const request = (query = "") => new Request(`https://shaozhuangai.com/api/management/gateway-billing/accounts${query ? `?${query}` : ""}`);

describe("administrator gateway billing accounts API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "admin-1", authRole: "admin", status: "active" });
    mocks.list.mockResolvedValue({ items: [{ userId: "user-1", balanceCents: 200 }], total: 1, page: 1, pageSize: 20 });
  });

  it.each([
    [null, 401],
    [{ id: "tenant", authRole: "tenant", role: "admin", status: "active" }, 403],
    [{ id: "disabled", authRole: "admin", status: "disabled" }, 403]
  ])("denies unauthorized users before querying other accounts: %j", async (user, status) => {
    mocks.user.mockResolvedValue(user);
    const response = await GET(request("userId=other"));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("returns a paginated accounts result with bounded defaults and no caching", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 20 }));
    expect(await response.json()).toEqual({ data: { items: [{ userId: "user-1", balanceCents: 200 }], total: 1, page: 1, pageSize: 20 } });
  });

  it("passes validated account filters without accepting unrestricted query fields", async () => {
    expect((await GET(request("tenantId=tenant-1&userId=user-1&planCode=growth&search=%20用户%20&page=3&pageSize=50&password=ignored"))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ tenantId: "tenant-1", userId: "user-1", planCode: "growth", search: "用户", page: 3, pageSize: 50 });
  });

  it.each([
    "page=0", "page=-2", "page=1.2", "page=1000001", "page=1&page=2",
    "pageSize=0", "pageSize=101", "pageSize=2.5",
    `tenantId=${"a".repeat(121)}`, `userId=${"a".repeat(121)}`,
    `planCode=${"a".repeat(81)}`, `search=${"a".repeat(121)}`, "search=invalid%00value"
  ])("rejects invalid or excessive accounts filters: %s", async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_QUERY" });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("never exposes raw database or session exceptions", async () => {
    mocks.list.mockRejectedValue(new Error("password=private-secret"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify(await response.json())).not.toContain("private-secret");
    mocks.user.mockRejectedValue(new Error("apiKey=private-secret"));
    const authFailure = await GET(request());
    expect(authFailure.status).toBe(503);
    expect(await authFailure.json()).toMatchObject({ code: "BILLING_SERVICE_UNAVAILABLE" });
  });
});
