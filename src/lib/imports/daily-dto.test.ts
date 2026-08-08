import { describe, expect, it } from "vitest";
import { validateMappedImportRows } from "@/lib/imports/daily-dto";

describe("mapped import DTO validation", () => {
  it("accepts null measurements but preserves a real zero", () => {
    const result = validateMappedImportRows("promotion_product_source", [{
      subjectId: "P-1",
      date: "2026-08-01",
      subjectName: "商品一",
      impressions: null,
      clicks: 0,
      cost: null,
      roi: null
    }]);
    expect(result.rejectedCount).toBe(0);
    expect(result.acceptedRows[0]).toMatchObject({ impressions: null, clicks: 0 });
  });

  it("isolates an invalid row without rejecting valid rows", () => {
    const valid = {
      subjectId: "P-1",
      date: "2026-08-01",
      subjectName: "商品一",
      impressions: 100,
      clicks: 10,
      cost: 20,
      roi: 3
    };
    const result = validateMappedImportRows("promotion_product_source", [
      valid,
      { ...valid, subjectId: "", date: "today" }
    ]);
    expect(result.acceptedRows).toHaveLength(1);
    expect(result.rejectedCount).toBe(1);
  });

  it("rejects out-of-range audience ratios instead of letting the algorithm classify them", () => {
    const result = validateMappedImportRows("audience_source", [{
      date: "2026-08-01",
      sceneId: "S-1",
      sceneName: "拉新",
      planId: "PLAN-1",
      planName: "计划一",
      audienceName: "新客",
      subjectId: "P-1",
      subjectName: "商品一",
      clicks: 50,
      roi: 2,
      guidedPotentialCustomerRatio: 1.2,
      newCustomerRatio: 0.5
    }]);
    expect(result.acceptedRows).toHaveLength(0);
    expect(result.issues.join("；")).toContain("比例必须在 0 到 1 之间");
  });
});
