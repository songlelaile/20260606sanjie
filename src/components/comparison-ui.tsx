"use client";

import clsx from "clsx";
import type { ComparisonMetric } from "@/lib/types/domain";

/** 对比指标格式化：rate=百分比，ratio=倍数，money=金额（小额留小数），int=整数。 */
export function fmtMetric(value: number, unit: ComparisonMetric["unit"]): string {
  if (unit === "rate") return `${(value * 100).toFixed(1)}%`;
  if (unit === "ratio") return value.toFixed(2);
  if (unit === "money") {
    const rounded = Math.abs(value) < 100 ? Number(value.toFixed(1)) : Math.round(value);
    return `¥${rounded.toLocaleString()}`;
  }
  return Math.round(value).toLocaleString();
}

/** 中性指标恒 flat；否则按 higherIsBetter 判断符号方向。 */
export function metricTone(metric: ComparisonMetric): "good" | "bad" | "flat" {
  if (metric.neutral || Math.abs(metric.delta) < 1e-9) return "flat";
  return metric.delta > 0 === metric.higherIsBetter ? "good" : "bad";
}

export function MetricCard({ m }: { m: ComparisonMetric }) {
  const t = metricTone(m);
  return (
    <div className={clsx("review-metric", t)}>
      <span className="review-metric-label">{m.label}</span>
      <span className="review-metric-values">
        {fmtMetric(m.before, m.unit)} → <strong>{fmtMetric(m.after, m.unit)}</strong>
      </span>
      <span className="review-metric-delta">
        {m.delta >= 0 ? "+" : ""}
        {fmtMetric(m.delta, m.unit)}（{m.deltaPct >= 0 ? "+" : ""}
        {(m.deltaPct * 100).toFixed(1)}%）
      </span>
    </div>
  );
}

/** 前→后单元格（带涨跌色，higherIsBetter 决定红绿）。 */
export function deltaCell(
  before: number,
  after: number,
  unit: ComparisonMetric["unit"],
  higherIsBetter: boolean
): { before: string; after: string; tone: "good" | "bad" | "flat" } {
  const delta = after - before;
  const tone: "good" | "bad" | "flat" =
    Math.abs(delta) < 1e-9 ? "flat" : delta > 0 === higherIsBetter ? "good" : "bad";
  return { before: fmtMetric(before, unit), after: fmtMetric(after, unit), tone };
}
