import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminResponse: vi.fn(),
  deleteInviteCode: vi.fn(),
  UserManagementAccessError: class extends Error { status = 403; }
}));

vi.mock("@/lib/route-guards", () => ({ requireAdminResponse: mocks.requireAdminResponse }));
vi.mock("@/lib/store/user-store", () => ({
  deleteInviteCode: mocks.deleteInviteCode,
  UserManagementAccessError: mocks.UserManagementAccessError
}));

import { DELETE } from "./route";

const request = new Request("http://localhost/api/invite-codes/invite-1", { method: "DELETE" });
const context = (id = "invite-1") => ({ params: Promise.resolve({ id }) });

describe("DELETE /api/invite-codes/[id]", () => {
  beforeEach(() => {
    mocks.requireAdminResponse.mockReset().mockResolvedValue(null);
    mocks.deleteInviteCode.mockReset().mockResolvedValue(true);
  });

  it("does not revoke invitations for a non-admin", async () => {
    mocks.requireAdminResponse.mockResolvedValue(Response.json({ error: "仅管理员可执行此操作" }, { status: 403 }));
    const response = await DELETE(request, context("../invalid"));
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.deleteInviteCode).not.toHaveBeenCalled();
  });

  it.each(["", "../invite-1", "invite/1", "invite 1", "邀请", "x".repeat(129)])("rejects invalid id %s", async (id) => {
    const response = await DELETE(request, context(id));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.deleteInviteCode).not.toHaveBeenCalled();
  });

  it("revokes an existing invitation", async () => {
    const response = await DELETE(request, context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ data: { deleted: true } });
    expect(mocks.deleteInviteCode).toHaveBeenCalledWith("invite-1");
  });

  it("returns 404 when an invitation is missing or outside the administrator scope", async () => {
    mocks.deleteInviteCode.mockResolvedValue(false);
    const response = await DELETE(request, context());
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "未找到邀请码" });
  });

  it("maps a store access refusal to 403", async () => {
    mocks.deleteInviteCode.mockRejectedValue(new mocks.UserManagementAccessError("管理员会话已失效"));
    const response = await DELETE(request, context());
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "管理员会话已失效" });
  });

  it("does not claim revocation when persistence fails", async () => {
    const error = new Error("database unavailable");
    mocks.deleteInviteCode.mockRejectedValue(error);
    await expect(DELETE(request, context())).rejects.toBe(error);
  });
});
