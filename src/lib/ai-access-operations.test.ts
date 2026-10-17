import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIAccessAuthorization } from "./ai-access";
import { resolveAiAccessOperation, type AiAccessOperation } from "./ai-access-operation-policy";

const mocks = vi.hoisted(() => {
  class AccessError extends Error {
    constructor(readonly code: string, message: string, readonly status = 503) { super(message); }
  }
  return { Error: AccessError, shops: vi.fn(), shop: vi.fn(), setShop: vi.fn(), creative: vi.fn(),
    entitlement: vi.fn(), report: vi.fn(), summaries: vi.fn(), models: vi.fn() };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ prisma: { shop: { findMany: mocks.shops, findFirst: mocks.shop } } }));
vi.mock("@/lib/ai-access", () => ({ AIAccessError: mocks.Error, setAIAccessActiveShop: mocks.setShop }));
vi.mock("@/lib/creative-entitlements", () => ({ getCreativeAccessForSession: mocks.creative }));
vi.mock("@/lib/tool-entitlements", () => ({ getDmpAutomationAccessForSession: mocks.entitlement }));
vi.mock("@/lib/ai-access-production-reports", () => ({ getDmpBusinessReport: mocks.report, listDmpBusinessReportSummaries: mocks.summaries }));
const modelData = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("@/lib/model-gateway/catalog", () => ({ get GATEWAY_MODELS() { mocks.models(); return modelData.rows; } }));
import { executeAiAccessOperation } from "./ai-access-operations";

const auth: AIAccessAuthorization = { grantId: "grant-a", userId: "user-a", username: "admin-a", tenantId: "tenant-a", scope: "action", activeShopId: "shop-a" };
const session = { username: auth.username, tenantId: auth.tenantId, role: "admin", name: auth.username };
function operation(method: string, path: string, body?: { shopId: string }): AiAccessOperation {
  const resolved = resolveAiAccessOperation(body ? { method, path, body } : { method, path });
  if (!resolved.allowed) throw new Error("Invalid test operation: " + path);
  return resolved.operation;
}

describe("AI operations dispatch to scoped services without a credential proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shop.mockResolvedValue({ id: "shop-a" });
    mocks.shops.mockResolvedValue([{ id: "shop-a", name: "店铺甲", platform: "taobao" }]);
    mocks.creative.mockResolvedValue({ allowed: true, reason: "admin", expiresAt: null });
    mocks.entitlement.mockResolvedValue({ allowed: true });
    mocks.report.mockResolvedValue({ id: "report-a", shopId: "shop-a", subjectItemId: "item-a" });
    mocks.summaries.mockResolvedValue({ summaries: [{ id: "report-a" }], page: 2, pageSize: 3, total: 4, totalPages: 2, hasNext: false });
    mocks.setShop.mockResolvedValue({ ...auth, activeShopId: "shop-b" });
  });

  it("returns a minimal channel identity without account or tenant secrets", async () => {
    const result = await executeAiAccessOperation(operation("GET", "/api/auth/me"), auth);
    expect(result).toEqual({ role: "admin", channel: "ai-access", scope: "action", activeShopId: "shop-a" });
    expect(JSON.stringify(result)).not.toMatch(/admin-a|tenant-a|user-a|grant-a/);
    expect(mocks.shops).not.toHaveBeenCalled(); expect(mocks.models).not.toHaveBeenCalled();
  });

  it("derives creative authorization from the token actor, without a web-session fallback", async () => {
    expect(await executeAiAccessOperation(operation("GET", "/api/auth/creative-access"), auth)).toEqual({ access: { allowed: true, reason: "admin", expiresAt: null } });
    expect(mocks.creative).toHaveBeenCalledWith(session);
  });

  it("selects only public shop fields and limits the database query to the grant tenant", async () => {
    const rows = [
      { id: "shop-a", name: "店铺甲", platform: "taobao", tenantId: "tenant-a", providerKey: "private-a" },
      { id: "shop-x", name: "外部店铺", platform: "taobao", tenantId: "tenant-x", providerKey: "private-x" }
    ];
    mocks.shops.mockImplementation(async ({ where, select }) => rows.filter(row => row.tenantId === where.tenantId)
      .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => select[key]))));
    const result = await executeAiAccessOperation(operation("GET", "/api/shops"), auth);
    expect(mocks.shops).toHaveBeenCalledWith({ where: { tenantId: "tenant-a" }, select: { id: true, name: true, platform: true }, orderBy: { createdAt: "asc" } });
    expect(result).toEqual({ shops: [{ id: "shop-a", name: "店铺甲", platform: "taobao" }], activeShopId: "shop-a" });
    expect(JSON.stringify(result)).not.toMatch(/tenant-a|tenant-x|private-|shop-x/);
  });

  it("filters model output to public IDs and labels, removing upstream keys, env names and URLs", async () => {
    modelData.rows = [{ id: "model-a", label: "模型甲", kind: "image", provider: "shaozhuang", upstreamModel: "private-upstream-model",
      apiKeyEnv: "PRIVATE_PROVIDER_API_KEY", baseUrlEnv: "PRIVATE_PROVIDER_BASE_URL", defaultBaseUrl: "https://private-provider.test/v1",
      apiKey: "private-api-key", key: "private-key", config: { token: "private-config-token" } }];
    const result = await executeAiAccessOperation(operation("GET", "/api/v1/models"), auth);
    expect(result).toEqual({ models: [{ id: "model-a", label: "模型甲", kind: "image", provider: "shaozhuang" }] });
    expect(JSON.stringify(result)).not.toMatch(/private|PRIVATE|upstream|apiKey|baseUrl|config/);
    expect(mocks.models).toHaveBeenCalledOnce();
  });

  it("switches only the token's independent shop context and returns no user snapshot", async () => {
    const result = await executeAiAccessOperation(operation("PATCH", "/api/shops/active", { shopId: "shop-b" }), auth);
    expect(mocks.setShop).toHaveBeenCalledWith(auth, "shop-b");
    expect(result).toEqual({ activeShopId: "shop-b" });
    expect(mocks.shops).not.toHaveBeenCalled(); expect(mocks.shop).not.toHaveBeenCalled();
  });

  it.each(["/api/dmp-reports", "/api/dmp-reports?id=report-a"])("does not fall back to an arbitrary shop when no grant shop exists: %s", async path => {
    await expect(executeAiAccessOperation(operation("GET", path), { ...auth, activeShopId: null })).rejects.toMatchObject({ code: "SHOP_REQUIRED", status: 409 });
    expect(mocks.shop).not.toHaveBeenCalled(); expect(mocks.shops).not.toHaveBeenCalled();
    expect(mocks.entitlement).not.toHaveBeenCalled(); expect(mocks.report).not.toHaveBeenCalled(); expect(mocks.summaries).not.toHaveBeenCalled();
  });

  it("rejects a grant shop removed from its original tenant without another shop lookup", async () => {
    mocks.shop.mockResolvedValue(null);
    await expect(executeAiAccessOperation(operation("GET", "/api/dmp-reports?id=report-a"), auth)).rejects.toMatchObject({ code: "SHOP_INVALID", status: 403 });
    expect(mocks.shop).toHaveBeenCalledOnce();
    expect(mocks.shop).toHaveBeenCalledWith({ where: { id: "shop-a", tenantId: "tenant-a" }, select: { id: true } });
    expect(mocks.shops).not.toHaveBeenCalled(); expect(mocks.report).not.toHaveBeenCalled(); expect(mocks.entitlement).not.toHaveBeenCalled();
  });

  it("requires current DMP entitlement before retrieving any report", async () => {
    mocks.entitlement.mockResolvedValue({ allowed: false });
    await expect(executeAiAccessOperation(operation("GET", "/api/dmp-reports?id=report-a"), auth)).rejects.toMatchObject({ code: "DMP_ACCESS_REQUIRED", status: 403 });
    expect(mocks.entitlement).toHaveBeenCalledWith(session);
    expect(mocks.report).not.toHaveBeenCalled(); expect(mocks.summaries).not.toHaveBeenCalled();
  });

  it("passes exact report ID, grant user, tenant and shop to the canonical report service", async () => {
    expect(await executeAiAccessOperation(operation("GET", "/api/dmp-reports?id=report-a"), auth)).toEqual({ report: { id: "report-a", shopId: "shop-a", subjectItemId: "item-a" } });
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith({ userId: "user-a", tenantId: "tenant-a" }, "report-a", "shop-a");
    expect(mocks.summaries).not.toHaveBeenCalled(); expect(mocks.shops).not.toHaveBeenCalled();
  });

  it("returns 404 on an exact report miss without substituting another report or shop", async () => {
    mocks.report.mockResolvedValue(null);
    await expect(executeAiAccessOperation(operation("GET", "/api/dmp-reports?id=missing-report"), auth)).rejects.toMatchObject({ code: "REPORT_NOT_FOUND", status: 404 });
    expect(mocks.report).toHaveBeenCalledExactlyOnceWith({ userId: "user-a", tenantId: "tenant-a" }, "missing-report", "shop-a");
    expect(mocks.summaries).not.toHaveBeenCalled(); expect(mocks.shops).not.toHaveBeenCalled();
  });

  it("lists only the exact grant shop with bounded pagination and a minimal receipt", async () => {
    const result = await executeAiAccessOperation(operation("GET", "/api/dmp-reports?page=2&pageSize=3"), auth);
    expect(mocks.summaries).toHaveBeenCalledExactlyOnceWith({ userId: "user-a", tenantId: "tenant-a" }, { shopId: "shop-a", page: 2, pageSize: 3 });
    expect(result).toEqual({ reports: [{ id: "report-a" }], pagination: { page: 2, pageSize: 3, total: 4, totalPages: 2, hasNext: false } });
    expect(mocks.report).not.toHaveBeenCalled(); expect(mocks.shops).not.toHaveBeenCalled();
  });

  it("propagates a service failure instead of manufacturing an empty success", async () => {
    mocks.entitlement.mockRejectedValue(new Error("report entitlement unavailable"));
    await expect(executeAiAccessOperation(operation("GET", "/api/dmp-reports"), auth)).rejects.toThrow("report entitlement unavailable");
    expect(mocks.report).not.toHaveBeenCalled(); expect(mocks.summaries).not.toHaveBeenCalled();
  });
});
