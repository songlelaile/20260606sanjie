import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { DmpReportWorkspace } from "@/components/tools/DmpReportWorkspace";
import {
  getDmpBusinessReport,
  getDmpReportAccess,
  listDmpBusinessReportSummaries,
  resolveDmpReportRequestContext
} from "@/lib/dmp-report-store";
import { getActiveShopCookie } from "@/lib/session-server";
import { getShopSwitcherData } from "@/lib/store/runtime-store";

export const metadata: Metadata = {
  title: "达摩盘一体化报告中心｜少壮AI自动化"
};

export const dynamic = "force-dynamic";

const REPORT_PAGE_SIZE = 24;
const EMPTY_PAGINATION = {
  page: 1,
  pageSize: REPORT_PAGE_SIZE,
  total: 0,
  totalPages: 0,
  hasNext: false
};

export default async function DmpReportPage({
  searchParams
}: {
  searchParams: Promise<{ reportId?: string; view?: string; source?: string }>;
}) {
  const query = await searchParams;
  if (query.source === "dmp-extension") {
    const access = await getDmpReportAccess();
    if (!access) redirect("/tools?dmpAccess=paid");
    return <main id="dmp-extension-report-host" />;
  }

  const activeShopId = String(await getActiveShopCookie() ?? "").trim();
  const context = await resolveDmpReportRequestContext({ shopId: activeShopId });
  if (!context.ok) {
    if (context.status === 401) redirect("/tools?dmpAccess=paid");
    return (
      <>
        <PageHeader title="达摩盘一体化报告中心｜少壮AI自动化" />
        <DmpReportWorkspace
          initialReports={[]}
          initialPagination={EMPTY_PAGINATION}
          initialShops={[]}
          activeShopId=""
          canCreateShop={false}
          initialNotice={context.error}
        />
      </>
    );
  }

  const requestedReportId = query.reportId?.trim() ?? "";
  const [shopData, listed, requestedReport] = await Promise.all([
    getShopSwitcherData(),
    listDmpBusinessReportSummaries(context.access, {
      shopId: context.shop.id,
      page: 1,
      pageSize: REPORT_PAGE_SIZE
    }),
    requestedReportId
      ? getDmpBusinessReport(context.access, requestedReportId, context.shop.id)
      : Promise.resolve(null)
  ]);
  if (requestedReportId && !requestedReport) notFound();

  const pagination = {
    page: listed.page,
    pageSize: listed.pageSize,
    total: listed.total,
    totalPages: listed.totalPages,
    hasNext: listed.hasNext
  };

  return (
    <>
      <PageHeader title="达摩盘一体化报告中心｜少壮AI自动化" />
      <DmpReportWorkspace
        initialReports={listed.summaries}
        initialPagination={pagination}
        initialShops={shopData.shops.map(({ id, name }) => ({ id, name }))}
        activeShopId={context.shop.id}
        canCreateShop={shopData.canCreate}
        initialSelectedReport={requestedReport}
        focusReport={query.view === "report"}
      />
    </>
  );
}
