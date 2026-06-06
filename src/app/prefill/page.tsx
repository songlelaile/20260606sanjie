import { GrowthProfitConfigEditor } from "@/components/GrowthProfitConfigEditor";
import { PageHeader } from "@/components/PageHeader";
import { PrefillEditor } from "@/components/PrefillEditor";
import {
  getGrowthProfitConfig,
  getPrefillItems,
  getWorkspaceContext
} from "@/lib/store/runtime-store";

export default function PrefillPage() {
  const { cycle } = getWorkspaceContext();
  const items = getPrefillItems(cycle.id);
  const growthProfitConfig = getGrowthProfitConfig();

  return (
    <>
      <PageHeader
        eyebrow="Editable Parameters"
        title="预填写表"
        description="先维护 V9 增长利润配置，再补充商品 SAB 分层、GSV 机会、毛利率、付费访客比和人群策略。"
      />
      <GrowthProfitConfigEditor cycleId={cycle.id} initialConfig={growthProfitConfig} />
      <PrefillEditor cycleId={cycle.id} initialItems={items} />
    </>
  );
}
