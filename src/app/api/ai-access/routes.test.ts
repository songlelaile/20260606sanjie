import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AccessError extends Error {
    constructor(readonly code: string, message: string, readonly status = 503) { super(message); }
  }
  return { Error: AccessError, session: vi.fn(), user: vi.fn(), activeShop: vi.fn(),
    list: vi.fn(), create: vi.fn(), revoke: vi.fn(), toggle: vi.fn(), events: vi.fn(), authorize: vi.fn(), audit: vi.fn(),
    execute: vi.fn(), rate: vi.fn(), ip: vi.fn() };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/server-session", () => ({ getCurrentSession: mocks.session, getCurrentUser: mocks.user }));
vi.mock("@/lib/session-server", () => ({ getActiveShopCookie: mocks.activeShop }));
vi.mock("@/lib/ai-access", () => ({
  AIAccessError: mocks.Error, listAIAccessGrants: mocks.list, createAIAccessGrant: mocks.create,
  revokeAIAccessGrant: mocks.revoke, setAIAccessGrantEnabled: mocks.toggle, listAIAccessEvents: mocks.events,
  authorizeAIAccessToken: mocks.authorize, recordAIAccessEvent: mocks.audit
}));
vi.mock("@/lib/ai-access-operations", () => ({ executeAiAccessOperation: mocks.execute }));
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: mocks.rate }));
vi.mock("@/lib/security-client-ip", () => ({ trustedClientIp: mocks.ip }));
import { GET as listGrants, POST as createGrant } from "./grants/route";
import { DELETE as revokeGrant, PATCH as toggleGrant } from "./grants/[id]/route";
import { GET as listEvents } from "./events/route";
import { POST as execute } from "./execute/route";

const actor = { username: "admin-a", tenantId: "tenant-a", role: "admin", name: "Admin" };
const grantId = "3f5ecdbd-c75b-4bc3-93f2-9bc7886e53a0";
const token = `sja_${grantId}.${"a".repeat(43)}`;
const grant = { id: grantId, name: "Codex", scope: "read", activeShopId: "shop-a",
  createdAt: "2026-10-02T01:00:00.000Z", expiresAt: null, enabled: false, revokedAt: null, lastUsedAt: null };
const authorization = { grantId, userId: "user-a", username: "admin-a", tenantId: "tenant-a", scope: "action", activeShopId: "shop-a" };
const allowed = { allowed: true, remaining: 20, retryAfterSeconds: 0 };
const denied = { allowed: false, remaining: 0, retryAfterSeconds: 28, reason: "rate_limited" };
function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://site.test" + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body)
  });
}
const execution = (body: unknown = { method: "GET", path: "/api/auth/me" }, headers: Record<string, string> = { Authorization: `Bearer ${token}` }) =>
  execute(jsonRequest("/api/ai-access/execute", body, headers));
const toggling = (body: unknown = { enabled: true }, headers: Record<string, string> = {}) =>
  toggleGrant(new Request("https://site.test/api/ai-access/grants/" + grantId, {
    method: "PATCH", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body)
  }), { params: Promise.resolve({ id: grantId }) });
function privateHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}
const managers = [
  ["list", () => listGrants()],
  ["create", () => createGrant(jsonRequest("/api/ai-access/grants", { name: "Codex", scope: "read" }))],
  ["revoke", () => revokeGrant(new Request("https://site.test/api/ai-access/grants/" + grantId, { method: "DELETE" }), { params: Promise.resolve({ id: grantId }) })],
  ["events", () => listEvents()],
  ["enable", () => toggling({ enabled: true })],
  ["disable", () => toggling({ enabled: false })]
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(actor);
  mocks.user.mockResolvedValue({ status: "active", authRole: "admin" });
  mocks.activeShop.mockResolvedValue("shop-a");
  mocks.list.mockResolvedValue([grant]); mocks.create.mockResolvedValue({ grant, token });
  mocks.revoke.mockResolvedValue({ revoked: true });
  mocks.toggle.mockImplementation(async (_actor, _id, enabled) => ({ ...grant, enabled }));
  mocks.events.mockResolvedValue([{ id: "event-a", type: "request", grantName: "Codex", method: "GET", path: "/api/shops", status: 200, createdAt: "2026-10-02T01:00:00.000Z" }]);
  mocks.authorize.mockResolvedValue(authorization); mocks.audit.mockResolvedValue(undefined);
  mocks.execute.mockResolvedValue({ role: "admin", channel: "ai-access", scope: "action", activeShopId: "shop-a" });
  mocks.rate.mockResolvedValue(allowed);
  mocks.ip.mockReturnValue(null);
});

describe("AI grant management routes require a live administrator cookie", () => {
  it.each(managers)("denies anonymous %s before any grant service", async (_name, action) => {
    mocks.session.mockResolvedValue(null);
    const response = await action();
    expect(response.status).toBe(401); privateHeaders(response);
    for (const service of [mocks.list, mocks.create, mocks.revoke, mocks.toggle, mocks.events, mocks.authorize, mocks.rate]) expect(service).not.toHaveBeenCalled();
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it.each(managers)("denies disabled or demoted actors on %s", async (_name, action) => {
    mocks.user.mockResolvedValue({ status: "disabled", authRole: "admin" });
    const response = await action();
    expect(response.status).toBe(403);
    for (const service of [mocks.list, mocks.create, mocks.revoke, mocks.toggle, mocks.events, mocks.rate]) expect(service).not.toHaveBeenCalled();
  });

  it("a bearer alone cannot create management grants", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await createGrant(jsonRequest("/api/ai-access/grants", { scope: "action" }, { Authorization: `Bearer ${token}` }));
    expect(response.status).toBe(401); expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it("a bearer alone cannot change management controls", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await toggling({ enabled: true }, { Authorization: `Bearer ${token}` });
    expect(response.status).toBe(401); expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.toggle).not.toHaveBeenCalled();
  });

  it("returns a one-time token for a closed indefinite grant bound only to the server-read shop", async () => {
    const response = await createGrant(jsonRequest("/api/ai-access/grants", { name: "Codex", scope: "read" }));
    expect(response.status).toBe(201); privateHeaders(response);
    expect(mocks.create).toHaveBeenCalledWith(actor, { name: "Codex", scope: "read", activeShopId: "shop-a" });
    expect(await response.json()).toEqual({ data: { grant, token } });
    expect(mocks.rate).toHaveBeenCalledWith("ai-grant-create", JSON.stringify([actor.tenantId, actor.username]), 20, 3600);
  });

  it("list, revoke and audit endpoints return metadata without a token or account identity", async () => {
    const listed = await listGrants(); const history = await listEvents(); const toggled = await toggling();
    const revoked = await revokeGrant(new Request("https://site.test/api/ai-access/grants/" + grantId, { method: "DELETE" }), { params: Promise.resolve({ id: grantId }) });
    for (const response of [listed, history, revoked, toggled]) {
      expect(response.status).toBe(200); privateHeaders(response);
      expect(await response.text()).not.toMatch(/sja_|tokenHash|password|admin-a|tenant-a|user-a/);
    }
    expect(mocks.list).toHaveBeenCalledWith(actor); expect(mocks.events).toHaveBeenCalledWith(actor);
    expect(mocks.revoke).toHaveBeenCalledWith(actor, grantId);
  });

  it.each([
    null, [], { scope: "admin" }, { scope: "read", durationMinutes: "30" }, { scope: "read", durationMinutes: 1.5 },
    { scope: "read", durationMinutes: 30 }, { scope: "read", enabled: true }, { scope: "read", expiresAt: null },
    { scope: "read", name: 3 }, { scope: "read", tenantId: "foreign-tenant" }, { scope: "read", userId: "foreign-user" },
    { scope: "read", activeShopId: "foreign-shop" }, { scope: "read", token: "injected-token" }
  ])("rejects identity/shop injection and invalid creation envelopes: %j", async body => {
    const response = await createGrant(jsonRequest("/api/ai-access/grants", body));
    expect(response.status).toBe(400); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.activeShop).not.toHaveBeenCalled();
  });

  it("limits actual creation bytes despite a spoofed small content length", async () => {
    const response = await createGrant(new Request("https://site.test/api/ai-access/grants", {
      method: "POST", headers: { "Content-Length": "1" }, body: JSON.stringify({ scope: "read", name: "x".repeat(5000) })
    }));
    expect(response.status).toBe(413); expect(mocks.create).not.toHaveBeenCalled(); privateHeaders(response);
  });

  it.each([[denied, 429], [{ ...denied, reason: "unavailable" }, 503]])("closes grant creation when its quota is denied: %j", async (limit, status) => {
    mocks.rate.mockResolvedValue(limit);
    const response = await createGrant(jsonRequest("/api/ai-access/grants", { scope: "action" }));
    expect(response.status).toBe(status); expect(response.headers.get("Retry-After")).toBe("28");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.activeShop).not.toHaveBeenCalled(); privateHeaders(response);
  });

  it("does not reveal a foreign grant when revocation returns an ownership miss", async () => {
    mocks.revoke.mockRejectedValue(new mocks.Error("GRANT_NOT_FOUND", "授权不存在或不属于当前管理账号", 404));
    const response = await managers[2][1]();
    expect(response.status).toBe(404); expect(mocks.revoke).toHaveBeenCalledWith(actor, grantId);
    expect(await response.text()).not.toMatch(/sja_|password|user-a|tenant-a/);
  });

  it.each(managers)("fails closed on service/database failure in %s", async (name, action) => {
    const service = { list: mocks.list, create: mocks.create, revoke: mocks.revoke, events: mocks.events, enable: mocks.toggle, disable: mocks.toggle }[name];
    service.mockRejectedValue(new Error("postgres://private-secret"));
    const response = await action();
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-secret"); privateHeaders(response);
  });

  it.each([true, false])("manually sets enabled=%s without returning a replacement token", async enabled => {
    const response = await toggling({ enabled });
    expect(response.status).toBe(200); privateHeaders(response);
    expect(await response.json()).toEqual({ data: { grant: { ...grant, enabled } } });
    expect(mocks.toggle).toHaveBeenCalledWith(actor, grantId, enabled);
    expect(mocks.rate).toHaveBeenCalledWith("ai-grant-toggle", JSON.stringify([actor.tenantId, actor.username]), 60, 60);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { enabled: "true" }, { enabled: 1 }, { enabled: null },
    { enabled: true, scope: "action" }, { enabled: false, durationMinutes: 30 },
    { enabled: true, tenantId: "foreign-tenant" }, { enabled: true, activeShopId: "shop-b" },
    { enabled: true, token }, { disabled: true }])("rejects toggle injection or non-boolean envelopes: %j", async body => {
    const response = await toggling(body);
    expect(response.status).toBe(400); expect(mocks.toggle).not.toHaveBeenCalled();
  });

  it("limits toggle bytes independently of a spoofed content length", async () => {
    const response = await toggleGrant(new Request("https://site.test/api/ai-access/grants/" + grantId, {
      method: "PATCH", headers: { "Content-Length": "1" }, body: JSON.stringify({ enabled: true, name: "x".repeat(1100) })
    }), { params: Promise.resolve({ id: grantId }) });
    expect(response.status).toBe(413); expect(mocks.toggle).not.toHaveBeenCalled(); privateHeaders(response);
  });

  it("rejects malformed toggle JSON safely", async () => {
    const response = await toggleGrant(new Request("https://site.test/api/ai-access/grants/" + grantId, {
      method: "PATCH", body: "{"
    }), { params: Promise.resolve({ id: grantId }) });
    expect(response.status).toBe(400); expect(mocks.toggle).not.toHaveBeenCalled();
  });

  it.each([[denied, 429], [{ ...denied, reason: "unavailable" }, 503]])("does not change controls when toggle quota closes: %j", async (limit, status) => {
    mocks.rate.mockResolvedValue(limit);
    const response = await toggling();
    expect(response.status).toBe(status); expect(response.headers.get("Retry-After")).toBe("28");
    expect(mocks.toggle).not.toHaveBeenCalled(); privateHeaders(response);
  });

  it("retains the safe non-controllable status for legacy, foreign or permanent grants", async () => {
    mocks.toggle.mockRejectedValue(new mocks.Error("GRANT_NOT_CONTROLLABLE", "通道不可开启", 409));
    const response = await toggling();
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "通道不可开启", code: "GRANT_NOT_CONTROLLABLE" });
  });
});

describe("explicit bearer AI execution", () => {
  it.each(["", "Basic admin-password", "Bearer malformed", token])("never uses a cookie as a replacement for malformed bearer %s", async header => {
    const response = await execution(undefined, { Authorization: header, Cookie: "signed-admin-session" } as Record<string, string>);
    expect(response.status).toBe(401); expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled(); privateHeaders(response);
  });

  it.each(["invalid", "legacy expired", "closed manual", "revoked", "downgraded"])("does not execute when authorization rejects a %s token", async () => {
    mocks.authorize.mockResolvedValue(null);
    const response = await execution();
    expect(response.status).toBe(401); expect(mocks.authorize).toHaveBeenCalledWith(token, "read");
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("read scope rejects actions, charges its account quota, and audits only safe metadata", async () => {
    mocks.authorize.mockResolvedValue({ ...authorization, scope: "read" });
    const response = await execution({ method: "PATCH", path: "/api/shops/active", body: { shopId: "shop-b" } });
    expect(response.status).toBe(403); expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.rate).toHaveBeenCalledWith("ai-channel-execute", JSON.stringify([authorization.tenantId, authorization.userId]), 60, 60);
    expect(mocks.audit).toHaveBeenCalledWith({ ...authorization, scope: "read" }, { method: "PATCH", path: "/api/shops/active", status: 403 });
  });

  it.each([1, 2, 3])("rate stage %s prevents dispatch before any operation or request audit", async stage => {
    mocks.rate.mockReset();
    for (let i = 1; i < stage; i += 1) mocks.rate.mockResolvedValueOnce(allowed);
    mocks.rate.mockResolvedValueOnce(denied);
    const response = await execution({ method: "PATCH", path: "/api/shops/active", body: { shopId: "shop-b" } });
    expect(response.status).toBe(429); expect(response.headers.get("Retry-After")).toBe("28");
    expect(mocks.rate).toHaveBeenCalledTimes(stage);
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
    if (stage < 3) expect(mocks.authorize).not.toHaveBeenCalled();
    else expect(mocks.authorize).toHaveBeenCalledOnce();
    privateHeaders(response);
  });

  it.each([1, 2, 3])("unavailable rate stage %s fails closed with 503 before dispatch", async stage => {
    mocks.rate.mockReset();
    for (let i = 1; i < stage; i += 1) mocks.rate.mockResolvedValueOnce(allowed);
    mocks.rate.mockResolvedValueOnce({ ...denied, reason: "unavailable" });
    const response = await execution();
    expect(response.status).toBe(503); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.rate).toHaveBeenCalledTimes(stage); privateHeaders(response);
  });

  it("an exhausted read-token account budget closes action denials before writing another audit", async () => {
    mocks.authorize.mockResolvedValue({ ...authorization, scope: "read" });
    mocks.rate.mockResolvedValueOnce(allowed).mockResolvedValueOnce(allowed).mockResolvedValueOnce(denied);
    const response = await execution({ method: "PATCH", path: "/api/shops/active", body: { shopId: "shop-b" } });
    expect(response.status).toBe(429); expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("bounds unknown clients separately and uses a trusted IP only when resolved by the IP helper", async () => {
    expect((await execution()).status).toBe(200);
    expect(mocks.rate).toHaveBeenNthCalledWith(1, "ai-channel-unknown-attempt", "unknown-client", 600, 60);
    mocks.rate.mockClear(); mocks.ip.mockReturnValue("198.51.100.9");
    expect((await execution()).status).toBe(200);
    expect(mocks.rate).toHaveBeenNthCalledWith(1, "ai-channel-ip-attempt", "198.51.100.9", 120, 60);
  });

  it("catalog denial never authorizes paid generation, payment, sharing or deletion", async () => {
    for (const [method, path] of [["POST", "/api/v1/images/generations"], ["POST", "/api/model-gateway/orders"], ["POST", "/api/dmp-report-shares"], ["DELETE", "/api/managed-users/user-a"]]) {
      const response = await execution({ method, path });
      expect(response.status).toBe(403);
    }
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("strips report query identifiers from both pre-action and result audit metadata", async () => {
    const response = await execution({ method: "GET", path: "/api/dmp-reports?id=sja_report_secret" });
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ action: "dmp.report.read", query: { id: "sja_report_secret" } }), authorization);
    expect(mocks.audit.mock.calls.map(call => call[1])).toEqual([
      { method: "GET", path: "/api/dmp-reports" }, { method: "GET", path: "/api/dmp-reports", status: 200 }
    ]);
    expect(JSON.stringify(mocks.audit.mock.calls.map(call => call[1]))).not.toMatch(/secret|\?|sja_|token/);
  });

  it("rejects query token smuggling before any authorization or action", async () => {
    const response = await execution({ method: "GET", path: "/api/dmp-reports?token=leaked-token" });
    expect(response.status).toBe(400); expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("bounds actual execution body bytes independently of content length", async () => {
    const response = await execute(new Request("https://site.test/api/ai-access/execute", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Length": "1" }, body: "x".repeat(9000)
    }));
    expect(response.status).toBe(413); expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("pre-action audit failure prevents the direct operation", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("private-audit-database"));
    const response = await execution({ method: "PATCH", path: "/api/shops/active", body: { shopId: "shop-b" } });
    expect(response.status).toBe(503); expect(mocks.execute).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("private-audit-database");
  });

  it("a scope-denial audit failure cannot permit or execute the action", async () => {
    mocks.authorize.mockResolvedValue({ ...authorization, scope: "read" });
    mocks.audit.mockRejectedValueOnce(new Error("private-denial-audit"));
    const response = await execution({ method: "PATCH", path: "/api/shops/active", body: { shopId: "shop-b" } });
    expect(response.status).toBe(503); expect(mocks.execute).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("private-denial-audit");
  });

  it("authorization persistence failure prevents quota-dependent dispatch", async () => {
    mocks.authorize.mockRejectedValueOnce(new Error("private-authorize-audit"));
    const response = await execution();
    expect(response.status).toBe(503); expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("private-authorize-audit");
  });

  it("retains safe service status and audits failures after a reviewed operation throws", async () => {
    mocks.execute.mockRejectedValueOnce(new mocks.Error("REPORT_NOT_FOUND", "报告不存在", 404));
    const response = await execution({ method: "GET", path: "/api/dmp-reports?id=missing-report" });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "报告不存在", code: "REPORT_NOT_FOUND" });
    expect(mocks.audit).toHaveBeenLastCalledWith(authorization, { method: "GET", path: "/api/dmp-reports", status: 404 });
  });

  it("does not leak arbitrary direct-service errors through the execute response", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("provider-key=private-key"));
    const response = await execution();
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-key");
    expect(mocks.audit).toHaveBeenLastCalledWith(authorization, { method: "GET", path: "/api/auth/me", status: 503 });
  });

  it("stores a hashed token quota identity instead of the bearer credential", async () => {
    const response = await execution();
    expect(response.status).toBe(200);
    const identities = mocks.rate.mock.calls.map(call => call[1]);
    expect(identities).not.toContain(token);
    expect(JSON.stringify(identities)).not.toContain(token);
    const digest = createHash("sha256").update(token).digest("hex");
    expect(mocks.rate).toHaveBeenNthCalledWith(2, "ai-channel-token-attempt", digest, 90, 60);
    expect(await response.text()).not.toContain(digest);
    const order = [mocks.rate.mock.invocationCallOrder[0], mocks.rate.mock.invocationCallOrder[1],
      mocks.authorize.mock.invocationCallOrder[0], mocks.rate.mock.invocationCallOrder[2],
      mocks.audit.mock.invocationCallOrder[0], mocks.execute.mock.invocationCallOrder[0], mocks.audit.mock.invocationCallOrder[1]];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
