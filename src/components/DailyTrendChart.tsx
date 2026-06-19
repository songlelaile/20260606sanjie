"use client";

import { useCallback, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { fmtMetric } from "@/components/comparison-ui";
import {
  type Axis,
  CHART_METRICS,
  CHART_METRIC_BY_KEY,
  hasSignal
} from "@/components/trend-metrics";
import type { ComparisonMetric, DailyTrendPoint } from "@/lib/types/domain";

export interface TrendSelection {
  selected: string[];
  toggle: (key: string) => void;
  axisOf: (key: string) => Axis;
  flipAxis: (key: string) => void;
}

/** 趋势图选中态：可由父组件持有，从而让指标卡点击与图表联动（"各指标呼应"）。 */
export function useTrendSelection(initial: string[] = ["netSales"]): TrendSelection {
  const [selected, setSelected] = useState<string[]>(initial);
  const [axisOverride, setAxisOverride] = useState<Record<string, Axis>>({});
  const toggle = useCallback((key: string) => {
    if (!CHART_METRIC_BY_KEY.has(key)) return;
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  }, []);
  const axisOf = useCallback(
    (key: string): Axis => axisOverride[key] ?? CHART_METRIC_BY_KEY.get(key)?.axis ?? "left",
    [axisOverride]
  );
  const flipAxis = useCallback((key: string) => {
    // 读 prev override 计算，避免同批次多次调用基于过期闭包。
    setAxisOverride((o) => {
      const cur = o[key] ?? CHART_METRIC_BY_KEY.get(key)?.axis ?? "left";
      return { ...o, [key]: cur === "left" ? "right" : "left" };
    });
  }, []);
  return { selected, toggle, axisOf, flipAxis };
}

/** 大额走 万/亿 缩放（不带单位符号）。 */
function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(1)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(abs >= 1e5 ? 0 : 1)}万`;
  if (abs > 0 && abs < 1) return value.toFixed(2);
  return `${Math.round(value)}`;
}

/** 单一单位的刻度：费率→百分比、倍数→x、金额/整数→万/亿 缩放。 */
function compactTick(value: number, unit: ComparisonMetric["unit"]): string {
  if (unit === "rate") return `${(value * 100).toFixed(0)}%`;
  if (unit === "ratio") return value.toFixed(1);
  return compactNumber(value);
}

const UNIT_NAME: Record<ComparisonMetric["unit"], string> = {
  money: "¥",
  int: "个",
  rate: "%",
  ratio: "倍"
};

/** 该轴的刻度格式 + 轴标题：同一单位用带单位刻度；混合单位退化为无单位数字（避免把 7.5 倍误标成 750%）。 */
function axisFormat(units: Set<ComparisonMetric["unit"]>, firstUnit: ComparisonMetric["unit"]) {
  if (units.size <= 1) {
    return { tick: (v: number) => compactTick(v, firstUnit), label: UNIT_NAME[firstUnit] };
  }
  return { tick: (v: number) => compactNumber(v), label: "混合单位" };
}

export function DailyTrendChart({
  series,
  interventionDate,
  selection
}: {
  series: DailyTrendPoint[];
  interventionDate?: string;
  selection?: TrendSelection;
}) {
  const internal = useTrendSelection();
  const { selected, toggle, axisOf, flipAxis } = selection ?? internal;

  // 工具栏指标：默认指标 + 当前已选 + 区间内有数据的（自适应隐藏无投放等全 0 项）。
  const available = useMemo(
    () =>
      CHART_METRICS.filter(
        (m) => m.key === "netSales" || selected.includes(m.key) || hasSignal(series, m.key)
      ),
    [series, selected]
  );
  const activeDefs = selected
    .map((k) => CHART_METRIC_BY_KEY.get(k))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));
  const leftDefs = activeDefs.filter((d) => axisOf(d.key) === "left");
  const rightDefs = activeDefs.filter((d) => axisOf(d.key) === "right");
  const hasLeft = leftDefs.length > 0;
  const hasRight = rightDefs.length > 0;
  const left = axisFormat(new Set(leftDefs.map((d) => d.unit)), leftDefs[0]?.unit ?? "money");
  const right = axisFormat(new Set(rightDefs.map((d) => d.unit)), rightDefs[0]?.unit ?? "rate");

  if (series.length === 0) {
    return <p className="review-empty">该区间内暂无分日数据。</p>;
  }

  return (
    <div className="trend-chart">
      <div className="trend-chart-toolbar">
        {available.map((m) => {
          const active = selected.includes(m.key);
          return (
            <span key={m.key} className="trend-chip-wrap">
              <button
                type="button"
                className={active ? "trend-chip is-active" : "trend-chip"}
                style={active ? { borderColor: m.color, color: m.color } : undefined}
                onClick={() => toggle(m.key)}
                title={active ? "点击取消" : "点击加入对比"}
              >
                <span className="trend-dot" style={{ background: active ? m.color : "transparent", borderColor: m.color }} />
                {m.label}
              </button>
              {active ? (
                <button
                  type="button"
                  className="trend-axis-toggle"
                  onClick={() => flipAxis(m.key)}
                  title="切换左右 Y 轴"
                >
                  {axisOf(m.key) === "left" ? "左轴" : "右轴"}
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
      {selected.length === 0 ? (
        <p className="review-empty">请选择至少一个指标查看走势。</p>
      ) : (
        <div className="trend-chart-canvas">
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={series} margin={{ top: 8, right: hasRight ? 8 : 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="#3e431e" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={(d: string) => d.slice(5)}
                tick={{ fill: "#aaa58f", fontSize: 11 }}
                stroke="#3e431e"
              />
              <YAxis
                yAxisId="left"
                hide={!hasLeft}
                tick={{ fill: "#aaa58f", fontSize: 11 }}
                stroke="#3e431e"
                width={56}
                tickFormatter={left.tick}
                label={{ value: left.label, angle: -90, position: "insideLeft", fill: "#aaa58f", fontSize: 11 }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                hide={!hasRight}
                tick={{ fill: "#aaa58f", fontSize: 11 }}
                stroke="#3e431e"
                width={56}
                tickFormatter={right.tick}
                label={{ value: right.label, angle: 90, position: "insideRight", fill: "#aaa58f", fontSize: 11 }}
              />
              <Tooltip
                contentStyle={{
                  background: "#0d1708",
                  border: "1px solid #3e431e",
                  borderRadius: 8,
                  color: "#f3edd7"
                }}
                labelStyle={{ color: "#aaa58f" }}
                formatter={(value, _name, item) => {
                  const def = CHART_METRIC_BY_KEY.get(String(item?.dataKey ?? ""));
                  if (value === null || value === undefined || Number.isNaN(Number(value))) {
                    return ["—", def?.label ?? String(_name)];
                  }
                  if (!def) return [String(value), String(_name)];
                  return [fmtMetric(Number(value), def.unit), def.label];
                }}
              />
              {interventionDate ? (
                <ReferenceLine
                  yAxisId={hasLeft ? "left" : "right"}
                  x={interventionDate}
                  stroke="#f4a43e"
                  strokeWidth={2}
                  label={{ value: "动作", position: "top", fill: "#f4a43e", fontSize: 12 }}
                />
              ) : null}
              {activeDefs.map((def) => (
                <Line
                  key={def.key}
                  yAxisId={axisOf(def.key)}
                  type="monotone"
                  dataKey={def.key}
                  name={def.label}
                  stroke={def.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
