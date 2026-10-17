import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), create: vi.fn(), overview: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/store", () => ({ createGatewayOrder: mocks.create, getGatewayOverview: mocks.overview }));
import { GET, POST } from "./route";
import { GatewayPaymentError } from "@/lib/model-gateway/payment";
const request = (body: unknown) => new Request("http://localhost/api/model-gateway/orders", { method: "POST", body: JSON.stringify(body) });

describe("gateway orders collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "user-1", status: "active", authRole: "tenant" });
    mocks.create.mockResolvedValue({ id: "order-1", status: "pending" });
    mocks.overview.mockResolvedValue({ orders: [{ id: "order-1" }] });
  });
  it("creates only server-selected plan orders; client amount/status are ignored", async () => {
    const response = await POST(request({ planCode: "starter", amountCents: 1, status: "paid", userId: "other" }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith("user-1", "starter");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("rejects unauthenticated and disabled users", async () => {
    for (const user of [null, { id: "disabled", status: "disabled" }]) {
      mocks.user.mockResolvedValue(user);
      expect((await POST(request({ planCode: "starter" }))).status).toBe(401);
      expect((await GET()).status).toBe(401);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects invalid bodies and enforces actual byte limit", async () => {
    for (const body of [null, [], { planCode: 4 }, { planCode: "a".repeat(81) }]) {
      expect((await POST(request(body))).status).toBe(400);
    }
    expect((await POST(request({ planCode: "starter", noise: "a".repeat(5000) }))).status).toBe(413);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("returns safe domain codes and hides unexpected database exceptions", async () => {
    mocks.create.mockRejectedValue(new GatewayPaymentError("INVALID_PLAN", "套餐不存在", 400));
    expect(await (await POST(request({ planCode: "invalid" }))).json()).toEqual({ error: "套餐不存在", code: "INVALID_PLAN" });
    mocks.create.mockRejectedValue(new Error("database secret=not-for-response"));
    const response = await POST(request({ planCode: "starter" }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
  it("lists the current user's orders with no-store and safe failures", async () => {
    expect(await (await GET()).json()).toEqual({ data: { orders: [{ id: "order-1" }] } });
    expect(mocks.overview).toHaveBeenCalledWith("user-1");
    mocks.overview.mockRejectedValue(new Error("private database error"));
    expect((await GET()).status).toBe(503);
  });
  it("returns JSON service errors when authentication storage is unavailable", async () => {
    mocks.user.mockRejectedValue(new Error("private authentication database url"));
    expect((await GET()).status).toBe(503);
    const response = await POST(request({ planCode: "starter" }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("database");
  });
});
