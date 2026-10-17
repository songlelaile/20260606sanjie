import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/billing", () => ({ listGatewayBillingLedger: mocks.list }));
import { GET } from "./route";

const request = (query = "") => new Request(`https://shaozhuangai.com/api/management/gateway-billing/ledger${query ? `?${query}` : ""}`);

describe("administrator gateway billing ledger API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "admin-1", authRole: "admin", status: "active" });
    mocks.list.mockResolvedValue({ items: [{ id: "debit-1" }], total: 1, page: 1, pageSize: 20 });
  });

  it.each([
    [null, 401],
    [{ id: "tenant", authRole: "tenant", role: "admin", status: "active" }, 403],
    [{ id: "disabled", authRole: "admin", status: "disabled" }, 403]
  ])("denies an unauthorized account before querying the cross-tenant ledger: %j", async (user, status) => {
    mocks.user.mockResolvedValue(user);
    const response = await GET(request("tenantId=other"));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("uses bounded pagination defaults and returns the exact backend pagination envelope", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ page: 1, pageSize: 20 }));
    expect(await response.json()).toEqual({ data: { items: [{ id: "debit-1" }], total: 1, page: 1, pageSize: 20 } });
  });

  it("passes only validated filters and normalizes offset dates into UTC", async () => {
    const params = new URLSearchParams({
      tenantId: "tenant-2", userId: "user-2", planCode: "growth", search: " 用户 ",
      kind: "debit", model: "seedream", endpoint: "images.generations", page: "2", pageSize: "100",
      from: "2026-10-01T08:00:00+08:00", to: "2026-10-02T08:00:00+08:00", apiKey: "ignored"
    });
    expect((await GET(request(params.toString()))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({
      tenantId: "tenant-2", userId: "user-2", planCode: "growth", search: "用户",
      kind: "debit", model: "seedream", endpoint: "images.generations", page: 2, pageSize: 100,
      from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z"
    });
  });

  it.each(["opening", "recharge", "gift", "debit", "error"])("supports ledger kind %s", async (kind) => {
    expect((await GET(request(`kind=${kind}`))).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ kind }));
  });

  it.each([
    "page=0", "page=-1", "page=1.5", "page=1e2", "page=1000001", "page=",
    "pageSize=0", "pageSize=101", "pageSize=99999999999999999999", "page=1&page=2",
    "kind=refund", "kind=debit&kind=error", "from=2026-10-01", "from=invalid",
    "from=2026-02-30T00%3A00%3A00Z",
    "from=2026-10-02T00%3A00%3A00Z&to=2026-10-01T00%3A00%3A00Z",
    `model=${"a".repeat(161)}`, `endpoint=${"a".repeat(121)}`,
    `tenantId=${"a".repeat(121)}`, `userId=${"a".repeat(121)}`,
    `search=${"a".repeat(121)}`, `planCode=${"a".repeat(81)}`, "search=private%00value"
  ])("rejects invalid or unbounded ledger filters: %s", async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ code: "INVALID_QUERY" });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("returns safe JSON for database and authentication failures", async () => {
    mocks.list.mockRejectedValue(new Error("ledger private-secret"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private-secret");
    mocks.user.mockRejectedValue(new Error("postgres private-secret"));
    const authFailure = await GET(request());
    expect(authFailure.status).toBe(503);
    expect(authFailure.headers.get("cache-control")).toBe("private, no-store");
    expect(await authFailure.json()).toMatchObject({ code: "BILLING_SERVICE_UNAVAILABLE" });
  });
});
