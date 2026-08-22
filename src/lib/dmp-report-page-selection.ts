import type { DmpBusinessReportRecord } from "@/lib/dmp-report-types";

export function resolveDmpReportPageSelection(
  listedReports: DmpBusinessReportRecord[],
  requestedId: string,
  requestedReport: DmpBusinessReportRecord | null
): { reports: DmpBusinessReportRecord[]; selectedReportId: string } | null {
  const selectedReportId = requestedId.trim();
  if (!selectedReportId) return { reports: listedReports, selectedReportId: "" };
  if (listedReports.some((report) => report.id === selectedReportId)) {
    return { reports: listedReports, selectedReportId };
  }
  if (!requestedReport || requestedReport.id !== selectedReportId) return null;
  return { reports: [requestedReport, ...listedReports], selectedReportId };
}
