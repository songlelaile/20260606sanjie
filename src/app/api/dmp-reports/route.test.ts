import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildDmpReportCsv: vi.fn(),
  buildDmpReportWorkbook: vi.fn(),
  getDmpBusinessReport: vi.fn(),
  getDmpReportAccess: vi.fn(),
  getDmpReportAccessFromToken: vi.fn(),
  listDmpBusinessReports: vi.fn()
}));

vi.mock("@/lib/dmp-report-export", () => ({
  buildDmpReportCsv: mocks.buildDmpReportCsv,
  buildDmpReportWorkbook: mocks.buildDmpReportWorkbook
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

describe("GET /api/dmp-reports downloads", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.getDmpReportAccess.mockResolvedValue(ACCESS);
    mocks.getDmpBusinessReport.mockResolvedValue(REPORT);
  });

  it("returns a real Excel attachment for the selected history report", async () => {
    mocks.buildDmpReportWorkbook.mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const response = await GET(new Request("https://shaozhuangai.com/api/dmp-reports?id=report-a&format=xlsx"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("returns a UTF-8 CSV attachment for the selected history report", async () => {
    mocks.buildDmpReportCsv.mockReturnValue("\ufeff报告总览");
    const response = await GET(new Request("https://shaozhuangai.com/api/dmp-reports?id=report-a&format=csv"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv;charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain(".csv");
    expect(Buffer.from(await response.arrayBuffer()).toString("utf8")).toBe("\ufeff报告总览");
  });
});
