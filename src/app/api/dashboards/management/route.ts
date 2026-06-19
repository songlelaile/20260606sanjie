import { NextResponse } from "next/server";
import { getManagementData } from "@/lib/store/runtime-store";

export async function GET() {
  return NextResponse.json({
    data: {
      dashboard: (await getManagementData()).managementDashboard
    }
  });
}
