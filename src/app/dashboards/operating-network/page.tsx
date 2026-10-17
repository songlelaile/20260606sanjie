import { CreativeStudio } from "@/components/creative/CreativeStudio";

import { CREATIVE_VIRAL_SURFACES } from "@/lib/creative-viral-surfaces";

export const dynamic = "force-dynamic";

const SURFACES = new Set(["main", "detail", "ad", "mirror", "list-main", "list-legacy", "reference", "sku", "viral", ...CREATIVE_VIRAL_SURFACES.map((item) => item.id), "clothing", "buyer", "refinement"]);

export default async function OperatingNetworkPage({
  searchParams
}: {
  searchParams: Promise<{ surface?: string; batch?: string; history?: string; apiConfig?: string }>;
}) {
  const params = await searchParams;
  const surface = params.surface && SURFACES.has(params.surface) ? params.surface : "main";
  return <CreativeStudio kind="image" initialSurface={surface} initialBatch={params.batch === "1"} initialHistory={params.history === "1"} initialApiConfig={params.apiConfig === "1"} />;
}
