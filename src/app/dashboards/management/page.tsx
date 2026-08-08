import { ActionComparison } from "@/components/ActionComparison";
import { DashboardShareButton } from "@/components/DashboardShareButton";
import { DiagnosticsUploadPrompt } from "@/components/DiagnosticsUploadPrompt";
import { KpiBoard } from "@/components/KpiBoard";
import { ManagementTopProductsTable } from "@/components/ManagementTopProductsTable";
import { OperatingNetworkDashboard } from "@/components/OperatingNetworkDashboard";
import { PageHeader } from "@/components/PageHeader";
import { ProductTagDashboard } from "@/components/ProductTagDashboard";
import { getScopedOperatingNetwork } from "@/lib/operating-network-server";
import { getManagementData, getProductTags, getStoreDailyTrend } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function ManagementDashboardPage() {
  const [mgmt, trend, tags, network] = await Promise.all([
    getManagementData(),
    getStoreDailyTrend(),
    getProductTags(),
    getScopedOperatingNetwork()
  ]);
  const dashboard = mgmt.managementDashboard;

  return (
    <>
      <PageHeader
        eyebrow="Management Dashboard"
        title="盈利分层诊断・先看利润证据，再过投资闸门"
        description="展示分析窗经营结果、人工月目标与静态利润安全垫；安全垫不是获批预算，最终投资与放量以经营网络闸门为准。"
        actions={<DashboardShareButton currentSection="management" />}
      />
      <KpiBoard dashboard={dashboard} results={mgmt.investmentResults} trendSeries={trend?.series ?? []} />
      <ProductTagDashboard tags={tags} results={mgmt.investmentResults} analysisPeriod={dashboard.analysisPeriod} />
      <ManagementTopProductsTable products={dashboard.topProducts} />
      {network.hasDiagnosticData ? (
        <OperatingNetworkDashboard snapshot={network.snapshot} focus="management" />
      ) : (
        <DiagnosticsUploadPrompt description="当前店铺还没有可诊断的经营数据；上传源表并完成填写后，将在表格下生成经营结果、利润证据、投资闸门和动作网络。" />
      )}
      <ActionComparison view="overview" />
    </>
  );
}
