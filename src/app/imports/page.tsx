import { InterventionPanel } from "@/components/InterventionPanel";
import { PageHeader } from "@/components/PageHeader";
import { SourceDataConsole } from "@/components/SourceDataConsole";
import { getInterventions } from "@/lib/store/interventions";
import { getImportBatches, getPrefillItems, getWorkspaceContext } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const { cycle } = await getWorkspaceContext();
  const [batches, interventions, prefillItems] = await Promise.all([
    getImportBatches(),
    getInterventions(),
    getPrefillItems(cycle.id)
  ]);
  const products = prefillItems.map((item) => ({ id: item.productId, name: item.productName }));

  return (
    <>
      <PageHeader
        eyebrow="Import Center"
        title="源数据"
        description="四份报表统一入口：生意参谋商品源、达摩盘货品源、无界推广宝贝源、无界人群源。"
      />
      <SourceDataConsole initialBatches={batches} />
      <InterventionPanel initialInterventions={interventions} products={products} />
    </>
  );
}
