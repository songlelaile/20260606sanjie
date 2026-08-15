export const DMP_REPORT_TABLES = [
  "报告总览",
  "对标总表",
  "商品与成功品",
  "周期汇总",
  "日GMV与费比",
  "渠道花费",
  "一级场景",
  "二级场景",
  "成长阶段数据",
  "基础指标对比",
  "关键词样本"
] as const;

export interface DmpReportTableSnapshot {
  name: (typeof DMP_REPORT_TABLES)[number];
  columns: string[];
  rows: Array<{ cells: string[] }>;
}

export interface DmpCanonicalReport {
  schema_version: "3.0";
  title: string;
  item_id: string;
  period: string;
  tables: DmpReportTableSnapshot[];
}

export type DmpReportQuality = "complete" | "partial";

export interface DmpBusinessReportRecord {
  id: string;
  subjectItemId: string;
  competitorItemId: string;
  period: string;
  quality: DmpReportQuality;
  createdAt: string;
  report: DmpCanonicalReport;
}
