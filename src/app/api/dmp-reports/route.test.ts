import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assignDmpBusinessReportsShop: vi.fn(),
  deleteDmpBusinessReport: vi.fn(),
  getDmpBusinessReport: vi.fn(),
  listDmpBusinessReportArchivePair: vi.fn(),
  listDmpBusinessReportSummaries: vi.fn(),
  resolveDmpReportRequestContext: vi.fn(),
  saveDmpBusinessReport: vi.fn(),
  validCategoryId: vi.fn(),
  validItemId: vi.fn(),
  validateDmpCanonicalReport: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dmp-report-store", () => ({
  DMP_REPORT_ARCHIVE_MAX_BODY_BYTES: 2 * 1024 * 1024 + 64 * 1024,
  assignDmpBusinessReportsShop: mocks.assignDmpBusinessReportsShop,
  deleteDmpBusinessReport: mocks.deleteDmpBusinessReport,
  getDmpBusinessReport: mocks.getDmpBusinessReport,
  listDmpBusinessReportArchivePair: mocks.listDmpBusinessReportArchivePair,
  listDmpBusinessReportSummaries: mocks.listDmpBusinessReportSummaries,
  resolveDmpReportRequestContext: mocks.resolveDmpReportRequestContext,
  saveDmpBusinessReport: mocks.saveDmpBusinessReport,
  validCategoryId: mocks.validCategoryId,
  validItemId: mocks.validItemId,
  validateDmpCanonicalReport: mocks.validateDmpCanonicalReport
}));

import { DELETE, GET, OPTIONS, PATCH, POST } from "./route";

const ACCESS = { userId: "user-a", tenantId: "tenant-a" };
const SHOP = { id: "shop-a", name: "西西礼" };
const CONTEXT = { ok: true as const, access: ACCESS, shop: SHOP };
const CANONICAL = {
  schema_version: "3.0" as const,
  title: "达摩盘商品成长竞品对标报告",
  item_id: "593063365092",
  period: "近30天",
  tables: [{
    name: "商品与成功品",
    columns: ["角色", "商品ID"],
    rows: [
      { cells: ["主体", "593063365092"] },
      { cells: ["目标对手", "623803508105"] }
    ]
  }]
};
const STORED = {
  id: "report-a",
  reportType: "growth" as const,
  shopId: SHOP.id,
  shopName: SHOP.name,
  subjectItemId: "593063365092",
  competitorItemId: "623803508105",
  period: "近30天",
  quality: "complete" as const,
  createdAt: "2026-08-30T00:00:00.000Z",
  report: CANONICAL
};

function extensionRequest(url: string, init: RequestInit = {}) {
  return new Request(url, {
    ...init,
    headers: {
      "x-sanjie-session": "extension-token",
      "x-sanjie-shop": SHOP.id,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
}

function archiveBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    report: CANONICAL,
    sourceVersion: "2.3.58",
    expectedShop: { officialShopId: SHOP.id, sourceShopId: "123456789012", shopName: SHOP.name },
    sourceShop: { shopId: SHOP.id, sourceShopId: "123456789012", shopName: SHOP.name },
    ...extra
  });
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.resolveDmpReportRequestContext.mockResolvedValue(CONTEXT);
  mocks.validCategoryId.mockImplementation((value: unknown) => /^\d{1,20}$/.test(String(value ?? "")));
  mocks.validItemId.mockImplementation((value: unknown) => /^\d{6,20}$/.test(String(value ?? "")));
  mocks.validateDmpCanonicalReport.mockReturnValue({ report: CANONICAL });
  mocks.saveDmpBusinessReport.mockResolvedValue(STORED);
});

describe("DMP report request context", () => {
  it("allows the explicit shop header in CORS preflight", () => {
    expect(OPTIONS().headers.get("access-control-allow-headers")).toContain("x-sanjie-shop");
  });

  it("lets the authenticated server resolve the extension default shop without borrowing a browser cookie", async () => {
    const response = await GET(new Request("https://shaozhuangai.com/api/dmp-reports?scope=archive-shop", {
      headers: {
        "x-sanjie-session": "extension-token",
        "x-sanjie-shop": "shop-old",
        cookie: "sanjie_active_shop=shop-cookie"
      }
    }));
    expect(mocks.resolveDmpReportRequestContext).toHaveBeenCalledWith({
      extensionToken: "extension-token",
      allowDefaultShop: true,
      shopId: ""
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { shop: SHOP } });
  });

  it("never lets a non-GET archive-shop query bypass the frozen shop header", async () => {
    mocks.resolveDmpReportRequestContext.mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: "SHOP_REQUIRED",
      error: "请先选择店铺"
    });
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports?scope=archive-shop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sanjie-session": "extension-token"
      },
      body: archiveBody()
    }));
    expect(mocks.resolveDmpReportRequestContext).toHaveBeenCalledWith({
      extensionToken: "extension-token",
      shopId: ""
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "SHOP_REQUIRED" });
    expect(mocks.saveDmpBusinessReport).not.toHaveBeenCalled();
  });

  it("never lets the archive-shop resolver double as a report detail request", async () => {
    const response = await GET(new Request(
      "https://shaozhuangai.com/api/dmp-reports?scope=archive-shop&id=report-a",
      { headers: { "x-sanjie-session": "extension-token" } }
    ));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_ARCHIVE_SHOP_SCOPE" });
    expect(mocks.resolveDmpReportRequestContext).not.toHaveBeenCalled();
    expect(mocks.getDmpBusinessReport).not.toHaveBeenCalled();
  });

  it("does not expose the default archive-shop resolver to a browser-only request", async () => {
    const response = await GET(new Request("https://shaozhuangai.com/api/dmp-reports?scope=archive-shop", {
      headers: { cookie: "sanjie_active_shop=shop-a" }
    }));
    expect(response.status).toBe(401);
    expect(mocks.resolveDmpReportRequestContext).not.toHaveBeenCalled();
  });

  it("passes the browser's explicit activity cookie to the strict resolver", async () => {
    mocks.listDmpBusinessReportSummaries.mockResolvedValue({
      summaries: [], page: 1, pageSize: 24, total: 0, totalPages: 0, hasNext: false
    });
    await GET(new Request("https://shaozhuangai.com/api/dmp-reports", {
      headers: { cookie: "foo=bar; sanjie_active_shop=shop-cookie" }
    }));
    expect(mocks.resolveDmpReportRequestContext).toHaveBeenCalledWith({
      browserHeaderShopId: "",
      browserCookieShopId: "shop-cookie"
    });
  });

  it("fails closed when a browser page header conflicts with the current activity cookie", async () => {
    mocks.resolveDmpReportRequestContext.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "SHOP_MISMATCH",
      error: "页面店铺与当前官网活动店铺不一致，请刷新后重试"
    });
    const response = await GET(new Request("https://shaozhuangai.com/api/dmp-reports?id=report-a", {
      headers: { "x-sanjie-shop": "shop-old", cookie: "sanjie_active_shop=shop-new" }
    }));
    expect(mocks.resolveDmpReportRequestContext).toHaveBeenCalledWith({
      browserHeaderShopId: "shop-old",
      browserCookieShopId: "shop-new"
    });
    expect(response.status).toBe(409);
    expect(mocks.getDmpBusinessReport).not.toHaveBeenCalled();
  });
});

describe("GET /api/dmp-reports", () => {
  it("returns a shop-scoped paginated summary list without report bodies", async () => {
    const summary = {
      id: "summary-a", reportType: "growth", shopId: SHOP.id, shopName: SHOP.name,
      subjectItemId: "593063365092", competitorItemId: "623803508105", period: "近30天",
      quality: "partial", createdAt: "2026-08-30T00:00:00.000Z", title: "商品报告",
      subjectThumbnail: { url: "", title: "主体" }, competitorThumbnail: { url: "", title: "竞品" }
    };
    mocks.listDmpBusinessReportSummaries.mockResolvedValue({
      summaries: [summary], page: 2, pageSize: 50, total: 51, totalPages: 2, hasNext: false
    });

    const response = await GET(extensionRequest("https://shaozhuangai.com/api/dmp-reports?page=2&pageSize=99"));
    expect(response.status).toBe(200);
    expect(mocks.listDmpBusinessReportSummaries).toHaveBeenCalledWith(ACCESS, {
      shopId: SHOP.id, page: 2, pageSize: 99
    });
    const body = await response.json();
    expect(body.data.pagination).toEqual({ page: 2, pageSize: 50, total: 51, totalPages: 2, hasNext: false });
    expect(body.data.reports).toEqual([summary]);
    expect(body.data.reports[0]).not.toHaveProperty("report");
  });

  it("loads one report body only by id and current shop", async () => {
    mocks.getDmpBusinessReport.mockResolvedValue(STORED);
    const response = await GET(extensionRequest("https://shaozhuangai.com/api/dmp-reports?id=report-a"));
    expect(response.status).toBe(200);
    expect(mocks.getDmpBusinessReport).toHaveBeenCalledWith(ACCESS, "report-a", SHOP.id);
  });

  it("keeps online-only download blocking after the scoped detail lookup", async () => {
    mocks.getDmpBusinessReport.mockResolvedValue(STORED);
    const response = await GET(extensionRequest("https://shaozhuangai.com/api/dmp-reports?id=report-a&format=xlsx"));
    expect(response.status).toBe(403);
  });

  it("returns only the requested shop and product pair for plugin archive merging", async () => {
    mocks.listDmpBusinessReportArchivePair.mockResolvedValue([STORED]);
    const response = await GET(extensionRequest(
      "https://shaozhuangai.com/api/dmp-reports?scope=archive-pair&reportType=growth&subjectItemId=593063365092&competitorItemId=623803508105&quality=complete"
    ));
    expect(response.status).toBe(200);
    expect(mocks.listDmpBusinessReportArchivePair).toHaveBeenCalledWith(ACCESS, {
      shopId: SHOP.id, reportType: "growth", subjectItemId: "593063365092",
      competitorItemId: "623803508105", quality: "complete"
    });
  });
});

describe("POST /api/dmp-reports", () => {
  it("requires header, expected shop, source shop and saved shop to be identical", async () => {
    const response = await POST(extensionRequest("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST", body: archiveBody()
    }));
    expect(response.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({
      access: ACCESS, shopId: SHOP.id, sourceShop: expect.objectContaining({ shopId: SHOP.id }),
      subjectItemId: "593063365092", competitorItemId: "623803508105"
    }));
  });

  it("rejects a mismatched expected or source shop before saving", async () => {
    const response = await POST(extensionRequest("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST", body: archiveBody({ expectedShop: { officialShopId: "shop-b" } })
    }));
    expect(response.status).toBe(409);
    expect(mocks.saveDmpBusinessReport).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "DMP_REPORT_SHOP_MISMATCH" });
  });

  it("archives normalized incomplete input as partial without adding a quality gate", async () => {
    mocks.validateDmpCanonicalReport.mockReturnValueOnce({ report: CANONICAL, issues: ["待补数据"] });
    const response = await POST(extensionRequest("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST", body: archiveBody({ quality: "complete" })
    }));
    expect(response.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({ quality: "partial" }));
  });

  it("returns confirmed atomic replacement retention", async () => {
    mocks.saveDmpBusinessReport.mockResolvedValueOnce({
      ...STORED,
      retention: {
        mode: "replace-latest-pair", confirmed: true, replacedReportId: "report-a",
        absorbedReportIds: ["report-a", "report-old"]
      }
    });
    const response = await POST(extensionRequest("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      body: archiveBody({
        archiveMode: "replace-latest-pair", replaceReportId: "report-a",
        absorbedReportIds: ["report-a", "report-old", "report-old"]
      })
    }));
    expect(response.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({
      replaceReportId: "report-a", absorbedReportIds: ["report-a", "report-old"]
    }));
  });

  it.each([
    ["DMP_REPORT_REPLACE_CONFLICT", "原报告范围冲突"],
    ["DMP_REPORT_HISTORY_STALE", "历史报告已变化"]
  ])("returns a coded 409 and never masks %s", async (code, message) => {
    mocks.saveDmpBusinessReport.mockRejectedValueOnce(Object.assign(new Error(message), { code, status: 409 }));
    const response = await POST(extensionRequest("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      body: archiveBody({ archiveMode: "replace-latest-pair", replaceReportId: "report-a", absorbedReportIds: ["report-a"] })
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: message, code });
  });

  it("keeps the archive body-size limit", async () => {
    const response = await POST(extensionRequest("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "content-length": String(2 * 1024 * 1024 + 64 * 1024 + 1) },
      body: "{}"
    }));
    expect(response.status).toBe(413);
  });
});

describe("PATCH and DELETE /api/dmp-reports", () => {
  it("moves an entire identity group from the current source shop", async () => {
    mocks.assignDmpBusinessReportsShop.mockResolvedValue({
      ok: true, reportIds: ["report-a", "report-old"], shop: { id: "shop-b", name: "店铺 B" }
    });
    const response = await PATCH(extensionRequest("https://shaozhuangai.com/api/dmp-reports", {
      method: "PATCH",
      body: JSON.stringify({
        sourceShopId: SHOP.id, targetShopId: "shop-b", reportType: "growth",
        subjectItemId: "593063365092", competitorItemId: "623803508105"
      })
    }));
    expect(response.status).toBe(200);
    expect(mocks.assignDmpBusinessReportsShop).toHaveBeenCalledWith({
      access: ACCESS, sourceShopId: SHOP.id, targetShopId: "shop-b", reportType: "growth",
      subjectItemId: "593063365092", competitorItemId: "623803508105"
    });
  });

  it("preserves the existing unclassified target while keeping source-shop scoping", async () => {
    mocks.assignDmpBusinessReportsShop.mockResolvedValue({ ok: true, reportIds: ["report-a"], shop: null });
    const response = await PATCH(extensionRequest("https://shaozhuangai.com/api/dmp-reports", {
      method: "PATCH",
      body: JSON.stringify({ sourceShopId: SHOP.id, targetShopId: "", reportIds: ["report-a"] })
    }));
    expect(response.status).toBe(200);
    expect(mocks.assignDmpBusinessReportsShop).toHaveBeenCalledWith(expect.objectContaining({
      sourceShopId: SHOP.id, targetShopId: "", reportIds: ["report-a"]
    }));
  });

  it("rejects a foreign source shop before assignment", async () => {
    const response = await PATCH(extensionRequest("https://shaozhuangai.com/api/dmp-reports", {
      method: "PATCH",
      body: JSON.stringify({ sourceShopId: "shop-foreign", targetShopId: "shop-b", reportIds: ["report-a"] })
    }));
    expect(response.status).toBe(409);
    expect(mocks.assignDmpBusinessReportsShop).not.toHaveBeenCalled();
  });

  it("deletes only from the current shop", async () => {
    mocks.deleteDmpBusinessReport.mockResolvedValue(true);
    const response = await DELETE(extensionRequest("https://shaozhuangai.com/api/dmp-reports?id=report-a", {
      method: "DELETE"
    }));
    expect(response.status).toBe(200);
    expect(mocks.deleteDmpBusinessReport).toHaveBeenCalledWith(ACCESS, "report-a", SHOP.id);
  });
});
