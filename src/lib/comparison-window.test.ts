import { describe, expect, it } from "vitest";
import {
  assessComparisonWindow,
  canConcludeComparison,
  currentIsoDate,
  isFutureInterventionDate
} from "@/lib/comparison-window";

describe("comparison window evidence gate", () => {
  it("uses the Shanghai business day instead of the UTC date", () => {
    expect(currentIsoDate(new Date("2026-07-19T16:30:00.000Z"))).toBe("2026-07-20");
  });

  it("allows a conclusion only after two complete, fully covered windows", () => {
    const coverage = assessComparisonWindow({
      interventionDate: "2026-07-01",
      beforeEnd: "2026-06-30",
      afterEnd: "2026-07-07",
      beforeExpectedDays: 7,
      afterExpectedDays: 7,
      beforeObservedDays: 7,
      afterObservedDays: 7,
      asOfDate: "2026-07-09"
    });

    expect(coverage.status).toBe("ready");
    expect(canConcludeComparison(coverage)).toBe(true);
    expect(coverage.before).toMatchObject({ expectedDays: 7, observedDays: 7, complete: true });
    expect(coverage.after).toMatchObject({ expectedDays: 7, observedDays: 7, complete: true });
  });

  it("keeps an unclosed after window in observation even when dates already have rows", () => {
    const coverage = assessComparisonWindow({
      interventionDate: "2026-07-14",
      beforeEnd: "2026-07-13",
      afterEnd: "2026-07-20",
      beforeExpectedDays: 7,
      afterExpectedDays: 7,
      beforeObservedDays: 7,
      afterObservedDays: 7,
      asOfDate: "2026-07-20"
    });

    expect(coverage.status).toBe("observation");
    expect(canConcludeComparison(coverage)).toBe(false);
    expect(coverage.message).toContain("自然日尚未闭合");
  });

  it("marks a closed but partially uploaded after window insufficient", () => {
    const coverage = assessComparisonWindow({
      interventionDate: "2026-07-01",
      beforeEnd: "2026-06-30",
      afterEnd: "2026-07-07",
      beforeExpectedDays: 7,
      afterExpectedDays: 7,
      beforeObservedDays: 7,
      afterObservedDays: 1,
      asOfDate: "2026-07-09"
    });

    expect(coverage.status).toBe("insufficient");
    expect(coverage.after.observedDays).toBe(1);
    expect(coverage.message).toContain("后窗实际 1/7 天");
  });

  it("checks before-window coverage as well", () => {
    const coverage = assessComparisonWindow({
      interventionDate: "2026-07-01",
      beforeEnd: "2026-06-30",
      afterEnd: "2026-07-07",
      beforeExpectedDays: 7,
      afterExpectedDays: 7,
      beforeObservedDays: 3,
      afterObservedDays: 7,
      asOfDate: "2026-07-09"
    });

    expect(coverage.status).toBe("insufficient");
    expect(coverage.before.complete).toBe(false);
    expect(coverage.message).toContain("前窗实际 3/7 天");
  });

  it("reports an incomplete before window as insufficient even while the after window is still open", () => {
    const coverage = assessComparisonWindow({
      interventionDate: "2026-07-14",
      beforeEnd: "2026-07-13",
      afterEnd: "2026-07-20",
      beforeExpectedDays: 7,
      afterExpectedDays: 7,
      beforeObservedDays: 3,
      afterObservedDays: 1,
      asOfDate: "2026-07-20"
    });

    expect(coverage.status).toBe("insufficient");
    expect(coverage.message).toContain("前窗数据覆盖不足");
  });

  it("recognizes future action dates so create and update paths can reject them", () => {
    expect(isFutureInterventionDate("2026-07-21", "2026-07-20")).toBe(true);
    expect(isFutureInterventionDate("2026-07-20", "2026-07-20")).toBe(false);
  });
});
