import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  isSessionAccountValid: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/session-server", () => ({
  getServerSession: mocks.getServerSession
}));
vi.mock("@/lib/accounts", () => ({
  isSessionAccountValid: mocks.isSessionAccountValid
}));

import { requireAdminResponse } from "./route-guards";

const ADMIN_SESSION = {
  username: "admin",
  name: "管理员",
  role: "admin",
  tenantId: "admin-tenant"
};

describe("requireAdminResponse", () => {
  beforeEach(() => {
    mocks.getServerSession.mockReset();
    mocks.isSessionAccountValid.mockReset();
    mocks.getServerSession.mockResolvedValue(ADMIN_SESSION);
    mocks.isSessionAccountValid.mockResolvedValue(true);
  });

  it("allows an admin session that still matches the database", async () => {
    await expect(requireAdminResponse()).resolves.toBeNull();
    expect(mocks.isSessionAccountValid).toHaveBeenCalledWith(ADMIN_SESSION);
  });

  it("rejects a stale admin session after tenant or role changes", async () => {
    mocks.isSessionAccountValid.mockResolvedValueOnce(false);
    const response = await requireAdminResponse();
    expect(response?.status).toBe(403);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects a tenant role without trusting database lookup alone", async () => {
    mocks.getServerSession.mockResolvedValueOnce({ ...ADMIN_SESSION, role: "tenant" });
    const response = await requireAdminResponse();
    expect(response?.status).toBe(403);
    expect(mocks.isSessionAccountValid).not.toHaveBeenCalled();
  });
});
