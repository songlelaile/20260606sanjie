import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminResponse: vi.fn(),
  resetManagedUserPassword: vi.fn()
}));

vi.mock("@/lib/route-guards", () => ({ requireAdminResponse: mocks.requireAdminResponse }));
vi.mock("@/lib/store/user-store", () => ({ resetManagedUserPassword: mocks.resetManagedUserPassword }));

import { POST } from "./route";

const request = new Request("http://localhost/api/managed-users/user-1/reset-password", { method: "POST" });
const context = (id = "user-1") => ({ params: Promise.resolve({ id }) });

describe("POST /api/managed-users/[id]/reset-password", () => {
  beforeEach(() => {
    mocks.requireAdminResponse.mockReset().mockResolvedValue(null);
    mocks.resetManagedUserPassword.mockReset().mockResolvedValue({ ok: true, password: "temporary-password" });
  });

  it("never resets a password for a non-admin", async () => {
    mocks.requireAdminResponse.mockResolvedValue(Response.json({ error: "仅管理员可执行此操作" }, { status: 403 }));
    const response = await POST(request, context("../invalid"));
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.resetManagedUserPassword).not.toHaveBeenCalled();
  });

  it.each(["", "../user-1", "user/1", "user 1", "用户", "x".repeat(129)])("rejects invalid id %s", async (id) => {
    const response = await POST(request, context(id));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.resetManagedUserPassword).not.toHaveBeenCalled();
  });

  it("returns the one-time password in a private non-cacheable response", async () => {
    const response = await POST(request, context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ data: { password: "temporary-password" } });
    expect(mocks.resetManagedUserPassword).toHaveBeenCalledWith("user-1");
  });

  it.each([
    { status: 400, error: "不能对当前登录的账号执行此操作" },
    { status: 403, error: "不能操作管理员账号" },
    { status: 404, error: "用户不存在" },
    { status: 409, error: "账号已变更，请刷新后重试" }
  ])("preserves store failure $status without a password", async (failure) => {
    mocks.resetManagedUserPassword.mockResolvedValue({ ok: false, ...failure });
    const response = await POST(request, context());
    expect(response.status).toBe(failure.status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: failure.error });
  });

  it("does not expose a password when persistence fails", async () => {
    const error = new Error("database unavailable");
    mocks.resetManagedUserPassword.mockRejectedValue(error);
    await expect(POST(request, context())).rejects.toBe(error);
  });
});
