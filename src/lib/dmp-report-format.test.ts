import { describe, expect, it } from "vitest";
import { dmpCellSemantic, formatDmpCell } from "@/lib/dmp-report-format";

describe("DMP report value formatting", () => {
  it("rounds decimal values and percentages to two places", () => {
    expect(formatDmpCell("619.369207627182", "笔单价")).toBe("619.37");
    expect(formatDmpCell("0.010814939894664897", "支付转化率")).toBe("1.08%");
    expect(formatDmpCell("5.0247", "直接投产比")).toBe("5.02");
    expect(formatDmpCell("502.47%", "直接投产比")).toBe("5.02");
    expect(formatDmpCell("0.08345", "环比")).toBe("8.35%");
    expect(formatDmpCell("3.1267~4.2345", "投入产出比")).toBe("3.13~4.23");
    expect(formatDmpCell("312.67%~423.45%", "投入产出比")).toBe("3.13~4.23");
    expect(formatDmpCell("3.989", "ROI")).toBe("3.99");
    expect(formatDmpCell("4.567", "ROAS")).toBe("4.57");
    expect(formatDmpCell("3.4886~4.1863", "PPC")).toBe("3.49~4.19");
    expect(formatDmpCell("2.5%~5%", "CTR")).toBe("2.50%~5%");
    expect(formatDmpCell("", "ROI")).toBe("—");
    expect(formatDmpCell("0", "费比")).toBe("0.00%");
    expect(formatDmpCell("0", "ROI")).toBe("0");
    expect(formatDmpCell("0", "PPC")).toBe("0");
  });

  it("keeps identifiers and integers unchanged", () => {
    expect(formatDmpCell("593063365092", "商品ID")).toBe("593063365092");
    expect(formatDmpCell("11298", "成交笔数")).toBe("11298");
  });

  it("uses the row metric as table semantics", () => {
    expect(dmpCellSemantic("基础指标对比", ["指标", "主体值"], ["费比", "0.075638"], 1)).toContain("费比");
    const overviewSemantic = dmpCellSemantic(
      "报告总览",
      ["分析周期", "指标", "本店当前"],
      ["近7天", "直接投产比", "502.47%"],
      2
    );
    expect(overviewSemantic).toContain("直接投产比");
    expect(formatDmpCell("502.47%", overviewSemantic)).toBe("5.02");
    const changeSemantic = dmpCellSemantic(
      "报告总览",
      ["分析周期", "指标", "本店当前", "本店变化"],
      ["近7天", "直接投产比", "502.47%", "0.02"],
      3
    );
    expect(changeSemantic).not.toContain("直接投产比");
    expect(formatDmpCell("0.02", changeSemantic)).toBe("2.00%");
  });
});
