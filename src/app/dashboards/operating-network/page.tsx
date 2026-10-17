import { CreativeStudio } from "@/components/creative/CreativeStudio";
import { CreativeAccessGate } from "@/components/creative/CreativeAccessGate";
import { getCurrentSession } from "@/lib/server-session";
import { getCreativeAccessForSession, UNAVAILABLE_CREATIVE_ACCESS } from "@/lib/creative-entitlements";
import { GATEWAY_PLANS } from "@/lib/model-gateway/catalog";

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
  const access = await getCreativeAccessForSession(await getCurrentSession()).catch(() => UNAVAILABLE_CREATIVE_ACCESS);
  return <CreativeAccessGate access={access} plans={GATEWAY_PLANS}>
    {access.allowed ? <CreativeStudio kind="image" initialSurface={surface} initialBatch={params.batch === "1"} initialHistory={params.history === "1"} initialApiConfig={params.apiConfig === "1"} /> : null}
  </CreativeAccessGate>;
}
