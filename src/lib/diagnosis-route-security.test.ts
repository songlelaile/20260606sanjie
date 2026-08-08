import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireShopScope: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/store/runtime-store", () => ({
  requireShopScope: mocks.requireShopScope
}));

import {
  diagnosisJson,
  requireAiProviderExecutionAccess,
  requireDiagnosisApiAccess
} from "@/lib/diagnosis-route-security";

describe("diagnosis route security", () => {
  beforeEach(() => {
    mocks.requireShopScope.mockReset();
    mocks.requireShopScope.mockResolvedValue({
      tenantId: "tenant-a",
      shopId: "shop-a",
      user: { role: "operator" },
      isAdmin: false
    });
  });

  it("allows only the server-resolved current tenant shop scope", async () => {
    await expect(requireDiagnosisApiAccess()).resolves.toBeNull();
    expect(mocks.requireShopScope).toHaveBeenCalledWith();
  });

  it("fails closed when account, tenant or database scope validation fails", async () => {
    mocks.requireShopScope.mockRejectedValueOnce(new Error("stale tenant"));
    const response = await requireDiagnosisApiAccess();
    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("vary")).toBe("Cookie");
  });

  it("marks successful diagnostic payloads private and non-cacheable", () => {
    const response = diagnosisJson({ data: { ok: true } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("keeps viewers read-only and protects credential changes", async () => {
    mocks.requireShopScope.mockResolvedValueOnce({
      tenantId: "tenant-a",
      shopId: "shop-a",
      user: { role: "viewer" },
      isAdmin: false
    });
    expect((await requireDiagnosisApiAccess("write"))?.status).toBe(403);

    mocks.requireShopScope.mockResolvedValueOnce({
      tenantId: "tenant-a",
      shopId: "shop-a",
      user: { role: "operator" },
      isAdmin: false
    });
    expect((await requireDiagnosisApiAccess("credentials"))?.status).toBe(403);

    mocks.requireShopScope.mockResolvedValueOnce({
      tenantId: "tenant-a",
      shopId: "shop-a",
      user: { role: "owner" },
      isAdmin: false
    });
    await expect(requireDiagnosisApiAccess("credentials")).resolves.toBeNull();
  });

  it("fails closed for unknown persisted roles", async () => {
    mocks.requireShopScope.mockResolvedValue({
      tenantId: "tenant-a",
      shopId: "shop-a",
      user: { role: "legacy-role" },
      isAdmin: false
    });

    expect((await requireDiagnosisApiAccess())?.status).toBe(403);
    expect((await requireDiagnosisApiAccess("write"))?.status).toBe(403);
    expect((await requireDiagnosisApiAccess("credentials"))?.status).toBe(403);
  });

  it("limits custom gateway execution to credential managers", async () => {
    await expect(requireAiProviderExecutionAccess("deepseek")).resolves.toBeNull();
    const operatorResponse = await requireAiProviderExecutionAccess("custom");
    expect(operatorResponse?.status).toBe(403);
    await expect(operatorResponse?.json()).resolves.toMatchObject({
      error: expect.stringContaining("自定义 AI 网关")
    });

    mocks.requireShopScope.mockResolvedValueOnce({
      tenantId: "tenant-a",
      shopId: "shop-a",
      user: { role: "owner" },
      isAdmin: false
    });
    await expect(requireAiProviderExecutionAccess("custom")).resolves.toBeNull();
  });
});
