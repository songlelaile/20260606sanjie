"use client";

import clsx from "clsx";
import { useState } from "react";
import { DailyTrendChart, useTrendSelection } from "@/components/DailyTrendChart";
import { FunnelChain, StagedMetricGrid } from "@/components/comparison-ui";
import { ComparisonCoverageNotice } from "@/components/ComparisonCoverageNotice";
import type { Intervention, InterventionComparison } from "@/lib/types/domain";

export function ReviewConsole({ interventions }: { interventions: Intervention[] }) {
  const trend = useTrendSelection(); // 趋势图选中态：指标卡下钻与图表共享
  const [selectedId, setSelectedId] = useState<string | null>(interventions[0]?.id ?? null);
  const [beforeDays, setBeforeDays] = useState(7);
  const [afterDays, setAfterDays] = useState(7);
  const [comparison, setComparison] = useState<InterventionComparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(id: string, before = beforeDays, after = afterDays) {
    setSelectedId(id);
    setBusy(true);
    setError("");
    const response = await fetch(`/api/interventions/${id}/comparison?before=${before}&after=${after}`);
    const payload = (await response.json().catch(() => null)) as
      | { data?: { comparison: InterventionComparison }; error?: string }
      | null;
    setBusy(false);
    if (!response.ok || !payload?.data) {
      setComparison(null);
      setError(payload?.error ?? "加载对比失败");
      return;
    }
    setComparison(payload.data.comparison);
  }

  if (interventions.length === 0) {
    return (
      <section className="table-panel management-table-panel">
        <div className="panel-toolbar">
          <div>
            <strong>经营复盘</strong>
            <span>还没有标记任何优化动作。先到「数据导入」页标记一次调整，这里就能看到前后数据对比。</span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <div className="review-console">
      <section className="table-panel management-table-panel review-timeline">
        <div className="panel-toolbar">
          <div>
            <strong>优化动作</strong>
            <span>选择一个动作，查看它前后的经营数据变化。</span>
          </div>
        </div>
        <ul className="review-action-list">
          {interventions.map((iv) => (
            <li key={iv.id}>
              <button
                type="button"
                className={clsx("review-action-item", selectedId === iv.id && "active")}
                onClick={() => load(iv.id)}
              >
                <span className="review-action-date">{iv.date}</span>
                <span className="review-action-title">{iv.title}</span>
                <span className="review-action-meta">
                  {iv.category || "—"} · {iv.productIds.length === 0 ? "整店" : `${iv.productIds.length} 商品`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="table-panel management-table-panel review-detail">
        <div className="panel-toolbar">
          <div>
            <strong>前后对比</strong>
            <span>动作当天计入「后窗」；可调前后对比天数。</span>
          </div>
          <div className="review-window-controls">
            <label>
              前
              <input
                type="number"
                min={1}
                max={90}
                value={beforeDays}
                onChange={(e) => setBeforeDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
              />
              天
            </label>
            <label>
              后
              <input
                type="number"
                min={1}
                max={90}
                value={afterDays}
                onChange={(e) => setAfterDays(Math.max(1, Math.min(90, Number(e.target.value) || 1)))}
              />
              天
            </label>
            <button
              type="button"
              onClick={() => selectedId && load(selectedId, beforeDays, afterDays)}
              disabled={busy || !selectedId}
            >
              {busy ? "计算中…" : "应用"}
            </button>
          </div>
        </div>

        {error ? <p className="management-message">{error}</p> : null}

        {comparison ? (
          <div className="review-body">
            <p className="review-window-note">
              前窗 {comparison.window.beforeStart} ~ {comparison.window.beforeEnd}　·　后窗{" "}
              {comparison.window.afterStart} ~ {comparison.window.afterEnd}
            </p>
            <ComparisonCoverageNotice window={comparison.window} />

            {comparison.window.coverage.status === "ready" ? (
              <>
                <div className="review-lens">
              <h3>① 投产链路（{comparison.lensA.productScope}）</h3>
              <p className="review-lens-sub">动作如何沿 投放→流量→成交→利润 漏斗传导。</p>
              <FunnelChain steps={comparison.lensA.chain} />
              <StagedMetricGrid
                metrics={comparison.lensA.metrics}
                chartLink={{ activeKeys: new Set(trend.selected), onToggle: trend.toggle }}
              />
                </div>

                <div className="review-lens">
              <h3>② 计划 vs 实际（按完整后窗折算月度）</h3>
              {comparison.lensB.rows.length === 0 ? (
                <p className="review-empty">受影响商品暂无计划或完整后窗内无数据。</p>
              ) : (
                <div className="table-wrap">
                  <table className="management-table">
                    <thead>
                      <tr>
                        <th>商品</th>
                        <th>计划月GSV</th>
                        <th>实际折算月销</th>
                        <th>达成率</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.lensB.rows.map((r) => (
                        <tr key={r.productId}>
                          <td>
                            <strong>{r.productId}</strong>
                            <span>{r.productName}</span>
                          </td>
                          <td>¥{Math.round(r.planMonthlyGsv).toLocaleString()}</td>
                          <td>{r.actualMonthlyGsv === null ? "—" : `¥${Math.round(r.actualMonthlyGsv).toLocaleString()}`}</td>
                          <td>
                            {/* 未设月GSV目标 → 显示"未设目标"，不能渲染成 0% 的"完全未达标"。 */}
                            <span
                              className={clsx(
                                "user-status-pill",
                                r.attainmentPct === null
                                  ? "pending"
                                  : r.attainmentPct >= 1
                                    ? "active"
                                    : r.attainmentPct >= 0.6
                                      ? "pending"
                                      : "disabled"
                              )}
                            >
                              {r.attainmentPct === null ? "未设目标" : `${(r.attainmentPct * 100).toFixed(0)}%`}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
                </div>
              </>
            ) : (
              <p className="review-empty">当前仅展示已到达的每日趋势，不输出涨跌、投产或月度折算结论。</p>
            )}

            <div className="review-lens">
              <h3>③ 每日趋势（多指标多轴对比，动作日标注）</h3>
              <DailyTrendChart
                series={comparison.lensC.series}
                interventionDate={comparison.lensC.interventionDate}
                selection={trend}
              />
            </div>
          </div>
        ) : busy ? (
          <p className="review-empty">计算中…</p>
        ) : (
          <p className="review-empty">点选左侧一个动作查看对比。</p>
        )}
      </section>
    </div>
  );
}
