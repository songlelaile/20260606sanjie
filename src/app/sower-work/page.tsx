import { redirect } from "next/navigation";
import { getSowerWorkAccess } from "@/lib/sower-work-access";
import { SowerWorkStudio } from "@/components/sower-work/SowerWorkStudio";

export const dynamic = "force-dynamic";

export default async function SowerWorkPage() {
  const access = await getSowerWorkAccess();
  if (!access.allowed) {
    if (access.status === 401) redirect("/login");
    if (access.status === 403) redirect("/dashboards/operating-network");
    return (
      <section className="page" aria-label="Sower Work 授权状态">
        <h1>Sower Work</h1>
        <p role="alert">{access.message}</p>
      </section>
    );
  }
  return <SowerWorkStudio />;
}
