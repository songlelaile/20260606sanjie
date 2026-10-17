import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assignDmpBusinessReportsShop: vi.fn(),
  getDmpDefaultArchiveShop: vi.fn(),
  getDmpBusinessReport: vi.fn(),
  getDmpReportAccess: vi.fn(),
  getDmpReportAccessFromToken: vi.fn(),
  listDmpBusinessReportArchivePair: vi.fn(),
  listDmpBusinessReports: vi.fn(),
  saveDmpBusinessReport: vi.fn(),
  validCategoryId: vi.fn(),
  validItemId: vi.fn(),
  validateDmpCanonicalReport: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dmp-report-store", () => ({
  DMP_REPORT_ARCHIVE_MAX_BODY_BYTES: 8 * 1024 * 1024 + 64 * 1024,
  assignDmpBusinessReportsShop: mocks.assignDmpBusinessReportsShop,
  deleteDmpBusinessReport: vi.fn(),
  getDmpDefaultArchiveShop: mocks.getDmpDefaultArchiveShop,
  getDmpBusinessReport: mocks.getDmpBusinessReport,
  getDmpReportAccess: mocks.getDmpReportAccess,
  getDmpReportAccessFromToken: mocks.getDmpReportAccessFromToken,
  listDmpBusinessReportArchivePair: mocks.listDmpBusinessReportArchivePair,
  listDmpBusinessReports: mocks.listDmpBusinessReports,
  saveDmpBusinessReport: mocks.saveDmpBusinessReport,
  validCategoryId: mocks.validCategoryId,
  validItemId: mocks.validItemId,
  validateDmpCanonicalReport: mocks.validateDmpCanonicalReport
}));

import { GET, OPTIONS, PATCH, POST } from "./route";

const ACCESS = { userId: "user-a", tenantId: "tenant-a" };
const REPORT = {
  id: "report-a",
  subjectItemId: "593063365092",
  competitorItemId: "623803508105",
  period: "近30天",
  quality: "complete",
  createdAt: "2026-08-15T00:00:00.000Z",
  report: { schema_version: "3.0", title: "报告", item_id: "593063365092", period: "近30天", tables: [] }
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/dmp-reports online-only policy", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getDmpReportAccess.mockResolvedValue(ACCESS);
    mocks.getDmpReportAccessFromToken.mockResolvedValue(ACCESS);
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
    mocks.getDmpBusinessReport.mockResolvedValue(REPORT);
  });

  it("blocks Excel downloads while reports are online-only", async () => {
    const response = await GET(new Request("https://shaozhuangai.com/api/dmp-reports?id=report-a&format=xlsx"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "当前版本仅支持官网在线查看，暂不提供数据下载" });
  });

  it("blocks CSV downloads while reports are online-only", async () => {
    const response = await GET(new Request("https://shaozhuangai.com/api/dmp-reports?id=report-a&format=csv"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "当前版本仅支持官网在线查看，暂不提供数据下载" });
  });
});

describe("GET /api/dmp-reports default archive shop", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getDmpReportAccessFromToken.mockResolvedValue(ACCESS);
    mocks.getDmpDefaultArchiveShop.mockResolvedValue({ id: "shop-default", name: "西西礼" });
  });

  it("allows the frozen shop header in CORS preflight", () => {
    expect(OPTIONS().headers.get("access-control-allow-headers")).toContain("x-sanjie-shop");
  });

  it("resolves the account default shop from the extension token and ignores an old shop header", async () => {
    const response = await GET(new Request(
      "https://shaozhuangai.com/api/dmp-reports?scope=archive-shop",
      { headers: { "x-sanjie-session": "extension-token", "x-sanjie-shop": "shop-old" } }
    ));

    expect(response.status).toBe(200);
    expect(mocks.getDmpReportAccessFromToken).toHaveBeenCalledWith("extension-token");
    expect(mocks.getDmpDefaultArchiveShop).toHaveBeenCalledWith(ACCESS);
    expect(mocks.listDmpBusinessReports).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ data: { shop: { id: "shop-default", name: "西西礼" } } });
  });

  it("does not expose the resolver to a browser-only request", async () => {
    const response = await GET(new Request(
      "https://shaozhuangai.com/api/dmp-reports?scope=archive-shop",
      { headers: { cookie: "sanjie_active_shop=shop-old" } }
    ));

    expect(response.status).toBe(401);
    expect(mocks.getDmpReportAccess).not.toHaveBeenCalled();
    expect(mocks.getDmpDefaultArchiveShop).not.toHaveBeenCalled();
  });

  it("rejects a mixed archive-shop and report-detail request before authentication", async () => {
    const response = await GET(new Request(
      "https://shaozhuangai.com/api/dmp-reports?scope=archive-shop&id=report-a",
      { headers: { "x-sanjie-session": "extension-token" } }
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_ARCHIVE_SHOP_SCOPE" });
    expect(mocks.getDmpReportAccessFromToken).not.toHaveBeenCalled();
    expect(mocks.getDmpBusinessReport).not.toHaveBeenCalled();
  });
});

describe("GET /api/dmp-reports archive pair", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getDmpReportAccessFromToken.mockResolvedValue(ACCESS);
    mocks.validCategoryId.mockImplementation((value: unknown) => /^\d{1,20}$/.test(String(value ?? "")));
    mocks.validItemId.mockImplementation((value: unknown) => /^\d{6,20}$/.test(String(value ?? "")));
    mocks.listDmpBusinessReportArchivePair.mockResolvedValue([REPORT]);
  });

  it("returns only the frozen shop and requested product pair", async () => {
    const response = await GET(new Request(
      "https://shaozhuangai.com/api/dmp-reports?scope=archive-pair&reportType=growth&subjectItemId=593063365092&competitorItemId=623803508105&quality=complete",
      { headers: { "x-sanjie-session": "extension-token", "x-sanjie-shop": "shop-default" } }
    ));

    expect(response.status).toBe(200);
    expect(mocks.listDmpBusinessReportArchivePair).toHaveBeenCalledWith(ACCESS, {
      shopId: "shop-default",
      reportType: "growth",
      subjectItemId: "593063365092",
      competitorItemId: "623803508105",
      quality: "complete"
    });
    expect(mocks.listDmpBusinessReports).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ data: { reports: [REPORT] } });
  });

  it("requires the extension session and frozen shop", async () => {
    const noSession = await GET(new Request(
      "https://shaozhuangai.com/api/dmp-reports?scope=archive-pair&reportType=growth&subjectItemId=593063365092&competitorItemId=623803508105&quality=complete"
    ));
    expect(noSession.status).toBe(401);

    const noShop = await GET(new Request(
      "https://shaozhuangai.com/api/dmp-reports?scope=archive-pair&reportType=growth&subjectItemId=593063365092&competitorItemId=623803508105&quality=complete",
      { headers: { "x-sanjie-session": "extension-token" } }
    ));
    expect(noShop.status).toBe(400);
    await expect(noShop.json()).resolves.toMatchObject({ code: "SHOP_REQUIRED" });
    expect(mocks.listDmpBusinessReportArchivePair).not.toHaveBeenCalled();
  });

  it("rejects malformed pair parameters before querying history", async () => {
    const response = await GET(new Request(
      "https://shaozhuangai.com/api/dmp-reports?scope=archive-pair&reportType=growth&subjectItemId=bad&competitorItemId=623803508105&quality=complete",
      { headers: { "x-sanjie-session": "extension-token", "x-sanjie-shop": "shop-default" } }
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_ARCHIVE_PAIR_SCOPE" });
    expect(mocks.listDmpBusinessReportArchivePair).not.toHaveBeenCalled();
  });
});

describe("POST /api/dmp-reports archive contract", () => {
  const canonical = {
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
    }],
    render_data: {
      version: "1" as const,
      products: {
        subject: { picture_url: "https://img.alicdn.com/subject-main.png" },
        competitor: { picture_url: "https://img.alicdn.com/competitor-main.png" }
      }
    }
  };

  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getDmpReportAccess.mockResolvedValue(ACCESS);
    mocks.getDmpReportAccessFromToken.mockResolvedValue(ACCESS);
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
    mocks.validCategoryId.mockImplementation((value: unknown) => /^\d{1,20}$/.test(String(value ?? "")));
    mocks.validItemId.mockImplementation((value: unknown) => /^\d{6,20}$/.test(String(value ?? "")));
    mocks.validateDmpCanonicalReport.mockReturnValue({ report: canonical });
    mocks.saveDmpBusinessReport.mockImplementation(async (input: {
      subjectItemId: string;
      competitorItemId: string;
      report: typeof canonical;
      quality: "complete" | "partial";
    }) => ({
      id: "report_archive_123",
      reportType: "growth",
      subjectItemId: input.subjectItemId,
      competitorItemId: input.competitorItemId,
      period: input.report.period,
      quality: input.quality,
      createdAt: "2026-08-22T00:00:00.000Z",
      shopId: "shop-auto",
      shopName: "西西礼",
      report: input.report
    }));
  });

  it("archives with the canonical subject/competitor identity and returns the official report URL", async () => {
    const response = await POST(new Request("https://untrusted-inbound.example/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: canonical,
        subjectItemId: "999999999999",
        competitorItemId: "888888888888",
        shopId: "browser-active-shop",
        sourceVersion: "2.1.6"
      })
    }));

    expect(response.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({
      access: ACCESS,
      subjectItemId: "593063365092",
      competitorItemId: "623803508105",
      sourceVersion: "2.1.6",
      report: expect.objectContaining({
        render_data: {
          version: "1",
          products: {
            subject: { picture_url: "https://img.alicdn.com/subject-main.png" },
            competitor: { picture_url: "https://img.alicdn.com/competitor-main.png" }
          }
        }
      })
    }));
    expect(mocks.saveDmpBusinessReport.mock.calls[0]?.[0]).not.toHaveProperty("shopId");
    expect(mocks.saveDmpBusinessReport.mock.calls[0]?.[0]).not.toHaveProperty("sourceShopId");
    expect(mocks.saveDmpBusinessReport.mock.calls[0]?.[0]).not.toHaveProperty("sourceShop");
    await expect(response.json()).resolves.toMatchObject({
      data: {
        archived: true,
        report: {
          id: "report_archive_123",
          subjectItemId: "593063365092",
          competitorItemId: "623803508105",
          shopId: "shop-auto",
          shopName: "西西礼",
          report: {
            render_data: {
              products: {
                subject: { picture_url: "https://img.alicdn.com/subject-main.png" },
                competitor: { picture_url: "https://img.alicdn.com/competitor-main.png" }
              }
            }
          }
        },
        reportUrl: "https://shaozhuangai.com/tools/dmp-report?reportId=report_archive_123&view=report"
      }
    });
  });

  it("passes an external source ID and shop-name hint without treating either as an internal relation", async () => {
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({
        report: canonical,
        sourceVersion: "2.2.0",
        sourceShop: { sourceShopId: "123456789012", shopName: "西西礼" }
      })
    }));

    expect(response.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({
      access: ACCESS,
      sourceShop: { sourceShopId: "123456789012", shopName: "西西礼" }
    }));
  });

  it("accepts a name-only source hint and rejects malformed external IDs", async () => {
    const nameOnly = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({ report: canonical, sourceShop: { shopName: "西西礼" } })
    }));
    expect(nameOnly.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({
      sourceShop: { shopName: "西西礼" }
    }));

    mocks.saveDmpBusinessReport.mockClear();
    const malformed = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({ report: canonical, sourceShop: { sourceShopId: "not-numeric" } })
    }));
    expect(malformed.status).toBe(400);
    expect(mocks.saveDmpBusinessReport).not.toHaveBeenCalled();
  });

  it("returns the scoped storage error for an explicit foreign internal shop ID", async () => {
    const foreignError = Object.assign(new Error("店铺不存在或不属于当前账号"), {
      code: "DMP_REPORT_SOURCE_SHOP_INVALID",
      status: 404
    });
    mocks.saveDmpBusinessReport.mockRejectedValueOnce(foreignError);
    const foreign = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({ report: canonical, sourceShop: { shopId: "foreign-shop" } })
    }));
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toEqual({ error: "店铺不存在或不属于当前账号" });
  });

  it("archives a category-market report with category ID as the internal subject and no competitor", async () => {
    const market = {
      schema_version: "3.0" as const,
      report_type: "market" as const,
      title: "达摩盘类目大盘报告｜少壮AI自动化",
      item_id: "16",
      period: "2026-03-01 至 2026-07-31",
      market_scope: {
        category_id: "16",
        category_name: "女装",
        category_path: ["服饰", "女装"]
      },
      tables: [{
        name: "滚动7天市场数据",
        columns: ["请求截止日", "成交金额"],
        rows: [{ cells: ["2026-03-31", "3000万~4000万"] }]
      }]
    };
    mocks.validateDmpCanonicalReport.mockReturnValueOnce({ report: market });
    mocks.saveDmpBusinessReport.mockImplementationOnce(async (input: {
      subjectItemId: string;
      competitorItemId: string;
      report: typeof market;
      quality: "complete" | "partial";
    }) => ({
      id: "market-report-1",
      reportType: "market",
      subjectItemId: input.subjectItemId,
      competitorItemId: input.competitorItemId,
      period: input.report.period,
      quality: input.quality,
      createdAt: "2026-08-22T00:00:00.000Z",
      report: input.report
    }));

    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({ report: market, subjectItemId: "16", competitorItemId: "" })
    }));

    expect(response.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({
      subjectItemId: "16",
      competitorItemId: "",
      report: expect.objectContaining({ report_type: "market", market_scope: market.market_scope })
    }));
    await expect(response.json()).resolves.toMatchObject({
      data: { report: { reportType: "market", subjectItemId: "16", competitorItemId: "" } }
    });
  });

  it("returns the same official report identity when an archive POST is retried", async () => {
    const request = () => POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({ report: canonical, sourceVersion: "2.1.6" })
    }));

    const [first, retry] = await Promise.all([request(), request()]);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    const [firstBody, retryBody] = await Promise.all([first.json(), retry.json()]);
    expect(retryBody.data.report.id).toBe(firstBody.data.report.id);
    expect(retryBody.data.reportUrl).toBe(firstBody.data.reportUrl);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledTimes(2);
  });

  it("passes the atomic latest-pair contract and returns confirmed retention beside the report", async () => {
    mocks.saveDmpBusinessReport.mockResolvedValueOnce({
      ...REPORT,
      id: "report-target",
      shopId: "shop-a",
      shopName: "西西礼",
      report: canonical,
      retention: {
        mode: "replace-latest-pair",
        confirmed: true,
        replacedReportId: "report-target",
        absorbedReportIds: ["report-target", "report-older"]
      }
    });
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({
        report: canonical,
        quality: "complete",
        sourceVersion: "2.3.46",
        sourceShop: { shopId: "shop-a" },
        archiveMode: "replace-latest-pair",
        replaceReportId: "report-target",
        absorbedReportIds: ["report-target", "report-older", "report-older"]
      })
    }));

    expect(response.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({
      archiveMode: "replace-latest-pair",
      replaceReportId: "report-target",
      absorbedReportIds: ["report-target", "report-older"]
    }));
    await expect(response.json()).resolves.toMatchObject({
      data: {
        archived: true,
        report: { id: "report-target" },
        retention: {
          mode: "replace-latest-pair",
          confirmed: true,
          replacedReportId: "report-target",
          absorbedReportIds: ["report-target", "report-older"]
        }
      }
    });
  });

  it("passes the current-report CAS contract and returns the same report ID with confirmed retention", async () => {
    const previousCreatedAt = "2026-08-22T00:00:00.000Z";
    const newCreatedAt = "2026-08-30T14:05:00.000Z";
    mocks.saveDmpBusinessReport.mockResolvedValueOnce({
      ...REPORT,
      id: "report-current",
      createdAt: newCreatedAt,
      report: canonical,
      retention: {
        mode: "replace-current-report",
        confirmed: true,
        replacedReportId: "report-current",
        previousCreatedAt,
        newCreatedAt
      }
    });
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({
        report: canonical,
        quality: "partial",
        sourceVersion: "2.3.59",
        archiveMode: "replace-current-report",
        replaceReportId: "report-current",
        replaceReportCreatedAt: previousCreatedAt
      })
    }));

    expect(response.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({
      archiveMode: "replace-current-report",
      replaceReportId: "report-current",
      replaceReportCreatedAt: previousCreatedAt
    }));
    await expect(response.json()).resolves.toMatchObject({
      data: {
        archived: true,
        report: { id: "report-current", createdAt: newCreatedAt },
        retention: {
          mode: "replace-current-report",
          confirmed: true,
          replacedReportId: "report-current",
          previousCreatedAt,
          newCreatedAt
        }
      }
    });
  });

  it("returns recognizable TARGET_STALE without claiming a write", async () => {
    mocks.saveDmpBusinessReport.mockRejectedValueOnce(Object.assign(new Error("当前报告已被其他页面更新"), {
      code: "DMP_REPORT_TARGET_STALE",
      status: 409
    }));
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: canonical,
        archiveMode: "replace-current-report",
        replaceReportId: "report-current",
        replaceReportCreatedAt: "2026-08-22T00:00:00.000Z"
      })
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "当前报告已被其他页面更新",
      code: "DMP_REPORT_TARGET_STALE"
    });
  });

  it.each([
    ["missing revision", { archiveMode: "replace-current-report", replaceReportId: "report-current" }],
    ["noncanonical revision", {
      archiveMode: "replace-current-report",
      replaceReportId: "report-current",
      replaceReportCreatedAt: "2026-08-22T00:00:00Z"
    }],
    ["absorbed IDs", {
      archiveMode: "replace-current-report",
      replaceReportId: "report-current",
      replaceReportCreatedAt: "2026-08-22T00:00:00.000Z",
      absorbedReportIds: ["report-current"]
    }]
  ])("rejects an invalid current-report contract: %s", async (_label, replacement) => {
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report: canonical, ...replacement })
    }));

    expect(response.status).toBe(400);
    expect(mocks.saveDmpBusinessReport).not.toHaveBeenCalled();
  });

  it("returns 409 when atomic validation refuses to overwrite the current report", async () => {
    mocks.saveDmpBusinessReport.mockRejectedValueOnce(Object.assign(new Error("分日范围不连通，未执行原子替换"), {
      code: "DMP_REPORT_REPLACE_CONFLICT",
      status: 409
    }));
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: canonical,
        archiveMode: "replace-latest-pair",
        replaceReportId: "report-target",
        absorbedReportIds: ["report-target"]
      })
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "分日范围不连通，未执行原子替换" });
  });

  it("returns the recognizable HISTORY_STALE code when pair history changed under the snapshot", async () => {
    mocks.saveDmpBusinessReport.mockRejectedValueOnce(Object.assign(new Error("官网同商品对历史已变化，请重新读取并合并后再提交"), {
      code: "DMP_REPORT_HISTORY_STALE",
      status: 409
    }));
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report: canonical })
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "官网同商品对历史已变化，请重新读取并合并后再提交",
      code: "DMP_REPORT_HISTORY_STALE"
    });
  });

  it("rejects an incomplete atomic target list before calling the save layer", async () => {
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        report: canonical,
        archiveMode: "replace-latest-pair",
        replaceReportId: "report-target",
        absorbedReportIds: ["report-older"]
      })
    }));

    expect(response.status).toBe(400);
    expect(mocks.saveDmpBusinessReport).not.toHaveBeenCalled();
  });

  it("archives malformed channel-spend columns as partial instead of rejecting the report", async () => {
    const malformed = structuredClone(canonical);
    malformed.tables.push({
      name: "渠道花费",
      columns: ["渠道", "主体30日消耗"],
      rows: [{ cells: ["人群推广", "3921.86", "多出的业务值"] }]
    });
    const normalized = structuredClone(malformed);
    normalized.tables.at(-1)!.columns.push("列3");
    mocks.validateDmpCanonicalReport.mockReturnValueOnce({
      report: normalized,
      issues: ["业务表「渠道花费」列结构无效，已自动对齐"]
    });

    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({
        report: malformed,
        subjectItemId: "593063365092",
        competitorItemId: "623803508105",
        quality: "complete",
        sourceVersion: "2.1.8"
      })
    }));

    expect(response.status).toBe(201);
    expect(mocks.saveDmpBusinessReport).toHaveBeenCalledWith(expect.objectContaining({
      quality: "partial",
      report: expect.objectContaining({
        tables: expect.arrayContaining([
          expect.objectContaining({
            name: "渠道花费",
            columns: ["渠道", "主体30日消耗", "列3"]
          })
        ])
      })
    }));
    await expect(response.json()).resolves.toMatchObject({ data: { archived: true } });
  });

  it("keeps the archive body-size boundary before parsing oversized JSON", async () => {
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(8 * 1024 * 1024 + 64 * 1024 + 1),
        "x-sanjie-session": "extension-token"
      },
      body: "{}"
    }));

    expect(response.status).toBe(413);
    expect(mocks.saveDmpBusinessReport).not.toHaveBeenCalled();
  });

  it("rejects archives whose subject and competitor identity are the same", async () => {
    const sameIdentity = structuredClone(canonical);
    sameIdentity.tables[0].rows[1].cells[1] = "593063365092";
    mocks.validateDmpCanonicalReport.mockReturnValueOnce({ report: sameIdentity });

    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({ report: sameIdentity })
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "主体商品与对标商品 ID 不能相同" });
    expect(mocks.saveDmpBusinessReport).not.toHaveBeenCalled();
  });

  it("rejects a competition archive with more than three competitor identities", async () => {
    const overLimit = {
      ...structuredClone(canonical),
      report_type: "competition" as const,
      competitor_ids: ["623803508105", "563697874317", "589538478", "342744019"]
    };
    mocks.validateDmpCanonicalReport.mockReturnValueOnce({ report: overLimit });

    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({ report: overLimit })
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "本店与竞店 ID 无效" });
    expect(mocks.saveDmpBusinessReport).not.toHaveBeenCalled();
  });

  it("returns a client error without saving when the report contains authentication material", async () => {
    mocks.validateDmpCanonicalReport.mockReturnValueOnce({ error: "报告包含敏感鉴权字段，禁止归档" });
    const response = await POST(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sanjie-session": "extension-token" },
      body: JSON.stringify({
        report: { ...canonical, tables: [{ name: "渠道花费", columns: ["cookie"], rows: [] }] },
        subjectItemId: "593063365092",
        competitorItemId: "623803508105"
      })
    }));

    expect(response.status).toBe(400);
    expect(mocks.saveDmpBusinessReport).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/dmp-reports shop assignment", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getDmpReportAccess.mockResolvedValue(ACCESS);
  });

  it("assigns a complete report group to a tenant shop without accepting client-side shop names", async () => {
    mocks.assignDmpBusinessReportsShop.mockResolvedValue({
      ok: true,
      reportIds: ["report-a", "report-b"],
      shop: { id: "shop-a", name: "西西礼" }
    });
    const response = await PATCH(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportIds: ["report-a", "report-b"], shopId: "shop-a", shopName: "伪造名称" })
    }));

    expect(response.status).toBe(200);
    expect(mocks.assignDmpBusinessReportsShop).toHaveBeenCalledWith({
      access: ACCESS,
      reportIds: ["report-a", "report-b"],
      shopId: "shop-a"
    });
    await expect(response.json()).resolves.toEqual({
      data: {
        assignment: {
          ok: true,
          reportIds: ["report-a", "report-b"],
          shop: { id: "shop-a", name: "西西礼" }
        }
      }
    });
  });

  it("returns the scoped store error without changing its status", async () => {
    mocks.assignDmpBusinessReportsShop.mockResolvedValue({
      ok: false,
      error: "店铺不存在或不属于当前账号",
      status: 404
    });
    const response = await PATCH(new Request("https://shaozhuangai.com/api/dmp-reports", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportIds: ["report-a"], shopId: "foreign-shop" })
    }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "店铺不存在或不属于当前账号" });
  });
});
