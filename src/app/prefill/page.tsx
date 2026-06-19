import { PageHeader } from "@/components/PageHeader";
import { PrefillEditor } from "@/components/PrefillEditor";
import { getPrefillItems, getWorkspaceContext } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function PrefillPage() {
  const { cycle } = await getWorkspaceContext();
  const items = await getPrefillItems(cycle.id);

  return (
    <>
      <PageHeader
        eyebrow="Editable Parameters"
        title="预填写表"
        description="补充商品 SAB 分层、GSV 机会、毛利率。"
      />
      <PrefillEditor cycleId={cycle.id} initialItems={items} />
    </>
  );
}
