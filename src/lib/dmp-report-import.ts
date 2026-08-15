export type DmpCell = string | number | boolean | null;

export interface DmpReportTable {
  name: string;
  columns: string[];
  rows: DmpCell[][];
  subtitle?: string;
}

export interface DmpReport {
  version: number;
  title: string;
  item: {
    id: string;
    title?: string;
    competitorId: string;
    competitorTitle?: string;
  };
  period: { startDate: string; endDate: string; days: number };
  periodLabel: string;
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

function scalarDividedByRange(value: number, divisor: DmpCell | undefined): DmpCell | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const range = metricRange(divisor);
  if (!range) return null;
  const minDivisor = range.min != null && range.min > 0 ? range.min : null;
  const maxDivisor = range.max != null && range.max > 0 ? range.max : null;
  if (minDivisor != null && maxDivisor != null) {
    const lower = roundMetric(value / maxDivisor);
    const upper = roundMetric(value / minDivisor);
    return lower === upper ? lower : `${lower}~${upper}`;
  }
  if (maxDivisor != null) return `>${roundMetric(value / maxDivisor)}`;
  if (minDivisor != null) return `<${roundMetric(value / minDivisor)}`;
  return null;
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
  days: number
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
  if (itemIdIndex < 0 || itemGmvIndex < 0) return tables;

  itemTable?.rows.forEach((row) => {
    const gmv = gmvByItemId.get(String(row[itemIdIndex] ?? ""));
    if (gmv === undefined) return;
    if (isBlankCell(row[itemGmvIndex])) row[itemGmvIndex] = gmv;
    const numericGmv = numericCell(gmv);
    if (itemAverageIndex >= 0 && isBlankCell(row[itemAverageIndex]) && numericGmv != null && days > 0) {
      row[itemAverageIndex] = Math.round((numericGmv / days + Number.EPSILON) * 100) / 100;
    }
  });

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
    const dailyGmvIndex = daily?.columns.indexOf("日GMV") ?? -1;
    const dailyValues = dailyGmvIndex >= 0
      ? (daily?.rows.map((row) => ({ date: String(row[dailyDateIndex] ?? ""), gmv: numericCell(row[dailyGmvIndex]) })) ?? [])
        .filter((row): row is { date: string; gmv: number } => Boolean(row.date) && row.gmv != null)
      : [];
    const competitorGmv = numericCell(gmvByItemId.get(competitorItemId));
    const dailySum = dailyValues.reduce((sum, row) => sum + row.gmv, 0);
    const dailyClosed = dailyValues.length === days && competitorGmv != null && Math.abs(dailySum - competitorGmv) <= 0.01;
    if (dailyClosed && peakIndex >= 0 && volatilityIndex >= 0) {
      const peak = dailyValues.reduce((best, row) => row.gmv > best.gmv ? row : best, dailyValues[0]);
      const volatility = populationVolatility(dailyValues.map((row) => row.gmv));
      periodTable.rows.filter((row) => String(row[periodIdIndex] ?? "") === competitorItemId).forEach((row) => {
        if (isBlankCell(row[peakIndex])) row[peakIndex] = peak.date;
        if (isBlankCell(row[volatilityIndex]) && volatility != null) row[volatilityIndex] = roundMetric(volatility, 6);
      });
    }
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
    const chargeIndex = sceneTable.columns.indexOf("消耗(API精确值)");
    const ratioIndex = sceneTable.columns.indexOf("消耗占比(API原值)");
    const allocatedIndex = sceneTable.columns.indexOf("分配后消耗");
    const clickIndex = sceneTable.columns.indexOf("点击");
    const cpcIndex = sceneTable.columns.indexOf("CPC");
    const dealIndex = sceneTable.columns.findIndex((column) => /直接成交(金额|额)/.test(column));
    const roiIndex = sceneTable.columns.indexOf("直接ROI");
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
        if (cpc != null && shouldReplaceRange(row[cpcIndex])) row[cpcIndex] = cpc;
      }
      if (dealIndex >= 0 && roiIndex >= 0) {
        const roi = rangeDividedByScalar(row[dealIndex], allocated);
        if (roi != null && shouldReplaceRange(row[roiIndex])) row[roiIndex] = roi;
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
  const tables: DmpReportTable[] = input.tables.filter(isObject).map((table) => ({
    name: String(table.name ?? ""),
    columns: Array.isArray(table.columns) ? table.columns.map(String) : [],
    rows: Array.isArray(table.rows)
      ? table.rows.filter(isObject).map((row) => Array.isArray(row.cells) ? row.cells as DmpCell[] : [])
      : []
  }));
  const itemId = String(input.item_id ?? "");
  const periodLabel = String(input.period ?? "");
  const dateMatches = [...periodLabel.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((match) => match[0]);
  const overview = tables.find((table) => table.name === "报告总览");
  const itemRow = overview?.rows.find((row) => String(row[0]) === "商品ID");
  const competitorId = String(itemRow?.[2] ?? "");
  const startDate = dateMatches[0] ?? "";
  const endDate = dateMatches[1] ?? "";
  const days = daysInclusive(startDate, endDate) || 30;
  reconcileDmpCrossTableMetrics(tables, itemId, competitorId, days);
  return {
    version: 3,
    title: String(input.title ?? "达摩盘商品成长竞品对标报告"),
    item: { id: itemId, competitorId },
    period: { startDate, endDate, days },
    periodLabel,
    tables,
    quality: { status: "canonical", complete: true, expected: tables.length, observed: tables.length }
  };
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
