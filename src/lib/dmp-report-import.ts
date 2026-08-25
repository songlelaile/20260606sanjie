import {
  DMP_GROWTH_REPORT_TABLES,
  sanitizeDmpReportRenderData,
  type DmpReportRenderData,
  type DmpReportTableSnapshot
} from "@/lib/dmp-report-types";

export type DmpCell = string | number | boolean | null;

export interface DmpReportTable {
  name: string;
  columns: string[];
  rows: DmpCell[][];
  subtitle?: string;
  widths?: number[];
}

export interface DmpReport {
  version: number;
  title: string;
  item: {
    id: string;
    title?: string;
    pictureUrl?: string;
    detailUrl?: string;
    competitorId: string;
    competitorTitle?: string;
    competitorPictureUrl?: string;
    competitorDetailUrl?: string;
  };
  period: { startDate: string; endDate: string; days: number };
  periodLabel: string;
  generatedAt?: string;
  recordCount?: number;
  tables: DmpReportTable[];
  quality: {
    status: string;
    complete: boolean;
    expected?: number;
    observed?: number;
    parsedRecords?: number;
    failedRecords?: number;
    blockingIssues?: string[];
    warnings?: string[];
    missing?: string[];
  };
}

export interface DmpCaptureMeta {
  subjectItemId: string;
  successItemId: string;
  period: { startDate: string; endDate: string; days: number };
  periodConfirmed: boolean;
  periodPrecision: "exact" | "failed";
  startedAt: string;
  finishedAt: string;
}

type UnknownRecord = Record<string, unknown>;

function isObject(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonLike(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "string" ? parseJsonLike(parsed) : parsed;
  } catch {
    return null;
  }
}

function normalizeDate(value: unknown): string {
  const text = String(value ?? "").trim();
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dashed = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!dashed) return "";
  return `${dashed[1]}-${dashed[2].padStart(2, "0")}-${dashed[3].padStart(2, "0")}`;
}

function daysInclusive(startDate: string, endDate: string): number {
  if (!startDate || !endDate) return 0;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

function pathname(record: UnknownRecord): string {
  if (typeof record.pathname === "string") return record.pathname.replace(/\.json$/, "");
  try {
    return new URL(String(record.url ?? ""), "https://dmp.taobao.com").pathname.replace(/\.json$/, "");
  } catch {
    return "";
  }
}

function filterList(request: UnknownRecord, key: string): UnknownRecord[] {
  const parsed = parseJsonLike(request[key]);
  return Array.isArray(parsed) ? parsed.filter(isObject) : [];
}

function filterValues(filters: UnknownRecord[], pattern: RegExp): string[] {
  const match = filters.find((filter) =>
    pattern.test([filter.expression, filter.description, filter.name].map(String).join("|"))
  );
  return Array.isArray(match?.values) ? match.values.map(String).filter(Boolean) : [];
}

function findItemId(value: unknown, excluded = "", depth = 0): string {
  if (depth > 10 || value == null) return "";
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findItemId(child, excluded, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (!isObject(value)) return "";
  for (const key of ["itemId", "item_id", "id"]) {
    const candidate = String(value[key] ?? "");
    if (/^\d{6,20}$/.test(candidate) && candidate !== excluded) return candidate;
  }
  for (const child of Object.values(value)) {
    const found = findItemId(child, excluded, depth + 1);
    if (found) return found;
  }
  return "";
}

function responseBody(record: UnknownRecord): unknown {
  return parseJsonLike(record.body ?? record.responseBody);
}

export function unwrapDmpRecords(input: unknown): UnknownRecord[] {
  if (Array.isArray(input)) return input.filter(isObject);
  if (!isObject(input)) return [];
  for (const key of ["records", "data", "items"]) {
    if (Array.isArray(input[key])) return (input[key] as unknown[]).filter(isObject);
  }
  return [];
}

export function isFullDmpReport(input: unknown): input is DmpReport {
  return isObject(input) && input.version === 3 && Array.isArray(input.tables);
}

function isBlankCell(value: DmpCell | undefined) {
  return value == null || value === "" || value === "—";
}

function numericCell(value: DmpCell | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replace(/[,，]/g, "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

type MetricRange = {
  min: number | null;
  max: number | null;
  exact: boolean;
  lowerOpen?: boolean;
  upperOpen?: boolean;
};

function roundMetric(value: number, digits = 2) {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function magnitudeCell(value: string, inheritedMultiplier = 1) {
  let text = value.trim().replace(/[,，￥¥\s]/g, "");
  if (!text || text === "-" || text === "—") return null;
  const percent = text.endsWith("%");
  if (percent) text = text.slice(0, -1);
  text = text.replace(/[元个次笔人件]$/, "");
  const unit = text.match(/(亿|万|千|[wWkK])$/)?.[1] ?? "";
  const multiplier = unit === "亿" ? 100_000_000 : /^(万|[wW])$/.test(unit) ? 10_000 : /^(千|[kK])$/.test(unit) ? 1_000 : inheritedMultiplier;
  const numeric = Number(unit ? text.slice(0, -unit.length) : text);
  return Number.isFinite(numeric) ? numeric * multiplier / (percent ? 100 : 1) : null;
}

function metricRange(value: DmpCell | undefined): MetricRange | null {
  if (typeof value === "number" && Number.isFinite(value)) return { min: value, max: value, exact: true };
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/[,，￥¥]/g, "");
  if (!text || text === "-" || text === "—") return null;
  if (/^[<>]/.test(text)) {
    const boundary = magnitudeCell(text.slice(1));
    if (boundary == null) return null;
    return text.startsWith("<")
      ? { min: 0, max: boundary, exact: false, upperOpen: true }
      : { min: boundary, max: null, exact: false, lowerOpen: true };
  }
  const wordBound = text.match(/^(.+?)(及以上|以上|及以下|以下|以内)$/);
  if (wordBound) {
    const boundary = magnitudeCell(wordBound[1]);
    if (boundary == null) return null;
    return /以下|以内/.test(wordBound[2])
      ? { min: 0, max: boundary, exact: false, upperOpen: true }
      : { min: boundary, max: null, exact: false, lowerOpen: true };
  }
  const parts = text.split(/[~～]/);
  if (parts.length === 2) {
    const leftUnit = parts[0].match(/(亿|万|千|[wWkK])(?=%?(?:元)?$)/)?.[1] ?? "";
    const rightUnit = parts[1].match(/(亿|万|千|[wWkK])(?=%?(?:元)?$)/)?.[1] ?? "";
    const sharedMultiplier = magnitudeCell(`1${leftUnit || rightUnit}`) ?? 1;
    const min = magnitudeCell(parts[0], sharedMultiplier);
    const max = magnitudeCell(parts[1], sharedMultiplier);
    return min == null || max == null ? null : { min, max, exact: false };
  }
  const exact = magnitudeCell(text);
  return exact == null ? null : { min: exact, max: exact, exact: true };
}

function rangeDividedByScalar(value: DmpCell | undefined, divisor: number, digits = 2): DmpCell | null {
  if (!Number.isFinite(divisor) || divisor <= 0) return null;
  const range = metricRange(value);
  if (!range) return null;
  const min = range.min == null ? null : roundMetric(range.min / divisor, digits);
  const max = range.max == null ? null : roundMetric(range.max / divisor, digits);
  if (range.upperOpen && max != null) return `<${max}`;
  if (range.lowerOpen && min != null) return `>${min}`;
  if (min != null && max != null) return min === max ? min : `${min}~${max}`;
  if (max != null) return `<${max}`;
  if (min != null) return `>${min}`;
  return null;
}

function scalarDividedByRange(value: number, divisor: DmpCell | undefined, digits = 2): DmpCell | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const range = metricRange(divisor);
  if (!range) return null;
  const minDivisor = range.min != null && range.min > 0 ? range.min : null;
  const maxDivisor = range.max != null && range.max > 0 ? range.max : null;
  if (minDivisor != null && maxDivisor != null) {
    const lower = roundMetric(value / maxDivisor, digits);
    const upper = roundMetric(value / minDivisor, digits);
    return lower === upper ? lower : `${lower}~${upper}`;
  }
  if (maxDivisor != null) return `>${roundMetric(value / maxDivisor, digits)}`;
  if (minDivisor != null) return `<${roundMetric(value / minDivisor, digits)}`;
  return null;
}

type ReportSide = "subject" | "competitor";

type PartialSpendCoverage = {
  side: ReportSide;
  spend: number;
  keywordShare: number | null;
  returnedDays: number;
  expectedDays: number;
  label: string;
};

type ReconcileOptions = {
  preserveDisclosedRanges?: boolean;
  periodStartDate?: string;
  periodEndDate?: string;
};

const CROSS_TABLE_METRICS = {
  spend: ["推广消耗", "广告消耗", "广告/推广消耗", "营销推广消耗", "营销推广花费", "推广花费", "广告花费", "总消耗", "总花费"],
  paidGmv: ["付费成交额", "付费GMV", "广告归因GMV", "营销推广成交额", "推广成交额"],
  roi: ["ROI", "推广ROI", "营销推广ROI", "投入产出比", "投产比"],
  ppc: ["PPC", "CPC", "点击成本", "平均点击成本", "点击单价"],
  feeRatio: ["费比", "推广费比", "广告费比"],
  roas: ["全域ROAS", "ROAS"],
  keywordShare: ["关键词消耗占比", "关键词花费占比", "关键词推广消耗占比"],
  marketingClicks: ["营销推广点击量", "营销推广点击数", "营销推广点击", "广告点击量", "广告点击数", "推广点击量", "推广点击数", "付费点击量"],
  totalGmv: ["总GMV", "全渠道总GMV"]
} as const;

function normalizedMetricLabel(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s_\-/（）()【】\[\]：:]+/g, "");
}

function columnIndexByAliases(table: DmpReportTable | undefined, aliases: readonly string[]) {
  if (!table) return -1;
  const accepted = new Set(aliases.map(normalizedMetricLabel));
  return table.columns.findIndex((column) => accepted.has(normalizedMetricLabel(column)));
}

function metricRow(table: DmpReportTable | undefined, aliases: readonly string[]) {
  if (!table) return undefined;
  const metricIndex = columnIndexByAliases(table, ["项目", "对标指标", "指标"]);
  if (metricIndex < 0) return undefined;
  const accepted = new Set(aliases.map(normalizedMetricLabel));
  return table.rows.find((row) => accepted.has(normalizedMetricLabel(row[metricIndex])));
}

function sideColumnIndex(table: DmpReportTable | undefined, side: ReportSide) {
  if (!table) return -1;
  const aliases = side === "subject"
    ? ["主体", "主体值", "主体周期值", "本品", "本品值"]
    : ["对手", "对手值", "对手周期值", "目标对手", "目标对手值", "目标对手周期值", "竞品", "竞品值", "竞品周期值"];
  const index = columnIndexByAliases(table, aliases);
  if (index >= 0) return index;
  if (table.name === "报告总览" && table.columns.length >= 3) return side === "subject" ? 1 : 2;
  return -1;
}

function periodRoleRow(
  table: DmpReportTable | undefined,
  side: ReportSide,
  subjectItemId: string,
  competitorItemId: string
) {
  if (!table) return undefined;
  const itemId = side === "subject" ? subjectItemId : competitorItemId;
  const idIndex = columnIndexByAliases(table, ["商品ID", "商品编号"]);
  if (idIndex >= 0 && itemId) {
    const exact = table.rows.find((row) => String(row[idIndex] ?? "").trim() === itemId);
    if (exact) return exact;
  }
  const roleIndex = columnIndexByAliases(table, ["对象", "角色"]);
  if (roleIndex >= 0) {
    const pattern = side === "subject" ? /主体/ : /目标对手|对手|竞品/;
    const matched = table.rows.find((row) => pattern.test(String(row[roleIndex] ?? "")));
    if (matched) return matched;
  }
  if (table.rows.length === 2) return table.rows[side === "subject" ? 0 : 1];
  return undefined;
}

function tableMetricCell(
  table: DmpReportTable | undefined,
  side: ReportSide,
  aliases: readonly string[],
  subjectItemId: string,
  competitorItemId: string
) {
  if (!table) return undefined;
  if (table.name === "周期汇总") {
    const columnIndex = columnIndexByAliases(table, aliases);
    const row = periodRoleRow(table, side, subjectItemId, competitorItemId);
    return columnIndex >= 0 ? row?.[columnIndex] : undefined;
  }
  const row = metricRow(table, aliases);
  const columnIndex = sideColumnIndex(table, side);
  return row && columnIndex >= 0 ? row[columnIndex] : undefined;
}

function disclosedMetricCell(
  tables: DmpReportTable[],
  side: ReportSide,
  aliases: readonly string[],
  subjectItemId: string,
  competitorItemId: string
) {
  for (const name of ["周期汇总", "报告总览", "对标总表", "基础指标对比"]) {
    const value = tableMetricCell(
      tables.find((table) => table.name === name),
      side,
      aliases,
      subjectItemId,
      competitorItemId
    );
    if (!isBlankCell(value)) return value;
  }
  return undefined;
}

function appendCoverageScope(table: DmpReportTable, row: DmpCell[], side: ReportSide, coverage: string) {
  const scopeIndex = columnIndexByAliases(table, ["范围", "数据范围", "周期"]);
  if (scopeIndex < 0) return;
  const role = side === "subject" ? "主体" : "对手";
  const note = `${role}${coverage}`;
  const current = String(row[scopeIndex] ?? "").trim();
  if (!current) row[scopeIndex] = note;
  else if (!current.includes(note)) row[scopeIndex] = `${current}；补算范围：${note}`;
}

function fillMetricAcrossTables(
  tables: DmpReportTable[],
  side: ReportSide,
  aliases: readonly string[],
  value: DmpCell | null,
  coverage: string,
  subjectItemId: string,
  competitorItemId: string
) {
  if (value == null) return;
  for (const name of ["周期汇总", "报告总览", "对标总表", "基础指标对比"]) {
    const table = tables.find((candidate) => candidate.name === name);
    if (!table) continue;
    if (name === "周期汇总") {
      const columnIndex = columnIndexByAliases(table, aliases);
      const row = periodRoleRow(table, side, subjectItemId, competitorItemId);
      if (row && columnIndex >= 0 && isBlankCell(row[columnIndex])) row[columnIndex] = value;
      continue;
    }
    const row = metricRow(table, aliases);
    const columnIndex = sideColumnIndex(table, side);
    if (!row || columnIndex < 0 || !isBlankCell(row[columnIndex])) continue;
    row[columnIndex] = value;
    if (name === "报告总览") appendCoverageScope(table, row, side, coverage);
  }
}

function dateSequence(startDate: string, endDate: string) {
  const days = daysInclusive(startDate, endDate);
  if (!days) return [];
  const start = Date.parse(`${startDate}T00:00:00Z`);
  return Array.from({ length: days }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10));
}

function dailyRoleColumn(table: DmpReportTable, side: ReportSide, metric: "totalSpend" | "keywordSpend") {
  const sideTokens = side === "subject" ? ["主体"] : ["对手", "目标对手", "竞品"];
  const matchesSide = (label: string) => sideTokens.some((token) => label.includes(token));
  const matchesMetric = (label: string) => metric === "totalSpend"
    ? /日总(?:消耗|花费)|总日(?:消耗|花费)/.test(label)
    : /关键词推广.*(?:消耗|花费)|(?:消耗|花费).*关键词推广/.test(label);
  const specific = table.columns.findIndex((column) => {
    const label = normalizedMetricLabel(column).replace(/api原值/g, "");
    return matchesSide(label) && matchesMetric(label);
  });
  if (specific >= 0) return specific;
  if (side === "subject") return -1;
  return table.columns.findIndex((column) => {
    const label = normalizedMetricLabel(column).replace(/api原值/g, "");
    if (sideTokens.some((token) => label.includes(token))) return false;
    return metric === "totalSpend"
      ? /^(?:日总消耗|日总花费)$/.test(label)
      : /^(?:关键词推广|关键词推广日消耗|关键词推广消耗|关键词推广日花费|关键词推广花费)$/.test(label);
  });
}

function partialSpendCoverage(
  tables: DmpReportTable[],
  side: ReportSide,
  subjectItemId: string,
  competitorItemId: string,
  expectedDays: number,
  options: ReconcileOptions
): PartialSpendCoverage | null {
  if (expectedDays <= 1) return null;
  const daily = tables.find((table) => table.name === "日GMV与费比");
  const dateIndex = columnIndexByAliases(daily, ["日期", "自然日"]);
  if (!daily || dateIndex < 0) return null;
  const totalIndex = dailyRoleColumn(daily, side, "totalSpend");
  if (totalIndex < 0) return null;
  const keywordIndex = dailyRoleColumn(daily, side, "keywordSpend");

  const period = tables.find((table) => table.name === "周期汇总");
  const periodRow = periodRoleRow(period, side, subjectItemId, competitorItemId);
  const startIndex = columnIndexByAliases(period, ["周期开始", "开始日期", "开始"]);
  const endIndex = columnIndexByAliases(period, ["周期结束", "结束日期", "结束"]);
  const startDate = normalizeDate(options.periodStartDate || (startIndex >= 0 ? periodRow?.[startIndex] : ""));
  const endDate = normalizeDate(options.periodEndDate || (endIndex >= 0 ? periodRow?.[endIndex] : ""));
  const expectedDates = dateSequence(startDate, endDate);
  if (expectedDates.length !== expectedDays) return null;
  const expectedSet = new Set(expectedDates);
  const totalByDate = new Map<string, number>();
  const keywordByDate = new Map<string, number>();
  let totalConflict = false;
  let keywordConflict = false;

  const remember = (target: Map<string, number>, date: string, value: number, onConflict: () => void) => {
    const current = target.get(date);
    if (current != null && Math.abs(current - value) > 1e-9) onConflict();
    else target.set(date, value);
  };
  for (const row of daily.rows) {
    const date = normalizeDate(row[dateIndex]);
    if (!date || (expectedSet && !expectedSet.has(date))) continue;
    const total = numericCell(row[totalIndex]);
    if (total != null && total >= 0) remember(totalByDate, date, total, () => { totalConflict = true; });
    const keyword = keywordIndex >= 0 ? numericCell(row[keywordIndex]) : null;
    if (keyword != null && keyword >= 0) remember(keywordByDate, date, keyword, () => { keywordConflict = true; });
  }
  if (totalConflict || totalByDate.size !== expectedDays - 1) return null;

  const returnedDates = [...totalByDate.keys()].sort();
  const missingDates = expectedSet ? expectedDates.filter((date) => !totalByDate.has(date)) : [];
  const spend = roundMetric([...totalByDate.values()].reduce((sum, value) => sum + value, 0), 6);
  const keywordComplete = keywordIndex >= 0
    && !keywordConflict
    && returnedDates.every((date) => keywordByDate.has(date));
  const keywordSpend = keywordComplete
    ? returnedDates.reduce((sum, date) => sum + (keywordByDate.get(date) ?? 0), 0)
    : null;
  const actualRange = returnedDates.length ? `${returnedDates[0]} 至 ${returnedDates.at(-1)}` : "";
  const details = [actualRange ? `实际${actualRange}` : "", missingDates.length ? `缺少${missingDates.join("、")}` : "", "缺失日未按0计入"]
    .filter(Boolean)
    .join("；");
  return {
    side,
    spend,
    keywordShare: keywordSpend != null && spend > 0 ? roundMetric(keywordSpend / spend, 6) : null,
    returnedDays: totalByDate.size,
    expectedDays,
    label: `已返回${totalByDate.size}/${expectedDays}日${details ? `（${details}）` : ""}`
  };
}

function ensurePartialSpendCoverageRow(tables: DmpReportTable[], coverages: PartialSpendCoverage[]) {
  if (!coverages.length) return;
  const overview = tables.find((table) => table.name === "报告总览");
  if (!overview) return;
  const metricIndex = columnIndexByAliases(overview, ["项目", "指标", "对标指标"]);
  if (metricIndex < 0) return;
  let row = metricRow(overview, ["花费覆盖"]);
  if (!row) {
    row = overview.columns.map(() => "" as DmpCell);
    row[metricIndex] = "花费覆盖";
    overview.rows.push(row);
  }
  for (const coverage of coverages) {
    const index = sideColumnIndex(overview, coverage.side);
    if (index >= 0 && isBlankCell(row[index])) row[index] = coverage.label;
  }
  const scopeIndex = columnIndexByAliases(overview, ["范围", "数据范围", "周期"]);
  if (scopeIndex >= 0 && isBlankCell(row[scopeIndex])) row[scopeIndex] = "缺失日留空，未按0计入";
}

function reconcilePartialDailySpend(
  tables: DmpReportTable[],
  subjectItemId: string,
  competitorItemId: string,
  days: number,
  options: ReconcileOptions
) {
  const coverages = (["subject", "competitor"] as const)
    .map((side) => {
      const periodSpend = tableMetricCell(
        tables.find((table) => table.name === "周期汇总"),
        side,
        CROSS_TABLE_METRICS.spend,
        subjectItemId,
        competitorItemId
      );
      if (!isBlankCell(periodSpend)) return null;
      return partialSpendCoverage(tables, side, subjectItemId, competitorItemId, days, options);
    })
    .filter((coverage): coverage is PartialSpendCoverage => coverage != null);

  for (const coverage of coverages) {
    const paidGmv = disclosedMetricCell(tables, coverage.side, CROSS_TABLE_METRICS.paidGmv, subjectItemId, competitorItemId);
    const totalGmv = disclosedMetricCell(tables, coverage.side, CROSS_TABLE_METRICS.totalGmv, subjectItemId, competitorItemId);
    const marketingClicks = disclosedMetricCell(tables, coverage.side, CROSS_TABLE_METRICS.marketingClicks, subjectItemId, competitorItemId);
    const roi = rangeDividedByScalar(paidGmv, coverage.spend, 6);
    const ppc = scalarDividedByRange(coverage.spend, marketingClicks, 6);
    const feeRatio = scalarDividedByRange(coverage.spend, totalGmv, 6);
    const roas = rangeDividedByScalar(totalGmv, coverage.spend, 6);
    fillMetricAcrossTables(tables, coverage.side, CROSS_TABLE_METRICS.spend, coverage.spend, coverage.label, subjectItemId, competitorItemId);
    fillMetricAcrossTables(tables, coverage.side, CROSS_TABLE_METRICS.roi, roi, coverage.label, subjectItemId, competitorItemId);
    fillMetricAcrossTables(tables, coverage.side, CROSS_TABLE_METRICS.ppc, ppc, coverage.label, subjectItemId, competitorItemId);
    fillMetricAcrossTables(tables, coverage.side, CROSS_TABLE_METRICS.feeRatio, feeRatio, coverage.label, subjectItemId, competitorItemId);
    fillMetricAcrossTables(tables, coverage.side, CROSS_TABLE_METRICS.roas, roas, coverage.label, subjectItemId, competitorItemId);
    fillMetricAcrossTables(tables, coverage.side, CROSS_TABLE_METRICS.keywordShare, coverage.keywordShare, coverage.label, subjectItemId, competitorItemId);
  }
  ensurePartialSpendCoverageRow(tables, coverages);
}

function populationVolatility(values: number[]) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!Number.isFinite(mean) || mean === 0) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function shouldReplaceRange(value: DmpCell | undefined) {
  const range = metricRange(value);
  return isBlankCell(value) || Boolean(range && !range.exact);
}

export function reconcileDmpCrossTableMetrics(
  tables: DmpReportTable[],
  subjectItemId: string,
  competitorItemId: string,
  days: number,
  options: ReconcileOptions = {}
) {
  const gmvByItemId = new Map<string, DmpCell>();
  const remember = (itemId: string, value: DmpCell | undefined) => {
    if (itemId && !isBlankCell(value) && !gmvByItemId.has(itemId)) gmvByItemId.set(itemId, value as DmpCell);
  };

  const periodTable = tables.find((table) => table.name === "周期汇总");
  const periodIdIndex = periodTable?.columns.indexOf("商品ID") ?? -1;
  const periodGmvIndex = periodTable?.columns.indexOf("总GMV") ?? -1;
  if (periodIdIndex >= 0 && periodGmvIndex >= 0) {
    periodTable?.rows.forEach((row) => remember(String(row[periodIdIndex] ?? ""), row[periodGmvIndex]));
  }

  const benchmark = tables.find((table) => table.name === "对标总表");
  const benchmarkMetricIndex = benchmark?.columns.indexOf("对标指标") ?? -1;
  const benchmarkSubjectIndex = benchmark?.columns.indexOf("主体周期值") ?? -1;
  const benchmarkCompetitorIndex = benchmark?.columns.indexOf("对手周期值") ?? -1;
  const benchmarkGmv = benchmarkMetricIndex >= 0 ? benchmark?.rows.find((row) => String(row[benchmarkMetricIndex]) === "总GMV") : null;
  if (benchmarkGmv) {
    remember(subjectItemId, benchmarkGmv[benchmarkSubjectIndex]);
    remember(competitorItemId, benchmarkGmv[benchmarkCompetitorIndex]);
  }

  const base = tables.find((table) => table.name === "基础指标对比");
  const baseMetricIndex = base?.columns.indexOf("指标") ?? -1;
  const baseSubjectIndex = base?.columns.indexOf("主体值") ?? -1;
  const baseCompetitorIndex = base?.columns.indexOf("对手值") ?? -1;
  const baseGmv = baseMetricIndex >= 0 ? base?.rows.find((row) => String(row[baseMetricIndex]) === "总GMV") : null;
  if (baseGmv) {
    remember(subjectItemId, baseGmv[baseSubjectIndex]);
    remember(competitorItemId, baseGmv[baseCompetitorIndex]);
  }

  const itemTable = tables.find((table) => table.name === "商品与成功品");
  const itemIdIndex = itemTable?.columns.indexOf("商品ID") ?? -1;
  const itemGmvIndex = itemTable?.columns.indexOf("30日GMV") ?? -1;
  const itemAverageIndex = itemTable?.columns.findIndex((column) => /日均成交/.test(column)) ?? -1;
  if (itemIdIndex >= 0 && itemGmvIndex >= 0) {
    itemTable?.rows.forEach((row) => {
      const gmv = gmvByItemId.get(String(row[itemIdIndex] ?? ""));
      if (gmv === undefined) return;
      if (isBlankCell(row[itemGmvIndex])) row[itemGmvIndex] = gmv;
      const numericGmv = numericCell(gmv);
      if (itemAverageIndex >= 0 && isBlankCell(row[itemAverageIndex]) && numericGmv != null && days > 0) {
        row[itemAverageIndex] = Math.round((numericGmv / days + Number.EPSILON) * 100) / 100;
      }
    });
  }

  reconcilePartialDailySpend(tables, subjectItemId, competitorItemId, days, options);

  if (periodTable) {
    const paidGmvIndex = periodTable.columns.findIndex((column) => /^(付费成交额|广告归因GMV)$/.test(column));
    const contributionIndex = periodTable.columns.findIndex((column) => /^(付费|广告)GMV贡献率$/.test(column));
    const peakIndex = periodTable.columns.indexOf("GMV峰值日");
    const volatilityIndex = periodTable.columns.indexOf("GMV波动率");
    periodTable.rows.forEach((row) => {
      const totalGmv = numericCell(row[periodGmvIndex]);
      if (paidGmvIndex >= 0 && contributionIndex >= 0 && totalGmv != null && isBlankCell(row[contributionIndex])) {
        row[contributionIndex] = rangeDividedByScalar(row[paidGmvIndex], totalGmv, 6);
      }
    });

    const daily = tables.find((table) => table.name === "日GMV与费比");
    const dailyDateIndex = daily?.columns.indexOf("日期") ?? -1;
    const fillDailyStatistics = (itemId: string, columnPatterns: RegExp[]) => {
      const gmvIndex = daily?.columns.findIndex((column) => columnPatterns.some((pattern) => pattern.test(column))) ?? -1;
      if (!daily || dailyDateIndex < 0 || gmvIndex < 0) return;
      const values = daily.rows
        .map((row) => ({ date: String(row[dailyDateIndex] ?? ""), gmv: numericCell(row[gmvIndex]) }))
        .filter((row): row is { date: string; gmv: number } => Boolean(row.date) && row.gmv != null);
      const periodGmv = numericCell(gmvByItemId.get(itemId));
      const sum = values.reduce((total, row) => total + row.gmv, 0);
      if (values.length !== days || periodGmv == null || Math.abs(sum - periodGmv) > 0.01) return;
      const peak = values.reduce((best, row) => row.gmv > best.gmv ? row : best, values[0]);
      const volatility = populationVolatility(values.map((row) => row.gmv));
      periodTable.rows.filter((row) => String(row[periodIdIndex] ?? "") === itemId).forEach((row) => {
        if (peakIndex >= 0 && isBlankCell(row[peakIndex])) row[peakIndex] = peak.date;
        if (volatilityIndex >= 0 && isBlankCell(row[volatilityIndex]) && volatility != null) row[volatilityIndex] = roundMetric(volatility, 6);
      });
    };
    fillDailyStatistics(subjectItemId, [/^主体日GMV$/]);
    fillDailyStatistics(competitorItemId, [/^对手日GMV$/, /^日GMV$/]);
  }

  const spendByRole = new Map<string, number>();
  if (periodTable) {
    const spendIndex = periodTable.columns.findIndex((column) => /^(广告消耗|推广消耗)$/.test(column));
    periodTable.rows.forEach((row) => {
      const itemId = String(row[periodIdIndex] ?? "");
      const spend = numericCell(row[spendIndex]);
      if (spend == null) return;
      if (itemId === subjectItemId) spendByRole.set("主体", spend);
      if (itemId === competitorItemId) spendByRole.set("对手", spend);
    });
  }

  const reconcileScenes = (sceneTable: DmpReportTable | undefined, parentSpend?: Map<string, number>) => {
    const allocatedByParent = new Map<string, number>();
    if (!sceneTable) return allocatedByParent;
    const roleIndex = sceneTable.columns.indexOf("对象");
    const primaryIndex = sceneTable.columns.indexOf("一级场景");
    const chargeIndex = sceneTable.columns.findIndex((column) => /^(?:消耗|花费)(?:\(API精确值\))?$/.test(column));
    const ratioIndex = sceneTable.columns.findIndex((column) => /^(?:消耗|花费)占比(?:\(API原值\))?$/.test(column));
    const allocatedIndex = sceneTable.columns.findIndex((column) => /^(?:分配后)?(?:消耗|花费)$/.test(column) && column !== sceneTable.columns[chargeIndex]);
    const clickIndex = sceneTable.columns.findIndex((column) => /^点击(?:量)?$/.test(column));
    const cpcIndex = sceneTable.columns.findIndex((column) => /^(?:CPC|点击单价)$/.test(column));
    const dealIndex = sceneTable.columns.findIndex((column) => /直接成交(金额|额)/.test(column));
    const roiIndex = sceneTable.columns.findIndex((column) => /^(?:直接)?ROI$/.test(column));
    if ([roleIndex, primaryIndex, chargeIndex, ratioIndex, allocatedIndex].some((index) => index < 0)) return allocatedByParent;
    sceneTable.rows.forEach((row) => {
      const role = /主体/.test(String(row[roleIndex] ?? "")) ? "主体" : "对手";
      const primary = String(row[primaryIndex] ?? "");
      const exactCharge = numericCell(row[chargeIndex]);
      const ratio = metricRange(row[ratioIndex]);
      const ratioValue = ratio?.exact ? ratio.min : null;
      const baseSpend = parentSpend?.get(`${role}|${primary}`) ?? spendByRole.get(role);
      let allocated = numericCell(row[allocatedIndex]) ?? exactCharge;
      if (allocated == null && ratioValue != null && baseSpend != null) allocated = roundMetric(baseSpend * ratioValue);
      if (allocated == null) return;
      if (isBlankCell(row[allocatedIndex])) row[allocatedIndex] = allocated;
      allocatedByParent.set(`${role}|${primary}`, allocated);
      if (clickIndex >= 0 && cpcIndex >= 0) {
        const cpc = scalarDividedByRange(allocated, row[clickIndex]);
        const mayReplace = options.preserveDisclosedRanges ? isBlankCell(row[cpcIndex]) : shouldReplaceRange(row[cpcIndex]);
        if (cpc != null && mayReplace) row[cpcIndex] = cpc;
      }
      if (dealIndex >= 0 && roiIndex >= 0) {
        const roi = rangeDividedByScalar(row[dealIndex], allocated);
        const mayReplace = options.preserveDisclosedRanges ? isBlankCell(row[roiIndex]) : shouldReplaceRange(row[roiIndex]);
        if (roi != null && mayReplace) row[roiIndex] = roi;
      }
    });
    return allocatedByParent;
  };

  const level1Spend = reconcileScenes(tables.find((table) => table.name === "一级场景"));
  reconcileScenes(tables.find((table) => table.name === "二级场景"), level1Spend);
  return tables;
}

export function canonicalToDmpReport(input: unknown): DmpReport | null {
  if (!isObject(input) || input.schema_version !== "3.0" || !Array.isArray(input.tables)) return null;
  const snapshots: DmpReportTableSnapshot[] = input.tables.filter(isObject).map((table) => ({
    name: String(table.name ?? ""),
    columns: Array.isArray(table.columns) ? table.columns.map(String) : [],
    rows: Array.isArray(table.rows)
      ? table.rows.filter(isObject).map((row) => ({ cells: Array.isArray(row.cells) ? row.cells.map(String) : [] }))
      : []
  }));
  const itemId = String(input.item_id ?? "");
  const periodLabel = String(input.period ?? "");
  const renderData = sanitizeDmpReportRenderData(input.render_data, {
    itemId,
    period: periodLabel,
    tables: snapshots,
    expectedTableNames: DMP_GROWTH_REPORT_TABLES
  });
  const renderTableMeta = new Map((renderData?.tables ?? []).map((table) => [table.name, table]));
  const tables: DmpReportTable[] = snapshots.map((table) => {
    const meta = renderTableMeta.get(table.name);
    return {
      name: table.name,
      columns: table.columns,
      rows: table.rows.map((row) => row.cells),
      ...(meta?.subtitle ? { subtitle: meta.subtitle } : {}),
      ...(meta?.widths ? { widths: [...meta.widths] } : {})
    };
  });
  const dateMatches = [...periodLabel.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((match) => match[0]);
  const overview = tables.find((table) => table.name === "报告总览");
  const itemRow = overview?.rows.find((row) => String(row[0]) === "商品ID");
  const productTable = tables.find((table) => table.name === "商品与成功品");
  const roleIndex = productTable?.columns.indexOf("角色") ?? -1;
  const productIdIndex = productTable?.columns.indexOf("商品ID") ?? -1;
  const titleIndex = productTable?.columns.indexOf("商品标题") ?? -1;
  const mediaIndex = productTable?.columns.indexOf("图片/详情") ?? -1;
  const subjectProduct = productTable?.rows.find((row) => roleIndex >= 0 && /^主体/.test(String(row[roleIndex] ?? "")));
  const competitorProduct = productTable?.rows.find((row) => roleIndex >= 0 && /目标对手|^对手|^竞品/.test(String(row[roleIndex] ?? "")));
  const competitorId = String(
    itemRow?.[2]
      ?? (productIdIndex >= 0 ? competitorProduct?.[productIdIndex] : "")
      ?? (Array.isArray(input.competitor_ids) ? input.competitor_ids[0] : "")
      ?? ""
  );
  const subjectMedia = mediaIndex >= 0 ? String(subjectProduct?.[mediaIndex] ?? "") : "";
  const competitorMedia = mediaIndex >= 0 ? String(competitorProduct?.[mediaIndex] ?? "") : "";
  const startDate = dateMatches[0] ?? "";
  const endDate = dateMatches[1] ?? "";
  const days = daysInclusive(startDate, endDate) || 30;
  mergeSubjectDailyGmv(tables, renderData?.subject_daily_gmv);
  alignComparisonRoleRows(tables);
  reconcileDmpCrossTableMetrics(tables, itemId, competitorId, days, {
    preserveDisclosedRanges: Boolean(renderData),
    periodStartDate: startDate,
    periodEndDate: endDate
  });
  const subjectRender = renderData?.products?.subject;
  const competitorRender = renderData?.products?.competitor;
  return {
    version: 3,
    title: String(input.title ?? "达摩盘商品成长竞品对标报告"),
    item: {
      id: itemId,
      title: titleIndex >= 0 ? String(subjectProduct?.[titleIndex] ?? "") : "",
      ...(subjectRender?.picture_url
        ? { pictureUrl: subjectRender.picture_url }
        : looksLikeImageUrl(subjectMedia)
          ? { pictureUrl: subjectMedia }
          : {}),
      ...(subjectRender?.detail_url
        ? { detailUrl: subjectRender.detail_url }
        : !looksLikeImageUrl(subjectMedia) && subjectMedia
          ? { detailUrl: subjectMedia }
          : {}),
      competitorId,
      competitorTitle: titleIndex >= 0 ? String(competitorProduct?.[titleIndex] ?? "") : "",
      ...(competitorRender?.picture_url
        ? { competitorPictureUrl: competitorRender.picture_url }
        : looksLikeImageUrl(competitorMedia)
          ? { competitorPictureUrl: competitorMedia }
          : {}),
      ...(competitorRender?.detail_url
        ? { competitorDetailUrl: competitorRender.detail_url }
        : !looksLikeImageUrl(competitorMedia) && competitorMedia
          ? { competitorDetailUrl: competitorMedia }
          : {})
    },
    period: { startDate, endDate, days },
    periodLabel,
    ...(renderData?.generated_at ? { generatedAt: renderData.generated_at } : {}),
    tables,
    quality: { status: "canonical", complete: true, expected: tables.length, observed: tables.length }
  };
}

function mergeSubjectDailyGmv(tables: DmpReportTable[], rows: DmpReportRenderData["subject_daily_gmv"] | undefined) {
  if (!rows?.length) return;
  const table = tables.find((candidate) => candidate.name === "日GMV与费比");
  if (!table) return;
  const dateIndex = table.columns.indexOf("日期");
  if (dateIndex < 0) return;
  let subjectIndex = table.columns.indexOf("主体日GMV");
  if (subjectIndex < 0) {
    const competitorIndex = table.columns.findIndex((column) => /^(?:对手)?日GMV$/.test(column));
    subjectIndex = competitorIndex >= 0 ? competitorIndex : 1;
    const subjectWidth = table.widths?.[competitorIndex] ?? 16;
    table.columns.splice(subjectIndex, 0, "主体日GMV");
    table.rows.forEach((row) => row.splice(subjectIndex, 0, ""));
    if (table.widths) table.widths.splice(subjectIndex, 0, subjectWidth);
  }
  const byDate = new Map(rows.map((row) => [row.date, row.gmv]));
  const allowedDates = new Set(byDate.keys());
  const existingByDate = new Map<string, DmpCell[]>();
  for (const source of table.rows.filter((row) => allowedDates.has(String(row[dateIndex] ?? "")))) {
    const date = String(source[dateIndex] ?? "");
    const current = existingByDate.get(date);
    if (!current) {
      existingByDate.set(date, table.columns.map((_, index) => source[index] ?? ""));
      continue;
    }
    table.columns.forEach((_, index) => {
      if (isBlankCell(current[index]) && !isBlankCell(source[index])) current[index] = source[index];
    });
  }
  table.rows = [...existingByDate.values()];
  for (const { date } of rows) {
    if (existingByDate.has(date)) continue;
    const row = table.columns.map(() => "" as DmpCell);
    row[dateIndex] = date;
    table.rows.push(row);
    existingByDate.set(date, row);
  }
  table.rows.sort((left, right) => String(left[dateIndex] ?? "").localeCompare(String(right[dateIndex] ?? "")));
  table.rows.forEach((row) => {
    const value = byDate.get(String(row[dateIndex] ?? ""));
    if (value !== undefined && isBlankCell(row[subjectIndex])) row[subjectIndex] = value;
  });
}

function alignComparisonRoleRows(tables: DmpReportTable[]) {
  for (const table of tables) {
    if (table.name !== "一级场景" && table.name !== "二级场景") continue;
    const roleIndex = table.columns.indexOf("对象");
    if (roleIndex < 0) continue;
    const dimensionIndexes = ["层级", "一级场景", "二级场景", "场景编号", "sceneId"]
      .map((column) => table.columns.indexOf(column))
      .filter((index, position, values) => index >= 0 && values.indexOf(index) === position);
    if (!dimensionIndexes.length) continue;
    const levelIndex = table.columns.indexOf("层级");
    const primaryIndex = table.columns.indexOf("一级场景");
    const secondaryIndex = table.columns.indexOf("二级场景");
    const idIndexes = [table.columns.indexOf("场景编号"), table.columns.indexOf("sceneId")]
      .filter((index, position, values) => index >= 0 && values.indexOf(index) === position);
    const keyFor = (row: DmpCell[]) => {
      const names = [levelIndex, primaryIndex, secondaryIndex].map((index) => index >= 0 ? String(row[index] ?? "").trim() : "");
      if (names.slice(1).some(Boolean)) return names.join("\u0001");
      return [...names, ...idIndexes.map((index) => String(row[index] ?? "").trim())].join("\u0001");
    };

    const groups = new Map<string, { template: DmpCell[]; subject?: DmpCell[]; competitor?: DmpCell[] }>();
    for (const row of table.rows) {
      const key = keyFor(row);
      const current = groups.get(key) ?? { template: row };
      if (/^主体/.test(String(row[roleIndex] ?? ""))) current.subject = row;
      else if (/目标对手|^对手|^竞品/.test(String(row[roleIndex] ?? ""))) current.competitor = row;
      groups.set(key, current);
    }
    table.rows = [...groups.values()].flatMap(({ template, subject, competitor }) => {
      const placeholder = (role: "主体" | "对手") => table.columns.map((_, index) => {
        if (index === roleIndex) return role;
        return dimensionIndexes.includes(index) ? template[index] ?? "" : "";
      });
      return [subject ?? placeholder("主体"), competitor ?? placeholder("对手")];
    });
  }
}

function looksLikeImageUrl(value: string) {
  const text = value.trim();
  if (!/^(?:https?:)?\/\//i.test(text)) return false;
  try {
    const parsed = new URL(text.startsWith("//") ? `https:${text}` : text);
    return parsed.protocol === "https:"
      && (/(?:^|\.)(?:alicdn\.com|tbcdn\.cn|taobaocdn\.com)$/i.test(parsed.hostname)
        || /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?&#])/i.test(`${parsed.pathname}${parsed.search}`));
  } catch {
    return false;
  }
}

export function inferDmpCaptureMeta(records: UnknownRecord[], fileName = ""): DmpCaptureMeta {
  const fileIds = fileName.match(/(\d{6,20})_vs_(\d{6,20})/i);
  let subjectItemId = fileIds?.[1] ?? "";
  let successItemId = fileIds?.[2] ?? "";

  type Candidate = {
    subjectIds: string[];
    competitorIds: string[];
    dates: string[];
    compareDates: string[];
    capturedAt: string;
    score: number;
  };
  const candidates: Candidate[] = [];

  for (const record of records) {
    const path = pathname(record);
    if (!subjectItemId && path === "/api/goods/item/info") {
      subjectItemId = findItemId(responseBody(record));
    }
    if (!successItemId && (path === "/api/goods/grow/define/success/load" || path === "/api/goods/grow/define/success/item/list")) {
      successItemId = findItemId(responseBody(record), subjectItemId);
    }
    if (path !== "/dataplatform/dataset/report/query") continue;
    const request = parseJsonLike(record.requestBody ?? (isObject(record.request) ? record.request.postData : null));
    if (!isObject(request)) continue;
    const subjectFilters = filterList(request, "filterCondition");
    const competitorFilters = filterList(request, "filterCompareCondition");
    const subjectIds = filterValues(subjectFilters, /item_id|宝贝ID/i);
    const competitorIds = filterValues(competitorFilters, /item_id|宝贝ID/i);
    const dates = filterValues(subjectFilters, /thedate|日期|时间/i).map(normalizeDate).filter(Boolean);
    const compareDates = filterValues(competitorFilters, /thedate|日期|时间/i).map(normalizeDate).filter(Boolean);
    const startDate = dates[0] ?? "";
    const endDate = dates[1] ?? dates[0] ?? "";
    const days = daysInclusive(startDate, endDate);
    let score = 0;
    if (subjectItemId && subjectIds.includes(subjectItemId)) score += 30;
    if (successItemId && competitorIds.includes(successItemId)) score += 35;
    if (dates.length >= 2 && dates.join("|") === compareDates.join("|")) score += 20;
    if (days === 30) score += 40;
    else if (days > 0) score += Math.max(0, 20 - Math.abs(days - 30));
    candidates.push({
      subjectIds,
      competitorIds,
      dates,
      compareDates,
      capturedAt: String(record.capturedAt ?? ""),
      score
    });
  }

  candidates.sort((left, right) => right.score - left.score || right.capturedAt.localeCompare(left.capturedAt));
  const chosen = candidates[0];
  subjectItemId ||= chosen?.subjectIds[0] ?? "";
  successItemId ||= chosen?.competitorIds[0] ?? "";
  const startDate = chosen?.dates[0] ?? "";
  const endDate = chosen?.dates[1] ?? chosen?.dates[0] ?? "";
  const days = daysInclusive(startDate, endDate);
  const timestamps = records.map((record) => String(record.capturedAt ?? "")).filter(Boolean).sort();

  if (!/^\d{6,20}$/.test(subjectItemId)) throw new Error("无法识别主体商品 ID，请使用插件原始监听 JSON 或保留 _主体ID_vs_竞品ID_ 文件名");
  if (!/^\d{6,20}$/.test(successItemId)) throw new Error("无法识别成功品/竞品 ID，请使用插件原始监听 JSON");
  if (!startDate || !endDate || days <= 0) throw new Error("没有找到主体与竞品完全对齐的日期区间");

  return {
    subjectItemId,
    successItemId,
    period: { startDate, endDate, days },
    periodConfirmed: days === 30 && chosen?.dates.join("|") === chosen?.compareDates.join("|"),
    periodPrecision: days === 30 ? "exact" : "failed",
    startedAt: timestamps[0] ?? "",
    finishedAt: timestamps.at(-1) ?? ""
  };
}
