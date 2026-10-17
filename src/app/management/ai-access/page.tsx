import { redirect } from "next/navigation";
import { AIAccessConsole } from "@/components/management/AIAccessConsole";
import { ROLE_HOME } from "@/lib/auth";
import { getCurrentSession, getCurrentUser } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export default async function AIAccessPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const user = await getCurrentUser();
  if (!user || user.status !== "active") redirect("/login");
  if (session.role !== "admin" || user.authRole !== "admin") redirect(ROLE_HOME[session.role]);
  return <AIAccessConsole />;
}
