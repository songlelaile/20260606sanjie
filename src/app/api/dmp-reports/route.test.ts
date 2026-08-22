import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDmpBusinessReport: vi.fn(),
  getDmpReportAccess: vi.fn(),
  getDmpReportAccessFromToken: vi.fn(),
  listDmpBusinessReports: vi.fn(),
  saveDmpBusinessReport: vi.fn(),
  validItemId: vi.fn(),
  validateDmpCanonicalReport: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dmp-report-store", () => ({
  deleteDmpBusinessReport: vi.fn(),
  getDmpBusinessReport: mocks.getDmpBusinessReport,
  getDmpReportAccess: mocks.getDmpReportAccess,
  getDmpReportAccessFromToken: mocks.getDmpReportAccessFromToken,
  listDmpBusinessReports: mocks.listDmpBusinessReports,
  saveDmpBusinessReport: mocks.saveDmpBusinessReport,
  validItemId: mocks.validItemId,
  validateDmpCanonicalReport: mocks.validateDmpCanonicalReport
}));

import { GET, POST } from "./route";

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
    vi.stubEnv("PUBLIC_APP_ORIGIN", "");
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
    await expect(response.json()).resolves.toMatchObject({
      data: {
        archived: true,
        report: {
          id: "report_archive_123",
          subjectItemId: "593063365092",
          competitorItemId: "623803508105",
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
});
