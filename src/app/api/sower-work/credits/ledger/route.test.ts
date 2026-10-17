import { beforeEach, describe, expect, it, vi } from "vitest";
import { SOWER_WORK_CREDIT_META } from "@/lib/sower-work-credit-contract";

const mocks = vi.hoisted(() => ({ access: vi.fn(), ledger: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/sower-work-access", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/sower-work-access")>()),
  getSowerWorkAccess: mocks.access
}));
vi.mock("@/lib/creative-credit", () => ({ getCreativeCreditLedger: mocks.ledger }));

import { GET } from "./route";

const request = (query = "") => new Request(`https://example.com/api/sower-work/credits/ledger${query}`);
const ledger = { items: [{ id: "own-event", kind: "debit", deltaCents: -3, deltaPoints: -0.3 }], total: 41, page: 2, pageSize: 20 };

describe("Sower Work read-only SaaS credit ledger", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.access.mockResolvedValue({ allowed: true, user: { id: "canonical-admin", username: "admin", name: "管理", tenantId: "tenant-a" } });
    mocks.ledger.mockResolvedValue(ledger);
  });

  it("paginates only the live session owner's ledger without changing values", async () => {
    const response = await GET(request("?page=2"));
    expect(response.status).toBe(200);
    expect(mocks.ledger).toHaveBeenCalledExactlyOnceWith("canonical-admin", 2);
    expect(await response.json()).toEqual({ data: ledger, meta: SOWER_WORK_CREDIT_META });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("defaults to the first page", async () => {
    await GET(request());
    expect(mocks.ledger).toHaveBeenCalledExactlyOnceWith("canonical-admin", 1);
  });

  it.each([401, 403, 503] as const)("requires existing administrator access (%i) before reading the ledger", async status => {
    mocks.access.mockResolvedValue({ allowed: false, status, message: "访问不可用" });
    const response = await GET(request("?page=2"));
    expect(response.status).toBe(status);
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(["?userId=foreign", "?tenantId=other", "?workspaceId=other", "?page=1&userId=canonical-admin", "?kind=recharge", "?page=1&page=2", "?page=0", "?page=-1", "?page=1.5", "?page=01", "?page=1000000", "?page=", "?page=NaN"])("rejects identity filters and invalid pages %s without a ledger read", async query => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(mocks.ledger).not.toHaveBeenCalled();
    expect((await response.json()).code).toBe("INVALID_QUERY");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns a safe noncacheable unavailable response on ledger failure", async () => {
    mocks.ledger.mockRejectedValue(new Error("sensitive database details"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "积分信息暂不可用，请稍后重试", code: "CREDIT_SERVICE_UNAVAILABLE" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
