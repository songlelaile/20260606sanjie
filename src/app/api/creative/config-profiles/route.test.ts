import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), get: vi.fn(), resolve: vi.fn(), put: vi.fn(), unlink: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/creative-config-profile-store", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/creative-config-profile-store")>(),
  getCreativeConfigProfiles: mocks.get, resolveCreativeConfigProfile: mocks.resolve,
  putCreativeConfigProfile: mocks.put, unlinkCreativeConfigProfile: mocks.unlink
}));
import { GET, POST, PUT, DELETE } from "./route";
import { creativeConfigOwnerFingerprint } from "@/lib/creative-config-profile-store";

const alice = { id: "immutable-alice", tenantId: "tenant-a", username: "alice", status: "active" };
const accountKey = "user:tenant-a:alice";
const ownerFingerprint = creativeConfigOwnerFingerprint(alice);
function request(method: string, input?: unknown, headers: Record<string, string> = {}) {
  return new Request("https://studio.example.test/api/creative/config-profiles", { method,
    headers: { Origin: "https://studio.example.test", "Content-Type": "application/json", ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
}
describe("account-owned image API profile routes", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.user.mockResolvedValue(alice);
    mocks.get.mockResolvedValue({ accountKey, ownerFingerprint, accountRevision: 0, profiles: [] });
    mocks.resolve.mockResolvedValue({ accountKey, ownerFingerprint, provider: "openai", config: { apiKey: "synthetic-own-key" } });
    mocks.put.mockResolvedValue({ accountKey, ownerFingerprint, accountRevision: 1, profiles: [] }); mocks.unlink.mockResolvedValue({ accountKey, ownerFingerprint, accountRevision: 2, profiles: [] });
  });

  it("GET returns metadata under the database-verified owner with no-store headers", async () => {
    const response = await GET(request("GET"));
    expect(response.status).toBe(200); expect(mocks.get).toHaveBeenCalledExactlyOnceWith({ id: alice.id, tenantId: alice.tenantId, username: alice.username });
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-own-key");
  });

  it.each(["resolve", "resolveAll"])("hydrates only the current owner for explicit %s", async operation => {
    const response = await POST(request("POST", { operation, accountKey, provider: "openai" }));
    expect(response.status).toBe(200);
    if (operation === "resolveAll") expect(mocks.get).toHaveBeenCalledExactlyOnceWith({ id: alice.id, tenantId: alice.tenantId, username: alice.username }, true);
    else expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({ id: alice.id, tenantId: alice.tenantId, username: alice.username }, "openai");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("passes provider CAS and selection-only CAS through without accepting client owner authority", async () => {
    const body = { accountKey, ownerFingerprint, provider: "openai", revision: 1, config: { apiKey: "" }, tenantId: "forged-tenant", userId: "forged-user" };
    expect((await PUT(request("PUT", body))).status).toBe(200);
    expect(mocks.put).toHaveBeenCalledWith({ id: alice.id, tenantId: alice.tenantId, username: alice.username }, body);
    const selection = { accountKey, ownerFingerprint, accountRevision: 2, selection: { activeProvider: "openai", activeSupplyChannel: "external_key" } };
    await PUT(request("PUT", selection)); expect(mocks.put).toHaveBeenLastCalledWith(expect.objectContaining({ id: alice.id }), selection);
    await DELETE(request("DELETE", { accountKey, ownerFingerprint, provider: "openai", revision: 1 }));
    expect(mocks.unlink).toHaveBeenCalledWith(expect.objectContaining({ id: alice.id }), { accountKey, ownerFingerprint, provider: "openai", revision: 1 });
  });

  it.each([PUT, DELETE])("rejects stale and absent immutable fingerprints even when account names and numeric revisions match", async handler => {
    const replacement = { ...alice, id: "immutable-replacement-alice" }, method = handler === PUT ? "PUT" : "DELETE";
    mocks.user.mockResolvedValue(replacement);
    for (const fingerprint of [ownerFingerprint, undefined]) {
      const response = await handler(request(method, { accountKey, ownerFingerprint: fingerprint, provider: "openai", revision: 0, config: { apiKey: "synthetic-stale-form-key" } }));
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "ACCOUNT_CHANGED" });
    }
    expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
    const current = creativeConfigOwnerFingerprint(replacement);
    expect((await handler(request(method, { accountKey, ownerFingerprint: current, provider: "openai", revision: 0, config: { apiKey: "synthetic-current-form-key" } }))).status).toBe(200);
    expect(handler === PUT ? mocks.put : mocks.unlink).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: replacement.id }), expect.objectContaining({ ownerFingerprint: current }));
  });

  it("bootstraps the current immutable fingerprint through metadata and explicit hydration without requiring a previous fingerprint", async () => {
    const replacement = { ...alice, id: "immutable-replacement-alice" }, current = creativeConfigOwnerFingerprint(replacement);
    mocks.user.mockResolvedValue(replacement); mocks.get.mockResolvedValue({ accountKey, ownerFingerprint: current, accountRevision: 0, profiles: [] });
    expect(await (await GET(request("GET"))).json()).toMatchObject({ data: { ownerFingerprint: current, profiles: [] } });
    expect(await (await POST(request("POST", { operation: "resolveAll", accountKey }))).json()).toMatchObject({ data: { ownerFingerprint: current, profiles: [] } });
    expect(mocks.get).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: replacement.id }));
    expect(mocks.get).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: replacement.id }), true);
  });

  it.each([POST, PUT, DELETE])("rejects a stale/foreign account before invoking any store operation", async handler => {
    const response = await handler(request(handler === POST ? "POST" : handler === PUT ? "PUT" : "DELETE", { operation: "resolveAll", accountKey: "user:tenant-b:bob" }));
    expect(response.status).toBe(409); expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it.each([GET, POST, PUT, DELETE])("does not read or mutate profiles for anonymous or temporarily unverifiable users", async handler => {
    const method = handler === GET ? "GET" : handler === POST ? "POST" : handler === PUT ? "PUT" : "DELETE";
    mocks.user.mockResolvedValueOnce(null);
    expect((await handler(request(method, method === "GET" ? undefined : { accountKey }))).status).toBe(401);
    mocks.user.mockRejectedValueOnce(new Error("synthetic private database credential must not escape"));
    const response = await handler(request(method, method === "GET" ? undefined : { accountKey }));
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("synthetic private");
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it.each([POST, PUT, DELETE])("requires same-origin intent for hydration and mutations", async handler => {
    const method = handler === POST ? "POST" : handler === PUT ? "PUT" : "DELETE";
    const forbiddenHeaders: Record<string, string>[] = [{ Origin: "https://other.example.test" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of forbiddenHeaders) {
      expect((await handler(request(method, { accountKey }, headers))).status).toBe(403);
    }
    const absent = new Request("https://studio.example.test/api/creative/config-profiles", { method, body: JSON.stringify({ accountKey }) });
    expect((await handler(absent)).status).toBe(403); expect(mocks.user).not.toHaveBeenCalled();
  });

  it("enforces the actual body limit before storage and rejects unsupported hydration operations", async () => {
    expect((await PUT(request("PUT", { accountKey, payload: "x".repeat(49 * 1024) }))).status).toBe(413);
    expect((await POST(request("POST", { accountKey, operation: "exportOtherAccount" }))).status).toBe(400);
    expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.get).not.toHaveBeenCalled();
  });
});
