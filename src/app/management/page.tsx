import { getCurrentUser } from "@/lib/server-session";
import { ManagementConsole } from "@/components/management/ManagementConsole";
import Link from "next/link";
import {
  getInviteCodes,
  getManagedUsers,
  getWorkspaceContext
} from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function ManagementPage() {
  const { user } = await getWorkspaceContext();
  const account = await getCurrentUser();
  const [initialInvites, initialUsers] = await Promise.all([
    getInviteCodes(),
    getManagedUsers()
  ]);

  return (
    <>
    <p><Link className="button-link" href="/management/sower-work">Sower Work 独立采集插件授权管理</Link></p>
    {account?.authRole === "admin" && account.status === "active" && <p><Link className="button-link" href="/management/video-materials">视频素材自动报备 · 安全配置</Link></p>}
    <ManagementConsole
      currentUser={{ ...user, authRole: account?.authRole === "admin" ? "admin" : "tenant" }}
      canManageGatewayBilling={account?.authRole === "admin" && account.status === "active"}
      initialInvites={initialInvites}
      initialUsers={initialUsers}
    />
    </>
  );
}
