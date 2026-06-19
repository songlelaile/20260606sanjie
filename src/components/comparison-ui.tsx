"use client";

import clsx from "clsx";
import { CHART_METRIC_BY_KEY, isChartable } from "@/components/trend-metrics";
import type { ComparisonMetric, FunnelChainStep, FunnelStage } from "@/lib/types/domain";

/** 指标卡到趋势图的联动：哪些卡当前在图中、点击切换。 */
export interface ChartLink {
  activeKeys: Set<string>;
  onToggle: (key: string) => void;
}

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

export function MetricCard({ m, chartLink }: { m: ComparisonMetric; chartLink?: ChartLink }) {
  const t = metricTone(m);
  const chartable = Boolean(chartLink) && isChartable(m.key);
  const active = chartable && chartLink!.activeKeys.has(m.key);
  const color = CHART_METRIC_BY_KEY.get(m.key)?.color;
  const body = (
    <>
      <span className="review-metric-label">
        {m.label}
        {active ? <span className="review-metric-dot" style={{ background: color }} /> : null}
      </span>
      <span className="review-metric-values">
        {fmtMetric(m.before, m.unit)} → <strong>{fmtMetric(m.after, m.unit)}</strong>
      </span>
      <span className="review-metric-delta">{deltaText(m.before, m.after, m.delta, m.deltaPct, m.unit)}</span>
    </>
  );
  if (!chartable) {
    return <div className={clsx("review-metric", t)}>{body}</div>;
  }
  return (
    <button
      type="button"
      className={clsx("review-metric", "review-metric-clickable", t, active && "is-charted")}
      style={active && color ? { borderColor: color } : undefined}
      onClick={() => chartLink!.onToggle(m.key)}
      title={active ? "已在趋势图中，点击移除" : "点击加入趋势图对比"}
    >
      {body}
    </button>
  );
}

const STAGE_ORDER: FunnelStage[] = ["投放", "流量", "成交", "利润"];
const STAGE_HINT: Record<FunnelStage, string> = {
  投放: "投入多少、单位成本",
  流量: "带来多少流量、流量值不值",
  成交: "流量怎么转成订单",
  利润: "净产出与投产效率"
};

/** 按 投放→流量→成交→利润 漏斗分组展示指标卡片：每阶段一个小标题，体现因果链路。chartLink 时卡片可点选下钻到趋势图。 */
export function StagedMetricGrid({
  metrics,
  chartLink
}: {
  metrics: ComparisonMetric[];
  chartLink?: ChartLink;
}) {
  // 有 stage 用 stage 分组；老数据无 stage 则退回单网格，保证兼容。
  const hasStages = metrics.some((m) => m.stage);
  if (!hasStages) {
    return (
      <div className="review-metric-grid">
        {metrics.map((m) => (
          <MetricCard key={m.key} m={m} chartLink={chartLink} />
        ))}
      </div>
    );
  }
  return (
    <div className="funnel-stages">
      {chartLink ? (
        <p className="funnel-drill-hint">点指标卡可把它的走势加进下方趋势图（可多选、左右轴对比）。</p>
      ) : null}
      {STAGE_ORDER.map((stage, i) => {
        const group = metrics.filter((m) => m.stage === stage);
        if (group.length === 0) return null;
        return (
          <div className="funnel-stage" key={stage}>
            <div className="funnel-stage-head">
              <span className="funnel-stage-idx">{i + 1}</span>
              <strong>{stage}</strong>
              <span className="funnel-stage-hint">{STAGE_HINT[stage]}</span>
            </div>
            <div className="review-metric-grid">
              {group.map((m) => (
                <MetricCard key={m.key} m={m} chartLink={chartLink} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 链路节点变化色：中性=灰；否则 higherIsBetter 决定红绿。 */
function chainTone(s: FunnelChainStep): "good" | "bad" | "flat" {
  if (s.neutral || Math.abs(s.after - s.before) < 1e-9) return "flat";
  return s.after - s.before > 0 === s.higherIsBetter ? "good" : "bad";
}

/** 投产链路：花费→展现→点击→访客→买家→销售额→ROI 一行式因果展示。 */
export function FunnelChain({ steps }: { steps: FunnelChainStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="funnel-chain" role="list" aria-label="投产链路">
      {steps.map((s, i) => {
        const t = chainTone(s);
        const pct = Math.abs(s.before) < EPS && Math.abs(s.after) >= EPS
          ? "新增"
          : `${s.deltaPct >= 0 ? "+" : ""}${(s.deltaPct * 100).toFixed(0)}%`;
        return (
          <div className="funnel-chain-item" role="listitem" key={s.key}>
            <div className="funnel-node">
              <span className="funnel-node-label">{s.label}</span>
              <span className="funnel-node-val">{fmtMetric(s.after, s.unit)}</span>
              <span className={clsx("funnel-node-delta", `cmp-${t}`)}>{pct}</span>
            </div>
            {i < steps.length - 1 ? <span className="funnel-arrow" aria-hidden>→</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/** 前→后单元格（带涨跌色，higherIsBetter 决定红绿）。 */
export function deltaCell(
  before: number,
  after: number,
  unit: ComparisonMetric["unit"],
  higherIsBetter: boolean,
  neutral = false
): { before: string; after: string; tone: "good" | "bad" | "flat" } {
  const delta = after - before;
  const tone: "good" | "bad" | "flat" =
    neutral || Math.abs(delta) < 1e-9 ? "flat" : delta > 0 === higherIsBetter ? "good" : "bad";
  return { before: fmtMetric(before, unit), after: fmtMetric(after, unit), tone };
}
