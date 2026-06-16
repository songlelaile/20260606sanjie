"use client";

import { useState } from "react";
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
import type { DailyTrendPoint } from "@/lib/types/domain";

type MetricKey = "netSales" | "visitors" | "paymentBuyers";

const METRICS: { key: MetricKey; label: string }[] = [
  { key: "netSales", label: "净销额" },
  { key: "visitors", label: "访客" },
  { key: "paymentBuyers", label: "支付买家" }
];

export function DailyTrendChart({
  series,
  interventionDate
}: {
  series: DailyTrendPoint[];
  interventionDate: string;
}) {
  const [metric, setMetric] = useState<MetricKey>("netSales");
  const label = METRICS.find((m) => m.key === metric)!.label;

  if (series.length === 0) {
    return <p className="review-empty">该区间内暂无分日数据。</p>;
  }

  return (
    <div className="trend-chart">
      <div className="trend-chart-toolbar">
        {METRICS.map((m) => (
          <button
            key={m.key}
            type="button"
            className={m.key === metric ? "is-active" : ""}
            onClick={() => setMetric(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="trend-chart-canvas">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={series} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid stroke="#3e431e" strokeDasharray="3 3" />
            <XAxis
              dataKey="date"
              tickFormatter={(d: string) => d.slice(5)}
              tick={{ fill: "#aaa58f", fontSize: 11 }}
              stroke="#3e431e"
            />
            <YAxis tick={{ fill: "#aaa58f", fontSize: 11 }} stroke="#3e431e" width={56} />
            <Tooltip
              contentStyle={{
                background: "#0d1708",
                border: "1px solid #3e431e",
                borderRadius: 8,
                color: "#f3edd7"
              }}
              labelStyle={{ color: "#aaa58f" }}
              formatter={(value) => [Math.round(Number(value)).toLocaleString(), label]}
            />
            <ReferenceLine
              x={interventionDate}
              stroke="#f4a43e"
              strokeWidth={2}
              label={{ value: "动作", position: "top", fill: "#f4a43e", fontSize: 12 }}
            />
            <Line
              type="monotone"
              dataKey={metric}
              stroke="#f6c65f"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
