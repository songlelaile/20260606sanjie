import type { DmpBusinessReportRecord, DmpMarketScope } from "@/lib/dmp-report-types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DMP_MARKET_TIME_ZONE = "Asia/Shanghai" as const;
const ENGINEERING_FIELD = /(?:^|\b)(?:periodType|requestDate|queryRange|analysisRange|purpose|conflict)(?:$|\b)|请求截止日|任务|轮次|工程(?:信息|数据|文件|计算(?:逻辑)?)?|接口(?:名称|地址|状态|数量|证据)?|响应(?:体|状态|数量|结果)|采集(?:时间|状态|进度|数量|失败)|窗口(?:开始|结束|总数)?|对比(?:开始|结束|窗口)|数据(?:开始|结束|证据|说明|完整性提示)|分析(?:开始|结束)|生成时间|叶子类目\s*ID|类目\s*ID|冲突|缺失|计算(?:逻辑|公式)|推导过程|算法口径|完整性(?:门禁|状态|提示)|质量门禁|证据等级|校验状态|错误(?:码|代码)|失败原因|解析失败|待补采|部分数据(?:报告)?|取数时段提示|花费覆盖|细分赛道数据状态/i;
const DATE_FIELD = /^(?:日期|截止日|请求截止日|周期)$/;
const REFERENCE_ONLY = /^(?:(?:自然周|自然月|月度|上月|7\s*日|期间)\s*)?(?:拟合值|参考值|中位(?:数)?)$/i;
const REFERENCE_SUFFIX = /(?:(?:自然周|自然月|月度|上月|7\s*日|期间)\s*)?(?:拟合值|参考值|中位(?:数)?)$/i;
const GENERIC_CATEGORY_NAME = /^(?:类目|类目大盘|叶子类目)$/;
const PERIOD_CONTEXT_TABLE = /^(?:类目周期环比|类目历史周期|细分赛道周期对比(?:-|$)|细分赛道矩阵(?:-|$))/;
const TRACK_COMPARISON_TABLE = /^细分赛道周期对比-(.+)$/;
const TRACK_COMPARISON_COLUMNS = ["属性维度", "属性值", "价格带", "指标"] as const;
const TRACK_LONG_TABLE = /^细分赛道矩阵(?:-(.+))?$/;
const TRACK_LONG_COLUMNS = ["周期", "周期开始", "周期结束", "属性维度", "属性值", "价格带", "指标", "数值"] as const;
const TRACK_COMPACT_COLUMNS = [
  "周期", "周期开始", "周期结束", "属性维度", "属性值", "价格带",
  "搜索潜力", "成交潜力", "拉新潜力", "蓝海指数"
] as const;
const TRACK_OPPORTUNITY_ARCHIVE = /^(货品增长机会概览|货品增长机会|赛道整体与本店|赛道人群|赛道投放结构)(?:-分片\d+)?$/;

const KNOWN_CATEGORY_PATHS: Record<string, string[]> = {
  "50015382": ["大家电", "厨房大电", "油烟机"]
};

export type DmpMarketPeriodMode = "day" | "week" | "month";

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
  selectedTrackPeriod?: { start: string; end: string };
}

export interface DmpMarketReportViewModel {
  scope: DmpMarketScope;
  period: string;
  tables: DmpMarketViewerTable[];
  periods: Record<DmpMarketPeriodMode, DmpMarketPeriodOption[]>;
  capturedPeriod: { start: string; end: string; count: number } | null;
}

export interface DmpMarketKpiMetric {
  label: string;
  value: number;
  percent: boolean;
}

export interface DmpMarketTrackMatrixCell {
  propertyValue: string;
  current: number | null;
  previous: number | null;
  change: number | null;
}

export interface DmpMarketTrackMatrixRow {
  priceBand: string;
  cells: DmpMarketTrackMatrixCell[];
}

export interface DmpMarketTrackMatrixMetric {
  label: string;
  scale: number;
  rows: DmpMarketTrackMatrixRow[];
}

export interface DmpMarketTrackMatrix {
  tableName: string;
  propertyName: string;
  currentLabel: string;
  previousLabel: string;
  propertyValues: string[];
  priceBands: string[];
  metrics: DmpMarketTrackMatrixMetric[];
}

export function projectDmpMarketReport(record: DmpBusinessReportRecord): DmpMarketReportViewModel {
  const scope = resolveDmpMarketScope(record.report.market_scope, record.subjectItemId);
  const availableDays = new Set<string>();
  const sourceTables = mergeDmpMarketOpportunityArchiveFragments(record.report.tables);
  // 新版按属性、按容量分片归档赛道；必须先跨源表合并，再按属性投影。
  // 否则本期与上一周期落在不同分片时，会被误渲染成两个同名模块且上一周期全为“—”。
  const archivedTrackTables = projectDmpMarketTrackArchiveTables(sourceTables);
  archivedTrackTables.forEach((trackTable) => trackTable.rowPeriods.forEach((period) => {
    if (period && period.start === period.end) availableDays.add(period.start);
  }));
  const tables = [
    ...archivedTrackTables,
    ...sourceTables.flatMap((table) => {
    const tableName = businessTableName(table.name);
    if (!tableName || ENGINEERING_FIELD.test(tableName)) return [];
    if (matchesDmpMarketArchivedTrackContract(tableName, table.columns)) return [];
    const trackComparison = matchesDmpMarketTrackContract(tableName, table.columns);
    const dateIndex = table.columns.findIndex((column) => DATE_FIELD.test(String(column).trim()));
    const dateColumn = dateIndex >= 0 && String(table.columns[dateIndex]).trim() === "周期" ? "周期" : "日期";
    const periodMode = /自然日/.test(tableName)
      ? "day" as const
      : /自然周/.test(tableName)
        ? "week" as const
        : /自然月/.test(tableName)
          ? "month" as const
          : undefined;
    if (dateIndex >= 0 && (!periodMode || periodMode === "day")) {
      for (const row of table.rows) {
        const period = parseBusinessPeriod(row.cells[dateIndex]);
        if (period && period.start === period.end) availableDays.add(period.start);
      }
    }
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
        // 赛道上一周期或变化列允许整列缺失；仍要保留完整七列合同，才能明确展示“—”，
        // 而不是把缺失列悄悄删掉后退回普通表格。
        && (trackComparison || table.rows.some((row) => hasBusinessValue(String(row.cells[index] ?? "").trim())))
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
        ...(dateIndex >= 0 ? [rowPeriod ? dateColumn === "日期" && rowPeriod.start === rowPeriod.end ? rowPeriod.start : source[dateIndex] : ""] : []),
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
  })];
  const dates = [...new Set(tables.flatMap((table) => table.dates).filter((date) => ISO_DATE.test(date)))].sort();
  return {
    scope,
    period: record.period,
    tables,
    capturedPeriod: summarizeDmpMarketCapturedPeriods(archivedTrackTables.length ? archivedTrackTables : tables),
    periods: {
      day: buildDayPeriods([...availableDays]),
      week: buildDirectPeriods(tables, "week") || buildWeekPeriods(dates),
      month: buildDirectPeriods(tables, "month") || buildMonthPeriods(dates)
    }
  };
}

function summarizeDmpMarketCapturedPeriods(tables: readonly DmpMarketViewerTable[]) {
  const periods = new Map<string, { start: string; end: string }>();
  for (const table of tables) {
    for (const period of table.rowPeriods) {
      if (!period || !ISO_DATE.test(period.start) || !ISO_DATE.test(period.end)) continue;
      periods.set(trackPeriodIdentity(period), period);
    }
  }
  if (!periods.size) return null;
  const values = [...periods.values()];
  return {
    start: values.reduce((minimum, period) => period.start < minimum ? period.start : minimum, values[0].start),
    end: values.reduce((maximum, period) => period.end > maximum ? period.end : maximum, values[0].end),
    count: values.length
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
    if (isDmpMarketLongTrackTable(table)) {
      const paired = selectDmpMarketLongTrackPeriods(table, selected);
      return paired ? [paired] : [];
    }
    if (table.periodMode && table.periodMode !== mode) return [];
    // v2.3.4 的周期汇总表负责随自然日/周/月切换；赛道矩阵与周期对比则是该份报告的
    // 独立业务上下文，没有逐行日期。不能因为存在周期汇总就把这些模块一并过滤掉。
    if (!table.rowPeriods.some(Boolean)) {
      return hasPeriodSpecificTable && !PERIOD_CONTEXT_TABLE.test(table.name) ? [] : [table];
    }
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
    if (!rows.length) return [];
    const selectedTable = pruneEmptySelectedColumns({ ...table, rows, dates, rowPeriods });
    return selectedTable ? [selectedTable] : [];
  });
  return { selected, tables };
}

/**
 * 赛道矩阵是独立的周/月对比业务周期。它与顶部所选类目周期无交集时，
 * 仍按自身明确起止日期单独展示，但绝不进入所选周期的 KPI 或类目表。
 */
export function dmpMarketIndependentTrackTables(
  model: DmpMarketReportViewModel,
  selectedTables: DmpMarketViewerTable[]
) {
  const selectedNames = new Set(selectedTables.map((table) => table.name));
  return model.tables.filter((table) =>
    isDmpMarketTrackComparisonTable(table) && !selectedNames.has(table.name));
}

export function marketKpiMetrics(tables: DmpMarketViewerTable[]): DmpMarketKpiMetric[] {
  const candidates: Array<DmpMarketKpiMetric & { priority: number; sourceRank: number }> = [];
  for (const table of tables) {
    // 周期对比和价格带属性赛道用于正文对照，不参与顶部 KPI 候选，避免把价格带区间
    // 或 dScore 等赛道分值误识别为类目核心指标。
    if (PERIOD_CONTEXT_TABLE.test(table.name)) continue;
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

/**
 * 同时识别历史七列周期对比宽表，以及新版保留全部采集周期的八列长表。
 * 其它类目表即使碰巧含“价格带”字样，也继续走普通业务表渲染。
 */
export function isDmpMarketTrackComparisonTable(table: DmpMarketViewerTable) {
  return matchesDmpMarketTrackContract(table.name, table.columns) || isDmpMarketLongTrackTable(table);
}

export function dmpMarketTrackPeriodOptions(table: DmpMarketViewerTable): DmpMarketPeriodOption[] {
  if (!isDmpMarketLongTrackTable(table)) return [];
  return uniqueTrackPeriods(table).map((period) => ({
    key: dmpMarketTrackPeriodKey(period),
    label: trackPeriodLabel(period),
    start: period.start,
    end: period.end
  }));
}

export function selectDmpMarketTrackPeriod(table: DmpMarketViewerTable, key: string): DmpMarketViewerTable {
  const selected = uniqueTrackPeriods(table).find((period) => dmpMarketTrackPeriodKey(period) === key);
  return selected ? { ...table, selectedTrackPeriod: selected } : table;
}

export function buildDmpMarketTrackMatrix(table: DmpMarketViewerTable): DmpMarketTrackMatrix | null {
  if (isDmpMarketLongTrackTable(table)) return buildDmpMarketLongTrackMatrix(table);
  if (!matchesDmpMarketTrackContract(table.name, table.columns)) return null;
  const tableMatch = table.name.match(TRACK_COMPARISON_TABLE);
  const records: DmpMarketTrackRecord[] = [];
  const seenCoordinates = new Set<string>();
  let propertyName = "";

  for (const row of table.rows) {
    if (row.length < 7) return null;
    const rowPropertyName = String(row[0] ?? "").trim();
    const propertyValue = String(row[1] ?? "").trim();
    const priceBand = normalizeDmpMarketPriceBand(row[2]);
    const metric = String(row[3] ?? "").trim();
    if (!rowPropertyName || !propertyValue || !priceBand || !metric) return null;
    if (propertyName && rowPropertyName !== propertyName) return null;
    propertyName = rowPropertyName;
    const coordinate = [metric, priceBand, propertyValue].join("\u001f");
    if (seenCoordinates.has(coordinate)) return null;
    seenCoordinates.add(coordinate);
    records.push({
      propertyName: rowPropertyName,
      propertyValue,
      priceBand,
      metric,
      current: parseDmpMarketTrackScore(row[4]),
      previous: parseDmpMarketTrackScore(row[5])
    });
  }
  return assembleDmpMarketTrackMatrix(records, {
    tableName: table.name,
    propertyName: propertyName || String(tableMatch?.[1] ?? "").trim(),
    currentLabel: table.columns[4],
    previousLabel: table.columns[5]
  });
}

interface DmpMarketTrackRecord {
  propertyName: string;
  propertyValue: string;
  priceBand: string;
  metric: string;
  current: number | null;
  previous: number | null;
}

function buildDmpMarketLongTrackMatrix(table: DmpMarketViewerTable): DmpMarketTrackMatrix | null {
  const periodIndex = table.columns.indexOf("周期");
  const propertyNameIndex = table.columns.indexOf("属性维度");
  const propertyValueIndex = table.columns.indexOf("属性值");
  const priceBandIndex = table.columns.indexOf("价格带");
  const metricIndex = table.columns.indexOf("指标");
  const valueIndex = table.columns.indexOf("数值");
  if ([periodIndex, propertyNameIndex, propertyValueIndex, priceBandIndex, metricIndex, valueIndex].some((index) => index < 0)) {
    return null;
  }

  const periods = uniqueTrackPeriods(table);
  const currentPeriod = table.selectedTrackPeriod
    ? periods.find((period) => trackPeriodIdentity(period) === trackPeriodIdentity(table.selectedTrackPeriod!)) ?? null
    : periods[0] ?? null;
  const previousPeriod = currentPeriod ? previousDmpMarketTrackPeriod(periods, currentPeriod) : null;
  if (!currentPeriod) return null;
  const currentKey = trackPeriodIdentity(currentPeriod);
  const previousKey = previousPeriod ? trackPeriodIdentity(previousPeriod) : "";
  const byCoordinate = new Map<string, DmpMarketTrackRecord>();
  let propertyName = "";
  let currentLabel = trackPeriodLabel(currentPeriod);
  let previousLabel = previousPeriod ? trackPeriodLabel(previousPeriod) : "—";

  table.rows.forEach((row, rowIndex) => {
    const period = table.rowPeriods[rowIndex] ?? parseBusinessPeriod(row[periodIndex]);
    if (!period) return;
    const periodKey = trackPeriodIdentity(period);
    if (periodKey !== currentKey && periodKey !== previousKey) return;
    const rowPropertyName = String(row[propertyNameIndex] ?? "").trim();
    const propertyValue = String(row[propertyValueIndex] ?? "").trim();
    const priceBand = normalizeDmpMarketPriceBand(row[priceBandIndex]);
    const metric = String(row[metricIndex] ?? "").trim();
    if (!rowPropertyName || !propertyValue || !priceBand || !metric) return;
    if (propertyName && propertyName !== rowPropertyName) return;
    propertyName = rowPropertyName;
    const coordinate = [metric, priceBand, propertyValue].join("\u001f");
    const record = byCoordinate.get(coordinate) ?? {
      propertyName: rowPropertyName,
      propertyValue,
      priceBand,
      metric,
      current: null,
      previous: null
    };
    const value = parseDmpMarketTrackScore(row[valueIndex]);
    if (periodKey === currentKey) {
      record.current = value;
      currentLabel = String(row[periodIndex] ?? "").trim() || currentLabel;
    } else {
      record.previous = value;
      previousLabel = String(row[periodIndex] ?? "").trim() || previousLabel;
    }
    byCoordinate.set(coordinate, record);
  });

  return assembleDmpMarketTrackMatrix([...byCoordinate.values()], {
    tableName: table.name,
    propertyName: propertyName || String(table.name.match(TRACK_LONG_TABLE)?.[1] ?? "").trim(),
    currentLabel,
    previousLabel
  });
}

function assembleDmpMarketTrackMatrix(
  records: DmpMarketTrackRecord[],
  context: Pick<DmpMarketTrackMatrix, "tableName" | "propertyName" | "currentLabel" | "previousLabel">
): DmpMarketTrackMatrix | null {
  const propertyValues: string[] = [];
  const priceBands: string[] = [];
  const metricLabels: string[] = [];
  for (const record of records) {
    if (!propertyValues.includes(record.propertyValue)) propertyValues.push(record.propertyValue);
    if (!priceBands.includes(record.priceBand)) priceBands.push(record.priceBand);
    if (!metricLabels.includes(record.metric)) metricLabels.push(record.metric);
  }
  if (!records.length || !context.propertyName || !propertyValues.length || !priceBands.length || !metricLabels.length) return null;

  const metrics = [...metricLabels]
    .sort((left, right) => trackMetricPriority(left) - trackMetricPriority(right))
    .map((label) => {
      const metricRecords = records.filter((record) => record.metric === label);
      const byCoordinate = new Map(metricRecords.map((record) => [
        [record.priceBand, record.propertyValue].join("\u001f"),
        record
      ]));
      const values = metricRecords.flatMap((record) => [record.current, record.previous])
        .filter((value): value is number => value !== null);
      const scale = Math.max(0, ...values.map((value) => Math.abs(value)));
      return {
        label,
        scale,
        rows: priceBands.map((priceBand) => ({
          priceBand,
          cells: propertyValues.map((propertyValue) => {
            const record = byCoordinate.get([priceBand, propertyValue].join("\u001f"));
            const current = record?.current ?? null;
            const previous = record?.previous ?? null;
            return {
              propertyValue,
              current,
              previous,
              change: current !== null && previous !== null ? normalizedTrackScore(current - previous) : null
            };
          })
        }))
      };
    });

  return { ...context, propertyValues, priceBands, metrics };
}

export function formatDmpMarketTrackScore(value: number | null, signed = false) {
  if (value === null || !Number.isFinite(value)) return "—";
  const normalized = normalizedTrackScore(value);
  const text = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 4,
    useGrouping: false
  }).format(normalized);
  return signed && normalized > 0 ? `+${text}` : text;
}

export function dmpMarketTrackHeatOpacity(value: number | null, scale: number) {
  if (value === null || value === 0 || !Number.isFinite(value) || !Number.isFinite(scale) || scale <= 0) return 0;
  const intensity = Math.max(0, Math.min(1, Math.abs(value) / scale));
  return Number((0.08 + intensity * 0.34).toFixed(3));
}

export function normalizeDmpMarketPriceBand(value: unknown) {
  const text = String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const alreadyAbove = text.match(/^(?:>=|≥|>)\s*(.+)$/);
  if (alreadyAbove) return `≥${alreadyAbove[1].trim()}`;
  const alreadyBelow = text.match(/^(?:<=|≤|<)\s*(.+)$/);
  if (alreadyBelow) return `≤${alreadyBelow[1].trim()}`;
  const above = text.match(/^(.+?)(?:及)?以上$/) || text.match(/^(.+?)\+$/);
  if (above) return `≥${above[1].trim()}`;
  const below = text.match(/^(.+?)(?:及)?以下$/);
  if (below) return `≤${below[1].trim()}`;
  return text.replace(/\s*(?:~|～|至)\s*/g, "~");
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

function buildDayPeriods(dates: string[]) {
  return [...new Set(dates.filter((date) => ISO_DATE.test(date)))]
    .sort()
    .map((date) => ({ key: date, label: date, start: date, end: date }));
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
        label: mode === "month" ? `${year}年${month}月` : mode === "day" ? period.start : `${period.start} 至 ${period.end}`,
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
  const exactDate = ISO_DATE.test(text) || /^\d{4}-\d{2}-\d{2}T/.test(text) ? shanghaiDateKey(text) : "";
  if (exactDate) {
    return { start: exactDate, end: exactDate };
  }
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

export function shanghaiDateKey(value: unknown) {
  const text = String(value ?? "").trim();
  if (ISO_DATE.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : "";
  }
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)
    ? `${text}+08:00`
    : text;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: DMP_MARKET_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(parsed);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : "";
  } catch {
    return new Date(parsed.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
}

function pruneEmptySelectedColumns(table: DmpMarketViewerTable): DmpMarketViewerTable | null {
  const dateIndex = table.columns.findIndex((column) => DATE_FIELD.test(column));
  const keptIndices = table.columns
    .map((_, index) => index)
    .filter((index) => index === dateIndex || table.rows.some((row) => hasBusinessValue(row[index] ?? "")));
  if (!keptIndices.some((index) => index !== dateIndex)) return null;
  return {
    ...table,
    columns: keptIndices.map((index) => table.columns[index]),
    rows: table.rows.map((row) => keptIndices.map((index) => row[index] ?? ""))
  };
}

function mergeDmpMarketOpportunityArchiveFragments(
  tables: readonly {
    name: string;
    columns: readonly unknown[];
    rows: readonly { cells: readonly unknown[] }[];
  }[]
) {
  const merged = new Map<string, {
    table: { name: string; columns: unknown[]; rows: Array<{ cells: readonly unknown[] }> };
    signature: string;
  }>();
  const output: Array<{
    name: string;
    columns: readonly unknown[];
    rows: readonly { cells: readonly unknown[] }[];
  }> = [];

  for (const table of tables) {
    const name = businessTableName(table.name);
    const baseName = name.match(TRACK_OPPORTUNITY_ARCHIVE)?.[1] ?? "";
    if (!baseName) {
      output.push(table);
      continue;
    }
    const signature = JSON.stringify(table.columns.map((column) => String(column ?? "").trim()));
    const existing = merged.get(baseName);
    if (existing && existing.signature !== signature) {
      // 未知旧合同不强行拼接，避免列错位；仍按原表进入通用渲染。
      output.push(table);
      continue;
    }
    const group = existing ?? {
      table: { name: baseName, columns: [...table.columns], rows: [] },
      signature
    };
    if (!existing) {
      merged.set(baseName, group);
      output.push(group.table);
    }
    for (const row of table.rows) {
      // 分片以“周期×赛道”为原子且互斥；展示字段不含 trackId，两个不同赛道可能
      // 恰好拥有相同 cells。必须按分片顺序守恒拼接，不能按可见文本去重。
      group.table.rows.push(row);
    }
  }
  return output;
}

function projectDmpMarketTrackArchiveTables(
  tables: readonly {
    name: unknown;
    columns: readonly unknown[];
    rows: readonly { cells: readonly unknown[] }[];
  }[]
): DmpMarketViewerTable[] {
  type TrackRowRecord = { row: string[]; period: { start: string; end: string }; conflict: boolean };
  type TrackPropertyGroup = { stem: string; propertyName: string; records: Map<string, TrackRowRecord> };
  const groups = new Map<string, TrackPropertyGroup>();

  for (const table of tables) {
    const tableName = businessTableName(String(table.name ?? ""));
    const contract = dmpMarketArchivedTrackContract(tableName, table.columns);
    if (!contract) continue;
    const stem = dmpMarketArchivedTrackStem(tableName);
    for (const sourceRow of table.rows) {
      const source = table.columns.map((_, index) => String(sourceRow.cells[index] ?? "").trim());
      const period = parseBusinessPeriod(source[0]) ?? parseBusinessPeriod(`${source[1]} 至 ${source[2]}`);
      const propertyName = source[3];
      const propertyValue = source[4];
      const priceBand = normalizeDmpMarketPriceBand(source[5]);
      if (!period || !propertyName || !propertyValue || !priceBand) continue;
      const groupIdentity = `${stem || "旧版统一表"}\u001f${propertyName}`;
      const group = groups.get(groupIdentity) ?? { stem, propertyName, records: new Map() };
      const metricValues = contract === "compact"
        ? TRACK_COMPACT_COLUMNS.slice(6).map((metric, offset) => [metric, source[offset + 6]] as const)
        : [[source[6], source[7]] as const];
      for (const [metric, value] of metricValues) {
        if (!metric) continue;
        const coordinate = [period.start, period.end, propertyValue, priceBand, metric].join("\u001f");
        const row = [
          source[0] || trackPeriodLabel(period),
          source[1] || period.start,
          source[2] || period.end,
          propertyName,
          propertyValue,
          priceBand,
          metric,
          value
        ];
        const existing = group.records.get(coordinate);
        if (!existing) {
          group.records.set(coordinate, { row, period, conflict: false });
          continue;
        }
        const existingValue = parseDmpMarketTrackScore(existing.row[7]);
        const nextValue = parseDmpMarketTrackScore(value);
        if (existing.conflict || (existingValue !== null && nextValue !== null && existingValue !== nextValue)) {
          existing.row[7] = "";
          existing.conflict = true;
        } else if (existingValue === null && nextValue !== null) {
          existing.row = row;
        }
      }
      groups.set(groupIdentity, group);
    }
  }

  return [...groups.values()].flatMap((group) => {
    const records = [...group.records.values()];
    if (!records.length) return [];
    const namePart = (group.stem || group.propertyName).slice(0, 120);
    return [{
      name: `细分赛道矩阵-${namePart}`,
      columns: [...TRACK_LONG_COLUMNS],
      rows: records.map((record) => record.row),
      dates: records.map((record) => record.period.end),
      rowPeriods: records.map((record) => record.period)
    }];
  });
}

function dmpMarketArchivedTrackContract(name: string, columns: readonly unknown[]): "long" | "compact" | null {
  if (!TRACK_LONG_TABLE.test(String(name).trim())) return null;
  const normalized = columns.map((column) => String(column ?? "").trim());
  if (normalized.length === TRACK_LONG_COLUMNS.length
    && TRACK_LONG_COLUMNS.every((column, index) => normalized[index] === column)) return "long";
  if (normalized.length === TRACK_COMPACT_COLUMNS.length
    && TRACK_COMPACT_COLUMNS.every((column, index) => normalized[index] === column)) return "compact";
  return null;
}

function matchesDmpMarketArchivedTrackContract(name: string, columns: readonly unknown[]) {
  return dmpMarketArchivedTrackContract(name, columns) !== null;
}

function dmpMarketArchivedTrackStem(name: string) {
  const suffix = String(name).trim().match(TRACK_LONG_TABLE)?.[1]?.trim() ?? "";
  return suffix.replace(/-分片\d+$/i, "").trim();
}

function isDmpMarketLongTrackTable(table: DmpMarketViewerTable) {
  return matchesDmpMarketLongTrackContract(table.name, table.columns);
}

function matchesDmpMarketLongTrackContract(name: string, columns: readonly unknown[]) {
  if (!TRACK_LONG_TABLE.test(String(name).trim()) || columns.length !== TRACK_LONG_COLUMNS.length) return false;
  return TRACK_LONG_COLUMNS.every((column, index) => String(columns[index] ?? "").trim() === column);
}

function selectDmpMarketLongTrackPeriods(
  table: DmpMarketViewerTable,
  selected: DmpMarketPeriodOption
): DmpMarketViewerTable | null {
  const periods = uniqueTrackPeriods(table);
  if (!periods.length) return null;
  const exact = periods.find((period) => period.start === selected.start && period.end === selected.end);
  const containsSelectedEnd = periods.find((period) => period.start <= selected.end && period.end >= selected.end);
  const endingInSelection = periods.find((period) => period.end >= selected.start && period.end <= selected.end);
  const overlapping = periods.find((period) => period.end >= selected.start && period.start <= selected.end);
  // 赛道周期可以是采集到的固定窗口（例如 30 天），不一定与自然月边界完全一致；
  // 但必须与用户选择的周期真实相交。没有交集时宁可不展示，也不能回退到最新周期造成串月。
  const current = exact ?? containsSelectedEnd ?? endingInSelection ?? overlapping ?? null;
  if (!current) return null;
  // 保留该属性的全部已采周期，供报告内“赛道周期”下拉自选；这里只设置全局
  // 自然周期对应的默认值。矩阵构建时再严格配对其紧邻上一周期。
  return { ...table, selectedTrackPeriod: current };
}

function uniqueTrackPeriods(table: DmpMarketViewerTable) {
  const byPeriod = new Map<string, { start: string; end: string }>();
  table.rows.forEach((row, index) => {
    const period = table.rowPeriods[index] ?? parseBusinessPeriod(row[0]);
    if (period) byPeriod.set(trackPeriodIdentity(period), period);
  });
  return [...byPeriod.values()].sort((left, right) => (
    right.end.localeCompare(left.end) || right.start.localeCompare(left.start)
  ));
}

function trackPeriodIdentity(period: { start: string; end: string }) {
  return `${period.start}\u001f${period.end}`;
}

function dmpMarketTrackPeriodKey(period: { start: string; end: string }) {
  return `${period.start}__${period.end}`;
}

function trackPeriodLabel(period: { start: string; end: string }) {
  return period.start === period.end ? period.start : `${period.start} 至 ${period.end}`;
}

function trackPeriodDuration(period: { start: string; end: string }) {
  const start = Date.parse(`${period.start}T00:00:00Z`);
  const end = Date.parse(`${period.end}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 86_400_000) + 1 : 0;
}

function previousDmpMarketTrackPeriod(
  periods: readonly { start: string; end: string }[],
  current: { start: string; end: string }
) {
  const currentDuration = trackPeriodDuration(current);
  const adjacentEnd = shiftIsoDate(current.start, -1);
  return periods.find((period) => (
    period.end === adjacentEnd
    && (
      trackPeriodDuration(period) === currentDuration
      || (isFullCalendarMonth(period) && isFullCalendarMonth(current))
    )
  )) ?? null;
}

function isFullCalendarMonth(period: { start: string; end: string }) {
  if (!ISO_DATE.test(period.start) || !ISO_DATE.test(period.end) || !period.start.endsWith("-01")) return false;
  const nextMonthStart = new Date(`${period.start}T00:00:00Z`);
  if (!Number.isFinite(nextMonthStart.getTime())) return false;
  nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1);
  const expectedEnd = new Date(nextMonthStart.getTime() - 86_400_000).toISOString().slice(0, 10);
  return period.end === expectedEnd;
}

function shiftIsoDate(date: string, days: number) {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp + days * 86_400_000).toISOString().slice(0, 10) : "";
}

function businessTableName(name: string) {
  if (/滚动\s*7\s*天市场数据/.test(name)) return "市场核心指标";
  if (/滚动\s*7\s*日明细/.test(name)) return "市场趋势明细";
  if (/报告总览/.test(name)) return "类目经营概览";
  return businessColumnName(name).replace(/滚动\s*7\s*(?:天|日)/g, "").trim();
}

function matchesDmpMarketTrackContract(name: string, columns: readonly unknown[]) {
  if (!TRACK_COMPARISON_TABLE.test(String(name).trim()) || columns.length !== 7) return false;
  const normalized = columns.map((column) => String(column ?? "").trim());
  return TRACK_COMPARISON_COLUMNS.every((column, index) => normalized[index] === column)
    && Boolean(normalized[4])
    && Boolean(normalized[5])
    && normalized[6] === "变化值";
}

function parseDmpMarketTrackScore(value: unknown) {
  const text = String(value ?? "").normalize("NFKC").replaceAll(",", "").trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? normalizedTrackScore(numeric) : null;
}

function normalizedTrackScore(value: number) {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function trackMetricPriority(label: string) {
  if (/dScore|增长潜力/i.test(label)) return 0;
  if (/aScore|搜索潜力/i.test(label)) return 1;
  if (/bScore|成交潜力/i.test(label)) return 2;
  if (/cScore|拉新潜力/i.test(label)) return 3;
  if (/eScore|蓝海/i.test(label)) return 4;
  return 10;
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
