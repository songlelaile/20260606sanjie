import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminResponse: vi.fn(),
  getManagedUsers: vi.fn(),
  UserManagementAccessError: class extends Error { status = 403; }
}));

vi.mock("@/lib/route-guards", () => ({ requireAdminResponse: mocks.requireAdminResponse }));
vi.mock("@/lib/store/user-store", () => ({
  getManagedUsers: mocks.getManagedUsers,
  UserManagementAccessError: mocks.UserManagementAccessError
}));

import { GET } from "./route";

describe("GET /api/managed-users", () => {
  beforeEach(() => {
    mocks.requireAdminResponse.mockReset().mockResolvedValue(null);
    mocks.getManagedUsers.mockReset();
  });

  it("does not read users for a non-admin", async () => {
    mocks.requireAdminResponse.mockResolvedValue(Response.json({ error: "仅管理员可执行此操作" }, { status: 403 }));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.getManagedUsers).not.toHaveBeenCalled();
  });

  it("returns users only after the administrator guard and prevents caching", async () => {
    const users = [{ id: "user-1", registrationSource: "self" }];
    mocks.getManagedUsers.mockResolvedValue(users);
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { users } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.requireAdminResponse.mock.invocationCallOrder[0]).toBeLessThan(mocks.getManagedUsers.mock.invocationCallOrder[0]);
  });

  it("maps a store access refusal to 403", async () => {
    mocks.getManagedUsers.mockRejectedValue(new mocks.UserManagementAccessError("管理员会话已失效"));
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "管理员会话已失效" });
  });

  it("does not turn a database failure into an empty successful list", async () => {
    const error = new Error("database unavailable");
    mocks.getManagedUsers.mockRejectedValue(error);
    await expect(GET()).rejects.toBe(error);
  });
});
