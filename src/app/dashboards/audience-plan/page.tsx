import { ActionComparison } from "@/components/ActionComparison";
import { AudiencePlanTable } from "@/components/AudiencePlanTable";
import { DashboardShareButton } from "@/components/DashboardShareButton";
import { DiagnosticsUploadPrompt } from "@/components/DiagnosticsUploadPrompt";
import { OperatingNetworkDashboard } from "@/components/OperatingNetworkDashboard";
import { PageHeader } from "@/components/PageHeader";
import { getScopedOperatingNetwork } from "@/lib/operating-network-server";
import { getAudiencePlans } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

// 首屏只传点击≥该门槛的计划（与表格默认筛选一致）；表格里可「加载全部」拉低点击计划。
const INITIAL_MIN_CLICKS = 100;

export default async function AudiencePlanPage() {
  const [allItems, network] = await Promise.all([getAudiencePlans(), getScopedOperatingNetwork()]);
  const items = allItems.filter((item) => (item.clicks ?? 0) >= INITIAL_MIN_CLICKS);

  return (
    <>
      <PageHeader
        eyebrow="Audience Plan"
        title="人群三收计划・先分角色，再验证人群经济性"
        description="按引潜/新客占比划分拉新、追投、收割与观察；当前 ROI 是点击加权报表代理，缺花费、支付与贡献利润时不代表高回报。"
        actions={<DashboardShareButton currentSection="audience" />}
      />
      <AudiencePlanTable items={items} serverMinClicks={INITIAL_MIN_CLICKS} />
      {network.hasDiagnosticData ? (
        <OperatingNetworkDashboard snapshot={network.snapshot} focus="audience" />
      ) : (
        <DiagnosticsUploadPrompt description="当前店铺还没有人群计划数据；上传源表并完成填写后，将在表格下生成人群结构、经济闸门和验证动作。" />
      )}
      <ActionComparison view="audience" />
    </>
  );
}
