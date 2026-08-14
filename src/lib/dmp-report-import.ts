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
  return {
    version: 3,
    title: String(input.title ?? "达摩盘商品成长竞品对标报告"),
    item: { id: itemId, competitorId },
    period: { startDate, endDate, days: daysInclusive(startDate, endDate) || 30 },
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
