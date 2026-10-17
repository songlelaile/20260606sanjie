import { CreativeStudio } from "@/components/creative/CreativeStudio";

export const dynamic = "force-dynamic";

export default async function VideoStudioPage({ searchParams }: { searchParams: Promise<{ apiConfig?: string }> }) {
  const params = await searchParams;
  return <CreativeStudio kind="video" initialApiConfig={params.apiConfig === "1"} />;
}
