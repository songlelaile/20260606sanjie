import { describe, expect, it } from "vitest";
import { resolveAnalysisPeriod, resolveSourcePeriodAlignment } from "@/lib/analysis-period";
import type { ImportBatch, ReportType } from "@/lib/types/domain";

describe("resolveAnalysisPeriod", () => {
  const cycle = { startDate: "2026-01-01", endDate: "2026-12-31" };

  it("uses the latest product upload dates instead of all retained history", () => {
    expect(resolveAnalysisPeriod(cycle, [batch(["2026-05-03", "2026-05-01", "2026-05-02"])])).toEqual({
      start: "2026-05-01",
      end: "2026-05-03",
      source: "latest-product-upload"
    });
  });

  it("clamps upload dates to the configured cycle", () => {
    expect(
      resolveAnalysisPeriod(
        { startDate: "2026-05-02", endDate: "2026-05-02" },
        [batch(["2026-05-01", "2026-05-03"])]
      )
    ).toMatchObject({ start: "2026-05-02", end: "2026-05-02" });
  });

  it("falls back to the cycle when no valid product dates exist", () => {
    expect(resolveAnalysisPeriod(cycle, [])).toEqual({ ...cycleToRange(cycle), source: "cycle" });
  });

  it("parses raw compact ranges instead of falling back to a year-long cycle", () => {
    expect(resolveAnalysisPeriod(cycle, [batch(["20260501至20260531"])])).toMatchObject({
      start: "2026-05-01",
      end: "2026-05-31"
    });
  });

  it("requires every core source to cover the product analysis window", () => {
    const batches = (["product_source", "damo_product_source", "promotion_product_source", "audience_source"] as ReportType[])
      .map((type) => batch(["2026-05-01", "2026-05-31"], type));
    expect(resolveSourcePeriodAlignment(batches, { start: "2026-05-01", end: "2026-05-31" }).aligned).toBe(true);
    batches[2] = batch(["2026-05-10", "2026-05-31"], "promotion_product_source");
    const result = resolveSourcePeriodAlignment(batches, { start: "2026-05-01", end: "2026-05-31" });
    expect(result.aligned).toBe(false);
    expect(result.issues.join("；")).toContain("推广宝贝源");
  });

  it("rejects a daily source whose min/max range hides missing calendar days", () => {
    const batches = (["product_source", "damo_product_source", "promotion_product_source", "audience_source"] as ReportType[])
      .map((type) => batch(["2026-05-01", "2026-05-31"], type));
    batches[3]!.validation.dateObservedDays = 30;
    batches[3]!.validation.dateExpectedDays = 31;

    const result = resolveSourcePeriodAlignment(batches, { start: "2026-05-01", end: "2026-05-31" });
    expect(result.aligned).toBe(false);
    expect(result.issues.join("；")).toContain("人群源统计日期仅覆盖 30/31");
  });
});

function cycleToRange(cycle: { startDate: string; endDate: string }) {
  return { start: cycle.startDate, end: cycle.endDate };
}

function batch(dateValues: string[], reportType: ReportType = "product_source"): ImportBatch {
  return {
    id: "batch",
    cycleId: "cycle",
    datasetId: "dataset",
    reportType,
    fileName: "product.xlsx",
    fileSizeBytes: 1,
    status: "validated",
    rowCount: dateValues.length,
    createdAt: "2026-05-04T00:00:00.000Z",
    validation: {
      ok: true,
      reportType,
      receivedHeaders: [],
      requiredHeaders: [],
      missingHeaders: [],
      extraHeaders: [],
      rowCount: dateValues.length,
      uniqueEntityCount: 1,
      duplicateEntityIds: [],
      dateValues,
      dateObservedDays: dateValues.length,
      dateExpectedDays: dateValues.length,
      warnings: [],
      errors: []
    }
  };
}
