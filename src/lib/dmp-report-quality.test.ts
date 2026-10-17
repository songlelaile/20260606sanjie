import { describe, expect, it } from "vitest";
import { assessDmpEffectiveReportQuality } from "@/lib/dmp-report-quality";
import type { DmpCanonicalReport } from "@/lib/dmp-report-types";

function report(rows: string[][]): DmpCanonicalReport {
  return {
    schema_version: "3.0",
    title: "达摩盘商品成长竞品对标报告",
    item_id: "593063365092",
    period: "2026-08-01 至 2026-08-02",
    tables: [
      {
        name: "报告总览",
        columns: ["项目", "主体", "对手", "范围"],
        rows: [
          { cells: ["商品ID", "593063365092", "623803508105", ""] },
          ...rows.map((cells) => ({ cells }))
        ]
      },
      {
        name: "日GMV与费比",
        columns: ["日期", "主体日GMV", "对手日GMV"],
        rows: [
          { cells: ["2026-08-01", "100", "200"] },
          { cells: ["2026-08-02", "100", "200"] }
        ]
      }
    ]
  };
}

const completeRows = [
  ["总GMV", "200", "400", "2日"],
  ["付费成交额", "80", "160", "2日"],
  ["推广消耗", "20", "40", "2日"],
  ["费比", "0.1", "0.1", "2日"],
  ["ROI", "4", "4", "2日"],
  ["PPC", "2", "2", "2日"],
  ["付费金额占比", "0.4", "0.4", "2日"],
  ["全域ROAS", "10", "10", "2日"]
];

describe("DMP effective report quality", () => {
  it("accepts complete only after both sides disclose all eight fixed overview metrics", () => {
    const result = assessDmpEffectiveReportQuality(report(completeRows), "complete");
    expect(result).toMatchObject({
      effectiveQuality: "complete",
      missing: [],
      coverageLabel: "覆盖2/2日",
      notice: ""
    });
  });

  it("derives paid amount share from paid GMV divided by total GMV before completeness review", () => {
    const source = report(completeRows.filter(([metric]) => metric !== "付费金额占比"));
    const result = assessDmpEffectiveReportQuality(source, "complete");
    expect(result.effectiveQuality).toBe("complete");
    expect(result.missing).toEqual([]);
  });

  it("downgrades an untrusted client complete and exposes business coverage without treating blanks as zero", () => {
    const partial = report(completeRows.filter(([metric]) => metric !== "PPC"));
    const overview = partial.tables[0];
    overview.rows.push({ cells: ["花费覆盖", "主体已返回1/2日（缺少2026-08-02）", "对手已返回2/2日", "缺失日留空"] });

    const result = assessDmpEffectiveReportQuality(partial, "complete");

    expect(result.effectiveQuality).toBe("partial");
    expect(result.missing.map(({ role, label }) => `${role}${label}`)).toEqual(["主体PPC", "对手PPC"]);
    expect(result.coverageLabel).toContain("主体覆盖1/2日");
    expect(result.notice).toContain("缺失值未按0计入");
    expect(result.notice).toContain("可继续补采");
  });

  it("keeps explicit zero disclosed and treats zero-denominator ROI, PPC and ROAS as not applicable", () => {
    const zeroSpendRows = completeRows
      .filter(([metric]) => !["ROI", "PPC", "全域ROAS"].includes(metric))
      .map((row) => row[0] === "推广消耗" ? [row[0], "0", "0", row[3]] : row);
    const result = assessDmpEffectiveReportQuality(report(zeroSpendRows), "complete");
    expect(result.effectiveQuality).toBe("complete");
    expect(result.missing).toEqual([]);
  });

  it("never mutates legacy report text while evaluating its effective quality", () => {
    const legacy = report(completeRows.slice(0, 3));
    const before = JSON.stringify(legacy);
    expect(assessDmpEffectiveReportQuality(legacy, "complete").effectiveQuality).toBe("partial");
    expect(JSON.stringify(legacy)).toBe(before);
  });
});
