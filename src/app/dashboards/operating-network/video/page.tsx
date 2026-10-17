import { CreativeStudio } from "@/components/creative/CreativeStudio";
import { CreativeAccessGate } from "@/components/creative/CreativeAccessGate";
import { getCurrentSession } from "@/lib/server-session";
import { getCreativeAccessForSession, UNAVAILABLE_CREATIVE_ACCESS } from "@/lib/creative-entitlements";
import { GATEWAY_PLANS } from "@/lib/model-gateway/catalog";

export const dynamic = "force-dynamic";

export default async function VideoStudioPage({ searchParams }: { searchParams: Promise<{ apiConfig?: string }> }) {
  const params = await searchParams;
  const access = await getCreativeAccessForSession(await getCurrentSession()).catch(() => UNAVAILABLE_CREATIVE_ACCESS);
  return <CreativeAccessGate access={access} plans={GATEWAY_PLANS}>
    {access.allowed ? <CreativeStudio kind="video" initialApiConfig={params.apiConfig === "1"} /> : null}
  </CreativeAccessGate>;
}
