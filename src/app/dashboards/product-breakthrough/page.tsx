import { PageHeader } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { formatNumber } from "@/lib/format";
import { getLatestCalcRun } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

export default async function ProductBreakthroughPage() {
  const items = [...(await getLatestCalcRun()).breakthroughResults].sort((a, b) => b.score - a.score);

  return (
    <>
      <PageHeader
        eyebrow="Product Breakthrough"
        title="三维八步・S 单品突围"
        description="用八个 0/1 指标生成方案编码，定位搜索、承接、退款、连带和复购问题。"
      />
      <section className="table-panel">
        <div className="panel-toolbar">
          <div>
            <strong>商品诊断结果</strong>
            <span>1 为优于阈值，0 为低于阈值；跳失率和退款率为越低越好</span>
          </div>
          <span className="table-count">共 {items.length} 个商品</span>
        </div>
        <div className="table-wrap">
          <table className="breakthrough-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>生命周期</th>
                <th>评级</th>
                <th>评分</th>
                <th>方案编码</th>
                <th>待优化项</th>
                <th>解决方案</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty-table-cell">
                    暂无诊断数据，请先导入源数据并运行算法。
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const failedDimensions = item.dimensions
                    .filter((dimension) => !dimension.passed)
                    .map((dimension) => dimension.label);
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
                      <td className="code-cell">{item.solutionCode}</td>
                      <td>{failedDimensions.length > 0 ? failedDimensions.join("、") : "—"}</td>
                      <td>{item.solution}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
