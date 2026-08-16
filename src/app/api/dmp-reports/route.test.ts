import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDmpBusinessReport: vi.fn(),
  getDmpReportAccess: vi.fn(),
  getDmpReportAccessFromToken: vi.fn(),
  listDmpBusinessReports: vi.fn()
}));

vi.mock("@/lib/dmp-report-store", () => ({
  deleteDmpBusinessReport: vi.fn(),
  getDmpBusinessReport: mocks.getDmpBusinessReport,
  getDmpReportAccess: mocks.getDmpReportAccess,
  getDmpReportAccessFromToken: mocks.getDmpReportAccessFromToken,
  listDmpBusinessReports: mocks.listDmpBusinessReports,
  saveDmpBusinessReport: vi.fn(),
  validItemId: vi.fn(),
  validateDmpCanonicalReport: vi.fn()
}));

import { GET } from "./route";

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

describe("GET /api/dmp-reports online-only policy", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getDmpReportAccess.mockResolvedValue(ACCESS);
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
