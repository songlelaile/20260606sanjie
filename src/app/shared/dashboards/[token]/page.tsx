import { notFound } from "next/navigation";
import { KpiGrid } from "@/components/KpiGrid";
import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { formatDateTime, formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { isPrefillReady } from "@/lib/prefill-status";
import { getDashboardShareSnapshot } from "@/lib/store/runtime-store";
import type { DashboardShareSection, ProductTag } from "@/lib/types/domain";

export const dynamic = "force-dynamic";

const DEFAULT_LEGACY_SECTIONS: DashboardShareSection[] = ["management", "breakthrough", "audience"];

const SECTION_LABEL: Record<DashboardShareSection, string> = {
  management: "综合看板",
  breakthrough: "单品突破",
  audience: "人群计划",
  prefill: "预填写表"
};

export default async function SharedDashboardPage({
  params
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const snapshot = await getDashboardShareSnapshot(token);
  if (!snapshot) {
    notFound();
  }
  const run = snapshot.calcRun;
  const dashboard = run.managementDashboard;
  const sections = snapshot.sections?.length ? snapshot.sections : DEFAULT_LEGACY_SECTIONS;
  const has = (section: DashboardShareSection) => sections.includes(section);
  const tagById = new Map((snapshot.prefill?.tags ?? []).map((tag: ProductTag) => [tag.id, tag]));

  return (
    <>
      <PageHeader
        eyebrow="Shared Snapshot"
        title={snapshot.title}
        description={`${snapshot.sourceTenantName} / ${snapshot.sourceShopName} · ${formatDateTime(snapshot.createdAt)} 固定版本 · 只读分享`}
      />
      <div className="retention-strip">
        <b>只读快照</b>
        <span>创建人：{snapshot.createdBy || "—"}</span>
        <span>分享模块：{sections.map((section) => SECTION_LABEL[section]).join("、")}</span>
        <span>源数据后续变化不会影响此链接</span>
        <span>被分享者无法修改数据</span>
      </div>

      {has("management") ? (
        <>
          <KpiGrid
            items={[
              { label: "商品数量", value: formatNumber(dashboard.productCount) },
              { label: "分析窗去退销售额", value: formatMoney(dashboard.monthlyNetSales, 1) },
              { label: "分析窗贡献利润估算", value: formatMoney(dashboard.monthlyProfitEstimate, 1) },
              { label: "月GSV机会", value: formatMoney(dashboard.monthlyGsvOpportunity, 1) },
              { label: "静态利润安全垫（非预算）", value: formatMoney(dashboard.availableAdBudget, 1) },
              { label: "历史利润率", value: formatPercent(dashboard.historicalMarginRate, 1) }
            ]}
          />

          <section className="table-panel">
            <div className="panel-toolbar">
              <div>
                <strong>综合看板 · 销售 TOP 商品</strong>
                <span>分享创建时的固定版本</span>
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
                    <th>可投费用</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.topProducts.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="empty-table-cell">该快照暂无商品数据。</td>
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
                        <td>{formatMoney(product.remainingAdBudget, 1)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {has("breakthrough") ? (
        <section className="table-panel">
          <div className="panel-toolbar">
            <div>
              <strong>单品突破诊断</strong>
              <span>前 30 条，按评分降序</span>
            </div>
            <span className="table-count">共 {run.breakthroughResults.length} 个商品</span>
          </div>
          <div className="table-wrap">
            <table className="breakthrough-table">
              <thead>
                <tr>
                  <th>商品</th>
                  <th>生命周期</th>
                  <th>评级</th>
                  <th>评分</th>
                  <th>待优化项</th>
                </tr>
              </thead>
              <tbody>
                {[...run.breakthroughResults]
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 30)
                  .map((item) => {
                    const failed = item.dimensions.filter((d) => !d.passed).map((d) => d.label);
                    return (
                      <tr key={item.productId}>
                        <td>
                          <strong>{item.productId}</strong>
                          <span>{item.productName}</span>
                        </td>
                        <td>{item.lifecycle}</td>
                        <td>{item.grade}</td>
                        <td>
                          <StatusPill tone={item.score >= 5 ? "good" : item.score >= 3 ? "warn" : "bad"}>
                            {formatNumber(item.score)} / 8
                          </StatusPill>
                        </td>
                        <td>{failed.length > 0 ? failed.join("、") : "—"}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {has("audience") ? (
        <section className="table-panel">
          <div className="panel-toolbar">
            <div>
              <strong>人群计划</strong>
              <span>前 50 条，按点击量降序</span>
            </div>
            <span className="table-count">共 {run.audiencePlans.length} 条</span>
          </div>
          <div className="table-wrap">
            <table className="audience-plan-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>计划</th>
                  <th>人群</th>
                  <th>主体商品</th>
                  <th>点击量</th>
                  <th>ROI</th>
                </tr>
              </thead>
              <tbody>
                {[...run.audiencePlans]
                  .sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0))
                  .slice(0, 50)
                  .map((item, index) => (
                    <tr key={`${item.type}-${item.planId}-${item.audienceName}-${index}`}>
                      <td>{item.type}</td>
                      <td>
                        <strong>{item.planName}</strong>
                        <span>{item.sceneName}</span>
                      </td>
                      <td>{item.audienceName}</td>
                      <td>{item.subjectName}</td>
                      <td>{formatNumber(item.clicks)}</td>
                      <td>{formatNumber(item.roi, 2)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {has("prefill") ? (
        <section className="table-panel">
          <div className="panel-toolbar">
            <div>
              <strong>预填写表</strong>
              <span>当前周期固定版本，只读展示</span>
            </div>
            <span className="table-count">共 {snapshot.prefill?.items.length ?? 0} 个商品</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>商品</th>
                  <th>看数分类（选填）</th>
                  <th>分层</th>
                  <th>月GSV机会</th>
                  <th>毛利率</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {(snapshot.prefill?.items ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty-table-cell">该快照暂无预填写商品。</td>
                  </tr>
                ) : (
                  (snapshot.prefill?.items ?? []).map((item) => {
                    const tags = (item.tagIds ?? []).map((id) => tagById.get(id)?.name).filter(Boolean);
                    return (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.productId}</strong>
                          <span>{item.productName}</span>
                        </td>
                        <td>{tags.length > 0 ? tags.join("、") : "未分类"}</td>
                        <td>{item.grade || "未填写"}</td>
                        <td>{item.monthlyGsvOpportunity > 0 ? formatMoney(item.monthlyGsvOpportunity, 1) : "未填写"}</td>
                        <td>{item.grossMarginRate > 0 ? formatPercent(item.grossMarginRate, 1) : "未填写"}</td>
                        <td>
                          <span className={isPrefillReady(item) ? "pill-ready" : "pill-pending"}>
                            {isPrefillReady(item) ? "纳入计算" : "待填写"}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
