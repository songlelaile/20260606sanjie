import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminResponse: vi.fn(),
  setManagedUserStatus: vi.fn(),
  deleteManagedUser: vi.fn()
}));

vi.mock("@/lib/route-guards", () => ({ requireAdminResponse: mocks.requireAdminResponse }));
vi.mock("@/lib/store/user-store", () => ({
  setManagedUserStatus: mocks.setManagedUserStatus,
  deleteManagedUser: mocks.deleteManagedUser
}));

import { DELETE, PATCH } from "./route";

const context = (id = "user-1") => ({ params: Promise.resolve({ id }) });
const request = (body: unknown) => new Request("http://localhost/api/managed-users/user-1", {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

describe("/api/managed-users/[id]", () => {
  beforeEach(() => {
    mocks.requireAdminResponse.mockReset().mockResolvedValue(null);
    mocks.setManagedUserStatus.mockReset().mockResolvedValue({ ok: true });
    mocks.deleteManagedUser.mockReset().mockResolvedValue({ ok: true });
  });

  it.each([PATCH, DELETE])("refuses non-admins before reading input or mutating users", async (handler) => {
    mocks.requireAdminResponse.mockResolvedValue(Response.json({ error: "仅管理员可执行此操作" }, { status: 403 }));
    const json = vi.fn().mockRejectedValue(new Error("must not read"));
    const response = await handler({ json } as unknown as Request, context("../invalid"));
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(json).not.toHaveBeenCalled();
    expect(mocks.setManagedUserStatus).not.toHaveBeenCalled();
    expect(mocks.deleteManagedUser).not.toHaveBeenCalled();
  });

  it.each(["", "../user-1", "user/1", "user 1", "用户", "x".repeat(129)])("rejects an invalid id (%s) for both actions", async (id) => {
    for (const handler of [PATCH, DELETE]) {
      const response = await handler(request({ status: "active" }), context(id));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(mocks.setManagedUserStatus).not.toHaveBeenCalled();
    expect(mocks.deleteManagedUser).not.toHaveBeenCalled();
  });

  it.each([null, [], "active", true, 1, {}, { status: true }, { status: "deleted" }, { status: "active", role: "admin" }])("rejects invalid PATCH body %j", async (body) => {
    const response = await PATCH(request(body), context());
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.setManagedUserStatus).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await PATCH(new Request("http://localhost/api/managed-users/user-1", { method: "PATCH", body: "{" }), context());
    expect(response.status).toBe(400);
    expect(mocks.setManagedUserStatus).not.toHaveBeenCalled();
  });

  it.each(["active", "disabled"] as const)("sets an allowed status %s", async (status) => {
    const response = await PATCH(request({ status }), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ data: { id: "user-1", status } });
    expect(mocks.setManagedUserStatus).toHaveBeenCalledWith("user-1", status);
  });

  it("deletes an allowed user", async () => {
    const response = await DELETE(request({}), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ data: { deleted: true } });
    expect(mocks.deleteManagedUser).toHaveBeenCalledWith("user-1");
  });

  it.each([
    { status: 400, error: "不能对当前登录的账号执行此操作" },
    { status: 403, error: "不能操作管理员账号" },
    { status: 404, error: "用户不存在" },
    { status: 409, error: "账号已变更，请刷新后重试" }
  ])("preserves the store rejection $status", async (failure) => {
    mocks.setManagedUserStatus.mockResolvedValue({ ok: false, ...failure });
    mocks.deleteManagedUser.mockResolvedValue({ ok: false, ...failure });
    for (const handler of [PATCH, DELETE]) {
      const response = await handler(request({ status: "disabled" }), context());
      expect(response.status).toBe(failure.status);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ error: failure.error });
    }
  });

  it("does not report successful mutations when persistence fails", async () => {
    const error = new Error("database unavailable");
    mocks.setManagedUserStatus.mockRejectedValue(error);
    mocks.deleteManagedUser.mockRejectedValue(error);
    await expect(PATCH(request({ status: "active" }), context())).rejects.toBe(error);
    await expect(DELETE(request({}), context())).rejects.toBe(error);
  });
});
