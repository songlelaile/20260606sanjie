import { ActionComparison } from "@/components/ActionComparison";
import { DashboardShareButton } from "@/components/DashboardShareButton";
import { DiagnosticsUploadPrompt } from "@/components/DiagnosticsUploadPrompt";
import { OperatingNetworkDashboard } from "@/components/OperatingNetworkDashboard";
import { PageHeader } from "@/components/PageHeader";
import { ProductBreakthroughTable } from "@/components/ProductBreakthroughTable";
import { getScopedOperatingNetwork } from "@/lib/operating-network-server";
import { getBreakthroughResults } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function ProductBreakthroughPage() {
  const [items, network] = await Promise.all([getBreakthroughResults(), getScopedOperatingNetwork()]);

  return (
    <>
      <PageHeader
        eyebrow="Product Breakthrough"
        title="单品八步诊断・定位卡点、放大爆款产出"
        description="用八维相对基准定位搜索、承接、退款、连带和复购问题；缺源显示为“—/待补”，不会冒充商品短板。"
        actions={<DashboardShareButton currentSection="breakthrough" />}
      />
      <ProductBreakthroughTable items={items} />
      {network.hasDiagnosticData ? (
        <OperatingNetworkDashboard snapshot={network.snapshot} focus="product" />
      ) : (
        <DiagnosticsUploadPrompt description="当前店铺还没有单品承接数据；上传源表并完成填写后，将在表格下生成潜力商品、八维瓶颈和修复动作。" />
      )}
      <ActionComparison view="product" />
    </>
  );
}
