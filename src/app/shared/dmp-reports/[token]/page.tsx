import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DmpReportViewer } from "@/components/tools/DmpReportViewer";
import { DmpSharedReportClient } from "@/components/tools/DmpSharedReportClient";
import { getPublicDmpSharedReport } from "@/lib/dmp-report-share";

export const metadata: Metadata = {
  title: "少壮AI自动化报告",
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
      <DmpSharedReportClient token={token} showCopyButton={false} />
      <DmpReportViewer record={record} variant="shared" />
    </div>
  );
}
