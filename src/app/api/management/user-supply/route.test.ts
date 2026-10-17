import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn(), backfill: vi.fn(), reset: vi.fn(), provisioning: vi.fn(), save: vi.fn(), ProvisionError: class extends Error {
  constructor(message: string, readonly status = 503, readonly code = "supply_provisioning_failed") { super(message); }
} }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/user-supply", () => ({ listUserSupplyStatus: mocks.list, backfillUserSupplyKeys: mocks.backfill, resetUserSupplyProvisioningFailures: mocks.reset }));
vi.mock("@/lib/model-gateway/sub2api-provisioner", () => ({ getSub2ApiProvisioningView: mocks.provisioning, saveSub2ApiProvisionConfig: mocks.save, Sub2ApiProvisionError: mocks.ProvisionError }));
import { GET, POST, PUT } from "./route";

const url = "https://shaozhuangai.com/api/management/user-supply";
const request = (body: unknown = {}, headers: Record<string, string> = { origin: "https://shaozhuangai.com" }) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const slot = { id: "slot-primary", status: "ready", providerKeyId: "provider-primary" };
const account = { userId: "user-1", username: "registered-user", name: "注册用户", accountStatus: "active", primary: slot, backup: null };
const receipt = { processed: 1, ready: 1, failed: 0, remaining: 0, errors: [] };
const config = { email: "issuer@example.com", password: "private-secret", groupId: "1", quotaUsd: 0 };
const configView = { configured: true, missing: [], emailMasked: "i***@example.com", groupId: "1", quotaUsd: 0, baseUrl: "https://sub.shaozhuangai.com" };
const configRequest = (body: unknown = { config }, headers: Record<string, string> = { origin: "https://shaozhuangai.com" }) =>
  new Request(url, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const supportedHeaders: Record<string, string>[] = [{ origin: "https://shaozhuangai.com" }, { origin: "https://www.shaozhuangai.com" }, { "sec-fetch-site": "same-origin" }, {}];
const expectPrivate = (response: Response) => expect(response.headers.get("cache-control")).toBe("private, no-store");

describe("administrator user supply management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
    mocks.user.mockResolvedValue({ id: "admin-1", authRole: "admin", role: "operator", status: "active" });
    mocks.list.mockResolvedValue([account]);
    mocks.provisioning.mockReturnValue({ configured: true, missing: [] });
    mocks.backfill.mockResolvedValue(receipt);
    mocks.save.mockResolvedValue(configView);
    mocks.reset.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [null, 401, "AUTH_REQUIRED"],
    [{ authRole: "tenant", role: "admin", status: "active" }, 403, "ADMIN_REQUIRED"],
    [{ role: "admin", status: "active" }, 403, "ADMIN_REQUIRED"],
    [{ authRole: "admin", status: "disabled" }, 403, "ADMIN_REQUIRED"]
  ])("denies both reads and issuance for an unauthorized account %j", async (user, status, code) => {
    mocks.user.mockResolvedValue(user);
    for (const response of [await GET(), await POST(request()), await PUT(configRequest())]) {
      expect(response.status).toBe(status);
      expectPrivate(response);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.provisioning).not.toHaveBeenCalled();
    expect(mocks.backfill).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it("projects status fields and never returns stored or provider credentials", async () => {
    mocks.list.mockResolvedValue([{ ...account, apiKey: "private-secret", providerResponse: { token: "private-secret" },
      primary: { ...slot, sealedKey: "private-secret", rawKey: "private-secret" } }]);
    mocks.provisioning.mockReturnValue({ configured: false, missing: ["SUB2API_ADMIN_TOKEN", "private-secret"], token: "private-secret" });
    const response = await GET();
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({ data: { provisioning: { configured: false, missing: ["SUB2API_ADMIN_TOKEN"], baseUrl: "https://sub.shaozhuangai.com" }, users: [account] } });
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it("processes exactly one bounded batch and projects its safe receipt", async () => {
    mocks.backfill.mockResolvedValue({ ...receipt, remaining: 20, rawKey: "private-secret", providerResponse: { token: "private-secret" } });
    const response = await POST(request({ limit: 3 }));
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(mocks.backfill).toHaveBeenCalledExactlyOnceWith(3);
    expect(await response.json()).toEqual({ data: { ...receipt, remaining: 20 } });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("defaults to a maximum of ten users", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.backfill).toHaveBeenCalledExactlyOnceWith(10);
  });

  it("allows safe service codes while replacing unknown provider errors", async () => {
    mocks.backfill.mockResolvedValue({ ...receipt, failed: 2, errors: [
      { userId: "user-1", code: "USER_SUPPLY_PROVISION_PENDING", rawKey: "private-secret" },
      { userId: "user-2", code: "provider error private-secret", providerResponse: "private-secret" }
    ] });
    const response = await POST(request());
    expect(await response.json()).toEqual({ data: { ...receipt, failed: 2, errors: [
      { userId: "user-1", code: "USER_SUPPLY_PROVISION_PENDING" },
      { userId: "user-2", code: "USER_SUPPLY_PROVISION_FAILED" }
    ] } });
  });

  it("does not issue keys when the upstream issuer is not configured", async () => {
    mocks.provisioning.mockReturnValue({ configured: false, missing: ["SUB2API_ADMIN_TOKEN"] });
    const response = await POST(request());
    expect(response.status).toBe(503);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "SUPPLY_PROVISIONING_NOT_CONFIGURED" });
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it.each(["https://evil.example", "null", "https://sub.shaozhuangai.com", "https://shaozhuangai.com/path", "http://shaozhuangai.com"])("rejects foreign Origin %s before issuing keys", async (origin) => {
    const response = await POST(request({}, { origin, host: "evil.example", "x-forwarded-host": "evil.example", "sec-fetch-site": "same-origin" }));
    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "CROSS_SITE_REQUEST" });
    expect(mocks.backfill).not.toHaveBeenCalled();
    expect(mocks.provisioning).not.toHaveBeenCalled();
  });

  it.each(["cross-site", "same-site", "none"])("rejects foreign fetch metadata %s", async (site) => {
    expect((await POST(request({}, { "sec-fetch-site": site }))).status).toBe(403);
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it.each(supportedHeaders)("retains supported authenticated requests %j", async (headers) => {
    expect((await POST(request({}, headers))).status).toBe(200);
    expect(mocks.backfill).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 11, 1.5, "10", null])("rejects an invalid batch limit %s", async (limit) => {
    const response = await POST(request({ limit }));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "INVALID_SUPPLY_LIMIT" });
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it.each(["userId", "tenantId", "apiKey", "secret", "primary", "backup", "adminId", "providerResponse"])("rejects external authority or credential field %s", async (field) => {
    const response = await POST(request({ limit: 1, [field]: "private-secret" }));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: "仅支持批次大小，不能指定用户或凭据", code: "INVALID_SUPPLY_INPUT" });
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it.each(["{", "null", "[]", '"text"'])("rejects malformed or non-object JSON %s", async (body) => {
    const response = await POST(new Request(url, { method: "POST", headers: { origin: "https://shaozhuangai.com" }, body }));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "INVALID_JSON" });
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it("limits actual UTF-8 body bytes even with a forged content length", async () => {
    const response = await POST(request({ secret: "汉".repeat(400) }, { origin: "https://shaozhuangai.com", "content-length": "1" }));
    expect(response.status).toBe(413);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(mocks.backfill).not.toHaveBeenCalled();
  });

  it("rechecks the administrator after their account is disabled", async () => {
    expect((await POST(request())).status).toBe(200);
    mocks.user.mockResolvedValue({ authRole: "admin", status: "disabled" });
    expect((await GET()).status).toBe(403);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.user).toHaveBeenCalledTimes(3);
    expect(mocks.backfill).toHaveBeenCalledOnce();
  });

  it("saves only explicit configuration and returns its masked view without logging in or issuing keys", async () => {
    mocks.save.mockResolvedValue({ ...configView, password: "private-secret", email: config.email, token: "private-secret", providerResponse: "private-secret" });
    const response = await PUT(configRequest());
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(config);
    expect(await response.json()).toEqual({ data: { ...configView, retryReset: "ready" } });
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.backfill).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.provisioning).not.toHaveBeenCalled();
  });

  it.each(["supply_provisioning_rate_limited", "supply_provisioning_key_count_limit", "supply_provisioning_key_count_exceeded"])("retains the upstream retry limit code %s without exposing provider payloads", async (code) => {
    mocks.backfill.mockResolvedValue({ ...receipt, failed: 1, errors: [{ userId: "user-1", code, providerResponse: "private-secret" }] });
    const response = await POST(request());
    const json = await response.json();
    expect(json.data.errors).toEqual([{ userId: "user-1", code }]);
    expect(JSON.stringify(json)).not.toContain("private-secret");
  });

  it("retains the configuration save receipt when resetting previous failed rows is unavailable", async () => {
    mocks.reset.mockRejectedValue(new Error("database private-secret"));
    const response = await PUT(configRequest());
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({ data: { ...configView, retryReset: "unavailable" } });
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(config);
  });

  it.each([
    {}, { config: null }, { config: [] }, { config: {} }, { config, userId: "spoofed" },
    { config: { ...config, baseUrl: "https://evil.example" } }, { config: { ...config, apiKey: "private-secret" } },
    { config: { ...config, adminId: "spoofed" } }, { config: { ...config, primary: "private-secret" } }
  ])("rejects unrecognized or credential-spoofing configuration fields %j", async (body) => {
    const response = await PUT(configRequest(body));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "INVALID_SUPPLY_CONFIG" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(["https://evil.example", "null", "https://sub.shaozhuangai.com"])("rejects cross-site configuration writes %s", async (origin) => {
    const response = await PUT(configRequest({ config }, { origin, "sec-fetch-site": "same-origin" }));
    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "CROSS_SITE_REQUEST" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("bounds configuration body bytes before sending credentials to the save helper", async () => {
    const response = await PUT(configRequest({ config: { ...config, password: "汉".repeat(1400) } }, { origin: "https://shaozhuangai.com", "content-length": "1" }));
    expect(response.status).toBe(413);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([
    ["supply_provisioning_invalid_config", 400],
    ["supply_provisioning_config_busy", 409],
    ["supply_provisioning_encryption_unconfigured", 503]
  ])("keeps actionable configuration error %s while removing provider text", async (code, status) => {
    mocks.save.mockRejectedValue(new mocks.ProvisionError("provider response private-secret", 502, code));
    const response = await PUT(configRequest());
    expect(response.status).toBe(status);
    expectPrivate(response);
    const json = await response.json();
    expect(json.code).toBe(code);
    expect(JSON.stringify(json)).not.toContain("private-secret");
  });

  it("redacts unknown configuration exceptions and rejects malformed configuration JSON", async () => {
    mocks.save.mockRejectedValue(new Error("password=private-secret"));
    const write = await PUT(configRequest());
    expect(write.status).toBe(503);
    expectPrivate(write);
    expect(await write.json()).toEqual({ error: "用户供应 Key 服务暂不可用，请稍后重试", code: "USER_SUPPLY_UNAVAILABLE" });
    const invalid = await PUT(new Request(url, { method: "PUT", headers: { origin: "https://shaozhuangai.com" }, body: "{" }));
    expect(invalid.status).toBe(400);
    expectPrivate(invalid);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_JSON" });
  });

  it("never serializes session, database or upstream exception text", async () => {
    mocks.list.mockRejectedValue(new Error("database private-secret"));
    const read = await GET();
    mocks.backfill.mockRejectedValue(new Error("provider token=private-secret"));
    const write = await POST(request());
    mocks.provisioning.mockImplementation(() => { throw new Error("config private-secret"); });
    const config = await POST(request());
    mocks.user.mockRejectedValue(new Error("session private-secret"));
    for (const response of [read, write, config, await GET(), await POST(request())]) {
      expect(response.status).toBe(503);
      expectPrivate(response);
      const json = await response.json();
      expect(json).toMatchObject({ code: "USER_SUPPLY_UNAVAILABLE" });
      expect(JSON.stringify(json)).not.toContain("private-secret");
    }
  });
});
