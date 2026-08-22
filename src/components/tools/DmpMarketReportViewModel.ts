import type { DmpBusinessReportRecord, DmpMarketScope } from "@/lib/dmp-report-types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENGINEERING_FIELD = /(?:^|\b)(?:periodType|requestDate|queryRange|analysisRange|purpose|conflict)(?:$|\b)|请求截止日|任务|窗口(?:开始|结束|总数)?|对比(?:开始|结束|窗口)|数据(?:开始|结束)|分析(?:开始|结束)|生成时间|叶子类目\s*ID|类目\s*ID|冲突|缺失/i;
const DATE_FIELD = /^(?:日期|截止日|请求截止日)$/;

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
}

export interface DmpMarketReportViewModel {
  scope: DmpMarketScope;
  period: string;
  tables: DmpMarketViewerTable[];
  periods: Record<DmpMarketPeriodMode, DmpMarketPeriodOption[]>;
}

export interface DmpMarketMedianMetric {
  label: string;
  value: number;
  percent: boolean;
}

export function projectDmpMarketReport(record: DmpBusinessReportRecord): DmpMarketReportViewModel {
  const scope = record.report.market_scope ?? {
    category_id: record.subjectItemId,
    category_name: "类目大盘",
    category_path: ["类目大盘"]
  };
  const tables = record.report.tables.flatMap((table) => {
    if (ENGINEERING_FIELD.test(table.name)) return [];
    const dateIndex = table.columns.findIndex((column) => DATE_FIELD.test(String(column).trim()));
    const kept = table.columns
      .map((column, index) => ({ column: String(column).trim(), index }))
      .filter(({ column, index }) => index !== dateIndex && !ENGINEERING_FIELD.test(column));
    const columns = [...(dateIndex >= 0 ? ["日期"] : []), ...kept.map(({ column }) => column)];
    if (!columns.length) return [];
    const rows: string[][] = [];
    const dates: string[] = [];
    for (const row of table.rows) {
      const source = row.cells.map((cell) => String(cell ?? "").trim());
      const firstBusinessLabel = kept.length ? source[kept[0].index] : "";
      if (ENGINEERING_FIELD.test(firstBusinessLabel)) continue;
      const date = dateIndex >= 0 && ISO_DATE.test(source[dateIndex] ?? "") ? source[dateIndex] : "";
      const projected = [...(dateIndex >= 0 ? [date] : []), ...kept.map(({ index }) => source[index] ?? "")];
      if (!projected.some(hasBusinessValue)) continue;
      rows.push(projected);
      dates.push(date);
    }
    if (!rows.length) return [];
    return [{
      name: businessTableName(table.name),
      columns,
      rows,
      dates
    }];
  });
  const dates = [...new Set(tables.flatMap((table) => table.dates).filter((date) => ISO_DATE.test(date)))].sort();
  return {
    scope,
    period: record.period,
    tables,
    periods: {
      week: buildWeekPeriods(dates),
      month: buildMonthPeriods(dates)
    }
  };
}

export function selectDmpMarketPeriod(
  model: DmpMarketReportViewModel,
  mode: DmpMarketPeriodMode,
  key: string
) {
  const options = model.periods[mode];
  const selected = options.find((option) => option.key === key) ?? options.at(-1) ?? null;
  if (!selected) return { selected: null, tables: model.tables };
  const tables = model.tables.flatMap((table) => {
    if (!table.dates.some(Boolean)) return [table];
    const rows: string[][] = [];
    const dates: string[] = [];
    table.rows.forEach((row, index) => {
      const date = table.dates[index];
      if (!date || date < selected.start || date > selected.end) return;
      rows.push(row);
      dates.push(date);
    });
    return rows.length ? [{ ...table, rows, dates }] : [];
  });
  return { selected, tables };
}

export function marketMedianMetrics(tables: DmpMarketViewerTable[]): DmpMarketMedianMetric[] {
  const candidates: Array<DmpMarketMedianMetric & { priority: number }> = [];
  for (const table of tables) {
    table.columns.forEach((column, columnIndex) => {
      if (column === "日期" || ENGINEERING_FIELD.test(column)) return;
      const values = table.rows
        .map((row) => parseBusinessNumber(row[columnIndex], column))
        .filter((value): value is number => value !== null);
      if (!values.length) return;
      candidates.push({
        label: column,
        value: median(values),
        percent: /率|占比|环比|同比|贡献/.test(column),
        priority: metricPriority(column)
      });
    });
  }
  const seen = new Set<string>();
  return candidates
    .sort((left, right) => right.priority - left.priority)
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

function businessTableName(name: string) {
  if (/滚动\s*7\s*天市场数据/.test(name)) return "市场核心指标";
  if (/报告总览/.test(name)) return "类目经营概览";
  return name;
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
