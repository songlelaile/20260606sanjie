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
        0.1208,
        900
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
    expect(validation.warnings.join("；")).toContain("官方固定列序");
  });

  it("blocks only when no row has a reliable primary key and date", () => {
    const contract = reportContracts.product_source;
    const headers = contract.requiredHeaders.filter((header) => !["统计日期", "商品ID"].includes(header));
    const validation = validateImportRows(contract.reportType, headers, [["商品A", 1, 2]]);

    expect(validation.ok).toBe(false);
    expect(validation.rejectedRowCount).toBe(1);
    expect(validation.errors.join("；")).toContain("没有可参与计算");
  });

  it("商品源分日明细对重复主键不报警（同商品跨日由 mapper 按商品ID+日期求和）", () => {
    const contract = reportContracts.product_source;
    const validation = validateImportRows(contract.reportType, contract.requiredHeaders, [
      ["2026-05-08", "100", "甲", 10, 20, 5, 0.4, 3, 100, 0.05, 2, 0.03, 8],
      ["2026-05-09", "100", "甲", 12, 22, 6, 0.5, 4, 120, 0.06, 3, 0.04, 10]
    ]);

    expect(validation.ok).toBe(true);
    expect(validation.duplicateEntityIds).toEqual(["100"]); // 仍检测到，但不报警
    expect(validation.warnings).toEqual([]);
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
    expect(validation.dateValues).toEqual(["2026-05-01", "2026-05-08"]);
  });

  it.each(["-", "--", "—", "–", "－", "N/A"])(
    "accepts the explicit missing placeholder %s but records a nullable field issue",
    (placeholder) => {
      const contract = reportContracts.product_source;
      const row = ["2026-05-08", "100", "甲", 10, 20, 5, 0.4, 3, 100, 0.05, placeholder, 0.03, 8];
      const validation = validateImportRows(contract.reportType, contract.requiredHeaders, [row]);

      expect(validation.ok).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(validation.fieldIssueCount).toBeGreaterThan(0);
    }
  );

  it.each(["", "未投放", "无数据"])(
    "accepts blank or non-numeric value %j and records it as null",
    (fallbackValue) => {
      const contract = reportContracts.product_source;
      const row = [
        "2026-05-08",
        "100",
        "甲",
        10,
        20,
        5,
        0.4,
        3,
        100,
        0.05,
        fallbackValue,
        0.03,
        8
      ];
      const validation = validateImportRows(contract.reportType, contract.requiredHeaders, [row]);

      expect(validation.ok).toBe(true);
      expect(validation.errors).toEqual([]);
      expect(validation.fieldIssueCount).toBeGreaterThan(0);
    }
  );

  it("records unique observed dates and warns when a daily upload has a gap", () => {
    const contract = reportContracts.audience_source;
    const row = (date: string, planId: string) => [
      date, "s1", "拉新", planId, `计划${planId}`, "新客", "100", "甲", 50, 3.2, 0.9, 0.9
    ];
    const validation = validateImportRows(contract.reportType, contract.requiredHeaders, [
      row("2026-05-01", "p1"),
      row("2026/05/01", "p2"),
      row("2026-05-03", "p3")
    ]);

    expect(validation.ok).toBe(true);
    expect(validation.dateObservedDays).toBe(2);
    expect(validation.dateExpectedDays).toBe(3);
    expect(validation.warnings.join("；")).toContain("2/3");
  });
});
