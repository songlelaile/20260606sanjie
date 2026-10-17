import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function ReportsPage() {
  redirect("/dashboards/management");
}
