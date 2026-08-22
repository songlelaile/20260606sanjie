import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { DmpReportWorkspace } from "@/components/tools/DmpReportWorkspace";
import {
  getDmpBusinessReport,
  getDmpReportAccess,
  listDmpBusinessReports
} from "@/lib/dmp-report-store";
import { resolveDmpReportPageSelection } from "@/lib/dmp-report-page-selection";
import { getShopSwitcherData } from "@/lib/store/runtime-store";

export const metadata: Metadata = {
  title: "达摩盘一体化报告中心｜少壮AI自动化"
};

export const dynamic = "force-dynamic";

export default async function DmpReportPage({
  searchParams
}: {
  searchParams: Promise<{ reportId?: string; view?: string; source?: string }>;
}) {
  const query = await searchParams;
  const access = await getDmpReportAccess();
  if (!access) redirect("/tools?dmpAccess=paid");
  if (query.source === "dmp-extension") {
    return <main id="dmp-extension-report-host" />;
  }
  const requestedReportId = query.reportId?.trim() ?? "";
  const [listedReports, shopData] = await Promise.all([
    listDmpBusinessReports(access),
    getShopSwitcherData()
  ]);
  const listedRequestedReport = listedReports.find((report) => report.id === requestedReportId) ?? null;
  const requestedReport = requestedReportId && !listedRequestedReport
    ? await getDmpBusinessReport(access, requestedReportId)
    : listedRequestedReport;
  const selection = resolveDmpReportPageSelection(listedReports, requestedReportId, requestedReport);
  if (!selection) notFound();

  return (
    <>
      <PageHeader
        title="达摩盘一体化报告中心｜少壮AI自动化"
      />
      <DmpReportWorkspace
        initialReports={selection.reports}
        initialShops={shopData.shops.map(({ id, name }) => ({ id, name }))}
        canCreateShop={shopData.canCreate}
        initialSelectedId={selection.selectedReportId}
        focusReport={query.view === "report"}
      />
    </>
  );
}
