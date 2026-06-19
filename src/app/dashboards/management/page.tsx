import { ActionComparison } from "@/components/ActionComparison";
import { KpiBoard } from "@/components/KpiBoard";
import { PageHeader } from "@/components/PageHeader";
import { formatMoney, formatPercent } from "@/lib/format";
import { getManagementData, getStoreDailyTrend } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function ManagementDashboardPage() {
  // 只取 dashboard + investmentResults 切片，不加载 ~96% 体积的 audiencePlans。
  const [mgmt, trend] = await Promise.all([getManagementData(), getStoreDailyTrend()]);
  const dashboard = mgmt.managementDashboard;

  return (
    <>
      <PageHeader
        eyebrow="Management Dashboard"
        title="盈利分层诊断・把预算投向高回报商品"
        description="站在管理角度判断：哪些商品值得投、销售缺口有多大、全店还有多少可投费用。点 KPI 卡可下钻分析。"
      />
      <KpiBoard dashboard={dashboard} results={mgmt.investmentResults} trendSeries={trend?.series ?? []} />
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
