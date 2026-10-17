import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), access: vi.fn(), rate: vi.fn(), generate: vi.fn(), read: vi.fn(), capabilities: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: mocks.session, getCurrentUser: mocks.user }));
vi.mock("@/lib/creative-entitlements", () => ({ getCreativeAccessForSession: mocks.access }));
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: mocks.rate }));
vi.mock("@/lib/security-web-account", () => ({ securityAccountIdentity: () => "owner-account" }));
vi.mock("@/lib/video-narration", async (original) => ({ ...await original<typeof import("@/lib/video-narration")>(), generateNarration: mocks.generate, readNarration: mocks.read, narrationCapabilities: mocks.capabilities }));
import { GET, POST } from "./route";

const input = { requestId: "stable-request", shotId: "shot-1", text: "已确认台词", durationSeconds: 5, expectedAccountKey: "owner" };
function post(body: unknown = input, headers = {}) { return new Request("https://shaozhuangai.com/api/creative/narration", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://shaozhuangai.com", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.session.mockResolvedValue({ username: "owner", tenantId: "tenant", role: "tenant" }); mocks.user.mockResolvedValue({ id: "owner", username: "owner", tenantId: "tenant", status: "active" }); mocks.access.mockResolvedValue({ allowed: true });
  mocks.rate.mockResolvedValue({ allowed: true }); mocks.capabilities.mockReturnValue({ available: false, code: "NARRATION_NOT_CONFIGURED", message: "未配置" });
  const result = { bytes: new Uint8Array([1, 2, 3]), receipt: { requestId: input.requestId, durationSeconds: 2, fingerprint: "receipt-fingerprint", contentHash: "new-content-hash", billingEventId: "stable-billing" } };
  mocks.generate.mockResolvedValue(result); mocks.read.mockResolvedValue(result);
});
describe("account-scoped script narration HTTP boundary", () => {
  it("requires current session and creative entitlement before exposing supply or generating", async () => {
    mocks.session.mockResolvedValueOnce(null); expect((await POST(post())).status).toBe(401);
    mocks.access.mockResolvedValueOnce({ allowed: false, reason: "payment_required" }); expect((await POST(post())).status).toBe(402); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("rejects cross-site writes and changed expected account before provider calls", async () => {
    expect((await POST(post(input, { Origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(post({ ...input, expectedAccountKey: "other" }))).status).toBe(409); expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.rate).not.toHaveBeenCalled();
  });
  it("bounds actual request bytes, text length and exact allowed fields; original audio cannot enter the speech request", async () => {
    expect((await POST(post({ ...input, audios: ["original"] }))).status).toBe(400);
    expect((await POST(post({ ...input, text: "字".repeat(1001) }))).status).toBe(400);
    expect((await POST(post(" ".repeat(16 * 1024 + 1)))).status).toBe(413); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("applies account rate limits before speech generation", async () => {
    mocks.rate.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterSeconds: 60, reason: "rate_limited" });
    expect((await POST(post())).status).toBe(429); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("returns new-wave provenance and billing receipt only for current-account generation", async () => {
    const result = await POST(post()); expect(result.status).toBe(200); expect(result.headers.get("X-Narration-Origin")).toBe("script_narration"); expect(result.headers.get("X-Narration-Billing-Event")).toBe("stable-billing"); expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ id: "owner" }), input);
  });
  it("GET capability is read-only and requires exact account binding", async () => {
    expect((await GET(new Request("https://shaozhuangai.com/api/creative/narration?expectedAccountKey=other"))).status).toBe(409);
    const result = await GET(new Request("https://shaozhuangai.com/api/creative/narration?expectedAccountKey=owner")); expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ data: { available: false } }); expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("GET reconciles only an existing account-scoped request and cannot mutate or resubmit", async () => {
    const result = await GET(new Request("https://shaozhuangai.com/api/creative/narration?expectedAccountKey=owner&requestId=stable-request")); expect(result.status).toBe(200); expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ id: "owner" }), "stable-request"); expect(mocks.generate).not.toHaveBeenCalled();
    expect((await GET(new Request("https://shaozhuangai.com/api/creative/narration?expectedAccountKey=owner&requestId=one&requestId=two"))).status).toBe(400);
  });
});
