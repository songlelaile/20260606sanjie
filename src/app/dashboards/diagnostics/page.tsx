import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function DiagnosticsPage() {
  redirect("/dashboards/operating-network");
}
