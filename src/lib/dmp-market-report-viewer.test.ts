import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  marketMedianMetrics,
  parseBusinessNumber,
  projectDmpMarketReport,
  selectDmpMarketPeriod
} from "@/components/tools/DmpMarketReportViewModel";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";

function marketRecord(): DmpBusinessReportRecord {
  return {
    id: "market-report-1",
    reportType: "market",
    subjectItemId: "350511",
    competitorItemId: "",
    period: "2026-03-31 至 2026-04-02",
    quality: "complete",
    createdAt: "2026-08-22T00:00:00.000Z",
    report: {
      schema_version: "3.0",
      report_type: "market",
      title: "达摩盘类目大盘报告｜少壮AI自动化",
      item_id: "350511",
      period: "2026-03-31 至 2026-04-02",
      market_scope: {
        category_id: "350511",
        category_name: "油烟机",
        category_path: ["大家电", "厨房大电", "油烟机"]
      },
      tables: [{
        name: "滚动7天市场数据",
        columns: ["请求截止日", "窗口开始", "成交金额", "新客人数", "periodType"],
        rows: [
          { cells: ["2026-03-31", "2026-03-25", "3000万~4000万", "1500", "1"] },
          { cells: ["2026-04-01", "2026-03-26", "2000万~3000万", "1700", "1"] },
          { cells: ["2026-04-02", "2026-03-27", "3000万~4000万", "1600", "1"] }
        ]
      }]
    }
  };
}

describe("DMP category-market viewer", () => {
  it("projects only business fields and offers natural week/month periods", () => {
    const model = projectDmpMarketReport(marketRecord());
    expect(model.scope.category_path).toEqual(["大家电", "厨房大电", "油烟机"]);
    expect(model.tables[0].name).toBe("市场核心指标");
    expect(model.tables[0].columns).toEqual(["日期", "成交金额", "新客人数"]);
    expect(JSON.stringify(model.tables)).not.toMatch(/窗口开始|periodType|请求截止日/);
    expect(model.periods.month.map((option) => option.key)).toEqual(["2026-03", "2026-04"]);
    expect(model.periods.week).toEqual([expect.objectContaining({
      key: "2026-03-30",
      start: "2026-03-30",
      end: "2026-04-05"
    })]);
    expect(selectDmpMarketPeriod(model, "month", "2026-04").tables[0].rows).toHaveLength(2);
  });

  it("uses interval midpoints and reports the median as a direct reference value", () => {
    const model = projectDmpMarketReport(marketRecord());
    const april = selectDmpMarketPeriod(model, "month", "2026-04");
    expect(parseBusinessNumber("2000万~3000万", "成交金额")).toBe(25_000_000);
    expect(marketMedianMetrics(april.tables)).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "成交金额", value: 30_000_000 }),
      expect.objectContaining({ label: "新客人数", value: 1650 })
    ]));
  });

  it("keeps preview and share on the branded market viewer visual contract", () => {
    const viewer = readFileSync("src/components/tools/DmpMarketReportViewer.tsx", "utf8");
    const css = readFileSync("src/components/tools/DmpMarketReportViewer.module.css", "utf8");
    const dispatch = readFileSync("src/components/tools/DmpReportViewer.tsx", "utf8");
    expect(viewer).toContain("少壮AI自动化 · shaozhuangai.com");
    expect(viewer).toContain("自然周");
    expect(viewer).toContain("自然月");
    expect(dispatch).toContain("DmpMarketReportViewer");
    expect(css).toMatch(/\.tableShell thead th[^}]*\{[\s\S]*?color:\s*#fff\s*!important;[\s\S]*?background:\s*var\(--market-green\)\s*!important;/);
    expect(css).toMatch(/\.numeric\s*\{[^}]*text-align:\s*right\s*!important;/);
  });
});
