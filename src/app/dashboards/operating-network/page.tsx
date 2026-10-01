import { CreativeStudio } from "@/components/creative/CreativeStudio";

export const dynamic = "force-dynamic";

const SURFACES = new Set(["main", "detail", "reference", "sku", "viral"]);

export default async function OperatingNetworkPage({
  searchParams
}: {
  searchParams: Promise<{ surface?: string }>;
}) {
  const params = await searchParams;
  const surface = params.surface && SURFACES.has(params.surface) ? params.surface : "main";
  return <CreativeStudio kind="image" initialSurface={surface} />;
}
