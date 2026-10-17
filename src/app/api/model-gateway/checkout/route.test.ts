import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), create: vi.fn(), providers: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/scan-payment", () => ({ createCheckout: mocks.create, getCheckoutProviders: mocks.providers,
  isScanProvider: (value: unknown) => value === "alipay" || value === "wechat" }));
import { GET, POST } from "./route";
import { GatewayPaymentError } from "@/lib/model-gateway/payment";
const request = (body: unknown) => new Request("http://localhost/api/model-gateway/checkout", { method: "POST", body: JSON.stringify(body) });

describe("scan checkout authorization and trusted order input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "owner", status: "active" });
    mocks.create.mockResolvedValue({ id: "order", status: "pending" });
    mocks.providers.mockReturnValue([{ provider: "wechat", available: false }]);
  });
  it("passes only session owner, server plan code and allowed provider", async () => {
    const response = await POST(request({ planCode: " starter ", provider: "alipay", amountCents: 1, creditCents: 999999, status: "paid", userId: "victim" }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("owner", "starter", "alipay");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await (await GET()).json()).toEqual({ data: { providers: [{ provider: "wechat", available: false }] } });
  });
  it("rejects missing or disabled accounts before provider access", async () => {
    for (const user of [null, { id: "disabled", status: "disabled" }]) {
      mocks.user.mockResolvedValue(user);
      expect((await GET()).status).toBe(401);
      expect((await POST(request({ planCode: "starter", provider: "alipay" }))).status).toBe(401);
    }
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.providers).not.toHaveBeenCalled();
  });
  it("rejects unsupported channels, empty plans and oversized input", async () => {
    for (const body of [null, [], {}, { planCode: "starter", provider: "manual" }, { planCode: " ", provider: "wechat" }, { planCode: "x".repeat(81), provider: "wechat" }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect((await POST(request({ planCode: "starter", provider: "wechat", extra: "x".repeat(5000) }))).status).toBe(413);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("fails safely for unavailable credentials or infrastructure errors", async () => {
    mocks.create.mockRejectedValueOnce(new GatewayPaymentError("PAYMENT_PROVIDER_UNAVAILABLE", "暂未开通", 503));
    expect(await (await POST(request({ planCode: "starter", provider: "wechat" }))).json()).toEqual({ error: "暂未开通", code: "PAYMENT_PROVIDER_UNAVAILABLE" });
    mocks.create.mockRejectedValueOnce(new Error("secret-key-private"));
    const response = await POST(request({ planCode: "starter", provider: "wechat" }));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret");
  });
});
