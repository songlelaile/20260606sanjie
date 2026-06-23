import { ActionComparison } from "@/components/ActionComparison";
import { AudiencePlanTable } from "@/components/AudiencePlanTable";
import { PageHeader } from "@/components/PageHeader";
import { getAudiencePlans } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

// 首屏只传点击≥该门槛的计划（与表格默认筛选一致）；表格里可「加载全部」拉低点击计划。
const INITIAL_MIN_CLICKS = 100;

export default async function AudiencePlanPage() {
  const items = await getAudiencePlans(INITIAL_MIN_CLICKS);

  return (
    <>
      <PageHeader
        eyebrow="Audience Plan"
        title="人群三收计划・把预算投给高回报人群"
        description="从无界人群报表筛选拉新、追投、收割计划，让预算落到可执行人群。"
      />
      <AudiencePlanTable items={items} serverMinClicks={INITIAL_MIN_CLICKS} />
      <ActionComparison view="audience" />
    </>
  );
}
