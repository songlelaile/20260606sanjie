import type { Metadata } from "next";
import { ModelGatewayConsole } from "@/components/model-gateway/ModelGatewayConsole";
import {
  GATEWAY_PLANS,
  gatewayProviderLabel
} from "@/lib/model-gateway/catalog";
import { getGatewayOverview } from "@/lib/model-gateway/store";
import { listAvailableGatewayModels } from "@/lib/model-gateway/runtime-catalog";
import { getCurrentUser } from "@/lib/server-session";
import "@/components/model-gateway/PricingPage.css";

export const metadata: Metadata = {
  title: "购买积分 · 三阶引擎"
};

export const dynamic = "force-dynamic";

export default async function ModelsPage({ searchParams }: { searchParams?: Promise<{ tab?: string | string[] }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return null;
  }
  const [overview, catalog] = await Promise.all([
    getGatewayOverview(user.id),
    listAvailableGatewayModels().then((models) => ({ models, error: null })).catch(() => ({ models: [], error: "模型目录暂不可用，请管理员检查中转站配置后刷新。" }))
  ]);
  const serializable = JSON.parse(JSON.stringify(overview));
  const query = await searchParams;
  const view = query?.tab === "api" ? "api" : "pricing";

  return (
    <>
      <ModelGatewayConsole
        view={view}
        initialOverview={serializable}
        plans={GATEWAY_PLANS}
        canManageRelay={user.authRole === "admin" && user.status === "active"}
        modelCatalogError={catalog.error}
        models={catalog.models.map((model) => ({
          id: model.id,
          label: model.label,
          provider: model.provider,
          providerLabel: gatewayProviderLabel(model.provider),
          kind: model.kind,
          endpoint: model.endpoint
        }))}
      />
    </>
  );
}
