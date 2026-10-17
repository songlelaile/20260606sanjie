import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminResponse: vi.fn(),
  getInviteCodes: vi.fn(),
  createInviteCode: vi.fn(),
  UserManagementInputError: class extends Error {},
  UserManagementAccessError: class extends Error { status = 403; }
}));

vi.mock("@/lib/route-guards", () => ({ requireAdminResponse: mocks.requireAdminResponse }));
vi.mock("@/lib/store/user-store", () => ({
  getInviteCodes: mocks.getInviteCodes,
  createInviteCode: mocks.createInviteCode,
  UserManagementInputError: mocks.UserManagementInputError,
  UserManagementAccessError: mocks.UserManagementAccessError
}));

import { GET, POST } from "./route";

const request = (body: unknown) => new Request("http://localhost/api/invite-codes", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

describe("/api/invite-codes", () => {
  beforeEach(() => {
    mocks.requireAdminResponse.mockReset().mockResolvedValue(null);
    mocks.getInviteCodes.mockReset().mockResolvedValue([]);
    mocks.createInviteCode.mockReset().mockResolvedValue({ id: "invite-1", code: "ABCD12" });
  });

  it("refuses a non-admin before reading or creating invitations", async () => {
    mocks.requireAdminResponse.mockImplementation(async () => Response.json({ error: "仅管理员可执行此操作" }, { status: 403 }));
    const json = vi.fn().mockRejectedValue(new Error("must not read"));
    for (const response of [await GET(), await POST({ json } as unknown as Request)]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(json).not.toHaveBeenCalled();
    expect(mocks.getInviteCodes).not.toHaveBeenCalled();
    expect(mocks.createInviteCode).not.toHaveBeenCalled();
  });

  it("lists invitations with no cache", async () => {
    const invites = [{ id: "invite-1", code: "ABCD12", usedCount: 1, maxUses: 2 }];
    mocks.getInviteCodes.mockResolvedValue(invites);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ data: { invites } });
  });

  it.each([null, [], "", "invite", true, 1, { unknown: "value" }])("rejects invalid JSON object %j", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.createInviteCode).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON instead of creating a default invitation", async () => {
    const response = await POST(new Request("http://localhost/api/invite-codes", { method: "POST", body: "{" }));
    expect(response.status).toBe(400);
    expect(mocks.createInviteCode).not.toHaveBeenCalled();
  });

  it.each([null, true, false, "1", "99", "", 0, -1, 100, 1.5, {}, []])("rejects invalid maxUses %j without coercion", async (maxUses) => {
    const response = await POST(request({ maxUses }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "可用次数必须是 1 到 99 的整数" });
    expect(mocks.createInviteCode).not.toHaveBeenCalled();
  });

  it.each([null, true, 1, {}, [], "字".repeat(201)])("rejects invalid note %j", async (note) => {
    const response = await POST(request({ note }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "备注必须是 200 字以内的文本" });
    expect(mocks.createInviteCode).not.toHaveBeenCalled();
  });

  it.each([
    { input: {}, expected: { note: "", maxUses: 1 } },
    { input: { note: "客户开通", maxUses: 1 }, expected: { note: "客户开通", maxUses: 1 } },
    { input: { note: "字".repeat(200), maxUses: 99 }, expected: { note: "字".repeat(200), maxUses: 99 } }
  ])("creates invitations with defaults and valid boundary values", async ({ input, expected }) => {
    const response = await POST(request(input));
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ data: { invite: { id: "invite-1", code: "ABCD12" } } });
    expect(mocks.createInviteCode).toHaveBeenCalledWith(expected);
  });

  it("maps a typed store validation error to 400", async () => {
    mocks.createInviteCode.mockRejectedValue(new mocks.UserManagementInputError("可用次数必须是 1 到 99 的整数"));
    const response = await POST(request({}));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: "可用次数必须是 1 到 99 的整数" });
  });

  it("maps a typed store access refusal to 403 for both read and write", async () => {
    mocks.getInviteCodes.mockRejectedValue(new mocks.UserManagementAccessError("管理员会话已失效"));
    mocks.createInviteCode.mockRejectedValue(new mocks.UserManagementAccessError("管理员会话已失效"));
    for (const response of [await GET(), await POST(request({}))]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      await expect(response.json()).resolves.toEqual({ error: "管理员会话已失效" });
    }
  });

  it("propagates infrastructure failures without claiming read or creation success", async () => {
    const error = new Error("database unavailable");
    mocks.getInviteCodes.mockRejectedValue(error);
    mocks.createInviteCode.mockRejectedValue(error);
    await expect(GET()).rejects.toBe(error);
    await expect(POST(request({}))).rejects.toBe(error);
  });
});
