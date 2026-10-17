import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateRegistration: vi.fn(),
  createTenantOperator: vi.fn(),
  createTenantOperatorByInvite: vi.fn(),
  serializeSession: vi.fn(),
  rateLimit: vi.fn(),
  provisionSupply: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/security-rate-limit", () => ({ consumeSecurityRateLimit: mocks.rateLimit }));
vi.mock("@/lib/model-gateway/user-supply", () => ({ provisionRegisteredUserSupply: mocks.provisionSupply }));

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
    mocks.rateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 5, retryAfterSeconds: 0 });
    mocks.provisionSupply.mockReset().mockResolvedValue(undefined);
    mocks.validateRegistration.mockResolvedValue(null);
    mocks.serializeSession.mockResolvedValue("signed-session");
    vi.stubEnv("SANJIE_TRUST_PROXY_IP", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("consumes shared unknown short and daily allowances before registration validation", async () => {
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", headers: { "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.2" }, body: "{"
    }));
    expect(response.status).toBe(400);
    expect(mocks.rateLimit.mock.calls).toEqual([
      ["auth.register.ip.short", "unknown", 50, 600], ["auth.register.ip.daily", "unknown", 500, 86_400]
    ]);
    expect(mocks.validateRegistration).not.toHaveBeenCalled();
  });

  it("uses trusted canonical client IP for the stricter registration quotas", async () => {
    vi.stubEnv("SANJIE_TRUST_PROXY_IP", "true");
    await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", headers: { "x-real-ip": "2001:0db8:0:0:0:0:0:1", "x-forwarded-for": "203.0.113.2" }, body: "{"
    }));
    expect(mocks.rateLimit.mock.calls).toEqual([
      ["auth.register.ip.short", "2001:db8::1", 5, 600], ["auth.register.ip.daily", "2001:db8::1", 30, 86_400]
    ]);
  });

  it.each([
    ["short", "rate_limited", 429], ["short", "unavailable", 503],
    ["daily", "rate_limited", 429], ["daily", "unavailable", 503]
  ])("denies %s quota for %s before reading a body or creating accounts", async (window, reason, status) => {
    if (window === "daily") mocks.rateLimit.mockResolvedValueOnce({ allowed: true });
    mocks.rateLimit.mockResolvedValueOnce({ allowed: false, reason, remaining: 0, retryAfterSeconds: 30 });
    const incoming = new Request("http://localhost/api/auth/register", {
      method: "POST", body: JSON.stringify({ username: "13800138000", password: "secret12", inviteCode: "ABCD12" })
    });
    const readBody = vi.spyOn(incoming, "body", "get");
    const response = await POST(incoming);
    expect(response.status).toBe(status);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(readBody).not.toHaveBeenCalled();
    expect(mocks.validateRegistration).not.toHaveBeenCalled();
    expect(mocks.createTenantOperator).not.toHaveBeenCalled();
    expect(mocks.createTenantOperatorByInvite).not.toHaveBeenCalled();
    expect(mocks.serializeSession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledTimes(window === "short" ? 1 : 2);
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
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.serializeSession).toHaveBeenCalledWith({
      username: "13800138000", role: "tenant", name: "阿壮", tenantId: "tenant-self"
    });
    expect(response.cookies.get("active_shop")?.value).toBe("");
    expect(mocks.provisionSupply).toHaveBeenCalledWith("13800138000");
  });

  it("keeps a committed registration and session when supplier provisioning is unavailable", async () => {
    mocks.createTenantOperator.mockResolvedValue({ ok: true, account: {
      username: "13800138000", name: "阿壮", role: "tenant", tenantId: "tenant-self"
    } });
    mocks.provisionSupply.mockRejectedValue(new Error("supplier unavailable"));
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", body: JSON.stringify({ username: "13800138000", password: "secret12" })
    }));
    expect(response.status).toBe(200);
    expect(response.cookies.get("session")?.value).toBe("signed-session");
    expect(mocks.provisionSupply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await response.json())).not.toContain("supplier unavailable");
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

  it.each([null, [], "text", 123, true])("rejects a non-object JSON body: %j", async (body) => {
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", body: JSON.stringify(body)
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "请提交有效的注册信息" });
    expect(mocks.validateRegistration).not.toHaveBeenCalled();
    expect(mocks.createTenantOperator).not.toHaveBeenCalled();
    expect(mocks.createTenantOperatorByInvite).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("rejects malformed JSON without throwing", async () => {
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", body: "{"
    }));
    expect(response.status).toBe(400);
    expect(mocks.validateRegistration).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    ["{}", "20000"],
    [JSON.stringify({ ignored: "a".repeat(20_000) }), undefined],
    [JSON.stringify({ ignored: "a".repeat(20_000) }), "1"],
    [JSON.stringify({ ignored: "名".repeat(8_000) }), undefined]
  ])("limits declared and actual UTF-8 request bytes before validation", async (body, declaredLength) => {
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", body,
      ...(declaredLength ? { headers: { "content-length": declaredLength } } : {})
    }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "注册信息过长，请精简后重试" });
    expect(mocks.validateRegistration).not.toHaveBeenCalled();
    expect(mocks.createTenantOperator).not.toHaveBeenCalled();
    expect(mocks.createTenantOperatorByInvite).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    [{}, "手机号和密码必须是文本"],
    [{ username: 13800138000 }, "手机号和密码必须是文本"],
    [{ password: ["secret12"] }, "手机号和密码必须是文本"],
    [{ name: null }, "姓名 / 昵称必须是文本"],
    [{ name: { role: "admin" } }, "姓名 / 昵称必须是文本"],
    [{ inviteCode: 123456 }, "邀请码必须是文本"],
    [{ inviteCode: null }, "邀请码必须是文本"]
  ])("rejects invalid field types without silently switching registration modes: %j", async (fields, error) => {
    const body = Object.keys(fields).length ? {
      username: "13800138000", password: "secret12", name: "阿壮", ...fields
    } : {};
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", body: JSON.stringify(body)
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocks.validateRegistration).not.toHaveBeenCalled();
    expect(mocks.createTenantOperator).not.toHaveBeenCalled();
    expect(mocks.createTenantOperatorByInvite).not.toHaveBeenCalled();
    expect(mocks.serializeSession).not.toHaveBeenCalled();
  });

  it("passes original text to boundary validation and only normalized, permitted fields to creation", async () => {
    mocks.createTenantOperatorByInvite.mockResolvedValue({
      ok: true, account: { username: "13800138000", name: "阿壮", role: "tenant", tenantId: "tenant-invite" }
    });
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", body: JSON.stringify({
        username: " 13800138000 ", password: " secret12 ", name: " 阿壮 ", inviteCode: " abcd12 ",
        authRole: "admin", role: "admin", tenantId: "tenant-old", toolCode: "dmp", shopName: "其他店铺"
      })
    }));
    expect(response.status).toBe(200);
    expect(mocks.validateRegistration).toHaveBeenCalledWith({
      username: " 13800138000 ", password: " secret12 ", name: " 阿壮 ", inviteCode: " abcd12 "
    });
    expect(mocks.createTenantOperatorByInvite).toHaveBeenCalledExactlyOnceWith({
      username: "13800138000", password: " secret12 ", name: "阿壮", inviteCode: "abcd12"
    });
  });

  it.each(["密码最多 128 个字符", "姓名 / 昵称最多 50 个字符", "邀请码须为 6 到 32 位字母或数字"])
  ("returns a boundary validation error without issuing a session: %s", async (error) => {
    mocks.validateRegistration.mockResolvedValueOnce(error);
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", body: JSON.stringify({ username: "13800138000", password: "secret12", name: "阿壮" })
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocks.createTenantOperator).not.toHaveBeenCalled();
    expect(mocks.createTenantOperatorByInvite).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it.each(["", "ABCD12"])("returns transaction rejection without setting a session, invite=%s", async (inviteCode) => {
    const error = inviteCode ? "邀请码无效或已失效" : "该手机号已注册";
    (inviteCode ? mocks.createTenantOperatorByInvite : mocks.createTenantOperator)
      .mockResolvedValueOnce({ ok: false, error });
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", body: JSON.stringify({ username: "13800138000", password: "secret12", inviteCode })
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocks.serializeSession).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it.each(["validate", "self", "invite"])("returns a private 503 for an unexpected %s failure", async (stage) => {
    const exception = new Error("internal database detail");
    if (stage === "validate") mocks.validateRegistration.mockRejectedValueOnce(exception);
    else (stage === "invite" ? mocks.createTenantOperatorByInvite : mocks.createTenantOperator)
      .mockRejectedValueOnce(exception);
    const response = await POST(new Request("http://localhost/api/auth/register", {
      method: "POST", body: JSON.stringify({
        username: "13800138000", password: "secret12", ...(stage === "invite" ? { inviteCode: "ABCD12" } : {})
      })
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "注册暂时不可用，请稍后重试" });
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("issues a production cookie tied to the newly allocated tenant", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mocks.createTenantOperator.mockResolvedValueOnce({
      ok: true, account: { username: "13800138000", name: "阿壮", role: "tenant", tenantId: "tenant-new" }
    });
    const response = await POST(new Request("https://shaozhuangai.com/api/auth/register", {
      method: "POST", body: JSON.stringify({ username: "13800138000", password: "secret12" })
    }));
    expect(response.cookies.get("session")).toMatchObject({
      value: "signed-session", httpOnly: true, secure: true, sameSite: "lax", path: "/", domain: ".shaozhuangai.com"
    });
    expect(mocks.serializeSession).toHaveBeenCalledExactlyOnceWith({
      username: "13800138000", name: "阿壮", role: "tenant", tenantId: "tenant-new"
    });
    expect(mocks.createTenantOperator).toHaveBeenCalledWith({
      username: "13800138000", password: "secret12", name: "13800138000"
    });
  });
});
