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

  it("warns on duplicate entity ids without blocking calculation", () => {
    const contract = reportContracts.promotion_product_source;
    const validation = validateImportRows(contract.reportType, contract.requiredHeaders, [
      ["2026-05-08", "100", "商品", "A", 10, 1, 2, 2, 1],
      ["2026-05-09", "100", "商品", "A", 20, 2, 4, 2, 1]
    ]);

    expect(validation.ok).toBe(true);
    expect(validation.duplicateEntityIds).toEqual(["100"]);
    expect(validation.warnings[0]).toContain("重复");
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
