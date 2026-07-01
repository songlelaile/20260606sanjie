import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { ModelGatewayConsole } from "@/components/model-gateway/ModelGatewayConsole";
import { GATEWAY_MODELS, GATEWAY_PLANS } from "@/lib/model-gateway/catalog";
import { getGatewayOverview } from "@/lib/model-gateway/store";
import { getCurrentUser } from "@/lib/server-session";

export const metadata: Metadata = {
  title: "模型网关 · 三阶引擎"
};

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const user = await getCurrentUser();
  if (!user) {
    return null;
  }
  const overview = await getGatewayOverview(user.id);
  const serializable = JSON.parse(JSON.stringify(overview));

  return (
    <>
      <PageHeader
        eyebrow="Model Gateway"
        title="少壮 AI 模型网关"
        description="统一接入 OpenAI、DeepSeek、通义千问、豆包、智谱等上游模型，把平台套餐额度、用户 API Key、调用流水和插件配置收拢到一个网关。"
      />
      <ModelGatewayConsole
        initialOverview={serializable}
        plans={GATEWAY_PLANS}
        models={GATEWAY_MODELS.map((model) => ({
          id: model.id,
          label: model.label,
          provider: model.provider,
          kind: model.kind,
          endpoint: model.endpoint
        }))}
      />
    </>
  );
}
