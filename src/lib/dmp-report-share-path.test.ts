import { describe, expect, it } from "vitest";
import { safeDmpReportReturnPath } from "@/lib/dmp-report-share-path";

describe("DMP shared report return path", () => {
  it("accepts only a same-origin report path with a 64-character token", () => {
    const token = "a".repeat(64);
    expect(safeDmpReportReturnPath(`/shared/dmp-reports/${token}`)).toBe(`/shared/dmp-reports/${token}`);
  });

  it("rejects external, protocol-relative, query-appended and unrelated paths", () => {
    const token = "a".repeat(64);
    expect(safeDmpReportReturnPath(`https://evil.example/shared/dmp-reports/${token}`)).toBe("");
    expect(safeDmpReportReturnPath(`//evil.example/shared/dmp-reports/${token}`)).toBe("");
    expect(safeDmpReportReturnPath(`/shared/dmp-reports/${token}?next=https://evil.example`)).toBe("");
    expect(safeDmpReportReturnPath("/tools/dmp-report")).toBe("");
  });
});
