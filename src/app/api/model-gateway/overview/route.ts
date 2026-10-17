import { NextResponse } from "next/server";
import {
  GATEWAY_PLANS,
  gatewayProviderLabel
} from "@/lib/model-gateway/catalog";
import { getGatewayOverview } from "@/lib/model-gateway/store";
import { listAvailableGatewayModels } from "@/lib/model-gateway/runtime-catalog";
import { getCurrentUser } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const [overview, catalog] = await Promise.all([
    getGatewayOverview(user.id),
    listAvailableGatewayModels().then((models) => ({ models, error: null })).catch(() => ({ models: [], error: "模型目录暂不可用，请管理员检查中转站配置后刷新。" }))
  ]);
  return NextResponse.json({
    data: {
      ...overview,
      plans: GATEWAY_PLANS,
      modelCatalogError: catalog.error,
      models: catalog.models.map((model) => ({
        id: model.id,
        label: model.label,
        provider: model.provider,
        providerLabel: gatewayProviderLabel(model.provider),
        kind: model.kind,
        endpoint: model.endpoint
      }))
    }
  });
}
