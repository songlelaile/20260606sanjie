import { NextResponse } from "next/server";
import { getVersions, getWorkspaceContext } from "@/lib/store/runtime-store";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { cycle } = await getWorkspaceContext();
  const cycleId = url.searchParams.get("cycleId") ?? cycle.id;
  return NextResponse.json({
    data: {
      versions: await getVersions(cycleId)
    }
  });
}
