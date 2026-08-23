import type { DmpBusinessReportRecord, DmpMarketScope } from "@/lib/dmp-report-types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENGINEERING_FIELD = /(?:^|\b)(?:periodType|requestDate|queryRange|analysisRange|purpose|conflict)(?:$|\b)|请求截止日|任务|轮次|工程(?:信息|数据|文件)?|接口(?:名称|地址|状态|数量)?|响应(?:体|状态|数量|结果)|采集(?:时间|状态|进度|数量)|窗口(?:开始|结束|总数)?|对比(?:开始|结束|窗口)|数据(?:开始|结束)|分析(?:开始|结束)|生成时间|叶子类目\s*ID|类目\s*ID|冲突|缺失/i;
const DATE_FIELD = /^(?:日期|截止日|请求截止日|周期)$/;
const REFERENCE_ONLY = /^(?:(?:自然周|自然月|月度|上月|7\s*日|期间)\s*)?(?:拟合值|参考值|中位(?:数)?)$/i;
const REFERENCE_SUFFIX = /(?:(?:自然周|自然月|月度|上月|7\s*日|期间)\s*)?(?:拟合值|参考值|中位(?:数)?)$/i;
const GENERIC_CATEGORY_NAME = /^(?:类目|类目大盘|叶子类目)$/;

const KNOWN_CATEGORY_PATHS: Record<string, string[]> = {
  "50015382": ["大家电", "厨房大电", "油烟机"]
};

export type DmpMarketPeriodMode = "week" | "month";

export interface DmpMarketPeriodOption {
  key: string;
  label: string;
  start: string;
  end: string;
}

export interface DmpMarketViewerTable {
  name: string;
  columns: string[];
  rows: string[][];
  dates: string[];
  rowPeriods: Array<{ start: string; end: string } | null>;
  periodMode?: DmpMarketPeriodMode;
}

export interface DmpMarketReportViewModel {
  scope: DmpMarketScope;
  period: string;
  tables: DmpMarketViewerTable[];
  periods: Record<DmpMarketPeriodMode, DmpMarketPeriodOption[]>;
}

export interface DmpMarketKpiMetric {
  label: string;
  value: number;
  percent: boolean;
}

export function projectDmpMarketReport(record: DmpBusinessReportRecord): DmpMarketReportViewModel {
  const scope = resolveDmpMarketScope(record.report.market_scope, record.subjectItemId);
  const tables = record.report.tables.flatMap((table) => {
    const tableName = businessTableName(table.name);
    if (!tableName || ENGINEERING_FIELD.test(tableName)) return [];
    const dateIndex = table.columns.findIndex((column) => DATE_FIELD.test(String(column).trim()));
    const dateColumn = dateIndex >= 0 && String(table.columns[dateIndex]).trim() === "周期" ? "周期" : "日期";
    const periodMode = /自然周/.test(tableName) ? "week" as const : /自然月/.test(tableName) ? "month" as const : undefined;
    const seenColumns = new Set<string>();
    const kept = table.columns
      .map((column, index) => {
        const rawColumn = String(column).trim();
        return { column: businessColumnName(rawColumn), rawColumn, index };
      })
      .filter(({ column, rawColumn, index }) => (
        index !== dateIndex
        && Boolean(column)
        && !REFERENCE_ONLY.test(rawColumn)
        && !ENGINEERING_FIELD.test(column)
        && table.rows.some((row) => hasBusinessValue(String(row.cells[index] ?? "").trim()))
      ))
      .filter(({ column }) => {
        const key = column.toLocaleLowerCase("zh-CN");
        if (seenColumns.has(key)) return false;
        seenColumns.add(key);
        return true;
      });
    if (!kept.length) return [];
    const columns = [...(dateIndex >= 0 ? [dateColumn] : []), ...kept.map(({ column }) => column)];
    const rows: string[][] = [];
    const dates: string[] = [];
    const rowPeriods: Array<{ start: string; end: string } | null> = [];
    for (const row of table.rows) {
      const source = row.cells.map((cell) => String(cell ?? "").trim());
      const firstBusinessLabel = kept.length ? visibleCellValue(source[kept[0].index], kept[0].column) : "";
      if (ENGINEERING_FIELD.test(firstBusinessLabel) || REFERENCE_ONLY.test(firstBusinessLabel)) continue;
      const rowPeriod = dateIndex >= 0 ? parseBusinessPeriod(source[dateIndex]) : null;
      const projected = [
        ...(dateIndex >= 0 ? [rowPeriod ? source[dateIndex] : ""] : []),
        ...kept.map(({ column, index }) => visibleCellValue(source[index], column))
      ];
      const businessOffset = dateIndex >= 0 ? 1 : 0;
      if (!projected.slice(businessOffset).some(hasBusinessValue)) continue;
      rows.push(projected);
      dates.push(rowPeriod?.end ?? "");
      rowPeriods.push(rowPeriod);
    }
    if (!rows.length) return [];
    return [{
      name: tableName,
      columns,
      rows,
      dates,
      rowPeriods,
      ...(periodMode ? { periodMode } : {})
    }];
  });
  const dates = [...new Set(tables.flatMap((table) => table.dates).filter((date) => ISO_DATE.test(date)))].sort();
  return {
    scope,
    period: record.period,
    tables,
    periods: {
      week: buildDirectPeriods(tables, "week") || buildWeekPeriods(dates),
      month: buildDirectPeriods(tables, "month") || buildMonthPeriods(dates)
    }
  };
}

export function resolveDmpMarketScope(
  scope: DmpMarketScope | undefined,
  fallbackCategoryId = ""
): DmpMarketScope {
  const categoryId = String(scope?.category_id || fallbackCategoryId).trim();
  const knownPath = KNOWN_CATEGORY_PATHS[categoryId];
  const suppliedPath = (scope?.category_path ?? [])
    .map((part) => String(part ?? "").trim())
    .filter((part) => part && !/^\d+$/.test(part) && !GENERIC_CATEGORY_NAME.test(part));
  const suppliedName = String(scope?.category_name ?? "").trim();
  const path = suppliedPath.length
    ? suppliedPath
    : knownPath?.length
      ? knownPath
      : suppliedName && !/^\d+$/.test(suppliedName) && !GENERIC_CATEGORY_NAME.test(suppliedName)
        ? [suppliedName]
        : ["类目大盘"];
  return {
    category_id: categoryId,
    category_name: path.at(-1) ?? "类目大盘",
    category_path: path
  };
}

export function dmpMarketCategoryLabel(scope: DmpMarketScope | undefined, fallbackCategoryId = "") {
  return resolveDmpMarketScope(scope, fallbackCategoryId).category_path.join("-");
}

export function selectDmpMarketPeriod(
  model: DmpMarketReportViewModel,
  mode: DmpMarketPeriodMode,
  key: string
) {
  const options = model.periods[mode];
  const selected = options.find((option) => option.key === key) ?? options.at(-1) ?? null;
  if (!selected) return { selected: null, tables: model.tables };
  const hasPeriodSpecificTable = model.tables.some((table) => table.periodMode === mode && table.rowPeriods.some(Boolean));
  const tables = model.tables.flatMap((table) => {
    if (table.periodMode && table.periodMode !== mode) return [];
    if (!table.rowPeriods.some(Boolean)) return hasPeriodSpecificTable ? [] : [table];
    const rows: string[][] = [];
    const dates: string[] = [];
    const rowPeriods: Array<{ start: string; end: string } | null> = [];
    table.rows.forEach((row, index) => {
      const rowPeriod = table.rowPeriods[index];
      if (!rowPeriod) return;
      const matches = table.periodMode === mode
        ? rowPeriod.start === selected.start && rowPeriod.end === selected.end
        : rowPeriod.end >= selected.start && rowPeriod.start <= selected.end;
      if (!matches) return;
      rows.push(row);
      dates.push(rowPeriod.end);
      rowPeriods.push(rowPeriod);
    });
    return rows.length ? [{ ...table, rows, dates, rowPeriods }] : [];
  });
  return { selected, tables };
}

export function marketKpiMetrics(tables: DmpMarketViewerTable[]): DmpMarketKpiMetric[] {
  const candidates: Array<DmpMarketKpiMetric & { priority: number; sourceRank: number }> = [];
  for (const table of tables) {
    const labelIndex = table.columns.findIndex((column) => /^(?:指标|业务指标|指标名称|名称)$/.test(column));
    if (labelIndex >= 0) {
      const valueColumns = table.columns
        .map((column, index) => ({ column, index }))
        .filter(({ column, index }) => index !== labelIndex && column !== "日期")
        .sort((left, right) => directValueColumnPriority(right.column) - directValueColumnPriority(left.column));
      for (const row of table.rows) {
        const label = row[labelIndex]?.trim();
        if (!label || ENGINEERING_FIELD.test(label) || REFERENCE_ONLY.test(label)) continue;
        const valueColumn = valueColumns.find(({ column, index }) => parseBusinessNumber(row[index], column) !== null);
        if (!valueColumn) continue;
        const value = parseBusinessNumber(row[valueColumn.index], label);
        if (value === null) continue;
        candidates.push({
          label: businessColumnName(label),
          value,
          percent: /率|占比|环比|同比|贡献/.test(label),
          priority: metricPriority(label),
          sourceRank: 300 + directValueColumnPriority(valueColumn.column)
        });
      }
      continue;
    }

    const datedSeries = table.dates.filter(Boolean).length > 1;
    table.columns.forEach((column, columnIndex) => {
      if (DATE_FIELD.test(column) || ENGINEERING_FIELD.test(column)) return;
      const values = table.rows
        .map((row) => parseBusinessNumber(row[columnIndex], column))
        .filter((value): value is number => value !== null);
      if (!values.length) return;
      candidates.push({
        label: column,
        value: datedSeries ? median(values) : values.at(-1)!,
        percent: /率|占比|环比|同比|贡献/.test(column),
        priority: metricPriority(column),
        sourceRank: table.periodMode ? 400 : datedSeries ? 100 : 200
      });
    });
  }
  const seen = new Set<string>();
  return candidates
    .sort((left, right) => right.sourceRank - left.sourceRank || right.priority - left.priority)
    .filter((metric) => {
      const key = metric.label.replace(/(?:区间|中位数|参考值)/g, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6)
    .map((metric) => ({
      label: metric.label,
      value: metric.value,
      percent: metric.percent
    }));
}

/** 兼容旧调用；业务展示应优先使用 marketKpiMetrics。 */
export function marketMedianMetrics(tables: DmpMarketViewerTable[]) {
  return marketKpiMetrics(tables);
}

export function parseBusinessNumber(value: unknown, semantic = ""): number | null {
  const text = String(value ?? "").trim().replaceAll(",", "");
  if (!text || /^(?:[-–—]|null|undefined)$/i.test(text)) return null;
  const matches = [...text.matchAll(/-?\d+(?:\.\d+)?\s*(亿|万|千)?/g)];
  if (!matches.length) return null;
  const numbers = matches.map((match) => Number(match[0].match(/-?\d+(?:\.\d+)?/)?.[0]) * unitMultiplier(match[1]));
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  const valueAtMidpoint = numbers.length >= 2 ? (numbers[0] + numbers[1]) / 2 : numbers[0];
  if (/%/.test(text)) return valueAtMidpoint;
  if (/率|占比|环比|同比|贡献/.test(semantic) && Math.abs(valueAtMidpoint) <= 1) return valueAtMidpoint * 100;
  return valueAtMidpoint;
}

export function formatMarketMetric(value: number, percent = false) {
  if (percent) return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)}%`;
  if (Math.abs(value) >= 100_000_000) return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value / 100_000_000)}亿`;
  if (Math.abs(value) >= 10_000) return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value / 10_000)}万`;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function buildMonthPeriods(dates: string[]) {
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  return months.map((key) => {
    const [year, month] = key.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      key,
      label: `${year}年${month}月`,
      start: `${key}-01`,
      end: `${key}-${String(lastDay).padStart(2, "0")}`
    };
  });
}

function buildDirectPeriods(tables: DmpMarketViewerTable[], mode: DmpMarketPeriodMode) {
  const byKey = new Map<string, DmpMarketPeriodOption>();
  for (const table of tables) {
    if (table.periodMode !== mode) continue;
    for (const period of table.rowPeriods) {
      if (!period) continue;
      const key = mode === "month" ? period.start.slice(0, 7) : period.start;
      const [year, month] = period.start.split("-").map(Number);
      byKey.set(key, {
        key,
        label: mode === "month" ? `${year}年${month}月` : `${period.start} 至 ${period.end}`,
        start: period.start,
        end: period.end
      });
    }
  }
  const periods = [...byKey.values()].sort((left, right) => left.start.localeCompare(right.start));
  return periods.length ? periods : null;
}

function buildWeekPeriods(dates: string[]) {
  const byKey = new Map<string, DmpMarketPeriodOption>();
  for (const date of dates) {
    const current = new Date(`${date}T00:00:00Z`);
    const day = current.getUTCDay() || 7;
    const start = new Date(current);
    start.setUTCDate(current.getUTCDate() - day + 1);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
    const startText = start.toISOString().slice(0, 10);
    const endText = end.toISOString().slice(0, 10);
    byKey.set(startText, { key: startText, label: `${startText} 至 ${endText}`, start: startText, end: endText });
  }
  return [...byKey.values()].sort((left, right) => left.start.localeCompare(right.start));
}

function parseBusinessPeriod(value: unknown) {
  const text = String(value ?? "").trim();
  if (ISO_DATE.test(text)) return { start: text, end: text };
  const range = text.match(/(\d{4}-\d{2}-\d{2})\s*(?:至|~|～|—|–)\s*(\d{4}-\d{2}-\d{2})/);
  if (range && range[1] <= range[2]) return { start: range[1], end: range[2] };
  const month = text.match(/^(\d{4})[-年](\d{1,2})(?:月)?$/);
  if (!month) return null;
  const year = Number(month[1]);
  const monthNumber = Number(month[2]);
  if (!Number.isInteger(year) || monthNumber < 1 || monthNumber > 12) return null;
  const key = `${year}-${String(monthNumber).padStart(2, "0")}`;
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${key}-01`, end: `${key}-${String(lastDay).padStart(2, "0")}` };
}

function businessTableName(name: string) {
  if (/滚动\s*7\s*天市场数据/.test(name)) return "市场核心指标";
  if (/滚动\s*7\s*日明细/.test(name)) return "市场趋势明细";
  if (/报告总览/.test(name)) return "类目经营概览";
  return businessColumnName(name).replace(/滚动\s*7\s*(?:天|日)/g, "").trim();
}

function businessColumnName(name: string) {
  return name
    .replace(REFERENCE_SUFFIX, "")
    .replace(/滚动\s*7\s*(?:天|日)/g, "")
    .replace(/[（(]\s*[）)]$/, "")
    .trim();
}

function visibleCellValue(value: string | undefined, column: string) {
  const text = String(value ?? "").trim();
  return /^(?:指标|业务指标|指标名称|名称)$/.test(column) ? businessColumnName(text) : text;
}

function hasBusinessValue(value: string) {
  return Boolean(value && !/^(?:[-–—]|null|undefined)$/i.test(value));
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function unitMultiplier(unit: string | undefined) {
  if (unit === "亿") return 100_000_000;
  if (unit === "万") return 10_000;
  if (unit === "千") return 1_000;
  return 1;
}

function metricPriority(label: string) {
  if (/成交金额|GMV/.test(label)) return 100;
  if (/成交|人数|访客|流量/.test(label)) return 80;
  if (/新客|老客|商品|投放|消耗/.test(label)) return 60;
  return 20;
}

function directValueColumnPriority(label: string) {
  if (/^(?:本期值|当前值|业务值|数值|值)$/.test(label)) return 30;
  if (/本期|当前/.test(label)) return 20;
  return 10;
}
