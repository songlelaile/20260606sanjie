import { beforeAll, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import type { DmpCanonicalReport } from "@/lib/dmp-report-types";

vi.mock("server-only", () => ({}));

let buildDmpReportCsv: typeof import("@/lib/dmp-report-export").buildDmpReportCsv;
let buildDmpReportWorkbook: typeof import("@/lib/dmp-report-export").buildDmpReportWorkbook;

beforeAll(async () => {
  ({ buildDmpReportCsv, buildDmpReportWorkbook } = await import("@/lib/dmp-report-export"));
});

function report(includePpc = true): DmpCanonicalReport {
  const metrics = [
    ["总GMV", "200", "400"],
    ["付费成交额", "80", "160"],
    ["推广消耗", "20", "40"],
    ["费比", "0.1", "0.1"],
    ["ROI", "4", "4"],
    ...(includePpc ? [["PPC", "2", "2"]] : []),
    ["付费金额占比", "0.4", "0.4"],
    ["全域ROAS", "10", "10"]
  ];
  return {
    schema_version: "3.0",
    title: "达摩盘商品成长竞品对标报告",
    item_id: "593063365092",
    period: "2026-08-01 至 2026-08-02",
    tables: [{
      name: "报告总览",
      columns: ["项目", "主体", "对手", "范围"],
      rows: [
        { cells: ["商品ID", "593063365092", "623803508105", ""] },
        ...metrics.map((cells) => ({ cells }))
      ]
    }]
  };
}

describe("DMP report business-only exports", () => {
  it("keeps normalized business data but omits quality diagnostics from partial CSV and workbook exports", async () => {
    const csv = buildDmpReportCsv(report(false), "complete");
    expect(csv).toContain("付费金额占比");
    expect(csv).not.toMatch(/数据完整性提示|缺失值未按0计入|可继续补采|缺失字段|工程计算|错误代码/);

    const bytes = await buildDmpReportWorkbook(report(false), "complete");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    const visibleText = JSON.stringify(workbook.worksheets.map((sheet) => sheet.getSheetValues()));
    expect(workbook.worksheets[0].getCell("A1").value).toBe("项目");
    expect(visibleText).toContain("付费金额占比");
    expect(visibleText).not.toMatch(/数据完整性提示|缺失值未按0计入|可继续补采|缺失字段|工程计算|错误代码/);
  });

  it("does not add a quality diagnostic to a complete normalized export", () => {
    expect(buildDmpReportCsv(report(true), "complete")).not.toContain("数据完整性提示");
  });
});
