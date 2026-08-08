import { PlayCircle, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { KpiGrid } from "@/components/KpiGrid";
import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { getImportBatches, getManagementData, getVersions, getWorkspaceContext } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { tenant, shop, cycle } = await getWorkspaceContext();
  const { managementDashboard: dashboard } = await getManagementData();
  const imports = await getImportBatches();
  const versions = await getVersions(cycle.id);

  return (
    <>
      <PageHeader
        eyebrow={`${tenant.name} / ${shop.name}`}
        title="管理后台"
        description="从四份源报表到预填写参数、三阶算法、管理看板和版本留痕的经营决策闭环。"
        actions={
          <Link href="/dashboards/management" className="button-link">
            <PlayCircle size={17} />
            查看综合看板
          </Link>
        }
      />
      <KpiGrid
        items={[
          { label: "填写产品数量", value: formatNumber(dashboard.productCount), helper: cycle.name },
          { label: "分析窗去退销售额", value: formatMoney(dashboard.monthlyNetSales, 1) },
          { label: "分析窗贡献利润估算", value: formatMoney(dashboard.monthlyProfitEstimate, 1) },
          { label: "月GSV机会", value: formatMoney(dashboard.monthlyGsvOpportunity, 1) },
          {
            label: "静态利润安全垫（非预算）",
            value: formatMoney(dashboard.availableAdBudget, 1),
            tone: (dashboard.availableAdBudget ?? 0) > 0 ? undefined : "warn"
          },
          {
            label: "历史利润率",
            value: formatPercent(dashboard.historicalMarginRate, 1),
            helper: `预留毛利率 ${formatPercent(dashboard.plannedMarginRate, 1)}`
          }
        ]}
      />

      <section className="overview-grid">
        <div className="section-band">
          <div className="section-title">
            <h2>数据导入状态</h2>
            <Link href="/imports">进入导入台</Link>
          </div>
          <div className="compact-list">
            {imports.map((batch) => (
              <div className="list-row" key={batch.id}>
                <span>
                  <strong>{batch.fileName}</strong>
                  <small>{batch.rowCount} 行 / {batch.validation.uniqueEntityCount} 个主体</small>
                </span>
                <StatusPill tone={batch.validation.ok ? "good" : "bad"}>
                  {batch.validation.ok ? "已通过" : "需处理"}
                </StatusPill>
              </div>
            ))}
          </div>
        </div>

        <div className="section-band">
          <div className="section-title">
            <h2>版本留痕</h2>
            <Link href="/versions">查看全部</Link>
          </div>
          <div className="compact-list">
            {versions.slice(0, 3).map((version) => (
              <div className="list-row" key={version.id}>
                <span>
                  <strong>{version.title}</strong>
                  <small>{version.summary}</small>
                </span>
                <ShieldCheck size={18} />
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
