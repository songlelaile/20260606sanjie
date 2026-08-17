import { describe, expect, it } from "vitest";
import { normalizeDmpReportExportRequest } from "@/lib/dmp-report-export-contract";

describe("DMP report XLSX export request contract", () => {
  it("accepts the four documented low-sensitivity fields", () => {
    expect(normalizeDmpReportExportRequest({
      reportId: "report-growth-1",
      reportType: "growth",
      format: "xlsx",
      clientVersion: "2.1.3"
    })).toEqual({
      reportId: "report-growth-1",
      reportType: "growth",
      format: "xlsx",
      clientVersion: "2.1.3"
    });
  });

  it("rejects any extra field so a plugin cannot attach report or business-cell content", () => {
    expect(normalizeDmpReportExportRequest({
      reportId: "report-growth-1",
      reportType: "growth",
      format: "xlsx",
      clientVersion: "2.1.3",
      report: { tables: [{ cells: ["不得接收"] }] }
    })).toBeNull();
  });

  it.each([
    { reportId: "", reportType: "growth", format: "xlsx", clientVersion: "2.1.3" },
    { reportId: "report-1", reportType: "unknown", format: "xlsx", clientVersion: "2.1.3" },
    { reportId: "report-1", reportType: "growth", format: "json", clientVersion: "2.1.3" },
    { reportId: "report-1", reportType: "growth", format: "xlsx", clientVersion: "" },
    { reportId: 123, reportType: "growth", format: "xlsx", clientVersion: "2.1.3" },
    { reportId: "report 1", reportType: "growth", format: "xlsx", clientVersion: "2.1.3" },
    { reportId: "report-1", reportType: "growth", format: "xlsx", clientVersion: "x".repeat(65) },
    { reportId: "report-1", reportType: "growth", format: "xlsx", clientVersion: "业务数据" }
  ])("rejects an invalid or non-XLSX request: %o", (value) => {
    expect(normalizeDmpReportExportRequest(value)).toBeNull();
  });
});
