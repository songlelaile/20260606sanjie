import { GrowthProfitConfigEditor } from "@/components/GrowthProfitConfigEditor";
import { PageHeader } from "@/components/PageHeader";
import { PrefillEditor } from "@/components/PrefillEditor";
import {
  getGrowthProfitConfig,
  getPrefillItems,
  getWorkspaceContext
} from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function PrefillPage() {
  const { cycle } = await getWorkspaceContext();
  const items = await getPrefillItems(cycle.id);
  const growthProfitConfig = await getGrowthProfitConfig();

  return (
    <>
      <PageHeader
        eyebrow="Editable Parameters"
        title="预填写表"
        description="先维护 SABC 分层利润率规划表（默认值可自定义、参与三阶计算），再补充商品 SAB 分层、GSV 机会、毛利率。"
      />
      <GrowthProfitConfigEditor cycleId={cycle.id} initialConfig={growthProfitConfig} />
      <PrefillEditor cycleId={cycle.id} initialItems={items} />
    </>
  );
}
