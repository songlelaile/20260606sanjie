export const DMP_GROWTH_REPORT_TABLES = [
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

export const DMP_COMPETITION_REPORT_TABLES = [
  "报告总览",
  "对标总表",
  "流量投放结构",
  "渠道指标",
  "人群画像"
] as const;

// 兼容现有打爆路径代码的旧导出名。
export const DMP_REPORT_TABLES = DMP_GROWTH_REPORT_TABLES;

export type DmpReportKind = "growth" | "competition";

export interface DmpReportTableSnapshot {
  name: string;
  columns: string[];
  rows: Array<{ cells: string[] }>;
}

export interface DmpCanonicalReport {
  schema_version: "3.0";
  /** 旧版打爆路径报告没有该字段，缺省时按 growth 处理。 */
  report_type?: DmpReportKind;
  title: string;
  item_id: string;
  competitor_ids?: string[];
  period: string;
  tables: DmpReportTableSnapshot[];
}

export type DmpReportQuality = "complete" | "partial";

export interface DmpBusinessReportRecord {
  id: string;
  reportType: DmpReportKind;
  subjectItemId: string;
  competitorItemId: string;
  period: string;
  quality: DmpReportQuality;
  createdAt: string;
  report: DmpCanonicalReport;
}

export interface DmpReportHeatBucketSnapshot {
  sectionKey: string;
  elementKey: string;
  xBucket: number;
  yBucket: number;
  count: number;
}

export interface DmpReportInteractionSummary {
  reportId: string;
  shareCount: number;
  viewCount: number;
  clickCount: number;
  lastViewedAt: string | null;
  lastClickedAt: string | null;
  sections: Array<{ sectionKey: string; count: number }>;
  topElements: Array<{ sectionKey: string; elementKey: string; count: number }>;
  buckets: DmpReportHeatBucketSnapshot[];
}

export function dmpReportKind(report: Pick<DmpCanonicalReport, "report_type"> | null | undefined): DmpReportKind {
  return report?.report_type === "competition" ? "competition" : "growth";
}

export function dmpExpectedTableNames(kind: DmpReportKind): readonly string[] {
  return kind === "competition" ? DMP_COMPETITION_REPORT_TABLES : DMP_GROWTH_REPORT_TABLES;
}
