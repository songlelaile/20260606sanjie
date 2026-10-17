import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("server-only", () => ({}));

const input = { name: "sanjie-user-1-primary", customKey: "test_only_custom_key_0123456789", idempotencyKey: "sanjie:user-1:primary:v1" };
const secret = "test-only-password-never-emit";
const jwt = "test.jwt.only";
const refresh = "test-only-refresh-token-never-emit";
const keyRow = (changes: Record<string, unknown> = {}) => ({ id: 42, name: input.name, key: input.customKey, group_id: 8, user_id: 7, status: "active", quota: 0, ...changes });
const envelope = (data: unknown, headers?: HeadersInit) => Response.json({ code: 0, data }, { headers });
const login = (changes: Record<string, unknown> = {}, headers?: HeadersInit) => envelope({ access_token: jwt, refresh_token: refresh, expires_in: 3600, user: { id: 7, status: "active" }, ...changes }, headers);
const list = (items: unknown[] = [], total = items.length) => envelope({ items, total });

describe("Sub2API server-side key provisioning", () => {
  let api: typeof import("./sub2api-provisioner");
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let directory: string;
  beforeEach(async () => {
    vi.resetModules();
    directory = await mkdtemp(path.join(tmpdir(), "sub2api-provider-test-"));
    vi.stubEnv("SUB2API_PROVISION_CONFIG_FILE", path.join(directory, "config.json"));
    vi.stubEnv("SUB2API_PROVISION_BASE_URL", "");
    vi.stubEnv("SUB2API_PROVISION_EMAIL", "service@example.test");
    vi.stubEnv("SUB2API_PROVISION_PASSWORD", secret);
    vi.stubEnv("SUB2API_PROVISION_GROUP_ID", "8");
    vi.stubEnv("SUB2API_PROVISION_KEY_QUOTA_USD", "0");
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    api = await import("./sub2api-provisioner");
  });
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

  it("reports missing configuration without inventing a key quota or making requests", async () => {
    vi.stubEnv("SUB2API_PROVISION_KEY_QUOTA_USD", "");
    expect(await api.getSub2ApiProvisioningView()).toMatchObject({ configured: false, missing: ["SUB2API_PROVISION_KEY_QUOTA_USD"] });
    expect(await api.provisioningConfigured()).toBe(false);
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_unconfigured", status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["http://sub.shaozhuangai.com", "https://sub.shaozhuangai.com/v1", "https://evil.example", "https://sub.shaozhuangai.com?x=1", "https://user:password@sub.shaozhuangai.com", "https://sub.shaozhuangai.com:8443"])("blocks an unapproved management root: %s", async (url) => {
    vi.stubEnv("SUB2API_PROVISION_BASE_URL", url);
    await expect(api.getSub2ApiProvisioningView()).rejects.toMatchObject({ code: "supply_provisioning_invalid_config" });
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_invalid_config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["-1", "NaN", "Infinity", "1e6", "nonsense"])("rejects invalid configured quotas: %s", async (quota) => {
    vi.stubEnv("SUB2API_PROVISION_KEY_QUOTA_USD", quota);
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_invalid_config" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ customKey: "too-short" }, { customKey: "bad/key-value-too-long" }, { name: "bad\nname" }, { idempotencyKey: "key with spaces" }])("rejects invalid input before calling the issuer: %j", async (patch) => {
    await expect(api.provisionSub2ApiKey({ ...input, ...patch })).rejects.toMatchObject({ code: "supply_provisioning_invalid_input", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms a real upstream key before returning ready, with explicit quota zero and unchanged idempotency identity", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(list()).mockResolvedValueOnce(envelope(keyRow())).mockResolvedValueOnce(list([keyRow()]));
    expect(await api.getSub2ApiProvisioningView()).toMatchObject({ configured: true, missing: [], emailMasked: "s***@example.test" });
    await expect(api.provisionSub2ApiKey(input)).resolves.toEqual({ id: "42", key: input.customKey, ownerId: "7", groupId: "8" });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/api/v1/auth/login", "/api/v1/keys", "/api/v1/keys", "/api/v1/keys"]);
    const loginInit = fetchMock.mock.calls[0][1]!;
    expect(JSON.parse(String(loginInit.body))).toEqual({ email: "service@example.test", password: secret });
    const createInit = fetchMock.mock.calls[2][1]!;
    expect(createInit).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", headers: { Authorization: `Bearer ${jwt}`, "Idempotency-Key": input.idempotencyKey } });
    expect(JSON.parse(String(createInit.body))).toEqual({ name: input.name, custom_key: input.customKey, group_id: 8, quota: 0 });
    expect(JSON.stringify(await api.getSub2ApiProvisioningView())).not.toContain(secret);
  });

  it("reuses a verified existing key and an in-process service session", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(list([keyRow()])).mockResolvedValueOnce(list([keyRow()]));
    await api.provisionSub2ApiKey(input);
    await api.provisionSub2ApiKey(input);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("serializes concurrent login attempts without registering an upstream user", async () => {
    fetchMock.mockImplementation(async (url) => new URL(String(url)).pathname === "/api/v1/auth/login" ? login() : list([keyRow()]));
    await Promise.all([api.provisionSub2ApiKey(input), api.provisionSub2ApiKey(input)]);
    expect(fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/api/v1/auth/login")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("register"))).toBe(false);
  });

  it.each([{ key: "different_upstream_key_12345678" }, { user_id: 9 }, { group_id: 9 }, { status: "inactive" }, { status: "quota_exhausted" }])("refuses existing records with the wrong key, owner, group, or state: %j", async (patch) => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(list([keyRow(patch)]));
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_key_mismatch" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("detects duplicate names across pages instead of creating or picking an arbitrary match", async () => {
    const unrelated = Array.from({ length: 99 }, (_, index) => ({ name: `other-${index}`, key: `different-${index}` }));
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(list([keyRow(), ...unrelated], 101)).mockResolvedValueOnce(list([keyRow({ id: 43 })], 101));
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_key_conflict", status: 409 });
    expect(new URL(String(fetchMock.mock.calls[2][0])).searchParams.get("page")).toBe("2");
    expect(fetchMock.mock.calls.some(([, init]) => init?.headers && "Idempotency-Key" in init.headers)).toBe(false);
  });

  it("blocks TOTP challenges before issuing anything", async () => {
    fetchMock.mockResolvedValueOnce(envelope({ requires_2fa: true, token: refresh }));
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_2fa_required" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks an inactive service-account owner", async () => {
    fetchMock.mockResolvedValueOnce(login({ user: { id: 7, status: "inactive" } }));
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_inactive_owner" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes a rejected JWT once and uses the rotated tokens", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(new Response("secret", { status: 401 }))
      .mockResolvedValueOnce(envelope({ access_token: "rotated.jwt.only", refresh_token: "rotated-refresh", expires_in: 3600 }))
      .mockResolvedValueOnce(list([keyRow()]));
    await expect(api.provisionSub2ApiKey(input)).resolves.toMatchObject({ ownerId: "7" });
    expect(new URL(String(fetchMock.mock.calls[2][0])).pathname).toBe("/api/v1/auth/refresh");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ refresh_token: refresh });
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({ Authorization: "Bearer rotated.jwt.only" });
  });

  it("does not repeat refresh when the refreshed JWT is rejected", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(new Response("raw-secret", { status: 401 }))
      .mockResolvedValueOnce(envelope({ access_token: "rotated.jwt.only", refresh_token: "rotated-refresh" }))
      .mockResolvedValueOnce(new Response("raw-secret", { status: 401 }));
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_auth_rejected" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("recovers an idempotent create conflict by confirming the real existing record", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(list()).mockResolvedValueOnce(new Response("upstream-conflict", { status: 409 })).mockResolvedValueOnce(list([keyRow()]));
    await expect(api.provisionSub2ApiKey(input)).resolves.toMatchObject({ id: "42", key: input.customKey });
    expect(fetchMock.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === "/api/v1/keys" && init?.method === "POST")).toHaveLength(1);
  });

  it("reports a safe rate-limit code without issuing another create", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(list()).mockResolvedValueOnce(new Response(secret, { status: 429 })).mockResolvedValueOnce(list());
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_rate_limited", status: 429 });
    expect(fetchMock.mock.calls.filter(([url, init]) => new URL(String(url)).pathname === "/api/v1/keys" && init?.method === "POST")).toHaveLength(1);
  });

  it.each(["reason", "code"])("recognizes the official count limit in %s without exposing the error body", async (field) => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(list())
      .mockResolvedValueOnce(Response.json({ [field]: "API_KEY_COUNT_EXCEEDED", message: secret }, { status: 403 })).mockResolvedValueOnce(list());
    const error = await api.provisionSub2ApiKey(input).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "supply_provisioning_key_count_exceeded" });
    expect(String(error) + JSON.stringify(error)).not.toContain(secret);
  });

  it("does not call a locally generated key ready when the issuer and readback do not confirm it", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(list()).mockResolvedValueOnce(envelope(keyRow({ key: "wrong_key_from_upstream_0123456" }))).mockResolvedValueOnce(list());
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_key_mismatch" });
  });

  it("requires readback even after a successful creation response", async () => {
    fetchMock.mockResolvedValueOnce(login()).mockResolvedValueOnce(list()).mockResolvedValueOnce(envelope(keyRow())).mockResolvedValueOnce(list());
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_unconfirmed" });
  });

  it("never attaches raw supplier responses, passwords, or tokens to errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error(`${secret} ${jwt} ${refresh} ${input.customKey}`));
    const error = await api.provisionSub2ApiKey(input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(api.Sub2ApiProvisionError);
    const output = String(error) + JSON.stringify(error);
    for (const value of [secret, jwt, refresh, input.customKey]) expect(output).not.toContain(value);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("body");
  });

  it.each(["declared", "streamed"])("bounds %s response bodies to 1 MiB", async (kind) => {
    const response = kind === "declared" ? login({}, { "content-length": "1048577" }) : new Response(new Uint8Array(1_048_577));
    fetchMock.mockResolvedValueOnce(response);
    await expect(api.provisionSub2ApiKey(input)).rejects.toMatchObject({ code: "supply_provisioning_response_too_large", status: 502 });
  });

  it("aborts a request after 15 seconds with a sanitized timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(secret)), { once: true });
    }));
    const task = api.provisionSub2ApiKey(input);
    const assertion = expect(task).rejects.toMatchObject({ code: "supply_provisioning_timeout", status: 504 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
