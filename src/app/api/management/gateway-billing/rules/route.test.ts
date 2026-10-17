import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayBillingError } from "@/lib/model-gateway/billing-contract";

const mocks = vi.hoisted(() => ({ user: vi.fn(), rules: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/server-session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/model-gateway/billing", () => ({ getGatewayBillingRules: mocks.rules, updateGatewayBillingRule: mocks.update }));
import { GET, PUT } from "./route";

const validInput = { planCode: "growth", multiplierBps: 12500, reason: "调整增长套餐扣费", expectedVersion: 3 };
const request = (body: unknown) => new Request("https://shaozhuangai.com/api/management/gateway-billing/rules", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
});

describe("administrator gateway billing rules API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user.mockResolvedValue({ id: "admin-1", authRole: "admin", role: "operator", status: "active" });
    mocks.rules.mockResolvedValue({ rules: [{ planCode: "growth", version: 3 }], audits: [] });
    mocks.update.mockResolvedValue({ rule: { planCode: "growth", multiplierBps: 12500, version: 4 }, audit: { id: "audit-1" } });
  });

  it.each([
    [null, 401],
    [{ id: "tenant", authRole: "tenant", role: "admin", status: "active" }, 403],
    [{ id: "disabled", authRole: "admin", status: "disabled" }, 403]
  ])("denies read and write before loading data for %j", async (user, status) => {
    mocks.user.mockResolvedValue(user);
    for (const response of [await GET(), await PUT(request(validInput))]) {
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.rules).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns rules and audits without caching to an active database admin", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ data: { rules: [{ planCode: "growth", version: 3 }], audits: [] } });
    expect(mocks.user).toHaveBeenCalledOnce();
  });

  it("writes with the session admin and exact optimistic version after trimming input", async () => {
    const response = await PUT(request({ ...validInput, planCode: " growth ", reason: " 调整增长套餐扣费 " }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("admin-1", validInput);
    expect(await response.json()).toEqual({ data: { rule: { planCode: "growth", multiplierBps: 12500, version: 4 }, audit: { id: "audit-1" } } });
  });

  it.each([100, 1_000_000])("accepts the exact basis-point boundary %i", async (multiplierBps) => {
    expect((await PUT(request({ ...validInput, multiplierBps, expectedVersion: 0 }))).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("admin-1", { ...validInput, multiplierBps, expectedVersion: 0 });
  });

  it.each([
    null, [], {},
    { ...validInput, multiplierBps: 99 },
    { ...validInput, multiplierBps: 1_000_001 },
    { ...validInput, multiplierBps: 10000.5 },
    { ...validInput, multiplierBps: "12500" },
    { ...validInput, reason: " \t " },
    { ...validInput, reason: "短" },
    { ...validInput, reason: "a".repeat(501) },
    { ...validInput, reason: "理由\u0000" },
    { ...validInput, expectedVersion: undefined },
    { ...validInput, expectedVersion: -1 },
    { ...validInput, expectedVersion: 2.5 },
    { ...validInput, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...validInput, planCode: "" },
    { ...validInput, planCode: "a".repeat(81) },
    { ...validInput, adminId: "spoofed-admin" }
  ])("rejects invalid or authority-spoofing rule bodies: %j", async (body) => {
    const response = await PUT(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_RULE" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and oversized actual UTF-8 bytes before persistence", async () => {
    const malformed = new Request("https://shaozhuangai.com/api/management/gateway-billing/rules", { method: "PUT", body: "{" });
    expect((await PUT(malformed)).status).toBe(400);
    const large = request({ ...validInput, reason: "汉".repeat(1500) });
    large.headers.set("content-length", "1");
    const response = await PUT(large);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns a version conflict so a stale editor cannot silently overwrite a rule", async () => {
    mocks.update.mockRejectedValue(new GatewayBillingError("RULE_VERSION_CONFLICT", "规则已被其他管理员更新，请刷新后重试", 409));
    const response = await PUT(request(validInput));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "规则已被其他管理员更新，请刷新后重试", code: "RULE_VERSION_CONFLICT" });
    expect(mocks.update).toHaveBeenCalledWith("admin-1", validInput);
  });

  it("hides database, session and body-stream exceptions behind explicit JSON service errors", async () => {
    mocks.rules.mockRejectedValue(new Error("postgres://secret@private/database"));
    const read = await GET();
    expect(read.status).toBe(503);
    expect(JSON.stringify(await read.json())).not.toContain("secret");
    mocks.update.mockRejectedValue(new Error("apiKey=private-secret"));
    const write = await PUT(request(validInput));
    expect(write.status).toBe(503);
    expect(JSON.stringify(await write.json())).not.toContain("private-secret");
    const brokenStream = new Request("https://shaozhuangai.com/api/management/gateway-billing/rules", {
      method: "PUT", duplex: "half",
      body: new ReadableStream({ start(controller) { controller.error(new Error("stream private-secret")); } })
    } as RequestInit & { duplex: "half" });
    const streamFailure = await PUT(brokenStream);
    expect(streamFailure.status).toBe(503);
    expect(JSON.stringify(await streamFailure.json())).not.toContain("private-secret");
    mocks.user.mockRejectedValue(new Error("session private-secret"));
    for (const response of [await GET(), await PUT(request(validInput))]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({ code: "BILLING_SERVICE_UNAVAILABLE" });
    }
  });
});
