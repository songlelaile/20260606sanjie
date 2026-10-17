import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cookies: vi.fn(), parseSession: vi.fn(), findUnique: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "sanjie_session", parseSession: mocks.parseSession }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));

import { GET } from "./route";

describe("Sower Work bridge authorization endpoint", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.cookies.mockResolvedValue({ get: () => ({ value: "signed-session" }) });
    mocks.parseSession.mockResolvedValue({ username: "admin", role: "admin", tenantId: "tenant-admin" });
  });

  it("returns identity JSON only after live administrator authorization", async () => {
    mocks.findUnique.mockResolvedValue({ id: "admin-1", username: "admin", name: "管理员", tenantId: "tenant-admin", authRole: "admin", status: "active" });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-sower-user-id")).toBe("admin-1");
    expect(response.headers.get("x-sower-username")).toBe("admin");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ allowed: true, userId: "admin-1", userName: "管理员", tenantId: "tenant-admin" });
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { username: "admin" } });
  });

  it("returns 401 for no valid account", async () => {
    mocks.parseSession.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("x-sower-user-id")).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 for a tenant with a business admin role", async () => {
    mocks.parseSession.mockResolvedValue({ username: "tenant", role: "tenant", tenantId: "tenant-admin" });
    mocks.findUnique.mockResolvedValue({ username: "tenant", tenantId: "tenant-admin", authRole: "tenant", role: "admin", status: "active" });
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-sower-user-id")).toBeNull();
  });

  it("returns 503 without authorizing when account lookup fails", async () => {
    mocks.findUnique.mockRejectedValue(new Error("db unavailable"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("x-sower-user-id")).toBeNull();
    expect(await response.json()).toEqual({ error: "授权查询暂不可用，请稍后重试" });
  });
});
