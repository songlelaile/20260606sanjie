import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { SowerWorkAccessManager } from "@/components/management/SowerWorkAccessManager";
import { isSessionAccountValid } from "@/lib/accounts";
import { getServerSession } from "@/lib/session-server";
export const dynamic = "force-dynamic";
export default async function SowerWorkManagementPage() {
  const session = await getServerSession();
  if (!session || session.role !== "admin" || !await isSessionAccountValid(session)) redirect("/tools");
  return <>
    <PageHeader eyebrow="Sower Work" title="Sower Work 授权管理" description="只有当前有效的官网管理员可以开通、续期或撤销独立采集插件使用权。" />
    <p><Link href="/tools">返回工具页</Link> · <Link href="/management">返回管理</Link></p>
    <SowerWorkAccessManager />
  </>;
}
