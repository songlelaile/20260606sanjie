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

/**
 * 类目大盘报告由插件按页面真实业务模块归档，不强制补造固定表。这里列出的名称只用于
 * 优先排序；没有对应模块时不会生成空表。
 */
export const DMP_MARKET_REPORT_TABLES = [
  "市场总览",
  "规模与成交",
  "供给结构",
  "人群结构",
  "营销结构",
  "趋势明细"
] as const;

// 兼容现有打爆路径代码的旧导出名。
export const DMP_REPORT_TABLES = DMP_GROWTH_REPORT_TABLES;

export type DmpReportKind = "growth" | "competition" | "market";

export interface DmpMarketScope {
  category_id: string;
  category_name: string;
  category_path: string[];
}

export interface DmpReportTableSnapshot {
  name: string;
  columns: string[];
  rows: Array<{ cells: string[] }>;
}

export interface DmpReportRenderProduct {
  picture_url?: string;
  detail_url?: string;
}

export interface DmpReportRenderData {
  version: "1";
  generated_at?: string;
  products?: {
    subject?: DmpReportRenderProduct;
    competitor?: DmpReportRenderProduct;
  };
  subject_daily_gmv?: Array<{ date: string; gmv: string }>;
  tables?: Array<{ name: string; subtitle?: string; widths?: number[] }>;
}

export interface DmpCanonicalReport {
  schema_version: "3.0";
  /** 旧版打爆路径报告没有该字段，缺省时按 growth 处理。 */
  report_type?: DmpReportKind;
  /** 仅 report_type=market 使用；不把类目伪装成商品或竞品。 */
  market_scope?: DmpMarketScope;
  title: string;
  item_id: string;
  competitor_ids?: string[];
  period: string;
  tables: DmpReportTableSnapshot[];
  /**
   * 只保存官网复现本机 HTML 所需的无解释渲染数据。业务表仍是唯一业务数据合同；
   * 旧报告没有该字段时继续按表格内容回退。
   */
  render_data?: DmpReportRenderData;
}

export type DmpReportQuality = "complete" | "partial";

export interface DmpReportShop {
  id: string;
  name: string;
}

export interface DmpBusinessReportRecord {
  id: string;
  reportType: DmpReportKind;
  shopId?: string;
  shopName?: string;
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

export type DmpReportAnalyticsDays = 7 | 30 | 90;

export interface DmpReportAnalyticsOverview {
  totalShares: number;
  activeShares: number;
  activeSharesInRange: number;
  reportCount: number;
  sessionCount: number;
  uniqueVisitors: number;
  pageViews: number;
  clickCount: number;
  engagedSessions: number;
  totalActiveSeconds: number;
  averageActiveSeconds: number;
  averageScrollDepth: number;
  dataTruncated: boolean;
}

export interface DmpReportAnalyticsTrendRow {
  date: string;
  sessionCount: number;
  uniqueVisitors: number;
  pageViews: number;
  clickCount: number;
  engagedSessions: number;
  activeSeconds: number;
}

export interface DmpReportAnalyticsSourceRow {
  source: string;
  medium: string;
  campaign: string;
  referrerHost: string;
  sessionCount: number;
  uniqueVisitors: number;
  pageViews: number;
  clickCount: number;
  engagedSessions: number;
  activeSeconds: number;
}

export interface DmpReportAnalyticsTopReport {
  reportId: string;
  subjectItemId: string;
  competitorItemId: string;
  period: string;
  tenantId: string;
  tenantName: string;
  userId: string;
  userName: string;
  username: string;
  shareCount: number;
  sessionCount: number;
  uniqueVisitors: number;
  pageViews: number;
  clickCount: number;
  engagedSessions: number;
  activeSeconds: number;
  averageScrollDepth: number;
  lastSeenAt: string | null;
}

export interface DmpReportAnalyticsRecentShare {
  shareId: string;
  reportId: string;
  subjectItemId: string;
  competitorItemId: string;
  tenantId: string;
  tenantName: string;
  userId: string;
  userName: string;
  username: string;
  createdAt: string;
  revokedAt: string | null;
  viewCount: number;
  clickCount: number;
  sessionCount: number;
  lastViewedAt: string | null;
  lastClickedAt: string | null;
}

export interface DmpReportManagementAnalytics {
  days: DmpReportAnalyticsDays;
  range: { from: string; to: string; timeZone: "Asia/Shanghai" };
  overview: DmpReportAnalyticsOverview;
  trend: DmpReportAnalyticsTrendRow[];
  sources: DmpReportAnalyticsSourceRow[];
  topReports: DmpReportAnalyticsTopReport[];
  recentShares: DmpReportAnalyticsRecentShare[];
  sections: Array<{ sectionKey: string; count: number }>;
  topElements: Array<{ sectionKey: string; elementKey: string; count: number }>;
  heatmapScope: "all_time";
}

export function dmpReportKind(report: Pick<DmpCanonicalReport, "report_type"> | null | undefined): DmpReportKind {
  if (report?.report_type === "competition") return "competition";
  if (report?.report_type === "market") return "market";
  return "growth";
}

export function dmpExpectedTableNames(kind: DmpReportKind): readonly string[] {
  if (kind === "competition") return DMP_COMPETITION_REPORT_TABLES;
  if (kind === "market") return DMP_MARKET_REPORT_TABLES;
  return DMP_GROWTH_REPORT_TABLES;
}

const MAX_RENDER_URL_LENGTH = 2_048;
const MAX_RENDER_SUBTITLE_LENGTH = 500;
const MAX_RENDER_DAYS = 62;
const SENSITIVE_RENDER_QUERY = /(?:token|csrf|cookie|authorization|password|secret|(?:^|[_-])sign(?:ature|data)?$|session|webopsessionid|uniqueitemcampaign)/i;

type RenderDataContext = {
  itemId: string;
  period: string;
  tables: DmpReportTableSnapshot[];
  expectedTableNames: readonly string[];
};

/**
 * render_data 是可选的向后兼容展示层合同。任何无效子字段都会被忽略，不会阻止旧版
 * 业务报告保存，也不会让未经闭合的逐日金额进入官网报告。
 */
export function sanitizeDmpReportRenderData(value: unknown, context: RenderDataContext): DmpReportRenderData | undefined {
  if (!isPlainObject(value) || value.version !== "1") return undefined;

  const generatedAt = safeIsoInstant(value.generated_at);
  const products = sanitizeRenderProducts(value.products);
  const subjectDailyGmv = sanitizeSubjectDailyGmv(value.subject_daily_gmv, context);
  const tableMeta = sanitizeRenderTableMeta(value.tables, context);

  const sanitized: DmpReportRenderData = {
    version: "1",
    ...(generatedAt ? { generated_at: generatedAt } : {}),
    ...(products ? { products } : {}),
    ...(subjectDailyGmv ? { subject_daily_gmv: subjectDailyGmv } : {}),
    ...(tableMeta ? { tables: tableMeta } : {})
  };
  return Object.keys(sanitized).length > 1 ? sanitized : undefined;
}

function sanitizeRenderProducts(value: unknown): DmpReportRenderData["products"] | undefined {
  if (!isPlainObject(value)) return undefined;
  const subject = sanitizeRenderProduct(value.subject);
  const competitor = sanitizeRenderProduct(value.competitor);
  return subject || competitor ? { ...(subject ? { subject } : {}), ...(competitor ? { competitor } : {}) } : undefined;
}

function sanitizeRenderProduct(value: unknown): DmpReportRenderProduct | undefined {
  if (!isPlainObject(value)) return undefined;
  const pictureUrl = sanitizeDmpRenderImageUrl(value.picture_url);
  const detailUrl = sanitizeDmpRenderHttpsUrl(value.detail_url);
  return pictureUrl || detailUrl
    ? { ...(pictureUrl ? { picture_url: pictureUrl } : {}), ...(detailUrl ? { detail_url: detailUrl } : {}) }
    : undefined;
}

function sanitizeSubjectDailyGmv(value: unknown, context: RenderDataContext) {
  if (!Array.isArray(value)) return undefined;
  const periodDates = periodDateRange(context.period);
  const subjectGmv = subjectPeriodGmv(context.tables, context.itemId);
  if (!periodDates || subjectGmv == null || value.length !== periodDates.length) return undefined;

  const rows: Array<{ date: string; gmv: string }> = [];
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!isPlainObject(candidate)) return undefined;
    const date = String(candidate.date ?? "").trim();
    const gmv = String(candidate.gmv ?? "").trim();
    if (date !== periodDates[index] || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(gmv)) return undefined;
    const numeric = Number(gmv);
    if (!Number.isFinite(numeric) || numeric < 0) return undefined;
    rows.push({ date, gmv });
    total += numeric;
  }
  return Math.abs(total - subjectGmv) <= 0.011 ? rows : undefined;
}

function sanitizeRenderTableMeta(value: unknown, context: RenderDataContext) {
  if (!Array.isArray(value)) return undefined;
  const tables = new Map(context.tables.map((table) => [table.name, table]));
  const allowed = new Set(context.expectedTableNames);
  const seen = new Set<string>();
  const result: NonNullable<DmpReportRenderData["tables"]> = [];

  for (const candidate of value) {
    if (!isPlainObject(candidate)) continue;
    const name = String(candidate.name ?? "");
    const table = tables.get(name);
    if (!allowed.has(name) || !table || seen.has(name)) continue;
    const subtitle = safeRenderSubtitle(candidate.subtitle);
    const widths = safeRenderWidths(candidate.widths, table.columns.length);
    if (subtitle || widths) {
      seen.add(name);
      result.push({ name, ...(subtitle ? { subtitle } : {}), ...(widths ? { widths } : {}) });
    }
  }

  result.sort((left, right) => context.expectedTableNames.indexOf(left.name) - context.expectedTableNames.indexOf(right.name));
  return result.length ? result : undefined;
}

function safeRenderSubtitle(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return normalized && normalized.length <= MAX_RENDER_SUBTITLE_LENGTH ? normalized : "";
}

function safeRenderWidths(value: unknown, columnCount: number) {
  if (!Array.isArray(value) || value.length !== columnCount) return undefined;
  if (value.some((width) => typeof width !== "number" || !Number.isFinite(width) || width < 4 || width > 120)) return undefined;
  return value.map((width) => Math.round(width * 100) / 100);
}

function safeIsoInstant(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return "";
  const instant = new Date(text);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : "";
}

export function sanitizeDmpRenderHttpsUrl(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text.startsWith("https://") || text.length > MAX_RENDER_URL_LENGTH) return "";
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_RENDER_QUERY.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

export function sanitizeDmpRenderImageUrl(value: unknown) {
  const safe = sanitizeDmpRenderHttpsUrl(value);
  if (!safe) return "";
  const parsed = new URL(safe);
  const knownHost = /(?:^|\.)(?:alicdn\.com|tbcdn\.cn|taobaocdn\.com|img\.example)$/i.test(parsed.hostname);
  const imagePath = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?&#])/i.test(`${parsed.pathname}${parsed.search}`);
  return knownHost || imagePath ? parsed.href : "";
}

function periodDateRange(period: string) {
  const matches = [...String(period ?? "").matchAll(/\d{4}-\d{2}-\d{2}/g)].map((match) => match[0]);
  if (matches.length < 2 || !isCalendarDate(matches[0]) || !isCalendarDate(matches[1])) return null;
  const start = Date.parse(`${matches[0]}T00:00:00Z`);
  const end = Date.parse(`${matches[1]}T00:00:00Z`);
  const days = Math.round((end - start) / 86_400_000) + 1;
  if (!Number.isInteger(days) || days < 1 || days > MAX_RENDER_DAYS) return null;
  return Array.from({ length: days }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function isCalendarDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function subjectPeriodGmv(tables: DmpReportTableSnapshot[], itemId: string) {
  const period = tables.find((table) => table.name === "周期汇总");
  if (period) {
    const idIndex = period.columns.indexOf("商品ID");
    const roleIndex = period.columns.indexOf("对象");
    const gmvIndex = period.columns.indexOf("总GMV");
    if (gmvIndex >= 0) {
      const row = period.rows.find(({ cells }) => (idIndex >= 0 && String(cells[idIndex] ?? "") === itemId)
        || (roleIndex >= 0 && /^主体/.test(String(cells[roleIndex] ?? ""))));
      const numeric = exactRenderNumber(row?.cells[gmvIndex]);
      if (numeric != null) return numeric;
    }
  }

  const benchmark = tables.find((table) => table.name === "对标总表");
  if (benchmark) {
    const metricIndex = benchmark.columns.indexOf("对标指标");
    const subjectIndex = benchmark.columns.indexOf("主体周期值");
    const row = benchmark.rows.find(({ cells }) => metricIndex >= 0 && String(cells[metricIndex] ?? "") === "总GMV");
    const numeric = exactRenderNumber(row?.cells[subjectIndex]);
    if (numeric != null) return numeric;
  }
  return null;
}

function exactRenderNumber(value: unknown) {
  const text = String(value ?? "").trim().replace(/[,，]/g, "");
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
