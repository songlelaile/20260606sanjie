import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseSession: vi.fn(),
  isSessionAccountValid: vi.fn()
}));

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "sanjie_session",
  parseSession: mocks.parseSession
}));
vi.mock("@/lib/accounts", () => ({
  isSessionAccountValid: mocks.isSessionAccountValid
}));

import { GET } from "./route";

const SESSION = {
  username: "tenant-a",
  name: "租户 A",
  role: "tenant",
  tenantId: "tenant-a-id"
};

describe("GET /api/auth/me", () => {
  beforeEach(() => {
    mocks.parseSession.mockReset();
    mocks.isSessionAccountValid.mockReset();
    mocks.parseSession.mockResolvedValue(SESSION);
    mocks.isSessionAccountValid.mockResolvedValue(true);
  });

  it("rejects requests without a session token", async () => {
    const response = await GET(new Request("http://localhost/api/auth/me"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it("treats a malformed encoded cookie as unauthenticated", async () => {
    const response = await GET(
      new Request("http://localhost/api/auth/me", {
        headers: { cookie: "sanjie_session=%broken" }
      })
    );
    expect(response.status).toBe(401);
    expect(mocks.parseSession).not.toHaveBeenCalled();
  });

  it("returns only the validated session identity", async () => {
    const response = await GET(
      new Request("http://localhost/api/auth/me", {
        headers: { "x-sanjie-session": "signed-token" }
      })
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data).toMatchObject({
      ...SESSION,
      service: { online: true },
      capabilities: { dmpAutomation: true, dmpJsonImport: false }
    });
    expect(payload.data.service.checkedAt).toEqual(expect.any(String));
    expect(mocks.isSessionAccountValid).toHaveBeenCalledWith(SESSION);
  });

  it("grants the JSON engineering-file capability only to platform administrators", async () => {
    mocks.parseSession.mockResolvedValueOnce({ ...SESSION, role: "admin" });
    const response = await GET(
      new Request("http://localhost/api/auth/me", {
        headers: { "x-sanjie-session": "signed-admin-token" }
      })
    );
    const payload = await response.json();
    expect(payload.data.capabilities).toEqual({ dmpAutomation: true, dmpJsonImport: true });
  });

  it("rejects a signed session whose database tenant or role no longer matches", async () => {
    mocks.isSessionAccountValid.mockResolvedValueOnce(false);
    const response = await GET(
      new Request("http://localhost/api/auth/me", {
        headers: { cookie: "sanjie_session=signed-token" }
      })
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "会话已失效" });
  });

  it("fails closed when the account database cannot validate the signed session", async () => {
    mocks.isSessionAccountValid.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await GET(
      new Request("http://localhost/api/auth/me", {
        headers: { "x-sanjie-session": "signed-token" }
      })
    );
    expect(response.status).toBe(401);
  });
});
