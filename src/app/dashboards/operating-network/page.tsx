import { OperatingNetworkDashboard } from "@/components/OperatingNetworkDashboard";
import { OperatingNetworkAiPanel } from "@/components/OperatingNetworkAiPanel";
import { ActionComparison } from "@/components/ActionComparison";
import { PageHeader } from "@/components/PageHeader";
import { getScopedOperatingNetwork } from "@/lib/operating-network-server";
import { getAiApiConfig } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function OperatingNetworkPage() {
  const [network, aiConfig] = await Promise.all([getScopedOperatingNetwork(), getAiApiConfig()]);

  return (
    <>
      <PageHeader
        eyebrow="Operating Network"
        title="经营网络・从经营结果到动作验证"
        description="把盈利投资、单品突破、人群计划、市场业务诊断与分日趋势装配成同一条证据链，区分已证明事实、待验证假设和下一步动作。"
      />
      <OperatingNetworkDashboard snapshot={network.snapshot} />
      <ActionComparison view="overview" />
      <OperatingNetworkAiPanel initialConfig={aiConfig} />
    </>
  );
}
