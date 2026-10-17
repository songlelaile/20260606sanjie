import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  parseSession: vi.fn(), userFindUnique: vi.fn(), userFindMany: vi.fn(),
  upsert: vi.fn(), transaction: vi.fn(), readFile: vi.fn()
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "sanjie_session", parseSession: mocks.parseSession,
  ROLE_HOME: { admin: "/dashboards", tenant: "/dashboards" }, canAccess: () => false
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, findMany: mocks.userFindMany },
    toolEntitlement: { upsert: mocks.upsert }, $transaction: mocks.transaction
  }
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));

import { GET as access } from "@/app/api/tools/sower-work/access/route";
import { POST as issue } from "@/app/api/tools/sower-work/lease/route";
import { POST as verify } from "@/app/api/tools/sower-work/lease/verify/route";
import { GET as download } from "@/app/api/tools/sower-work/download/route";
import { GET as update } from "@/app/api/tools/sower-work/update/route";
import { GET as list } from "@/app/api/admin/sower-work/users/route";
import { PATCH as grant } from "@/app/api/managed-users/[id]/sower-work-access/route";
import { issueSowerWorkLease } from "./sower-work-lease";
import { loadSowerWorkSessionAccess, setSowerWorkEntitlement } from "./sower-work-entitlements";
import { SOWER_WORK_EXTENSION_ID, SOWER_WORK_ORIGIN, SOWER_WORK_PRODUCT_ID } from "./sower-work-product";
import { sowerWorkOptions } from "./sower-work-http";
import { middleware } from "@/middleware";

const now = new Date("2026-09-24T08:00:00.000Z");
const session = { username: "13800000000", name: "测试用户", tenantId: "tenant-a", role: "tenant" as const };
const admin = { username: "admin", name: "管理员", tenantId: "tenant-root", role: "admin" as const };
type UserRecord = { id: string; username: string; name: string; tenantId: string; authRole: string; status: string };
type GrantRecord = { status: string; grantedAt: Date; expiresAt: Date | null; note: string };
let users: UserRecord[];
let grants: Map<string, GrantRecord>;
const binding = {
  productId: SOWER_WORK_PRODUCT_ID, extensionId: SOWER_WORK_EXTENSION_ID, releaseVersion: "1.9.76",
  clientId: "client_12345678901234567890", runId: "d144c3df-681b-4a0f-9103-ae6caa003d40", challenge: "a".repeat(64)
} as const;
const freshGrant = (): GrantRecord => ({
  status: "active", grantedAt: now, expiresAt: new Date(now.getTime() + 30 * 86400000),
  note: "SOWER_COLLECTOR_GRANT_V1:initial"
});
function request(route: string, token: string | null = "user-token", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(SOWER_WORK_ORIGIN + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { "x-sanjie-session": token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}
async function performGrant(enabled: boolean, token = "admin-token", extra: Record<string, unknown> = {}, userId = "user-a") {
  return grant(request("/api/managed-users/" + userId + "/sower-work-access", token, { enabled, ...extra }), {
    params: Promise.resolve({ id: userId })
  });
}
async function obtainLease() {
  const response = await issue(request("/api/tools/sower-work/lease", "user-token", binding));
  expect(response.status).toBe(200);
  return (await response.json()).data.lease as string;
}
async function verifyLease(lease: string, changed: Record<string, unknown> = {}) {
  return verify(request("/api/tools/sower-work/lease/verify", null, { ...binding, ...changed, lease }));
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubEnv("SESSION_SECRET", "isolated-test-secret-".repeat(4));
  vi.clearAllMocks();
  users = [
    { id: "user-a", username: session.username, name: session.name, tenantId: session.tenantId, authRole: "tenant", status: "active" },
    { id: "admin-a", username: admin.username, name: admin.name, tenantId: admin.tenantId, authRole: "admin", status: "active" }
  ];
  grants = new Map();
  mocks.parseSession.mockImplementation(async token => token === "user-token" ? session : token === "admin-token" ? admin : null);
  mocks.userFindUnique.mockImplementation(async args => {
    const user = users.find(item => args.where.id ? item.id === args.where.id : item.username === args.where.username);
    if (!user) return null;
    const toolCode = args.select?.toolEntitlements?.where?.toolCode;
    const record = toolCode ? grants.get(user.id + ":" + toolCode) : null;
    return { ...user, toolEntitlements: record ? [record] : [] };
  });
  mocks.userFindMany.mockImplementation(async args => users.map(user => ({
    ...user, toolEntitlements: grants.has(user.id + ":" + args.select.toolEntitlements.where.toolCode)
      ? [grants.get(user.id + ":" + args.select.toolEntitlements.where.toolCode)] : []
  })));
  mocks.upsert.mockImplementation(async args => {
    const key = args.where.userId_toolCode.userId + ":" + args.where.userId_toolCode.toolCode;
    const previous = grants.get(key);
    const row = previous ? { ...previous, ...args.update } : args.create;
    grants.set(key, row);
    return row;
  });
  mocks.transaction.mockImplementation(async callback => callback({
    user: { findUnique: mocks.userFindUnique },
    toolEntitlement: { upsert: mocks.upsert }
  }));
  mocks.readFile.mockResolvedValue(Buffer.from("PK\x03\x04isolated-test-zip"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Sower Work independent entitlement", () => {
  it("rejects anonymous reads and never reads a package first", async () => {
    for (const handler of [access, download, update]) {
      expect((await handler(request("/api/tools/sower-work/access", null))).status).toBe(401);
    }
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
  it("reports login separately and does not inherit DMP, desktop SSO, invite or wallet purchase", async () => {
    grants.set("user-a:dmp-automation", freshGrant());
    grants.set("user-a:sower-work", freshGrant());
    grants.set("user-a:subscription", freshGrant());
    const response = await access(request("/api/tools/sower-work/access"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      productId: "sower-work-collector", authorized: false,
      entitlement: { status: "not_granted", allowed: false }
    });
    expect((await issue(request("/api/tools/sower-work/lease", "user-token", binding))).status).toBe(403);
    expect(mocks.userFindUnique.mock.calls[0][0].select.toolEntitlements.where).toEqual({ toolCode: "sower-work-collector" });
  });
  it("requires admins to have their own explicit usage grant", async () => {
    const response = await access(request("/api/tools/sower-work/access", "admin-token"));
    expect((await response.json()).data.authorized).toBe(false);
    expect((await download(request("/api/tools/sower-work/download", "admin-token"))).status).toBe(403);
  });
  it.each(["disabled", "deleted", "tenant-moved", "role-changed"])("invalidates the current session after %s", async change => {
    grants.set("user-a:" + SOWER_WORK_PRODUCT_ID, freshGrant());
    if (change === "disabled") users[0].status = "disabled";
    if (change === "deleted") users.shift();
    if (change === "tenant-moved") users[0].tenantId = "tenant-other";
    if (change === "role-changed") users[0].authRole = "admin";
    expect((await access(request("/api/tools/sower-work/access"))).status).toBe(401);
    expect((await download(request("/api/tools/sower-work/download"))).status).toBe(401);
  });
  it.each(["revoked", "expired", "null-expiry"])("denies %s entitlement", async state => {
    const record = freshGrant();
    if (state === "revoked") record.status = "revoked";
    if (state === "expired") record.expiresAt = now;
    if (state === "null-expiry") record.expiresAt = null;
    grants.set("user-a:" + SOWER_WORK_PRODUCT_ID, record);
    expect((await issue(request("/api/tools/sower-work/lease", "user-token", binding))).status).toBe(403);
    expect((await update(request("/api/tools/sower-work/update"))).status).toBe(403);
  });
  it("uses real bytes for private ZIP and update hash, then rejects a revoked user", async () => {
    grants.set("user-a:" + SOWER_WORK_PRODUCT_ID, freshGrant());
    const zip = await download(request("/api/tools/sower-work/download"));
    expect(zip.status).toBe(200);
    expect(zip.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await zip.arrayBuffer());
    const manifest = await update(request("/api/tools/sower-work/update"));
    expect((await manifest.json()).data).toMatchObject({
      productId: SOWER_WORK_PRODUCT_ID, version: "1.9.76", protocolVersion: 1,
      extensionId: SOWER_WORK_EXTENSION_ID, downloadUrl: "/api/tools/sower-work/download",
      sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length
    });
    expect(mocks.readFile.mock.calls[0][0]).toMatch(/private-assets\/sower-work\/sower-work-collector-v1\.9\.76\.zip$/);
    const count = mocks.readFile.mock.calls.length;
    await performGrant(false);
    expect((await download(request("/api/tools/sower-work/download"))).status).toBe(403);
    expect((await update(request("/api/tools/sower-work/update"))).status).toBe(403);
    expect(mocks.readFile).toHaveBeenCalledTimes(count);
  });
  it("returns an unavailable response without private filesystem details", async () => {
    grants.set("user-a:" + SOWER_WORK_PRODUCT_ID, freshGrant());
    mocks.readFile.mockRejectedValueOnce(new Error("secret/path/ENOENT"));
    const response = await download(request("/api/tools/sower-work/download"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret/path");
  });
});

describe("current database admin is the only grant authority", () => {
  it("grants and renews 30 days from server time with server-derived actor and rotated revision", async () => {
    expect((await performGrant(true)).status).toBe(200);
    let record = grants.get("user-a:" + SOWER_WORK_PRODUCT_ID)!;
    expect(record.expiresAt!.getTime() - record.grantedAt.getTime()).toBe(30 * 86400000);
    const firstRevision = record.note;
    expect(mocks.upsert.mock.calls[0][0].create.grantedBy).toBe("admin-a:admin");
    vi.setSystemTime(new Date(now.getTime() + 86400000));
    expect((await performGrant(true)).status).toBe(200);
    record = grants.get("user-a:" + SOWER_WORK_PRODUCT_ID)!;
    expect(record.grantedAt.getTime()).toBe(now.getTime() + 86400000);
    expect(record.note).not.toBe(firstRevision);
    expect((await performGrant(false)).status).toBe(200);
    expect(grants.get("user-a:" + SOWER_WORK_PRODUCT_ID)!.status).toBe("revoked");
  });
  it("rejects ordinary and tenant owner accounts at route and service boundaries", async () => {
    expect((await performGrant(true, "user-token")).status).toBe(403);
    await expect(setSowerWorkEntitlement(session, { userId: "user-a", enabled: true })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it.each(["disabled", "demoted", "deleted", "moved"])("rejects an old admin cookie after %s", async state => {
    if (state === "disabled") users[1].status = "disabled";
    if (state === "demoted") users[1].authRole = "tenant";
    if (state === "deleted") users.pop();
    if (state === "moved") users[1].tenantId = "other-tenant";
    expect((await performGrant(true)).status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("rejects client-supplied product, actor, duration and malformed target ids", async () => {
    for (const extra of [{ productId: "dmp-automation" }, { grantedBy: "admin" }, { expiresAt: "2099-01-01" }]) {
      expect((await performGrant(true, "admin-token", extra)).status).toBe(400);
    }
    expect((await performGrant(true, "admin-token", {}, "../user-a")).status).toBe(400);
    expect((await performGrant(true, "admin-token", {}, "missing")).status).toBe(404);
    users[0].status = "disabled";
    expect((await performGrant(true)).status).toBe(409);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("protects account listing and limits query boundaries", async () => {
    expect((await list(request("/api/admin/sower-work/users"))).status).toBe(403);
    expect(mocks.userFindMany).not.toHaveBeenCalled();
    expect((await list(request("/api/admin/sower-work/users?page=0", "admin-token"))).status).toBe(400);
    expect((await list(request("/api/admin/sower-work/users?unknown=1", "admin-token"))).status).toBe(400);
    const result = await list(request("/api/admin/sower-work/users", "admin-token"));
    expect(result.status).toBe(200);
    expect((await result.json()).data.users[0]).not.toHaveProperty("password");
  });
});

describe("short opaque lease with live revocation and strict binding", () => {
  beforeEach(() => { grants.set("user-a:" + SOWER_WORK_PRODUCT_ID, freshGrant()); });
  it("verifies without a website cookie and permits multiple packets only in the same binding", async () => {
    const lease = await obtainLease();
    for (let index = 0; index < 2; index++) {
      const response = await verifyLease(lease);
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({
        authorized: true, accountKey: "user:13800000000", account: { id: "user-a", tenantId: "tenant-a" }, ...binding
      });
    }
    expect(mocks.userFindUnique).toHaveBeenCalledTimes(3);
    expect(mocks.parseSession).toHaveBeenCalledTimes(1);
  });
  it.each([
    { productId: "sower-work" }, { extensionId: "a".repeat(32) }, { releaseVersion: "1.9.75" },
    { clientId: "other_client_12345678" }, { runId: "d144c3df-681b-4a0f-9103-ae6caa003d41" }, { challenge: "b".repeat(64) }
  ])("rejects cross-binding replay %j", async changed => {
    const lease = await obtainLease();
    const response = await verifyLease(lease, changed);
    expect([400, 403]).toContain(response.status);
  });
  it("rejects forged payloads and signatures before a database lookup", async () => {
    const lease = await obtainLease();
    const parts = lease.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    payload.account.id = "admin-a";
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const calls = mocks.userFindUnique.mock.calls.length;
    expect((await verifyLease(parts.join("."))).status).toBe(401);
    expect((await verifyLease(lease.slice(0, -10) + "a".repeat(10))).status).toBe(401);
    expect(mocks.userFindUnique).toHaveBeenCalledTimes(calls);
  });
  it("expires at 120 seconds and cannot outlive entitlement expiry", async () => {
    const lease = await obtainLease();
    vi.setSystemTime(new Date(now.getTime() + 120000));
    expect((await verifyLease(lease)).status).toBe(401);
    vi.setSystemTime(now);
    grants.get("user-a:" + SOWER_WORK_PRODUCT_ID)!.expiresAt = new Date(now.getTime() + 30000);
    const response = await issue(request("/api/tools/sower-work/lease", "user-token", binding));
    expect((await response.json()).data.expiresAt).toBe(new Date(now.getTime() + 30000).toISOString());
  });
  it("rejects future-issued leases", async () => {
    const loaded = await loadSowerWorkSessionAccess(session);
    const { lease } = issueSowerWorkLease(binding, loaded, now.getTime() + 1000);
    expect((await verifyLease(lease)).status).toBe(401);
  });
  it("blocks revoked leases immediately and cannot revive them by granting again", async () => {
    const lease = await obtainLease();
    await performGrant(false);
    expect((await verifyLease(lease)).status).toBe(403);
    await performGrant(true);
    const response = await verifyLease(lease);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("LEASE_GRANT_CHANGED");
    expect((await verifyLease(await obtainLease())).status).toBe(200);
  });
  it.each(["disabled", "deleted", "renamed", "tenant-moved"])("rechecks %s account state for every lease use", async change => {
    const lease = await obtainLease();
    if (change === "disabled") users[0].status = "disabled";
    if (change === "deleted") users.shift();
    if (change === "renamed") users[0].username = "13900000000";
    if (change === "tenant-moved") users[0].tenantId = "tenant-b";
    expect([401, 403]).toContain((await verifyLease(lease)).status);
  });
  it("does not normalize an unsupported legacy archive account name", async () => {
    users[0].username = "中文历史账号";
    const loaded = await loadSowerWorkSessionAccess({ ...session, username: users[0].username });
    const { lease } = issueSowerWorkLease(binding, loaded);
    const response = await verifyLease(lease);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("ARCHIVE_ACCOUNT_UNSUPPORTED");
  });
  it("fails closed on signing secret absence, weak secret, rotation or database outage", async () => {
    const lease = await obtainLease();
    vi.stubEnv("SESSION_SECRET", "");
    expect((await issue(request("/api/tools/sower-work/lease", "user-token", binding))).status).toBe(503);
    expect((await verifyLease(lease)).status).toBe(503);
    vi.stubEnv("SESSION_SECRET", "sanjie-dev-insecure-secret-change-me");
    expect((await verifyLease(lease)).status).toBe(503);
    vi.stubEnv("SESSION_SECRET", "rotated-independent-secret-".repeat(4));
    expect((await verifyLease(lease)).status).toBe(401);
    vi.stubEnv("SESSION_SECRET", "isolated-test-secret-".repeat(4));
    mocks.userFindUnique.mockRejectedValueOnce(new Error("database detail not for client"));
    const response = await verifyLease(lease);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("database detail");
  });
  it("rejects unknown claim inputs and account/grant claims supplied by the caller", async () => {
    for (const fields of [{ account: { id: "admin-a" } }, { expiresAt: "2099-01-01" }, { protocolVersion: 1 }, { challenge: "a" }]) {
      expect((await issue(request("/api/tools/sower-work/lease", "user-token", { ...binding, ...fields }))).status).toBe(400);
    }
  });
});

describe("HTTP token, origin, size and cache boundaries", () => {
  it("lets only exact product endpoints perform their own authentication", async () => {
    const paths = [
      "/api/tools/sower-work/access", "/api/tools/sower-work/download", "/api/tools/sower-work/update",
      "/api/tools/sower-work/lease", "/api/tools/sower-work/lease/verify",
      "/api/admin/sower-work/users", "/api/managed-users/user-a/sower-work-access"
    ];
    for (const path of paths) {
      const response = await middleware(new NextRequest(SOWER_WORK_ORIGIN + path));
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
    expect(mocks.parseSession).not.toHaveBeenCalled();
    for (const path of ["/api/tools/sower-work/grant", "/api/tools/sower-work/lease/verify/extra",
      "/api/admin/sower-work/users/extra", "/api/managed-users/user-a/dmp-access"]) {
      expect((await middleware(new NextRequest(SOWER_WORK_ORIGIN + path))).status).toBe(401);
    }
  });
  it("publishes only safe release metadata on successful and denied product responses", async () => {
    for (const response of [
      await access(request("/api/tools/sower-work/access")),
      await access(request("/api/tools/sower-work/access", null)),
      await download(request("/api/tools/sower-work/download")),
      await list(request("/api/admin/sower-work/users", null))
    ]) {
      expect(response.headers.get("x-sower-product-id")).toBe("sower-work-collector");
      expect(response.headers.get("x-sower-release-version")).toBe("1.9.76");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
  it("supports once-encoded extension tokens and website cookies", async () => {
    const cases: Record<string, string>[] = [{ "x-sanjie-session": "%75ser-token" }, { cookie: "sanjie_session=%75ser-token" }];
    for (const headers of cases) {
      const response = await access(request("/api/tools/sower-work/access", null, undefined, headers));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
  it("rejects a bad explicit header rather than falling back to an admin cookie", async () => {
    const response = await access(request("/api/tools/sower-work/access", "bad-token", undefined, { cookie: "sanjie_session=admin-token" }));
    expect(response.status).toBe(401);
  });
  it("allows only the independent extension CORS origin", async () => {
    const own = sowerWorkOptions(request("/api/tools/sower-work/access", null, undefined, { origin: "chrome-extension://" + SOWER_WORK_EXTENSION_ID }));
    expect(own.status).toBe(204);
    expect(own.headers.get("access-control-allow-origin")).toBe("chrome-extension://" + SOWER_WORK_EXTENSION_ID);
    const other = sowerWorkOptions(request("/api/tools/sower-work/access", null, undefined, { origin: "chrome-extension://" + "a".repeat(32) }));
    expect(other.status).toBe(403);
  });
  it("blocks cross-origin or originless ambient-cookie grant requests", async () => {
    for (const origin of ["https://evil.example", ""]) {
      const response = await grant(request("/api/managed-users/user-a/sower-work-access", null, { enabled: true }, {
        cookie: "sanjie_session=admin-token", ...(origin ? { origin } : {})
      }), { params: Promise.resolve({ id: "user-a" }) });
      expect(response.status).toBe(403);
    }
    expect(mocks.upsert).not.toHaveBeenCalled();
    const allowed = await grant(request("/api/managed-users/user-a/sower-work-access", null, { enabled: true }, {
      cookie: "sanjie_session=admin-token", origin: SOWER_WORK_ORIGIN
    }), { params: Promise.resolve({ id: "user-a" }) });
    expect(allowed.status).toBe(200);
  });
  it("limits the actual body even without Content-Length", async () => {
    const response = await verify(request("/api/tools/sower-work/lease/verify", null, { ...binding, lease: "x".repeat(9000) }));
    expect(response.status).toBe(413);
    expect(mocks.userFindUnique).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON, wrong content type and oversized declared lengths", async () => {
    const url = SOWER_WORK_ORIGIN + "/api/tools/sower-work/lease/verify";
    expect((await verify(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).status).toBe(400);
    expect((await verify(new Request(url, { method: "POST", body: "{}" }))).status).toBe(415);
    expect((await verify(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "99999" }, body: "{}" }))).status).toBe(413);
  });
});
