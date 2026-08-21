import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { DmpReportWorkspace } from "@/components/tools/DmpReportWorkspace";
import { getDmpReportAccess, listDmpBusinessReports } from "@/lib/dmp-report-store";

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
  const reports = await listDmpBusinessReports(access);

  return (
    <>
      <PageHeader
        title="达摩盘一体化报告中心｜少壮AI自动化"
      />
      <DmpReportWorkspace
        initialReports={reports}
        initialSelectedId={query.reportId ?? ""}
        focusReport={query.view === "report"}
      />
    </>
  );
}
