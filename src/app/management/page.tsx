import { ManagementConsole } from "@/components/management/ManagementConsole";
import {
  getInviteCodes,
  getManagedUsers,
  getWorkspaceContext
} from "@/lib/store/runtime-store";

export default function ManagementPage() {
  const { user } = getWorkspaceContext();

  return (
    <ManagementConsole
      currentUser={user}
      initialInvites={getInviteCodes()}
      initialUsers={getManagedUsers()}
    />
  );
}
