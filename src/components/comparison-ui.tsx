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

const EPS = 1e-9;

/** 变化文案：前窗为 0、后窗有值 → "新增"（避免误导的 +100%）；否则带符号绝对+相对。 */
export function deltaText(before: number, after: number, delta: number, deltaPct: number, unit: ComparisonMetric["unit"]): string {
  if (Math.abs(before) < EPS && Math.abs(after) >= EPS) {
    return "新增";
  }
  return `${delta >= 0 ? "+" : ""}${fmtMetric(delta, unit)}（${deltaPct >= 0 ? "+" : ""}${(deltaPct * 100).toFixed(1)}%）`;
}

/** 表格主指标变化标签（前窗0且后窗有值 → "新增"）。 */
export function deltaPctLabel(before: number, after: number, deltaPct: number): string {
  if (Math.abs(before) < EPS && Math.abs(after) >= EPS) {
    return "新增";
  }
  return `${deltaPct >= 0 ? "+" : ""}${(deltaPct * 100).toFixed(1)}%`;
}

export function MetricCard({ m }: { m: ComparisonMetric }) {
  const t = metricTone(m);
  return (
    <div className={clsx("review-metric", t)}>
      <span className="review-metric-label">{m.label}</span>
      <span className="review-metric-values">
        {fmtMetric(m.before, m.unit)} → <strong>{fmtMetric(m.after, m.unit)}</strong>
      </span>
      <span className="review-metric-delta">{deltaText(m.before, m.after, m.delta, m.deltaPct, m.unit)}</span>
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
