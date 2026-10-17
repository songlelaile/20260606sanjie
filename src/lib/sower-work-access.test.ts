import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  parseSession: vi.fn(),
  findUnique: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "sanjie_session", parseSession: mocks.parseSession }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));

import { getSowerWorkAccess, sowerWorkAccessResponse } from "./sower-work-access";

const SESSION = { username: "admin", name: "管理员", role: "admin", tenantId: "tenant-admin" };
const USER = {
  id: "user-admin", username: "admin", name: "管理员", status: "active",
  authRole: "admin", role: "operator", tenantId: "tenant-admin", password: "secret-never-forwarded"
};

describe("Sower Work live administrator authorization", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.cookies.mockResolvedValue({ get: () => ({ value: "signed-session" }) });
    mocks.parseSession.mockResolvedValue(SESSION);
    mocks.findUnique.mockResolvedValue(USER);
  });

  it("allows a live login administrator even when the business role is operator", async () => {
    const access = await getSowerWorkAccess();
    expect(access).toEqual({ allowed: true, user: { id: USER.id, username: USER.username, name: USER.name, tenantId: USER.tenantId } });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { username: SESSION.username } });
    const response = sowerWorkAccessResponse(access);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: true, userId: USER.id, userName: USER.name, tenantId: USER.tenantId });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-sower-user-id")).toBe(USER.id);
    expect(response.headers.get("x-sower-username")).toBe(USER.username);
  });

  it("rejects a business administrator whose login role is tenant", async () => {
    mocks.parseSession.mockResolvedValue({ ...SESSION, role: "tenant" });
    mocks.findUnique.mockResolvedValue({ ...USER, authRole: "tenant", role: "admin" });
    expect(await getSowerWorkAccess()).toMatchObject({ allowed: false, status: 403 });
  });

  it.each(["disabled", "pending", "unknown"])("rejects a non-active account (%s)", async status => {
    mocks.findUnique.mockResolvedValue({ ...USER, status });
    expect(await getSowerWorkAccess()).toMatchObject({ allowed: false, status: 401 });
  });

  it.each([
    { authRole: "tenant" },
    { tenantId: "another-tenant" },
    { status: "disabled" }
  ])("rechecks the database after an administrator changes account fields: %j", async change => {
    expect(await getSowerWorkAccess()).toMatchObject({ allowed: true });
    mocks.findUnique.mockResolvedValue({ ...USER, ...change });
    expect(await getSowerWorkAccess()).toMatchObject({ allowed: false, status: 401 });
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("rejects an expired, tampered or missing session before querying account identity", async () => {
    mocks.parseSession.mockResolvedValue(null);
    expect(await getSowerWorkAccess()).toMatchObject({ allowed: false, status: 401 });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a deleted administrator", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await getSowerWorkAccess()).toMatchObject({ allowed: false, status: 401 });
  });

  it("fails closed when the database is unavailable", async () => {
    mocks.findUnique.mockRejectedValue(new Error("private connection details"));
    const access = await getSowerWorkAccess();
    expect(access).toEqual({ allowed: false, status: 503, message: "授权查询暂不可用，请稍后重试" });
    const response = sowerWorkAccessResponse(access);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-sower-user-id")).toBeNull();
    expect(await response.text()).not.toContain("private connection details");
  });

  it.each([401, 403, 503] as const)("never returns a trusted identity on rejection (%s)", async status => {
    const response = sowerWorkAccessResponse({ allowed: false, status, message: "拒绝访问" });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-sower-user-id")).toBeNull();
    expect(response.headers.get("x-sower-username")).toBeNull();
    expect(await response.json()).toEqual({ error: "拒绝访问" });
  });

  it("encodes a non-ASCII username into a safe HTTP identity header", () => {
    const response = sowerWorkAccessResponse({ allowed: true, user: { id: USER.id, username: "管理员", name: "管理员", tenantId: USER.tenantId } });
    expect(response.headers.get("x-sower-username")).toBe(encodeURIComponent("管理员"));
  });
});
