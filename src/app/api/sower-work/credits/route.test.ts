import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";
import { SOWER_WORK_CREDIT_META } from "@/lib/sower-work-credit-contract";

const mocks = vi.hoisted(() => ({ access: vi.fn(), credits: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/sower-work-access", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/sower-work-access")>()),
  getSowerWorkAccess: mocks.access
}));
vi.mock("@/lib/creative-credit", () => ({ getCreativeCredits: mocks.credits }));

import { GET } from "./route";

const request = (query = "", headers?: HeadersInit) => new Request(`https://example.com/api/sower-work/credits${query}`, { headers });
const wallet = {
  wallet: { balanceCents: 127, balancePoints: 12.7, exists: true },
  plan: { code: "growth", name: "增长版", multiplierBps: 8000, ruleVersion: 2 },
  models: [], catalogError: null, observedAt: "2026-10-02T02:03:21.945Z", centsPerPoint: 10
};

describe("Sower Work read-only SaaS wallet", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.access.mockResolvedValue({ allowed: true, user: { id: "canonical-admin", username: "admin", name: "管理", tenantId: "tenant-a" } });
    mocks.credits.mockResolvedValue(wallet);
  });

  it("reads the session owner's existing wallet and exact cents, independent of forged identity headers", async () => {
    const response = await GET(request("", { "x-sower-user-id": "foreign-user", "x-sower-tenant-id": "tenant-b", authorization: "Bearer foreign" }));
    expect(response.status).toBe(200);
    expect(mocks.credits).toHaveBeenCalledExactlyOnceWith("canonical-admin");
    expect(await response.json()).toEqual({ data: wallet, meta: SOWER_WORK_CREDIT_META });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it.each([401, 403, 503] as const)("keeps the existing administrator gate (%i) and never reads a wallet", async status => {
    mocks.access.mockResolvedValue({ allowed: false, status, message: "访问不可用" });
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(mocks.credits).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: "访问不可用" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each(["?userId=foreign-user", "?tenantId=tenant-b", "?username=other", "?page=1", "?filter=all", "?userId=canonical-admin"])("rejects requester-selected account or unsupported query %s before any wallet read", async query => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(mocks.credits).not.toHaveBeenCalled();
    expect((await response.json()).code).toBe("INVALID_QUERY");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("reports no-wallet data without opening an account or inventing credits", async () => {
    const absent = { ...wallet, wallet: { balanceCents: 0, balancePoints: 0, exists: false } };
    mocks.credits.mockResolvedValue(absent);
    const response = await GET(request());
    expect((await response.json()).data.wallet).toEqual(absent.wallet);
    expect(mocks.credits).toHaveBeenCalledExactlyOnceWith("canonical-admin");
  });

  it("fails closed and redacts database or authorization failures", async () => {
    mocks.credits.mockRejectedValue(new Error("postgresql://private:secret@database"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "积分信息暂不可用，请稍后重试", code: "CREDIT_SERVICE_UNAVAILABLE" });
    mocks.access.mockRejectedValue(new Error("private account lookup failure"));
    mocks.credits.mockClear();
    const denied = await GET(request());
    expect(denied.status).toBe(503);
    expect(mocks.credits).not.toHaveBeenCalled();
  });

  it("preserves the safe wallet error status when the account changes after authorization", async () => {
    mocks.credits.mockRejectedValue(new GatewayBillingError("ACCOUNT_UNAVAILABLE", "账号已停用", 401));
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "账号已停用", code: "ACCOUNT_UNAVAILABLE" });
  });
});
