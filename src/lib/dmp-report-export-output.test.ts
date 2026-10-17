import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DmpCanonicalReport } from "@/lib/dmp-report-types";

vi.mock("server-only", () => ({}));

let buildDmpReportCsv: typeof import("@/lib/dmp-report-export").buildDmpReportCsv;

beforeAll(async () => {
  ({ buildDmpReportCsv } = await import("@/lib/dmp-report-export"));
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

describe("DMP report export quality notice", () => {
  it("uses the same normalized eight-metric result and prints a partial warning in CSV exports", () => {
    const csv = buildDmpReportCsv(report(false), "complete");
    expect(csv).toContain("数据完整性提示");
    expect(csv).toContain("缺失值未按0计入");
    expect(csv).toContain("可继续补采");
    expect(csv).toContain("付费金额占比");
  });

  it("does not add a partial warning to a complete normalized export", () => {
    expect(buildDmpReportCsv(report(true), "complete")).not.toContain("数据完整性提示");
  });
});
