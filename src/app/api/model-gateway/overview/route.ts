import { NextResponse } from "next/server";
import { GATEWAY_MODELS, GATEWAY_PLANS } from "@/lib/model-gateway/catalog";
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
      ...overview,
      plans: GATEWAY_PLANS,
      models: GATEWAY_MODELS.map((model) => ({
        id: model.id,
        label: model.label,
        provider: model.provider,
        kind: model.kind,
        endpoint: model.endpoint
      }))
    }
  });
}
