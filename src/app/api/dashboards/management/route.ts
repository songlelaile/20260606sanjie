import { NextResponse } from "next/server";
import { getLatestCalcRun } from "@/lib/store/runtime-store";

export async function GET() {
  return NextResponse.json({
    data: {
      dashboard: getLatestCalcRun().managementDashboard
    }
  });
}
