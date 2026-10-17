import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createDmpReportShare: vi.fn(),
  resolveDmpReportRequestContext: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dmp-report-share", () => ({ createDmpReportShare: mocks.createDmpReportShare }));
vi.mock("@/lib/dmp-report-store", () => ({
  resolveDmpReportRequestContext: mocks.resolveDmpReportRequestContext
}));

import { POST } from "./route";

describe("POST /api/dmp-report-shares strict shop context", () => {
  beforeEach(() => {
    mocks.createDmpReportShare.mockReset();
    mocks.resolveDmpReportRequestContext.mockReset();
  });

  it("fails closed when a browser page header conflicts with its current activity cookie", async () => {
    mocks.resolveDmpReportRequestContext.mockResolvedValue({
      ok: false,
      status: 409,
      code: "SHOP_MISMATCH",
      error: "页面店铺与当前官网活动店铺不一致，请刷新后重试"
    });
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-report-shares", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sanjie-shop": "shop-old",
        cookie: "sanjie_active_shop=shop-new"
      },
      body: JSON.stringify({ reportId: "report-a" })
    }));

    expect(mocks.resolveDmpReportRequestContext).toHaveBeenCalledWith({
      browserHeaderShopId: "shop-old",
      browserCookieShopId: "shop-new"
    });
    expect(response.status).toBe(409);
    expect(mocks.createDmpReportShare).not.toHaveBeenCalled();
  });

  it("uses only the extension header even when an unrelated browser cookie is present", async () => {
    mocks.resolveDmpReportRequestContext.mockResolvedValue({
      ok: true,
      access: { tenantId: "tenant-a", userId: "user-a" },
      shop: { id: "shop-a", name: "店铺 A" }
    });
    mocks.createDmpReportShare.mockResolvedValue({
      id: "share-a",
      path: "/shared/dmp-reports/token",
      createdAt: "2026-08-30T00:00:00.000Z"
    });
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-report-shares", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sanjie-session": "token",
        "x-sanjie-shop": "shop-a",
        cookie: "sanjie_active_shop=shop-b"
      },
      body: JSON.stringify({ reportId: "report-a" })
    }));
    expect(response.status).toBe(201);
    expect(mocks.resolveDmpReportRequestContext).toHaveBeenCalledWith({
      extensionToken: "token",
      shopId: "shop-a"
    });
    expect(mocks.createDmpReportShare).toHaveBeenCalledWith(
      { tenantId: "tenant-a", userId: "user-a" }, "report-a", "shop-a"
    );
  });
});
