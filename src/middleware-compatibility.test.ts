import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PUBLIC_AI_DOWNLOAD_PATHS } from "./lib/production-compatibility-policy";
const mocks = vi.hoisted(() => ({ session: vi.fn(), active: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "session", ROLE_HOME: { tenant: "/dashboards/operating-network" }, parseSession: mocks.session, canAccess: () => true }));
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: mocks.rate }));
vi.mock("@/lib/security-web-account", () => ({ isActiveSecurityAccount: mocks.active, securityAccountIdentity: () => "stable-account" }));
import { middleware } from "./middleware";
const req = (path: string, method = "GET", headers: Record<string, string> = {}) => new NextRequest(`https://shaozhuangai.com${path}`, { method, headers });
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("PUBLIC_APP_ORIGIN", ""); vi.clearAllMocks();
  mocks.session.mockResolvedValue(null); mocks.active.mockResolvedValue(true);
  mocks.rate.mockResolvedValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  "/api/tools/updates/ai-automation/latest", "/api/tools/updates/ai-automation/bootstrap",
  "/api/tools/updates/ai-automation/package/1.9.80", "/api/tools/updates/ai-automation/package/1.9.83",
  ...PUBLIC_AI_DOWNLOAD_PATHS
])("keeps GET and HEAD anonymous for reviewed update contract %s", async path => {
  for (const method of ["GET", "HEAD"]) expect((await middleware(req(path, method))).headers.get("x-middleware-next")).toBe("1");
  expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.rate).not.toHaveBeenCalled();
});
it.each([
  "/downloads/sycm-keyword-collector-v1.9.84.zip",
  "/downloads/shaozhuang-ai-v1.9.84-macos-full.zip"
])("keeps current official ZIP %s anonymous for reads and rejects writes and declared AI channels", async path => {
  for (const method of ["GET", "HEAD"]) expect((await middleware(req(path, method))).headers.get("x-middleware-next")).toBe("1");
  for (const method of ["POST", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await middleware(req(path, method));
    expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("GET, HEAD");
  }
  expect((await middleware(req(path, "GET", { "x-sanjie-ai-client": "Codex" }))).status).toBe(403);
  expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.rate).not.toHaveBeenCalled();
});
it.each(["POST", "PATCH", "DELETE", "OPTIONS"])("keeps public updates read-only: %s", async method => {
  const response = await middleware(req("/api/tools/updates/ai-automation/latest", method));
  expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("GET, HEAD");
});
it.each([
  "/downloads/unreviewed.zip", "/downloads/sycm-keyword-collector-v1.9.85.zip",
  "/downloads/shaozhuang-ai-v1.9.85-macos-full.zip",
  "/api/tools/updates/dmp-collector/latest", "/api/tools/updates/ai-automation/latest/extra"
])("keeps unknown/archive/non-AI product %s protected", async path => {
  expect((await middleware(req(path))).status).toBe(401);
});
it.each([
  "/api/video-assets", "/api/video-tasks/by-key/request_abcdefgh", "/api/tools/sower-work/lease",
  "/api/tools/sower-work/lease/verify", "/api/admin/sower-work/users",
  "/api/managed-users/user_a/sower-work-access"
])("lets exact existing handlers apply their own signed credentials and Origin: %s", async path => {
  const response = await middleware(req(path, "POST", { origin: "chrome-extension://existing-client", "x-sanjie-session": "extension-token" }));
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.rate).not.toHaveBeenCalled();
});
it("preserves body-lease verification and signed source URLs without a cookie", async () => {
  expect((await middleware(req("/api/tools/sower-work/lease/verify", "POST"))).headers.get("x-middleware-next")).toBe("1");
  expect((await middleware(req("/api/video-assets/source/" + "a".repeat(32) + "?expires=123&signature=example"))).headers.get("x-middleware-next")).toBe("1");
});
it.each(["/api/tools/sower-work/access", "/api/tools/sower-work/lease/verify", "/api/video-assets"])("keeps handler OPTIONS/CORS preflight %s", async path => {
  expect((await middleware(req(path, "OPTIONS", { origin: "chrome-extension://existing-client" }))).headers.get("x-middleware-next")).toBe("1");
});
it.each(["/api/video-assets/asset_abcdefgh/extra", "/api/tools/sower-work/lease/verify/extra", "/api/admin/sower-work/users/extra"])("does not bypass auth/CSRF for similar path %s", async path => {
  expect((await middleware(req(path))).status).toBe(401);
  expect((await middleware(req(path, "POST", { origin: "https://evil.example" }))).status).toBe(403);
});
it.each(["/v1/images/generations", "/api/v1/images/generations"])("preserves independent model API key authentication: %s", async path => {
  expect((await middleware(req(path, "POST", { origin: "https://external-client.example", authorization: "Bearer model-key" }))).headers.get("x-middleware-next")).toBe("1");
  expect(mocks.session).not.toHaveBeenCalled();
});
it.each([
  "/api/tools/updates/ai-automation/latest", PUBLIC_AI_DOWNLOAD_PATHS[0],
  "/api/tools/sower-work/lease/verify", "/api/video-assets", "/api/v1/models"
])("still confines declared AI to unified channel even on compatibility path %s", async path => {
  expect((await middleware(req(path, "GET", { authorization: "Bearer sja_test" }))).status).toBe(403);
  expect((await middleware(req(path, "GET", { "x-sanjie-ai-client": "Codex" }))).status).toBe(403);
});
it("keeps private source denial and protected archive rewrite intact", async () => {
  expect((await middleware(req("/_next/static/private.js.map"))).status).toBe(404);
  mocks.session.mockResolvedValue({ username: "user", role: "tenant", tenantId: "tenant" });
  expect((await middleware(req("/downloads/historical.zip"))).headers.get("x-middleware-rewrite")).toBe("https://shaozhuangai.com/api/protected-downloads/historical.zip");
  expect(mocks.rate).toHaveBeenCalledWith("web-pages", "stable-account", 120, 60);
});

it.each([
  ["/dashboards/operating-network", "/dashboards/operating-network"],
  ["/dashboards/operating-network?batch=1&surface=viral-style", "/dashboards/operating-network?surface=viral-style&batch=1"],
  ["/dashboards/operating-network/video", "/dashboards/operating-network/video"]
])("preserves actual production creative login return: %s", async (path, expectedReturn) => {
  const response = await middleware(req(path));
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get("location")!);
  expect(location.origin).toBe("https://shaozhuangai.com");
  expect(location.pathname).toBe("/login");
  expect([...location.searchParams]).toEqual([["returnTo", expectedReturn]]);
});
it.each([
  "/dashboards/operating-network?surface=viral&token=private-token",
  "/dashboards/operating-network?returnTo=https%3A%2F%2Fevil.test&apiKey=private-key",
  "/dashboards/operating-network?surface=viral&surface=main",
  "/dashboards/operating-network/video?token=private-token"
])("clears unapproved creative query from production login redirect: %s", async path => {
  const response = await middleware(req(path));
  expect(response.headers.get("location")).toBe("https://shaozhuangai.com/login");
});

it.each(["Codex", "Cursor", "Claude Code", "unknown-ai", ""])("confines every explicit AI declaration, including %j, to the same channel", async client => {
  for (const path of ["/api/shops", "/api/tools/updates/ai-automation/latest", PUBLIC_AI_DOWNLOAD_PATHS[0], "/api/video-assets", "/api/v1/models"]) {
    const response = await middleware(req(path, "GET", { "x-sanjie-ai-client": client }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "AI 访问必须使用管理账号授权通道", code: "AI_CHANNEL_REQUIRED" });
  }
  expect((await middleware(req("/api/ai-access/execute", "GET", { "x-sanjie-ai-client": client }))).headers.get("x-middleware-next")).toBe("1");
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.active).not.toHaveBeenCalled();
  expect(mocks.rate).not.toHaveBeenCalled();
});

it.each(["Codex", "Cursor", "Claude Code", "unknown-client", ""])("keeps existing browser authentication for undeclared User-Agent %j", async userAgent => {
  const headers = { "user-agent": userAgent };
  expect((await middleware(req("/api/shops", "GET", headers))).status).toBe(401);
  expect((await middleware(req("/login", "GET", headers))).headers.get("x-middleware-next")).toBe("1");
  expect((await middleware(req("/api/tools/updates/ai-automation/latest", "GET", headers))).headers.get("x-middleware-next")).toBe("1");
  mocks.session.mockResolvedValue({ username: "user", role: "tenant", tenantId: "tenant" });
  const response = await middleware(req("/creative/labs/image-prompt-lab/promptlab.html?mode=main&source=web&studio=1", "GET", { ...headers, cookie: "session=existing-browser-session" }));
  expect(response.headers.get("x-middleware-rewrite")).toBe("https://shaozhuangai.com/api/creative/assets/labs/image-prompt-lab/promptlab.html?mode=main&source=web&studio=1");
  expect(mocks.active).toHaveBeenCalledTimes(1);
  expect(mocks.rate).toHaveBeenCalledWith("web-assets", "stable-account", 300, 60);
});
