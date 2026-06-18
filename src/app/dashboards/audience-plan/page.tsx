import { ActionComparison } from "@/components/ActionComparison";
import { AudiencePlanTable } from "@/components/AudiencePlanTable";
import { PageHeader } from "@/components/PageHeader";
import { getLatestCalcRun } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function AudiencePlanPage() {
  const items = (await getLatestCalcRun()).audiencePlans;

  return (
    <>
      <PageHeader
        eyebrow="Audience Plan"
        title="三收 MVP 做增长"
        description="从无界人群报表筛选拉新、追投、收割计划，让预算落到可执行人群。"
      />
      <AudiencePlanTable items={items} />
      <ActionComparison view="audience" />
    </>
  );
}
