import { NextResponse } from "next/server";
import { getAudiencePlans } from "@/lib/store/runtime-store";

export async function GET() {
  return NextResponse.json({
    data: {
      items: await getAudiencePlans()
    }
  });
}
