import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ session: vi.fn(), active: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "session", ROLE_HOME: { tenant: "/dashboards/operating-network" }, parseSession: mocks.session, canAccess: () => true }));
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: mocks.rate }));
vi.mock("@/lib/security-web-account", () => ({ isActiveSecurityAccount: mocks.active, securityAccountIdentity: () => "stable-account" }));
import { middleware } from "./middleware";
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("PUBLIC_APP_ORIGIN", ""); vi.clearAllMocks();
  mocks.session.mockResolvedValue({ username: "user", role: "tenant", tenantId: "tenant" });
  mocks.active.mockResolvedValue(true);
  mocks.rate.mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
});
afterEach(() => vi.unstubAllEnvs());
const req = (path: string, headers: Record<string, string> = {}, method = "GET") => new NextRequest(`https://localhost:3040${path}`, { headers, method });

it.each(["/_next/static/chunks/app.js.map", "/.env", "/downloads/backup.tgz", "/src/server.ts"])("denies artifact %s before database or authentication", async path => {
  expect((await middleware(req(path))).status).toBe(404);
  expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.rate).not.toHaveBeenCalled();
});
it.each(["/_next/static/chunks/app.js", "/downloads/shaozhuang-ai-legacy-icon.png"])("keeps public runtime/icon %s accessible", async path => {
  mocks.session.mockResolvedValue(null);
  expect((await middleware(req(path))).headers.get("x-middleware-next")).toBe("1");
  expect(mocks.session).not.toHaveBeenCalled();
});
it("rewrites functional scripts as well as HTML through live entitlement checks", async () => {
  const response = await middleware(req("/creative/src/business-knowledge.js?v=123"));
  expect(response.headers.get("x-middleware-rewrite")).toBe("https://localhost:3040/api/creative/assets/src/business-knowledge.js?v=123");
  expect(mocks.rate).toHaveBeenCalledWith("web-assets", "stable-account", 300, 60);
});
it("closes anonymous archive downloads but preserves their URL for authorized users", async () => {
  mocks.session.mockResolvedValueOnce(null);
  expect((await middleware(req("/downloads/plugin.zip"))).status).toBe(401);
  expect((await middleware(req("/downloads/plugin.zip"))).headers.get("x-middleware-rewrite")).toBe("https://localhost:3040/api/protected-downloads/plugin.zip");
});
it("rejects revoked accounts and database failure before serving protected pages", async () => {
  mocks.active.mockResolvedValueOnce(false);
  expect((await middleware(req("/tools"))).status).toBe(401);
  mocks.active.mockRejectedValueOnce(new Error("private db credentials"));
  const response = await middleware(req("/tools"));
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("private db");
  expect(mocks.rate).not.toHaveBeenCalled();
});
it("returns an actionable 429 and fails closed for quota-store failure", async () => {
  mocks.rate.mockResolvedValueOnce({ allowed: false, reason: "rate_limited", retryAfterSeconds: 25, remaining: 0 });
  const response = await middleware(req("/api/shops"));
  expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("25");
  mocks.rate.mockResolvedValueOnce({ allowed: false, reason: "unavailable", retryAfterSeconds: 30, remaining: 0 });
  expect((await middleware(req("/api/shops"))).status).toBe(503);
});
it.each(["Codex", "Cursor", "Claude Code"])("blocks hostile writes and preserves account checks for undeclared %s User-Agent", async userAgent => {
  const bad = await middleware(req("/api/shops", { origin: "https://evil.example" }, "POST"));
  expect(bad.status).toBe(403); expect(mocks.session).not.toHaveBeenCalled();
  const good = await middleware(req("/api/shops", { origin: "https://shaozhuangai.com", "user-agent": userAgent }, "POST"));
  expect(good.headers.get("x-middleware-next")).toBe("1");
  expect(mocks.active).toHaveBeenCalledOnce();
  expect(mocks.rate).toHaveBeenCalledWith("web-api-write", "stable-account", 90, 60);
  mocks.session.mockResolvedValueOnce(null);
  const anonymous = await middleware(req("/api/shops", { origin: "https://shaozhuangai.com", "user-agent": userAgent }, "POST"));
  expect(anonymous.status).toBe(401);
  expect(mocks.rate).toHaveBeenCalledOnce();
});
it("keeps logout available during account/limiter failures", async () => {
  mocks.active.mockRejectedValue(new Error("db offline"));
  mocks.rate.mockResolvedValue({ allowed: false, reason: "unavailable", retryAfterSeconds: 30, remaining: 0 });
  expect((await middleware(req("/api/auth/logout", { origin: "https://shaozhuangai.com" }, "POST"))).headers.get("x-middleware-next")).toBe("1");
});
it.each([
  ["/tools", { "x-sanjie-ai-client": "Codex" }],
  ["/api/shops", { "x-sanjie-ai-client": "Cursor" }],
  ["/creative/labs/image-prompt-lab/promptlab.html", { "x-sanjie-ai-client": "Claude Code" }],
  ["/tools", { "x-sanjie-ai-client": "unknown-ai-client" }],
  ["/api/shops", { authorization: "Bearer sja_test" }],
  ["/_next/static/chunks/app.js", { "x-sanjie-ai-client": "" }],
  ["/api/v1/models", { "x-sanjie-ai-client": "assistant" }]
])("requires the unified channel for a declared AI request to %s", async (path, headers) => {
  const response = await middleware(req(path, headers as Record<string, string>));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "AI_CHANNEL_REQUIRED" });
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.rate).not.toHaveBeenCalled();
});
it("lets only the unified execution route perform its own grant verification", async () => {
  const response = await middleware(req("/api/ai-access/execute", { authorization: "Bearer sja_test" }, "POST"));
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.active).not.toHaveBeenCalled();
  expect(mocks.rate).not.toHaveBeenCalled();
});
it("still rejects cross-site browser use of the unified AI execution route", async () => {
  const response = await middleware(req("/api/ai-access/execute", { authorization: "Bearer sja_test", origin: "https://evil.example" }, "POST"));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "CROSS_SITE_REQUEST" });
});

it.each(["alipay", "wechat"])("delegates only the exact %s POST notification to provider signature verification", async provider => {
  mocks.session.mockResolvedValue(null);
  const path = `/api/payments/${provider}/notify`;
  const response = await middleware(req(path, { origin: "https://provider.example" }, "POST"));
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.active).not.toHaveBeenCalled();
  expect(mocks.rate).not.toHaveBeenCalled();
  for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
    const denied = await middleware(req(path, {}, method));
    expect(denied.status).toBe(405);
    expect(denied.headers.get("allow")).toBe("POST");
  }
});

it.each(["/api/payments/alipay/notify/extra", "/api/payments/wechat/notify-extra", "/api/payments/other/notify", "/api/model-gateway/checkout", "/api/payments/alipay"])("does not exempt adjacent payment path %s", async path => {
  mocks.session.mockResolvedValue(null);
  expect((await middleware(req(path, {}, "POST"))).status).toBe(401);
  expect((await middleware(req(path, { origin: "https://evil.example" }, "POST"))).status).toBe(403);
});

// These are existing deployed extension/client contracts; adding payment callbacks must preserve them.
it.each(["/api/tools/updates/ai-automation/latest", "/downloads/shaozhuang-ai-v1.9.83-macos-full.zip"])("preserves the precise production public updater %s", async path => {
  mocks.session.mockResolvedValue(null);
  expect((await middleware(req(path))).headers.get("x-middleware-next")).toBe("1");
  expect((await middleware(req(path, {}, "POST"))).status).toBe(405);
  expect(mocks.session).not.toHaveBeenCalled();
});
it.each(["/api/video-assets", "/api/tools/sower-work/lease/verify"])("preserves handler-owned extension authentication for %s", async path => {
  mocks.session.mockResolvedValue(null);
  const response = await middleware(req(path, { origin: "chrome-extension://existing-installed-client" }, "POST"));
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(mocks.session).not.toHaveBeenCalled();
});
it.each(["/api/payments/alipay/notify", "/api/payments/wechat/notify", "/api/tools/sower-work/lease/verify"])("keeps declared AI channel enforcement ahead of %s exceptions", async path => {
  const response = await middleware(req(path, { "x-sanjie-ai-client": "Codex" }, "POST"));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "AI_CHANNEL_REQUIRED" });
  expect(mocks.session).not.toHaveBeenCalled();
});
