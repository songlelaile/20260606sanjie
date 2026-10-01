import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateRegistration: vi.fn(),
  createTenantOperator: vi.fn(),
  createTenantOperatorByInvite: vi.fn(),
  serializeSession: vi.fn()
}));

vi.mock("@/lib/accounts", () => ({
  validateRegistration: mocks.validateRegistration,
  createTenantOperator: mocks.createTenantOperator,
  createTenantOperatorByInvite: mocks.createTenantOperatorByInvite
}));

vi.mock("@/lib/auth", () => ({
  ACTIVE_SHOP_COOKIE: "active_shop",
  SESSION_COOKIE: "session",
  SESSION_MAX_AGE_SECONDS: 3600,
  ROLE_HOME: {
    tenant: "/dashboards/operating-network",
    admin: "/dashboards/operating-network"
  },
  serializeSession: mocks.serializeSession
}));

import { POST } from "./route";

describe("POST /api/auth/register", () => {
  beforeEach(() => {
    mocks.validateRegistration.mockReset();
    mocks.createTenantOperator.mockReset();
    mocks.createTenantOperatorByInvite.mockReset();
    mocks.serializeSession.mockReset();
    mocks.validateRegistration.mockResolvedValue(null);
    mocks.serializeSession.mockResolvedValue("signed-session");
  });

  it("self-registers without invite code and issues a session home", async () => {
    mocks.createTenantOperator.mockResolvedValue({
      ok: true,
      account: {
        username: "13800138000",
        name: "阿壮",
        role: "tenant",
        tenantId: "tenant-self"
      }
    });

    const response = await POST(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "13800138000",
          password: "secret12",
          name: "阿壮"
        })
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      data: {
        role: "tenant",
        name: "阿壮",
        home: "/dashboards/operating-network"
      }
    });
    expect(mocks.createTenantOperator).toHaveBeenCalledWith({
      username: "13800138000",
      password: "secret12",
      name: "阿壮"
    });
    expect(mocks.createTenantOperatorByInvite).not.toHaveBeenCalled();
    expect(response.cookies.get("session")?.value).toBe("signed-session");
  });

  it("rejects duplicate accounts before creating a tenant", async () => {
    mocks.validateRegistration.mockResolvedValue("该手机号已注册");

    const response = await POST(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "13800138000",
          password: "secret12",
          name: "阿壮"
        })
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "该手机号已注册" });
    expect(mocks.createTenantOperator).not.toHaveBeenCalled();
    expect(mocks.createTenantOperatorByInvite).not.toHaveBeenCalled();
  });

  it("still uses invite registration when an invite code is provided", async () => {
    mocks.createTenantOperatorByInvite.mockResolvedValue({
      ok: true,
      account: {
        username: "13900139000",
        name: "邀请用户",
        role: "tenant",
        tenantId: "tenant-invite"
      }
    });

    const response = await POST(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "13900139000",
          password: "secret12",
          name: "邀请用户",
          inviteCode: "ABCD12"
        })
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.home).toBe("/dashboards/operating-network");
    expect(mocks.createTenantOperatorByInvite).toHaveBeenCalledWith({
      username: "13900139000",
      password: "secret12",
      name: "邀请用户",
      inviteCode: "ABCD12"
    });
    expect(mocks.createTenantOperator).not.toHaveBeenCalled();
  });
});
