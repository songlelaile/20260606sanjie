import { NextResponse } from "next/server";
import { getManagementData } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      data: {
        dashboard: (await getManagementData()).managementDashboard
      }
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
