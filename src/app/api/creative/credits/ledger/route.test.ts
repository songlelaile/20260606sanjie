import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), ledger: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/creative-credit", () => ({ getCreativeCreditLedger: mocks.ledger }));
import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "current-owner", tenantId: "tenant-a", status: "active" });
  mocks.ledger.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
});
const request = (query = "") => new Request(`https://app.example/api/creative/credits/ledger${query}`);

describe("GET own creative credit ledger", () => {
  it("scopes both default and paged reads to the active account only", async () => {
    expect((await GET(request())).status).toBe(200);
    expect(mocks.ledger).toHaveBeenLastCalledWith("current-owner", 1);
    const response = await GET(request("?page=2"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.ledger).toHaveBeenLastCalledWith("current-owner", 2);
  });
  it.each(["?userId=foreign", "?tenantId=foreign", "?pageSize=100", "?page=2&page=1", "?page=0", "?page=-1", "?page=1.1", "?page=1000000"]) ("rejects client identity or invalid pagination %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(mocks.ledger).not.toHaveBeenCalled();
  });
  it("rejects disabled accounts even when a foreign user is supplied", async () => {
    mocks.user.mockResolvedValue({ id: "disabled", status: "disabled" });
    expect((await GET(request("?userId=foreign"))).status).toBe(401);
    expect(mocks.ledger).not.toHaveBeenCalled();
  });
  it("returns a safe unavailable response when the ledger cannot be read", async () => {
    mocks.ledger.mockRejectedValue(new Error("private SQL and secret"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private");
  });
});
