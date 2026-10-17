import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";

const mocks = vi.hoisted(() => ({ user: vi.fn(), overview: vi.fn(), gift: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/credit-gifts", () => ({ getGatewayCreditGiftOverview: mocks.overview, giftGatewayCredits: mocks.gift }));
import { GET, POST } from "./route";

const url = "https://shaozhuangai.com/api/management/credit-gifts";
const validInput = {
  userId: "tenant-user-1",
  points: "12.3",
  reason: "管理员活动赠送",
  requestKey: "123e4567-e89b-42d3-a456-426614174000"
};
const parsedInput = { ...validInput };
const supportedOriginHeaders: Record<string, string>[] = [
  { origin: "https://shaozhuangai.com" },
  { origin: "https://www.shaozhuangai.com" },
  { "sec-fetch-site": "same-origin" },
  {}
];
const request = (body: unknown, headers: Record<string, string> = { origin: "https://shaozhuangai.com" }) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const expectPrivate = (response: Response) => expect(response.headers.get("cache-control")).toBe("private, no-store");

describe("administrator credit gift API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
    mocks.user.mockResolvedValue({ id: "admin-1", authRole: "admin", role: "operator", status: "active" });
    mocks.overview.mockResolvedValue({ pool: { ready: false, balanceCents: null, balancePoints: null }, gifts: [] });
    mocks.gift.mockResolvedValue({ id: "gift-1", points: "12.3", requestKey: validInput.requestKey });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [null, 401, "AUTH_REQUIRED"],
    [{ id: "tenant", authRole: "tenant", role: "admin", status: "active" }, 403, "ADMIN_REQUIRED"],
    [{ id: "operator", role: "admin", status: "active" }, 403, "ADMIN_REQUIRED"],
    [{ id: "disabled", authRole: "admin", status: "disabled" }, 403, "ADMIN_REQUIRED"]
  ])("denies reads and gifts for an unauthorized account %j", async (user, status, code) => {
    mocks.user.mockResolvedValue(user);
    for (const response of [await GET(), await POST(request(validInput))]) {
      expect(response.status).toBe(status);
      expectPrivate(response);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(mocks.overview).not.toHaveBeenCalled();
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it("returns the unconfigured pool as unavailable with null balances", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({ data: { pool: { ready: false, balanceCents: null, balancePoints: null }, gifts: [] } });
    expect(mocks.user).toHaveBeenCalledOnce();
    expect(mocks.overview).toHaveBeenCalledOnce();
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it("passes configured balances and existing gift records through without changing their values", async () => {
    const overview = { pool: { ready: true, balanceCents: 777, balancePoints: 77.7 }, gifts: [{ id: "gift-existing", amountCents: 123 }] };
    mocks.overview.mockResolvedValue(overview);
    const response = await GET();
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(await response.json()).toEqual({ data: overview });
  });

  it.each(["uninitialized", "pending", "invalid", "ready"])("passes the explicit %s GET state through without a financial write", async (state) => {
    const ready = state === "ready";
    const overview = { pool: { state, ready, balanceCents: ready ? 0 : null, balancePoints: ready ? 0 : null }, gifts: [] };
    mocks.overview.mockResolvedValueOnce(overview);
    const response = await GET();
    expect(response.status).toBe(200); expectPrivate(response);
    expect(await response.json()).toEqual({ data: overview });
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it("returns a safe failed-read response instead of claiming the pool is uninitialized", async () => {
    mocks.overview.mockRejectedValueOnce(new Error("private isolated database address"));
    const response = await GET();
    expect(response.status).toBe(503); expectPrivate(response);
    const body = await response.json();
    expect(body.code).toBe("BILLING_SERVICE_UNAVAILABLE");
    expect(body).not.toHaveProperty("data");
    expect(JSON.stringify(body)).not.toContain("private isolated database address");
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it("writes with the current authenticated admin, normalized points and the supplied idempotency key", async () => {
    const response = await POST(request({
      ...validInput,
      userId: " tenant-user-1 ",
      points: " 12.3 ",
      reason: " 管理员活动赠送 ",
      requestKey: validInput.requestKey.toUpperCase()
    }));
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(mocks.gift).toHaveBeenCalledExactlyOnceWith("admin-1", parsedInput);
    expect(await response.json()).toEqual({ data: { id: "gift-1", points: "12.3", requestKey: validInput.requestKey } });
  });

  it("rechecks the real account on every request, including after the admin is disabled", async () => {
    expect((await POST(request(validInput))).status).toBe(200);
    mocks.user.mockResolvedValue({ id: "admin-1", authRole: "admin", status: "disabled" });
    expect((await GET()).status).toBe(403);
    expect((await POST(request(validInput))).status).toBe(403);
    expect(mocks.user).toHaveBeenCalledTimes(3);
    expect(mocks.gift).toHaveBeenCalledOnce();
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example",
    "null",
    "http://shaozhuangai.com",
    "https://shaozhuangai.com.evil.example",
    "https://sub.shaozhuangai.com",
    "https://shaozhuangai.com/path"
  ])("rejects a foreign or malformed Origin %s before gifting", async (origin) => {
    const response = await POST(request(validInput, { origin, host: "evil.example", "x-forwarded-host": "evil.example", "sec-fetch-site": "same-origin", "x-sanjie-session": "forged-token" }));
    expect(response.status).toBe(403);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: "跨站操作被拒绝", code: "CROSS_SITE_REQUEST" });
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it.each(["cross-site", "same-site", "none"])("rejects missing Origin with browser fetch metadata %s", async (site) => {
    const response = await POST(request(validInput, { "sec-fetch-site": site }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CROSS_SITE_REQUEST" });
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it.each(supportedOriginHeaders)("retains supported same-origin and authenticated non-browser requests %j", async (headers) => {
    expect((await POST(request(validInput, headers))).status).toBe(200);
    expect(mocks.gift).toHaveBeenCalledExactlyOnceWith("admin-1", parsedInput);
  });

  it("uses configured staging origin even if forwarding headers suggest a different origin", async () => {
    vi.stubEnv("PUBLIC_APP_ORIGIN", "https://uat.example.com");
    expect((await POST(request(validInput, { origin: "https://uat.example.com", host: "evil.example" }))).status).toBe(200);
    expect((await POST(request(validInput))).status).toBe(403);
    expect(mocks.gift).toHaveBeenCalledOnce();
  });

  it.each([
    [], {},
    { ...validInput, userId: "" },
    { ...validInput, userId: "tenant\u0000user" },
    { ...validInput, points: 12.3 },
    { ...validInput, points: "0" },
    { ...validInput, points: "-1" },
    { ...validInput, points: "1e2" },
    { ...validInput, points: "1.23" },
    { ...validInput, reason: " \t " },
    { ...validInput, reason: "赠送\u0000理由" },
    { ...validInput, reason: "a".repeat(501) },
    { ...validInput, requestKey: undefined },
    { ...validInput, requestKey: "same-request" },
    { ...validInput, adminId: "spoofed-admin" },
    { ...validInput, tenantId: "spoofed-tenant" },
    { ...validInput, poolId: "spoofed-pool" },
    { ...validInput, poolBalanceCents: 999999 },
    { ...validInput, amountCents: 1 },
    { ...validInput, amount: "1" },
    { ...validInput, balancePoints: "9999" }
  ])("rejects invalid or authority-spoofing bodies %j", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect((await response.json()).code).toMatch(/^INVALID_GIFT_/u);
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it.each(["{", "null", "{\"reason\":\"secret\""])("returns a safe JSON error for malformed/non-object JSON %s", async (body) => {
    const response = await POST(new Request(url, { method: "POST", headers: { origin: "https://shaozhuangai.com" }, body }));
    expect(response.status).toBe(400);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: "赠送积分请求必须是有效的 JSON 对象", code: "INVALID_JSON" });
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it("enforces the 4 KiB limit using actual UTF-8 bytes even with a forged content length", async () => {
    const large = request({ ...validInput, reason: "汉".repeat(1500) });
    large.headers.set("content-length", "1");
    const response = await POST(large);
    expect(response.status).toBe(413);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: "赠送积分请求不能超过 4 KiB", code: "REQUEST_TOO_LARGE" });
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body without calling the gift service", async () => {
    const response = await POST(request(validInput, { origin: "https://shaozhuangai.com", "content-length": "4097" }));
    expect(response.status).toBe(413);
    expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(mocks.gift).not.toHaveBeenCalled();
  });

  it.each([
    ["CREDIT_POOL_NOT_READY", "总积分池尚未配置，暂时不能赠送"],
    ["INSUFFICIENT_POOL_BALANCE", "总积分池余额不足"],
    ["GIFT_REQUEST_CONFLICT", "该请求已用于其他赠送，请重新提交"]
  ])("retains the actionable pool or idempotency conflict %s", async (code, message) => {
    mocks.gift.mockRejectedValue(new GatewayBillingError(code, message, 409));
    const response = await POST(request(validInput));
    expect(response.status).toBe(409);
    expectPrivate(response);
    expect(await response.json()).toEqual({ error: message, code });
    expect(mocks.gift).toHaveBeenCalledExactlyOnceWith("admin-1", parsedInput);
  });

  it("passes the same idempotency key to the service when a response is retried", async () => {
    for (const response of [await POST(request(validInput)), await POST(request(validInput))]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { id: "gift-1", requestKey: validInput.requestKey } });
    }
    expect(mocks.gift.mock.calls).toEqual([["admin-1", parsedInput], ["admin-1", parsedInput]]);
  });

  it("does not expose database, session, or body-stream failures", async () => {
    mocks.overview.mockRejectedValue(new Error("postgres://private-secret@database"));
    const read = await GET();
    mocks.gift.mockRejectedValue(new Error("apiKey=private-secret"));
    const write = await POST(request(validInput));
    const brokenStream = new Request(url, {
      method: "POST", headers: { origin: "https://shaozhuangai.com" }, duplex: "half",
      body: new ReadableStream({ start(controller) { controller.error(new Error("stream private-secret")); } })
    } as RequestInit & { duplex: "half" });
    const streamFailure = await POST(brokenStream);
    mocks.user.mockRejectedValue(new Error("session private-secret"));
    for (const response of [read, write, streamFailure, await GET(), await POST(request(validInput))]) {
      expect(response.status).toBe(503);
      expectPrivate(response);
      const result = await response.json();
      expect(result).toMatchObject({ code: "BILLING_SERVICE_UNAVAILABLE" });
      expect(JSON.stringify(result)).not.toContain("private-secret");
    }
  });
});
