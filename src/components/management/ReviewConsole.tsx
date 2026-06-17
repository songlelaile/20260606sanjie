"use client";

import clsx from "clsx";
import { useState } from "react";
import { DailyTrendChart } from "@/components/DailyTrendChart";
import type { ComparisonMetric, Intervention, InterventionComparison } from "@/lib/types/domain";

function fmt(value: number, unit: ComparisonMetric["unit"]): string {
  if (unit === "rate") return `${(value * 100).toFixed(1)}%`;
  if (unit === "ratio") return value.toFixed(2);
  if (unit === "money") {
    // 小额（如客单价）保留 1 位小数，避免 2.5 被显示成 3；大额取整。
    const rounded = Math.abs(value) < 100 ? Number(value.toFixed(1)) : Math.round(value);
    return `¥${rounded.toLocaleString()}`;
  }
  return Math.round(value).toLocaleString();
}

/** 变化是好是坏：中性指标恒为 flat；否则按 higherIsBetter 判断符号方向。 */
function tone(metric: ComparisonMetric): "good" | "bad" | "flat" {
  if (metric.neutral || Math.abs(metric.delta) < 1e-9) return "flat";
  const up = metric.delta > 0;
  return up === metric.higherIsBetter ? "good" : "bad";
}

function MetricCard({ m }: { m: ComparisonMetric }) {
  const t = tone(m);
  return (
    <div className={clsx("review-metric", t)}>
      <span className="review-metric-label">{m.label}</span>
      <span className="review-metric-values">
        {fmt(m.before, m.unit)} → <strong>{fmt(m.after, m.unit)}</strong>
      </span>
      <span className="review-metric-delta">
        {m.delta >= 0 ? "+" : ""}
        {fmt(m.delta, m.unit)}（{m.deltaPct >= 0 ? "+" : ""}
        {(m.deltaPct * 100).toFixed(1)}%）
      </span>
    </div>
  );
}

export function ReviewConsole({ interventions }: { interventions: Intervention[] }) {
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

            <div className="review-lens">
              <h3>① 真实经营变化（{comparison.lensA.productScope}）</h3>
              <div className="review-metric-grid">
                {comparison.lensA.metrics
                  .filter((m) => m.group !== "广告")
                  .map((m) => (
                    <MetricCard key={m.key} m={m} />
                  ))}
              </div>
              {comparison.lensA.metrics.some((m) => m.group === "广告") ? (
                <>
                  <h4 className="review-subhead">广告投放</h4>
                  <div className="review-metric-grid">
                    {comparison.lensA.metrics
                      .filter((m) => m.group === "广告")
                      .map((m) => (
                        <MetricCard key={m.key} m={m} />
                      ))}
                  </div>
                </>
              ) : null}
            </div>

            <div className="review-lens">
              <h3>② 计划 vs 实际（按后窗折算月度）</h3>
              {comparison.lensB.rows.length === 0 ? (
                <p className="review-empty">受影响商品暂无计划或后窗无数据。</p>
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
                          <td>¥{Math.round(r.actualMonthlyGsv).toLocaleString()}</td>
                          <td>
                            <span
                              className={clsx(
                                "user-status-pill",
                                r.attainmentPct >= 1 ? "active" : r.attainmentPct >= 0.6 ? "pending" : "disabled"
                              )}
                            >
                              {(r.attainmentPct * 100).toFixed(0)}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="review-lens">
              <h3>③ 整店每日趋势（动作日标注）</h3>
              <DailyTrendChart
                series={comparison.lensC.series}
                interventionDate={comparison.lensC.interventionDate}
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
