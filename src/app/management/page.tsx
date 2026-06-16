import { ManagementConsole } from "@/components/management/ManagementConsole";
import { getInterventions } from "@/lib/store/interventions";
import {
  getInviteCodes,
  getManagedUsers,
  getManagementHistory,
  getWorkspaceContext
} from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function ManagementPage() {
  const { user } = await getWorkspaceContext();
  const [initialInvites, initialUsers, initialHistory, initialInterventions] = await Promise.all([
    getInviteCodes(),
    getManagedUsers(),
    getManagementHistory(),
    getInterventions()
  ]);

  return (
    <ManagementConsole
      currentUser={user}
      initialInvites={initialInvites}
      initialUsers={initialUsers}
      initialHistory={initialHistory}
      initialInterventions={initialInterventions}
    />
  );
}
