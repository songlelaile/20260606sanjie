import { describe, expect, it } from "vitest";
import { assessEvidenceWindow } from "@/lib/analysis-evidence";

describe("assessEvidenceWindow", () => {
  it("allows a conclusion only when the closed source window is complete", () => {
    const assessment = assessEvidenceWindow({
      asOfDate: "2026-08-08",
      sides: [{ start: "2026-08-01", end: "2026-08-07", observedDays: 7 }]
    });
    expect(assessment.status).toBe("ready");
    expect(assessment.conclusionAllowed).toBe(true);
    expect(assessment.reasons[0]?.code).toBe("ready");
  });

  it("keeps facts observable while a calendar window is still open", () => {
    const assessment = assessEvidenceWindow({
      asOfDate: "2026-08-08",
      sides: [{ start: "2026-08-02", end: "2026-08-08", observedDays: 7 }]
    });
    expect(assessment.status).toBe("observation");
    expect(assessment.conclusionAllowed).toBe(false);
  });

  it("distinguishes period mismatch from missing coverage", () => {
    const assessment = assessEvidenceWindow({
      asOfDate: "2026-08-08",
      comparable: false,
      comparisonIssue: "市场表与店铺表不是同一月份",
      sides: [{ start: "2026-07-01", end: "2026-07-31", observedDays: 31 }]
    });
    expect(assessment.status).toBe("not-comparable");
    expect(assessment.message).toContain("不是同一月份");
  });

  it("requires both source coverage and enough samples", () => {
    const assessment = assessEvidenceWindow({
      asOfDate: "2026-08-08",
      sides: [{
        start: "2026-08-01",
        end: "2026-08-07",
        observedDays: 6,
        sampleSize: 1,
        minimumSampleSize: 3
      }]
    });
    expect(assessment.status).toBe("insufficient");
    expect(assessment.message).toContain("6/7");
    expect(assessment.message).toContain("1/3");
  });
});
