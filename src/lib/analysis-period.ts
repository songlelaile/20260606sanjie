import type { AnalysisCycle, ImportBatch, ReportType } from "@/lib/types/domain";

export interface ResolvedAnalysisPeriod {
  start: string;
  end: string;
  source: "latest-product-upload" | "cycle";
}

export interface SourcePeriodAlignment {
  aligned: boolean;
  issues: string[];
  ranges: Partial<Record<ReportType, { start: string; end: string }>>;
}

/** ISO 日期范围（含首尾）的自然日数；非法或倒序范围返回 0。 */
export function countInclusiveDays(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from
    ? Math.floor((to - from) / 86_400_000) + 1
    : 0;
}

/**
 * 三阶结果按最新商品源实际日期窗计算；AnalysisCycle 只作为外层边界。
 * 这样重复上传多个周期时不会把保留期内所有历史与“月 GSV 机会”混算。
 */
export function resolveAnalysisPeriod(
  cycle: Pick<AnalysisCycle, "startDate" | "endDate">,
  batches: ImportBatch[]
): ResolvedAnalysisPeriod {
  const productBatch = batches.find(
    (item) => item.reportType === "product_source" && item.validation.ok
  );
  const range = productBatch
    ? dateRangeFromValues(productBatch.validation.dateValues) ?? dateRangeFromValues([productBatch.fileName])
    : null;
  if (range) {
    const start = range.start > cycle.startDate ? range.start : cycle.startDate;
    const end = range.end < cycle.endDate ? range.end : cycle.endDate;
    if (start <= end) return { start, end, source: "latest-product-upload" };
  }
  return { start: cycle.startDate, end: cycle.endDate, source: "cycle" };
}

/**
 * 校验四张核心源表是否完整覆盖商品分析窗。上传范围可以更宽，但不能缺商品窗内日期；
 * 达摩盘没有分日表，因此必须从“统计周期”列或文件名识别范围，不能把未知周期快照当同期证据。
 */
export function resolveSourcePeriodAlignment(
  batches: ImportBatch[],
  analysisPeriod: Pick<ResolvedAnalysisPeriod, "start" | "end">
): SourcePeriodAlignment {
  const labels: Record<ReportType, string> = {
    product_source: "商品源",
    damo_product_source: "达摩盘货品源",
    promotion_product_source: "推广宝贝源",
    audience_source: "人群源"
  };
  const types = Object.keys(labels) as ReportType[];
  const ranges: SourcePeriodAlignment["ranges"] = {};
  const issues: string[] = [];
  for (const reportType of types) {
    const batch = batches.find((item) => item.reportType === reportType && item.validation.ok);
    if (!batch) {
      issues.push(`${labels[reportType]}未上传或未通过校验`);
      continue;
    }
    const range = dateRangeFromValues(batch.validation.dateValues) ?? dateRangeFromValues([batch.fileName]);
    if (!range) {
      issues.push(`${labels[reportType]}未识别统计周期`);
      continue;
    }
    ranges[reportType] = range;
    if (range.start > analysisPeriod.start || range.end < analysisPeriod.end) {
      issues.push(
        `${labels[reportType]}范围 ${range.start}~${range.end} 未完整覆盖商品窗 ${analysisPeriod.start}~${analysisPeriod.end}`
      );
    }
    if (reportType !== "damo_product_source") {
      const observed = batch.validation.dateObservedDays;
      const expected = batch.validation.dateExpectedDays;
      if (observed === undefined || expected === undefined) {
        issues.push(`${labels[reportType]}缺少分日覆盖元数据，请重新上传校验`);
      } else if (observed < expected) {
        issues.push(`${labels[reportType]}统计日期仅覆盖 ${observed}/${expected} 个自然日`);
      }
    }
  }
  return { aligned: issues.length === 0, issues, ranges };
}

/** 把原始日期、日期范围或文件名中的日期归一成一个并集范围。 */
export function dateRangeFromValues(values: string[]): { start: string; end: string } | null {
  const ranges = values.map(parseDateRangeValue).filter((item) => item !== null);
  if (ranges.length === 0) return null;
  return {
    start: ranges.map((item) => item.start).sort()[0],
    end: ranges.map((item) => item.end).sort().at(-1)!
  };
}

/** 元数据只保留归一后的最早/最晚日期，避免“只截前 8 个原始日期”丢失真实结束日。 */
export function summarizeDateValues(values: string[]): string[] {
  const range = dateRangeFromValues(values);
  if (!range) return [];
  return range.start === range.end ? [range.start] : [range.start, range.end];
}

function parseDateRangeValue(value: string): { start: string; end: string } | null {
  const text = value.trim();
  if (!text) return null;
  const compactRange = text.match(/(\d{8})\s*(?:至|~|－|-|—|–)\s*(\d{8})/);
  if (compactRange) {
    return normalizedRange(formatCompact(compactRange[1]), formatCompact(compactRange[2]));
  }
  const dashed = text.match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g);
  if (dashed?.length) {
    const dates = dashed.map(formatLoose).filter(isIsoDate).sort();
    return dates.length ? { start: dates[0], end: dates.at(-1)! } : null;
  }
  const compact = text.match(/\b\d{8}\b/g);
  if (compact?.length) {
    const dates = compact.map(formatCompact).filter(isIsoDate).sort();
    return dates.length ? { start: dates[0], end: dates.at(-1)! } : null;
  }
  return null;
}

function formatLoose(value: string) {
  const [year, month, day] = value.split(/[-/.]/);
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function formatCompact(value: string) {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function normalizedRange(start: string, end: string) {
  if (!isIsoDate(start) || !isIsoDate(end)) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}
