import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { DmpReportWorkspace } from "@/components/tools/DmpReportWorkspace";
import { isSessionAccountValid } from "@/lib/accounts";
import { getCurrentSession } from "@/lib/server-session";

export const metadata: Metadata = {
  title: "达摩盘 AI 自动化 · 三阶引擎"
};

export const dynamic = "force-dynamic";

export default async function DmpReportPage() {
  const session = await getCurrentSession();
  const validAdmin = session?.role === "admin"
    ? await isSessionAccountValid(session).catch(() => false)
    : false;
  if (!validAdmin) redirect("/tools?dmpAccess=admin");

  return (
    <>
      <PageHeader
        eyebrow="DMP AI AUTOMATION"
        title="达摩盘 AI 自动化"
        description="把插件监听 JSON 在浏览器本机解析为一张可完整打开、筛选和导出的竞品对标页面。仅平台管理员可进入，原始接口记录不会上传服务器。"
      />
      <DmpReportWorkspace />
    </>
  );
}
