import { describe, expect, it } from "vitest";
import { reportContracts, validateImportRows } from "@/lib/imports/contracts";

describe("import contracts", () => {
  it("accepts a valid product source sheet", () => {
    const contract = reportContracts.product_source;
    const validation = validateImportRows(contract.reportType, contract.requiredHeaders, [
      [
        "2026-05-08",
        "982373108594",
        "霍卡切槽刀杆",
        4539,
        10312,
        28.45,
        0.7495,
        473,
        54306.24,
        0.1042,
        7195.22,
        0.1208
      ]
    ]);

    expect(validation.ok).toBe(true);
    expect(validation.uniqueEntityCount).toBe(1);
    expect(validation.errors).toEqual([]);
  });

  it("reports missing required headers clearly", () => {
    const validation = validateImportRows("audience_source", ["日期", "场景ID"], []);

    expect(validation.ok).toBe(false);
    expect(validation.missingHeaders).toContain("主体ID");
    expect(validation.errors.join("；")).toContain("缺少必填字段");
  });

  it("商品主数据重复主键时提示已保留首行，不阻断计算", () => {
    const contract = reportContracts.product_source;
    const validation = validateImportRows(contract.reportType, contract.requiredHeaders, [
      ["2026-05-08", "100", "甲", 10, 20, 5, 0.4, 3, 100, 0.05, 2, 0.03],
      ["2026-05-09", "100", "甲", 12, 22, 6, 0.5, 4, 120, 0.06, 3, 0.04]
    ]);

    expect(validation.ok).toBe(true);
    expect(validation.duplicateEntityIds).toEqual(["100"]);
    expect(validation.warnings[0]).toContain("已自动归并");
  });

  it("人群明细表对重复主键不报警（同商品多人群计划各自保留）", () => {
    const contract = reportContracts.audience_source;
    const validation = validateImportRows(contract.reportType, contract.requiredHeaders, [
      ["2026-05-08", "s1", "拉新", "p1", "计划A", "新客", "100", "甲", 50, 3.2, 0.9, 0.9],
      ["2026-05-09", "s1", "拉新", "p2", "计划B", "老客", "100", "甲", 40, 2.8, 0.3, 0.3]
    ]);

    expect(validation.ok).toBe(true);
    expect(validation.duplicateEntityIds).toEqual(["100"]);
    expect(validation.warnings).toEqual([]);
  });

  it("detects a loose period column for reports without a fixed date field", () => {
    const contract = reportContracts.damo_product_source;
    const validation = validateImportRows(
      contract.reportType,
      ["统计周期", ...contract.requiredHeaders],
      [["20260501至20260508", "100", "货品A", "成长期", 100, 20, 10, 2, 0.1, 0.2, 0.03, 0.4, 3]]
    );

    expect(validation.ok).toBe(true);
    expect(validation.dateValues).toEqual(["20260501至20260508"]);
  });
});
