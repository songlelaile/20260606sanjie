import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { DmpReportViewer } from "@/components/tools/DmpReportViewer";
import { DmpSharedReportClient } from "@/components/tools/DmpSharedReportClient";
import { getPublicDmpSharedReport } from "@/lib/dmp-report-share";
import { safeDmpReportReturnPath } from "@/lib/dmp-report-share-path";
import { getDmpReportAccess } from "@/lib/dmp-report-store";
import { getCurrentSession } from "@/lib/server-session";

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
  const returnTo = safeDmpReportReturnPath(`/shared/dmp-reports/${token}`);
  if (!returnTo) notFound();
  // Validate this viewer's website session and current DMP entitlement before
  // resolving the share token or loading any report data. The token remains an
  // additional read-only grant and never replaces account authorization.
  if (!(await getCurrentSession())) redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  if (!(await getDmpReportAccess())) redirect("/tools?dmpAccess=paid");
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
