import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), session: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user, getCurrentSession: mocks.session }));
vi.mock("@/lib/model-gateway/store", () => ({ markGatewayOrderPaidByOrderId: mocks.confirm }));
import { POST } from "./route";
import { GatewayPaymentError } from "@/lib/model-gateway/payment";
const params = { params: Promise.resolve({ id: "order-1" }) };
const request = (body: unknown) => new Request("http://localhost/api/model-gateway/orders/order-1/mark-paid", { method: "POST", body: JSON.stringify(body) });
const evidence = { receipt: "real-flow-123", receivedAmountCents: 9900, note: "已核对人工到账" };

describe("admin manual payment confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "admin-1", status: "active", authRole: "admin" });
    mocks.session.mockResolvedValue({ role: "admin" });
    mocks.confirm.mockResolvedValue({ id: "order-1", status: "paid" });
  });
  it("records the server-selected confirming administrator and mandatory evidence", async () => {
    const response = await POST(request({ ...evidence, confirmedBy: "fake-admin" }), params);
    expect(response.status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledWith("order-1", { ...evidence, confirmedBy: "admin-1" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("blocks unauthenticated and disabled accounts", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await POST(request(evidence), params)).status).toBe(401);
    mocks.user.mockResolvedValue({ id: "admin-1", status: "disabled", authRole: "admin" });
    expect((await POST(request(evidence), params)).status).toBe(401);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("blocks tenant self-confirmation and stale elevated sessions", async () => {
    mocks.session.mockResolvedValue({ role: "tenant" });
    expect((await POST(request(evidence), params)).status).toBe(403);
    mocks.session.mockResolvedValue({ role: "admin" });
    mocks.user.mockResolvedValue({ id: "user-1", status: "active", authRole: "tenant" });
    expect((await POST(request(evidence), params)).status).toBe(403);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("rejects empty confirmation, missing receipt, decimal amounts and excessive payload", async () => {
    for (const body of [null, {}, { receivedAmountCents: 9900 }, { ...evidence, receivedAmountCents: 99.5 }]) {
      expect((await POST(request(body), params)).status).toBe(400);
    }
    expect((await POST(request({ ...evidence, noise: "a".repeat(9000) }), params)).status).toBe(413);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("preserves amount/duplicate conflicts and does not leak infrastructure errors", async () => {
    mocks.confirm.mockRejectedValue(new GatewayPaymentError("PAYMENT_AMOUNT_MISMATCH", "金额不一致", 409));
    const mismatch = await POST(request(evidence), params);
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ error: "金额不一致", code: "PAYMENT_AMOUNT_MISMATCH" });
    mocks.confirm.mockRejectedValue(new Error("postgres password=private"));
    const response = await POST(request(evidence), params);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("password");
  });
  it("hides authentication storage exceptions", async () => {
    mocks.user.mockRejectedValue(new Error("private authentication secret"));
    const response = await POST(request(evidence), params);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
