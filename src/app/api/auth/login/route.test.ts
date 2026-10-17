import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findAccount: vi.fn(), rateLimit: vi.fn(), serializeSession: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/accounts", () => ({ findAccount: mocks.findAccount }));
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: mocks.rateLimit }));
vi.mock("@/lib/auth", () => ({
  ACTIVE_SHOP_COOKIE: "active_shop", SESSION_COOKIE: "session", SESSION_MAX_AGE_SECONDS: 28_800,
  ROLE_HOME: { tenant: "/dashboards/operating-network", admin: "/dashboards/operating-network" },
  serializeSession: mocks.serializeSession
}));
import { POST } from "./route";

function request(body: unknown = { username: " Alice ", password: "secret12" }, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  });
}

describe("POST /api/auth/login protection", () => {
  beforeEach(() => {
    mocks.findAccount.mockReset().mockResolvedValue(null);
    mocks.rateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 10, retryAfterSeconds: 0 });
    mocks.serializeSession.mockReset().mockResolvedValue("signed-session");
    vi.stubEnv("SANJIE_TRUST_PROXY_IP", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("limits unknown IP and normalized account before password verification", async () => {
    const response = await POST(request(undefined, { "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.2" }));
    expect(response.status).toBe(401);
    expect(mocks.rateLimit.mock.calls).toEqual([
      ["auth.login.ip", "unknown", 200, 300], ["auth.login.account", "alice", 10, 300]
    ]);
    expect(mocks.findAccount).toHaveBeenCalledWith("Alice", "secret12");
    expect(mocks.rateLimit.mock.invocationCallOrder[1]).toBeLessThan(mocks.findAccount.mock.invocationCallOrder[0]);
  });

  it("trusts only explicitly enabled ingress X-Real-IP and ignores XFF", async () => {
    vi.stubEnv("SANJIE_TRUST_PROXY_IP", "true");
    await POST(request(undefined, { "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.2" }));
    expect(mocks.rateLimit.mock.calls[0]).toEqual(["auth.login.ip", "203.0.113.1", 50, 300]);
    mocks.rateLimit.mockClear();
    await POST(request(undefined, { "x-real-ip": "203.0.113.1, 198.51.100.2", "x-forwarded-for": "198.51.100.2" }));
    expect(mocks.rateLimit.mock.calls[0]).toEqual(["auth.login.ip", "unknown", 200, 300]);
  });

  it("canonicalizes equivalent IPv6 ingress addresses to one rate bucket", async () => {
    vi.stubEnv("SANJIE_TRUST_PROXY_IP", "true");
    await POST(request(undefined, { "x-real-ip": "2001:0db8:0000:0000:0000:0000:0000:0001" }));
    expect(mocks.rateLimit.mock.calls[0][1]).toBe("2001:db8::1");
  });

  it.each(["rate_limited", "unavailable"])("fails closed at IP protection for %s without parsing or checking passwords", async reason => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, reason, remaining: 0, retryAfterSeconds: 30 });
    const response = await POST(request());
    expect(response.status).toBe(reason === "unavailable" ? 503 : 429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.findAccount).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.serializeSession).not.toHaveBeenCalled();
  });

  it("rejects account attempts after the IP counter passes, before checking the password", async () => {
    mocks.rateLimit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, reason: "rate_limited", retryAfterSeconds: 50 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("50");
    expect(mocks.findAccount).not.toHaveBeenCalled();
  });

  it("bounds actual chunked UTF-8 body bytes without trusting Content-Length", async () => {
    const raw = new TextEncoder().encode(JSON.stringify({ username: "Alice", password: "汉".repeat(6_000) }));
    const chunks = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(raw.slice(0, 8000)); controller.enqueue(raw.slice(8000)); controller.close(); } });
    const incoming = new Request("http://localhost/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "1" }, body: chunks, duplex: "half"
    } as RequestInit);
    const response = await POST(incoming);
    expect(response.status).toBe(413);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.findAccount).not.toHaveBeenCalled();
  });

  it.each([null, [], "malformed", { username: {} }, { username: "x".repeat(257), password: "test" }, { username: "ﷺ".repeat(256), password: "test" }])("rejects invalid or oversized account identity before account bucket creation %j", async body => {
    const response = await POST(request(body));
    expect([400, 401]).toContain(response.status);
    expect(mocks.findAccount).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
  });

  it("preserves the successful response, session and active-shop cookie reset", async () => {
    mocks.findAccount.mockResolvedValue({ username: "Alice", name: "阿壮", role: "tenant", tenantId: "tenant-a" });
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { role: "tenant", name: "阿壮", home: "/dashboards/operating-network" } });
    expect(response.cookies.get("session")?.value).toBe("signed-session");
    expect(response.cookies.get("session")?.httpOnly).toBe(true);
    expect(response.cookies.get("session")?.sameSite).toBe("lax");
    expect(response.cookies.get("session")?.maxAge).toBe(28_800);
    expect(response.cookies.get("active_shop")?.value).toBe("");
    expect(mocks.serializeSession).toHaveBeenCalledWith({ username: "Alice", name: "阿壮", role: "tenant", tenantId: "tenant-a" });
  });

  it("keeps disabled accounts denied and never signs a session", async () => {
    mocks.findAccount.mockResolvedValue("disabled");
    expect((await POST(request())).status).toBe(403);
    expect(mocks.serializeSession).not.toHaveBeenCalled();
  });
});
