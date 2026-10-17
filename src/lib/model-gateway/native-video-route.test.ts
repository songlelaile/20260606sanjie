import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), access: vi.fn(), rate: vi.fn(), create: vi.fn(), config: vi.fn(), poll: vi.fn(), resolve: vi.fn(), content: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: mocks.session, getCurrentUser: mocks.user }));
vi.mock("@/lib/creative-entitlements", () => ({ getCreativeAccessForSession: mocks.access }));
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: mocks.rate }));
vi.mock("./native-video", () => ({ createNativeVideo: mocks.create, nativeVideoCapabilities: mocks.config, pollNativeVideo: mocks.poll,
  resolveNativeVideo: mocks.resolve, nativeVideoContent: mocks.content, NATIVE_VIDEO_BODY_BYTES: 24 * 1024 * 1024 }));
import { nativeVideoCreateRoute, nativeVideoStatusRoute, nativeVideoConfigRoute, nativeVideoResolveRoute, nativeVideoContentRoute } from "./native-video-route";
import { NativeVideoError } from "./native-video-contract";
import { GatewayBillingError } from "./billing-contract";
const id = "nv_12345678-1234-1234-1234-123456789abc";
const url = "https://shaozhuangai.com/api/creative/native-video";
function req(body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request(url, { method: body === undefined ? "GET" : "POST", headers: { Origin: "https://shaozhuangai.com", "Content-Type": "application/json", "X-Sanjie-Expected-Account": "tenant:alice", "Idempotency-Key": "fixture-idem", ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ tenantId: "tenant", username: "alice", role: "tenant" });
  mocks.user.mockResolvedValue({ id: "user", tenantId: "tenant", username: "alice" });
  mocks.access.mockResolvedValue({ allowed: true }); mocks.rate.mockResolvedValue({ allowed: true });
  mocks.create.mockResolvedValue({ id, status: "running", stateUncertain: true });
  mocks.config.mockResolvedValue({ configured: false, models: [] });
  mocks.poll.mockResolvedValue({ id, status: "running" }); mocks.resolve.mockResolvedValue({ id, status: "running" });
  mocks.content.mockResolvedValue(new Response("fixture", { headers: { "Content-Type": "video/mp4" } }));
});
describe("native video session, ownership envelope, and local provenance", () => {
  it("requires an active session before config/status/resolve/content", async () => {
    mocks.session.mockResolvedValue(null);
    for (const action of [() => nativeVideoConfigRoute(req()), () => nativeVideoStatusRoute(req(), id), () => nativeVideoResolveRoute(req()), () => nativeVideoContentRoute(req(), id)]) {
      expect((await action()).status).toBe(401);
    }
    expect(mocks.config).not.toHaveBeenCalled(); expect(mocks.poll).not.toHaveBeenCalled(); expect(mocks.content).not.toHaveBeenCalled();
  });
  it("rejects a cross-site POST before forwarding or accounting", async () => {
    const response = await nativeVideoCreateRoute(req({ expectedAccount: "tenant:alice" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }));
    expect(response.status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires explicit expected account on creation", async () => {
    expect((await nativeVideoCreateRoute(req({ model: "seedance-2.0" }))).status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("trusted create account mismatch has only the exact local 409 proof", async () => {
    const response = await nativeVideoCreateRoute(req({ expectedAccount: "tenant:bob" }));
    expect(response.status).toBe(409); expect(response.headers.get("X-Sanjie-Provider-Submission")).toBe("not-submitted");
    expect(await response.json()).toMatchObject({ code: "CREATIVE_ACCOUNT_CHANGED", providerSubmitted: false, definitiveFailure: true });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("GET account mismatch never claims that an old provider task was not submitted", async () => {
    const response = await nativeVideoStatusRoute(req(undefined, { "X-Sanjie-Expected-Account": "tenant:bob" }), id);
    expect(response.status).toBe(409); expect(response.headers.get("X-Sanjie-Provider-Submission")).toBeNull();
    expect(await response.json()).not.toHaveProperty("providerSubmitted"); expect(mocks.poll).not.toHaveBeenCalled();
  });
  it("config GET rejects a missing expected-account header without claiming no provider submission", async () => {
    const response = await nativeVideoConfigRoute(new Request(url));
    expect(response.status).toBe(409); expect(response.headers.get("X-Sanjie-Provider-Submission")).toBeNull();
    expect(mocks.config).not.toHaveBeenCalled();
  });
  it("config GET accepts a correct explicit account binding", async () => {
    const response = await nativeVideoConfigRoute(req());
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ configured: false, models: [] });
    expect(mocks.config).toHaveBeenCalledWith({ id: "user", tenantId: "tenant", username: "alice" });
  });
  it("a revoked/moved user is rejected despite a signed cookie", async () => {
    mocks.user.mockResolvedValue({ id: "user", tenantId: "foreign-tenant", username: "alice" });
    expect((await nativeVideoCreateRoute(req({ expectedAccount: "tenant:alice" }))).status).toBe(401); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("forwards only a resolved owner and stable idempotency envelope", async () => {
    const body = { expectedAccount: "tenant:alice", model: "seedance-2.0", content: [{ type: "text", text: "fixture" }] };
    const response = await nativeVideoCreateRoute(req(body));
    expect(response.status).toBe(202); expect(response.headers.get("X-Sanjie-Provider-Submission")).toBeNull();
    expect(mocks.create).toHaveBeenCalledWith({ id: "user", tenantId: "tenant", username: "alice" }, body, "fixture-idem");
  });
  it.each(["NATIVE_VIDEO_CONFIG_INVALID", "NATIVE_VIDEO_SUPPLY_UNAVAILABLE", "NATIVE_VIDEO_DISABLED", "NATIVE_VIDEO_MODEL_UNAVAILABLE"]) ("only local pre-dispatch %s receives a 503 proof", async code => {
    mocks.create.mockRejectedValue(new NativeVideoError(code, "fixture unavailable", 503));
    const response = await nativeVideoCreateRoute(req({ expectedAccount: "tenant:alice" }));
    expect(response.status).toBe(503); expect(response.headers.get("X-Sanjie-Provider-Submission")).toBe("not-submitted");
    expect(await response.json()).toMatchObject({ code: code === "NATIVE_VIDEO_MODEL_UNAVAILABLE" ? code : "NATIVE_VIDEO_NOT_CONFIGURED", providerSubmitted: false, definitiveFailure: true });
  });
  it("unknown exceptions and polling config failures have no not-submitted proof", async () => {
    mocks.create.mockRejectedValue(new Error("private-key-and-provider-body"));
    const response = await nativeVideoCreateRoute(req({ expectedAccount: "tenant:alice" }));
    expect(response.status).toBe(503); expect(response.headers.get("X-Sanjie-Provider-Submission")).toBeNull(); expect(await response.text()).not.toContain("private-key");
    mocks.poll.mockRejectedValue(new NativeVideoError("NATIVE_VIDEO_SUPPLY_UNAVAILABLE", "fixture", 503));
    const polled = await nativeVideoStatusRoute(req(), id); expect(polled.headers.get("X-Sanjie-Provider-Submission")).toBeNull(); expect(await polled.json()).not.toHaveProperty("providerSubmitted");
  });
  it("wallet insufficient balance is a proven pre-hold rejection that can be retried after recharge", async () => {
    mocks.create.mockRejectedValue(new GatewayBillingError("INSUFFICIENT_BALANCE", "余额不足", 402));
    const response = await nativeVideoCreateRoute(req({ expectedAccount: "tenant:alice" }));
    expect(response.status).toBe(402); expect(response.headers.get("X-Sanjie-Provider-Submission")).toBe("not-submitted");
    expect(await response.json()).toMatchObject({ code: "NATIVE_VIDEO_REQUEST_NOT_SUBMITTED", reasonCode: "INSUFFICIENT_BALANCE", providerSubmitted: false, definitiveFailure: true });
  });
  it("the same status with an unrecognized post-create error has no local proof", async () => {
    mocks.create.mockRejectedValue(new NativeVideoError("UNTRUSTED_PROVIDER_ERROR", "fixture", 402));
    const response = await nativeVideoCreateRoute(req({ expectedAccount: "tenant:alice" }));
    expect(response.headers.get("X-Sanjie-Provider-Submission")).toBeNull(); expect(await response.json()).not.toHaveProperty("providerSubmitted");
  });
  it.each(["session", "user", "access", "rate"] as const)("a %s preflight exception proves zero create calls and permits recovery", async stage => {
    mocks[stage].mockRejectedValueOnce(new Error("fixture private preflight details"));
    const rejected = await nativeVideoCreateRoute(req({ expectedAccount: "tenant:alice" }));
    expect(rejected.status).toBe(503); expect(rejected.headers.get("X-Sanjie-Provider-Submission")).toBe("not-submitted");
    const body = await rejected.json(); expect(body).toMatchObject({ code: "NATIVE_VIDEO_REQUEST_NOT_SUBMITTED", providerSubmitted: false, definitiveFailure: true });
    expect(JSON.stringify(body)).not.toContain("private preflight"); expect(mocks.create).not.toHaveBeenCalled();
    expect((await nativeVideoCreateRoute(req({ expectedAccount: "tenant:alice" }))).status).toBe(202);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("uses actual UTF8 bytes rather than forged Content-Length", async () => {
    const response = await nativeVideoCreateRoute(req({ expectedAccount: "tenant:alice", text: "图".repeat(9 * 1024 * 1024) }, { "Content-Length": "1" }));
    expect(response.status).toBe(413); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires local job identifiers and delegates media ownership from the session", async () => {
    expect((await nativeVideoStatusRoute(req(), "provider-task-1")).status).toBe(404);
    const response = await nativeVideoContentRoute(new Request(url + "/" + id + "/content"), id);
    expect(response.status).toBe(200); expect(mocks.content.mock.calls[0].slice(0, 2)).toEqual([{ id: "user", tenantId: "tenant", username: "alice" }, id]);
    expect(mocks.poll).not.toHaveBeenCalled();
  });
  it("resolve is an authenticated local read and never invokes create or poll", async () => {
    expect((await nativeVideoResolveRoute(req())).status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith({ id: "user", tenantId: "tenant", username: "alice" }, "fixture-idem");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.poll).not.toHaveBeenCalled();
  });
});
