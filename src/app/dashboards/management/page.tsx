import { ActionComparison } from "@/components/ActionComparison";
import { KpiGrid } from "@/components/KpiGrid";
import { PageHeader } from "@/components/PageHeader";
import { formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { getLatestCalcRun } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function ManagementDashboardPage() {
  const dashboard = (await getLatestCalcRun()).managementDashboard;

  return (
    <>
      <PageHeader
        eyebrow="Management Dashboard"
        title="盈利分层・付费驱动增长"
        description="站在管理角度判断：哪些商品值得投、销售缺口有多大、全店还有多少可投费用。"
      />
      <KpiGrid
        items={[
          { label: "商品总数", value: formatNumber(dashboard.productCount) },
          { label: "月去退销售额", value: formatMoney(dashboard.monthlyNetSales, 1) },
          { label: "月利润预估", value: formatMoney(dashboard.monthlyProfitEstimate, 1) },
          { label: "历史利润率", value: formatPercent(dashboard.historicalMarginRate, 1) },
          { label: "月GSV机会", value: formatMoney(dashboard.monthlyGsvOpportunity, 1) },
          {
            label: dashboard.marketSalesGap < 0 ? "市场销售盈余" : "市场销售缺口",
            value: formatMoney(Math.abs(dashboard.marketSalesGap), 1),
            tone: dashboard.marketSalesGap < 0 ? "good" : "warn"
          },
          { label: "全店可投费用", value: formatMoney(dashboard.availableAdBudget, 1), tone: "good" },
          { label: "增长预留毛利", value: formatMoney(dashboard.plannedProfit, 1) },
          { label: "预留毛利率", value: formatPercent(dashboard.plannedMarginRate, 1) }
        ]}
      />
      <section className="table-panel">
        <div className="panel-toolbar">
          <div>
            <strong>销售 TOP 商品</strong>
            <span>按去退销售额降序，承接预算与人群方案</span>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>商品</th>
                <th>生命周期</th>
                <th>评级</th>
                <th>月GSV机会</th>
                <th>历史利润</th>
                <th>历史利润率</th>
                <th>预留毛利率</th>
                <th>增长预留毛利</th>
                <th>可投费用</th>
                <th>销售缺口</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.topProducts.length === 0 ? (
                <tr>
                  <td colSpan={10} className="empty-table-cell">
                    暂无商品数据，请先导入源数据并运行算法。
                  </td>
                </tr>
              ) : (
                dashboard.topProducts.map((product) => (
                  <tr key={product.productId}>
                    <td>
                      <strong>{product.productId}</strong>
                      <span>{product.productName}</span>
                    </td>
                    <td>{product.lifecycle}</td>
                    <td>{product.grade}</td>
                    <td>{formatMoney(product.monthlyGsvOpportunity, 1)}</td>
                    <td>{formatMoney(product.historicalGrossProfit, 1)}</td>
                    <td>{formatPercent(product.historicalMarginRate, 1)}</td>
                    <td>{formatPercent(product.attackDefenseMarginRate, 1)}</td>
                    <td>{formatMoney(product.plannedGrossProfit, 1)}</td>
                    <td>{formatMoney(product.remainingAdBudget, 1)}</td>
                    <td>{formatMoney(product.salesGap, 1)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
      <ActionComparison view="overview" />
    </>
  );
}
