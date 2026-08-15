import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { DmpReportWorkspace } from "@/components/tools/DmpReportWorkspace";
import { getDmpReportAccess, listDmpBusinessReports } from "@/lib/dmp-report-store";

export const metadata: Metadata = {
  title: "打爆路径报告中心 · 三阶引擎"
};

export const dynamic = "force-dynamic";

export default async function DmpReportPage() {
  const access = await getDmpReportAccess();
  if (!access) redirect("/tools?dmpAccess=paid");
  const reports = await listDmpBusinessReports(access);

  return (
    <>
      <PageHeader
        eyebrow="DMP Growth Report"
        title="打爆路径报告中心"
        description="从达摩盘「货品 → 打爆路径」沉淀主体商品与成功品的增长对标报告，支持历史管理、在线查看和下载复盘。"
      />
      <DmpReportWorkspace initialReports={reports} />
    </>
  );
}
