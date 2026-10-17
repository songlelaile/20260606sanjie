import { ManagementConsole } from "@/components/management/ManagementConsole";
import { getInviteCodes, getManagedUsers } from "@/lib/store/user-store";
import { getWorkspaceContext } from "@/lib/store/runtime-store";
import { getCurrentUser } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function ManagementPage() {
  const { user } = await getWorkspaceContext();
  const [initialInvites, initialUsers, billingAdmin] = await Promise.all([
    getInviteCodes(),
    getManagedUsers(),
    getCurrentUser()
  ]);

  return (
    <ManagementConsole
      currentUser={user}
      canManageGatewayBilling={billingAdmin?.authRole === "admin" && billingAdmin.status === "active"}
      initialInvites={initialInvites}
      initialUsers={initialUsers}
    />
  );
}
