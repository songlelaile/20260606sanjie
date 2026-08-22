import { describe, expect, it } from "vitest";
import { resolveDmpReportPageSelection } from "@/lib/dmp-report-page-selection";
import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";

const LATEST = { id: "report-latest" } as DmpBusinessReportRecord;
const HISTORICAL = { id: "report-historical" } as DmpBusinessReportRecord;

describe("DMP report page exact selection", () => {
  it("keeps the bounded history when it already contains reportId", () => {
    expect(resolveDmpReportPageSelection([LATEST], LATEST.id, LATEST)).toEqual({
      reports: [LATEST],
      selectedReportId: LATEST.id
    });
  });

  it("prepends an exact historical record outside the latest 200", () => {
    expect(resolveDmpReportPageSelection([LATEST], ` ${HISTORICAL.id} `, HISTORICAL)).toEqual({
      reports: [HISTORICAL, LATEST],
      selectedReportId: HISTORICAL.id
    });
  });

  it("rejects missing, unauthorized or mismatched exact records instead of selecting latest", () => {
    expect(resolveDmpReportPageSelection([LATEST], "missing-or-foreign", null)).toBeNull();
    expect(resolveDmpReportPageSelection([LATEST], HISTORICAL.id, LATEST)).toBeNull();
  });

  it("uses normal latest-first browsing only when no reportId was requested", () => {
    expect(resolveDmpReportPageSelection([LATEST], "", null)).toEqual({
      reports: [LATEST],
      selectedReportId: ""
    });
  });
});
