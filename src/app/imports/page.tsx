import { PageHeader } from "@/components/PageHeader";
import { SourceDataConsole } from "@/components/SourceDataConsole";
import { getImportBatches } from "@/lib/store/runtime-store";

export default function ImportsPage() {
  const batches = getImportBatches();

  return (
    <>
      <PageHeader
        eyebrow="Import Center"
        title="源数据"
        description="四份报表统一入口：生意参谋商品源、达摩盘货品源、无界推广宝贝源、无界人群源。"
      />
      <SourceDataConsole initialBatches={batches} />
    </>
  );
}
