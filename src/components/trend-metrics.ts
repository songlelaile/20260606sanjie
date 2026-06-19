import type { ComparisonMetric, DailyTrendPoint } from "@/lib/types/domain";

export type Axis = "left" | "right";

/** 趋势图可绘指标定义：key 与漏斗指标 key 对齐，便于卡片下钻联动；color 让卡片与折线同色"呼应"。 */
export interface ChartMetricDef {
  key: keyof DailyTrendPoint & string;
  label: string;
  unit: ComparisonMetric["unit"];
  axis: Axis; // 默认轴：大额可加和→左轴；费率/客单/ROI 等小量级→右轴
  color: string;
}

export const CHART_METRICS: ChartMetricDef[] = [
  { key: "netSales", label: "净销额", unit: "money", axis: "left", color: "#f6c65f" },
  { key: "paymentAmount", label: "销售额", unit: "money", axis: "left", color: "#f4843e" },
  { key: "visitors", label: "访客", unit: "int", axis: "left", color: "#36c9b0" },
  { key: "views", label: "浏览量", unit: "int", axis: "left", color: "#4a9be0" },
  { key: "paymentBuyers", label: "支付买家", unit: "int", axis: "left", color: "#b48ef0" },
  { key: "adCost", label: "推广花费", unit: "money", axis: "left", color: "#dd6a4a" },
  { key: "impressions", label: "展现", unit: "int", axis: "left", color: "#9aa0a6" },
  { key: "adClicks", label: "点击", unit: "int", axis: "left", color: "#d4b94a" },
  { key: "conversion", label: "支付转化率", unit: "rate", axis: "right", color: "#5fd17a" },
  { key: "aov", label: "客单价", unit: "money", axis: "right", color: "#ec6fb0" },
  { key: "refundRate", label: "退款率", unit: "rate", axis: "right", color: "#ef4d4d" },
  { key: "uvValue", label: "访客价值", unit: "money", axis: "right", color: "#38bdf8" },
  { key: "cpc", label: "点击成本", unit: "money", axis: "right", color: "#c084fc" },
  { key: "adRoi", label: "推广ROI", unit: "ratio", axis: "right", color: "#a3e635" }
];

export const CHART_METRIC_BY_KEY: Map<string, ChartMetricDef> = new Map(
  CHART_METRICS.map((m) => [m.key, m])
);

/** 漏斗指标卡是否可下钻到趋势图（key 命中可绘指标即可）。 */
export function isChartable(key: string): boolean {
  return CHART_METRIC_BY_KEY.has(key);
}

/** 该指标在区间内是否有任何非零数据（用于自适应隐藏全 0 的指标，如无投放时的广告项）。 */
export function hasSignal(series: DailyTrendPoint[], key: keyof DailyTrendPoint): boolean {
  return series.some((p) => {
    const v = p[key];
    return typeof v === "number" && Math.abs(v) > 1e-9;
  });
}
