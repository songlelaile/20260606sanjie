import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";
const mocks = vi.hoisted(() => ({ user: vi.fn(), credits: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/creative-credit", () => ({ getCreativeCredits: mocks.credits }));
import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({ id: "current-owner", tenantId: "tenant-a", status: "active" });
  mocks.credits.mockResolvedValue({ wallet: { balanceCents: 1003, balancePoints: 100.3 }, plan: { code: "starter", name: "体验版", multiplierBps: 10000, ruleVersion: 0 }, models: [], catalogError: null });
});

describe("GET creative credits", () => {
  it("returns current-account data with no-store without creating or charging a wallet", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.credits).toHaveBeenCalledWith("current-owner");
    expect((await response.json()).data.wallet.balancePoints).toBe(100.3);
  });
  it.each([null, { id: "disabled", status: "disabled" }])("rejects missing or disabled accounts", async (user) => {
    mocks.user.mockResolvedValue(user);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.credits).not.toHaveBeenCalled();
  });
  it("does not serialize credential-bearing backend exceptions", async () => {
    mocks.credits.mockRejectedValue(new Error("postgres://private-user:private-password@private-host/db"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private");
  });
  it("handles account-query failure and known inactive errors safely", async () => {
    mocks.user.mockRejectedValueOnce(new Error("private query"));
    expect((await GET()).status).toBe(503);
    mocks.credits.mockRejectedValueOnce(new GatewayBillingError("ACCOUNT_UNAVAILABLE", "账号已失效", 401));
    expect((await GET()).status).toBe(401);
  });
});
