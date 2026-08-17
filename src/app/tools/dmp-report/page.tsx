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
  searchParams: Promise<{ reportId?: string; view?: string }>;
}) {
  const query = await searchParams;
  const access = await getDmpReportAccess();
  if (!access) redirect("/tools?dmpAccess=paid");
  const reports = await listDmpBusinessReports(access);

  return (
    <>
      <PageHeader
        eyebrow="DMP Business Reports"
        title="达摩盘一体化报告中心｜少壮AI自动化"
        description="统一沉淀打爆路径与竞争态势分析结果，支持官网在线查看、公开只读分享和历史管理；传播与关注度数据仅在管理员后台查看，普通报告中心不展示业务数据下载入口。"
      />
      <DmpReportWorkspace
        initialReports={reports}
        initialSelectedId={query.reportId ?? ""}
        focusReport={query.view === "report"}
      />
    </>
  );
}
