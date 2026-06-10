import { ManagementConsole } from "@/components/management/ManagementConsole";
import {
  getInviteCodes,
  getManagedUsers,
  getManagementHistory,
  getWorkspaceContext
} from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function ManagementPage() {
  const { user } = await getWorkspaceContext();
  const [initialInvites, initialUsers, initialHistory] = await Promise.all([
    getInviteCodes(),
    getManagedUsers(),
    getManagementHistory()
  ]);

  return (
    <ManagementConsole
      currentUser={user}
      initialInvites={initialInvites}
      initialUsers={initialUsers}
      initialHistory={initialHistory}
    />
  );
}
