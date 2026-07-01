import { NextResponse } from "next/server";
import { getGatewayOverview } from "@/lib/model-gateway/store";
import { getCurrentUser } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const overview = await getGatewayOverview(user.id);
  return NextResponse.json({
    data: {
      wallet: overview.wallet,
      usages: overview.usages
    }
  });
}
