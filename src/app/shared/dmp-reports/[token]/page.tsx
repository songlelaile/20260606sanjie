import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DmpGrowthReportViewer } from "@/components/tools/DmpGrowthReportViewer";
import { DmpSharedReportClient } from "@/components/tools/DmpSharedReportClient";
import { getPublicDmpSharedReport } from "@/lib/dmp-report-share";

export const metadata: Metadata = {
  title: "达摩盘分享报告｜少壮AI自动化",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function SharedDmpReportPage({
  params
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const snapshot = await getPublicDmpSharedReport(token);
  if (!snapshot) notFound();
  const record = snapshot.report;

  return (
    <div className="dmp-shared-page" data-track-section="report">
      <DmpGrowthReportViewer
        record={record}
        variant="shared"
        actions={<DmpSharedReportClient token={token} />}
      />
    </div>
  );
}
