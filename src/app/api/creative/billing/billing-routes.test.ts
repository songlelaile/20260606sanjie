import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), rate: vi.fn(), model: vi.fn(), snapshot: vi.fn(), cancel: vi.fn(), cancelRequest: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: mocks.rate }));
vi.mock("@/lib/model-gateway/billing", () => ({ getGatewayBillingSnapshot: mocks.snapshot }));
vi.mock("@/lib/model-gateway/runtime-catalog", () => ({ findAvailableGatewayModel: mocks.model }));
vi.mock("@/lib/model-gateway/billing-hold", () => ({ cancelGatewayBillingHold: mocks.cancel, cancelGatewayBillingRequest: mocks.cancelRequest }));
import { POST as quote } from "./quote/route";
import { POST as cancel } from "./cancel/route";
const request = (body: unknown, origin = "http://localhost") => new Request("http://localhost/api/creative/billing/quote", { method: "POST", headers: { origin, host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify(body) });
const image = { endpoint: "images.generations", model: "image2", body: { n: 2, prompt: "private image input" }, expectedAccount: "t:alice" };
beforeEach(() => {
  vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: "u", tenantId: "t", username: "alice", status: "active" });
  mocks.rate.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mocks.model.mockResolvedValue({ id: "image2", provider: "shaozhuang", kind: "image", imageCents: 50 });
  mocks.snapshot.mockResolvedValue({ multiplierBps: 10001 });
  mocks.cancelRequest.mockResolvedValue({ hold: null, replayed: false });
});
describe("site submission billing quote and cancellation", () => {
  it.each([quote, cancel])("rejects cross-site, inactive, changed accounts and rate limits before financial work", async route => {
    expect((await route(request(image, "https://other.example"))).status).toBe(403);
    mocks.user.mockResolvedValueOnce(null); expect((await route(request(image))).status).toBe(401);
    expect((await route(request({ ...image, expectedAccount: "t:bob" }))).status).toBe(409);
    mocks.rate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 12 });
    expect((await route(request(image))).status).toBe(429);
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.cancelRequest).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
  });
  it("quotes exact image quantity with one frozen plan rounding and never creates a charge", async () => {
    const response = await quote(request(image)); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ billingMode: "prepaid_quote", quoteCents: 101, quotePoints: 10.1, refundOnFailure: true, refundOnCancel: false });
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.cancelRequest).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it("quotes text output budget instead of final supplier token usage", async () => {
    mocks.model.mockResolvedValue({ id: "chat", provider: "shaozhuang", kind: "chat", promptCentsPer1K: 2, completionCentsPer1K: 4 });
    mocks.snapshot.mockResolvedValue({ multiplierBps: 10000 });
    const response = await quote(request({ ...image, endpoint: "chat.completions", model: "chat", body: { messages: [{ role: "user", content: "hi" }], max_completion_tokens: 2000 } }));
    expect(await response.json()).toMatchObject({ quoteCents: 9, quotePoints: .9 });
  });
  it("refuses unavailable or non-platform models and malformed counts", async () => {
    mocks.model.mockResolvedValueOnce({ provider: "personal" }); expect((await quote(request(image))).status).toBe(404);
    expect((await quote(request({ ...image, body: { n: 0 } }))).status).toBe(400);
  });
  it("persists early cancellation by original stable key without claiming provider cancellation", async () => {
    const response = await cancel(request({ idempotencyKey: "native-video:stable-key", expectedAccount: "t:alice" }));
    expect(mocks.cancelRequest).toHaveBeenCalledExactlyOnceWith({ userId: "u", idempotencyKey: "native-video:stable-key" });
    expect(await response.json()).toMatchObject({ cancelled: true, providerCancelled: false, chargedCents: 0, refundOnCancel: false });
  });
  it("describes a prior failure refund truthfully without marking it cancelled or charging it again", async () => {
    mocks.cancel.mockResolvedValue({ hold: { eventId: "event", chargedCents: 50, refundedCents: 50, cancelledAt: null }, replayed: true });
    const value = await (await cancel(request({ billingEventId: "event" }))).json();
    expect(value).toMatchObject({ cancelled: false, refundedCents: 50, chargedCents: 50, replayed: true }); expect(value.message).toContain("已失败并退回积分");
  });
  it("rejects ambiguous cancellation identity and bounds bytes", async () => {
    expect((await cancel(request({ billingEventId: "event", idempotencyKey: "key" }))).status).toBe(400);
    expect((await cancel(request({ idempotencyKey: "x".repeat(3000) }))).status).toBe(413);
    expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.cancelRequest).not.toHaveBeenCalled();
  });
});
