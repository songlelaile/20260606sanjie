import type { DmpBusinessReportRecord, DmpMarketScope } from "@/lib/dmp-report-types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const DMP_MARKET_TIME_ZONE = "Asia/Shanghai" as const;
const ENGINEERING_FIELD = /(?:^|\b)(?:periodType|requestDate|queryRange|analysisRange|purpose|conflict)(?:$|\b)|请求截止日|任务|轮次|工程(?:信息|数据|文件)?|接口(?:名称|地址|状态|数量)?|响应(?:体|状态|数量|结果)|采集(?:时间|状态|进度|数量)|窗口(?:开始|结束|总数)?|对比(?:开始|结束|窗口)|数据(?:开始|结束)|分析(?:开始|结束)|生成时间|叶子类目\s*ID|类目\s*ID|冲突|缺失/i;
const DATE_FIELD = /^(?:日期|截止日|请求截止日|周期)$/;
const REFERENCE_ONLY = /^(?:(?:自然周|自然月|月度|上月|7\s*日|期间)\s*)?(?:拟合值|参考值|中位(?:数)?)$/i;
const REFERENCE_SUFFIX = /(?:(?:自然周|自然月|月度|上月|7\s*日|期间)\s*)?(?:拟合值|参考值|中位(?:数)?)$/i;
const GENERIC_CATEGORY_NAME = /^(?:类目|类目大盘|叶子类目)$/;
const PERIOD_CONTEXT_TABLE = /^(?:类目周期环比|类目历史周期|细分赛道矩阵$|细分赛道周期对比(?:-|$)|货品增长机会概览$|货品增长机会(?:-|$)|赛道整体与本店(?:-|$)|赛道人群(?:-|$)|赛道投放结构(?:-|$))/;
const GROWTH_OPPORTUNITY_TABLE = /^货品增长机会(?:-|$)/;
const TRACK_COMPARISON_TABLE = /^细分赛道周期对比-(.+)$/;
const TRACK_COMPARISON_COLUMNS = ["属性维度", "属性值", "价格带", "指标"] as const;
const LONG_OPPORTUNITY_TABLES = new Set([
  "细分赛道矩阵",
  "货品增长机会概览",
  "货品增长机会",
  "赛道整体与本店",
  "赛道人群",
  "赛道投放结构"
]);

const KNOWN_CATEGORY_PATHS: Record<string, string[]> = {
  "50015382": ["大家电", "厨房大电", "油烟机"]
};

export type DmpMarketPeriodMode = "all" | "day" | "week" | "month";

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
  allCollected: {
    table: DmpMarketViewerTable | null;
    periodCount: number;
    start: string;
    end: string;
  } | null;
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

export interface DmpMarketGrowthOpportunityTrack {
  trackName: string;
  propertyName: string;
  propertyValue: string;
  priceBand: string;
  score: string;
  shopRank: string;
  collected: string;
}

export interface DmpMarketGrowthOpportunityGroup {
  title: string;
  tag: string;
  description: string;
  tracks: DmpMarketGrowthOpportunityTrack[];
}

export interface DmpMarketOpportunityPeriod {
  key: string;
  label: string;
  start: string;
  end: string;
}

export interface DmpMarketOpportunityOverallRow {
  metric: string;
  trackValue: string;
  shopValue: string;
}

export interface DmpMarketOpportunityCrowdRow {
  dimension: string;
  feature: string;
  value: string;
}

export interface DmpMarketOpportunityPromotionRow {
  scope: string;
  scene: string;
  spendShare: string;
  clicks: string;
  clicksChange: string;
  clickRate: string;
  clickRateChange: string;
  conversionRate: string;
  conversionRateChange: string;
  roi: string;
  roiChange: string;
}

export interface DmpMarketOpportunityWorkspaceTrack extends DmpMarketGrowthOpportunityTrack {
  overall: DmpMarketOpportunityOverallRow[];
  crowds: DmpMarketOpportunityCrowdRow[];
  promotions: DmpMarketOpportunityPromotionRow[];
}

export interface DmpMarketOpportunityWorkspaceGroup {
  periodKey: string;
  propertyName: string;
  title: string;
  tag: string;
  description: string;
  declaredTrackCount: number | null;
  tracks: DmpMarketOpportunityWorkspaceTrack[];
}

export interface DmpMarketOpportunityMatrixRecord {
  periodKey: string;
  propertyName: string;
  propertyValue: string;
  priceBand: string;
  metric: string;
  value: number | null;
}

export interface DmpMarketOpportunityWorkspace {
  sourceTableNames: string[];
  periods: DmpMarketOpportunityPeriod[];
  propertyNames: string[];
  metricLabels: string[];
  matrixRecords: DmpMarketOpportunityMatrixRecord[];
  groups: DmpMarketOpportunityWorkspaceGroup[];
}

export function projectDmpMarketReport(record: DmpBusinessReportRecord): DmpMarketReportViewModel {
  const scope = resolveDmpMarketScope(record.report.market_scope, record.subjectItemId);
  const availableDays = new Set<string>();
  const tables = record.report.tables.flatMap((table) => {
    const tableName = businessTableName(table.name);
    if (!tableName || ENGINEERING_FIELD.test(tableName)) return [];
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
  });
  const dates = [...new Set(tables.flatMap((table) => table.dates).filter((date) => ISO_DATE.test(date)))].sort();
  const allCollected = mergeCollectedCoverage(
    buildAllCollectedPeriodTable(tables),
    buildCollectedCoverageOnly(tables)
  );
  return {
    scope,
    period: record.period,
    tables,
    periods: {
      all: allCollected ? [{
        key: "actual-collected",
        label: allCollected.start === allCollected.end ? allCollected.start : `${allCollected.start} 至 ${allCollected.end}`,
        start: allCollected.start,
        end: allCollected.end
      }] : [],
      day: buildDayPeriods([...availableDays]),
      week: buildDirectPeriods(tables, "week") || buildWeekPeriods(dates),
      month: buildDirectPeriods(tables, "month") || buildMonthPeriods(dates)
    },
    allCollected
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
  if (mode === "all") {
    const contextTables = model.tables.filter((table) => (
      isDmpMarketOpportunityWorkspaceSource(table)
      || (!table.rowPeriods.some(Boolean) && PERIOD_CONTEXT_TABLE.test(table.name))
    ));
    return {
      selected,
      tables: model.allCollected?.table ? [model.allCollected.table, ...contextTables] : contextTables
    };
  }
  const hasPeriodSpecificTable = model.tables.some((table) => table.periodMode === mode && table.rowPeriods.some(Boolean));
  const tables = model.tables.flatMap((table) => {
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
      const matches = table.periodMode === mode || isDmpMarketOpportunityWorkspaceSource(table)
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
 * 将实际成功落表的最细周期转置为“指标为行、周期为列”。这里不会根据 report.period
 * 或请求窗口补日期；整行均缺失的周期也不会进入覆盖范围，显式 0 则作为有效值保留。
 */
export function buildAllCollectedPeriodTable(tables: DmpMarketViewerTable[]) {
  const eligibleTables = tables.filter((table) => (
    !isDmpMarketOpportunityWorkspaceSource(table) && !PERIOD_CONTEXT_TABLE.test(table.name)
  ));
  const preferredMode = (["day", "week", "month"] as const).find((mode) => (
    eligibleTables.some((table) => table.periodMode === mode && table.rowPeriods.some(Boolean))
  ));
  const sources = eligibleTables.filter((table) => (
    preferredMode ? table.periodMode === preferredMode : table.rowPeriods.some(Boolean)
  ));
  if (!sources.length) return null;

  const periodOrder: string[] = [];
  const periodMeta = new Map<string, { start: string; end: string; label: string }>();
  const valuesByPeriod = new Map<string, Map<string, string>>();
  const metrics: string[] = [];

  for (const table of sources) {
    const dateIndex = table.columns.findIndex((column) => DATE_FIELD.test(column));
    if (dateIndex < 0) continue;
    table.rows.forEach((row, rowIndex) => {
      const period = table.rowPeriods[rowIndex];
      if (!period) return;
      const cells = table.columns
        .map((column, columnIndex) => ({ column, columnIndex, value: String(row[columnIndex] ?? "").trim() }))
        .filter(({ columnIndex }) => columnIndex !== dateIndex);
      if (!cells.some(({ value }) => hasBusinessValue(value))) return;
      const periodKey = `${period.start}\u001f${period.end}`;
      if (!periodMeta.has(periodKey)) {
        periodOrder.push(periodKey);
        periodMeta.set(periodKey, {
          ...period,
          label: period.start === period.end ? period.start : `${period.start} 至 ${period.end}`
        });
        valuesByPeriod.set(periodKey, new Map());
      }
      const values = valuesByPeriod.get(periodKey)!;
      for (const { column, value } of cells) {
        if (!metrics.includes(column)) metrics.push(column);
        const previous = values.get(column) ?? "";
        if (!hasBusinessValue(previous) && hasBusinessValue(value)) values.set(column, value);
      }
    });
  }

  periodOrder.sort((left, right) => {
    const leftPeriod = periodMeta.get(left)!;
    const rightPeriod = periodMeta.get(right)!;
    return leftPeriod.start.localeCompare(rightPeriod.start) || leftPeriod.end.localeCompare(rightPeriod.end);
  });
  if (!periodOrder.length || !metrics.length) return null;
  const periods = periodOrder.map((key) => periodMeta.get(key)!);
  const rows = metrics.map((metric) => [
    metric,
    ...periodOrder.map((periodKey) => valuesByPeriod.get(periodKey)?.get(metric) ?? "—")
  ]);
  return {
    table: {
      name: "全部已采周期",
      columns: ["指标", ...periods.map((period) => period.label)],
      rows,
      dates: [],
      rowPeriods: rows.map(() => null)
    },
    periodCount: periods.length,
    start: periods[0].start,
    end: periods.reduce((latest, period) => period.end > latest ? period.end : latest, periods[0].end),
    coveragePeriods: periods.map(({ start, end }) => ({ start, end }))
  };
}

function buildCollectedCoverageOnly(tables: DmpMarketViewerTable[]) {
  const periods = new Map<string, { start: string; end: string }>();
  for (const table of tables) {
    if (!isDmpMarketOpportunityWorkspaceSource(table)) continue;
    const dateIndex = table.columns.findIndex((column) => DATE_FIELD.test(column));
    table.rows.forEach((row, rowIndex) => {
      const period = table.rowPeriods[rowIndex];
      if (!period) return;
      const hasValue = row.some((value, columnIndex) => columnIndex !== dateIndex && hasBusinessValue(value));
      if (!hasValue) return;
      periods.set(`${period.start}\u001f${period.end}`, period);
    });
  }
  const ordered = [...periods.values()].sort((left, right) => (
    left.start.localeCompare(right.start) || left.end.localeCompare(right.end)
  ));
  if (!ordered.length) return null;
  return {
    table: null,
    periodCount: ordered.length,
    start: ordered[0].start,
    end: ordered.reduce((latest, period) => period.end > latest ? period.end : latest, ordered[0].end),
    coveragePeriods: ordered
  };
}

function mergeCollectedCoverage(
  primary: ReturnType<typeof buildAllCollectedPeriodTable>,
  secondary: ReturnType<typeof buildCollectedCoverageOnly>
) {
  if (!primary && !secondary) return null;
  const periodMap = new Map<string, { start: string; end: string }>();
  for (const period of [...(primary?.coveragePeriods ?? []), ...(secondary?.coveragePeriods ?? [])]) {
    periodMap.set(`${period.start}\u001f${period.end}`, period);
  }
  const periods = [...periodMap.values()].sort((left, right) => (
    left.start.localeCompare(right.start) || left.end.localeCompare(right.end)
  ));
  return {
    table: primary?.table ?? secondary?.table ?? null,
    periodCount: periods.length,
    start: periods[0].start,
    end: periods.reduce((latest, period) => period.end > latest ? period.end : latest, periods[0].end)
  };
}

export function isDmpMarketOpportunityWorkspaceSource(table: Pick<DmpMarketViewerTable, "name">) {
  return LONG_OPPORTUNITY_TABLES.has(String(table.name).trim());
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
        .sort((left, right) => table.name === "全部已采周期"
          ? right.index - left.index
          : directValueColumnPriority(right.column) - directValueColumnPriority(left.column));
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
 * 仅识别 v2.3.4 输出的“细分赛道周期对比-*”七列纯数据合同。
 * 其它类目表即使碰巧含“价格带”字样，也继续走普通业务表渲染。
 */
export function isDmpMarketTrackComparisonTable(table: DmpMarketViewerTable) {
  return matchesDmpMarketTrackContract(table.name, table.columns);
}

/**
 * 消费 v2.3.9 起的六张固定长表。周期、属性和机会类型全部来自数据行；函数只做
 * 结构合并，不跨周期回填，也不会因为概览声明 0 条赛道而删除该机会组。
 */
export function buildDmpMarketOpportunityWorkspace(tables: DmpMarketViewerTable[]): DmpMarketOpportunityWorkspace | null {
  const sources = tables.filter(isDmpMarketOpportunityWorkspaceSource);
  if (!sources.length) return null;
  const periods = new Map<string, DmpMarketOpportunityPeriod>();
  const propertyNames: string[] = [];
  const rawMetricLabels: string[] = [];
  const matrixByKey = new Map<string, DmpMarketOpportunityMatrixRecord>();
  const groupsByKey = new Map<string, DmpMarketOpportunityWorkspaceGroup>();

  const rememberProperty = (value: string) => {
    if (hasBusinessValue(value) && !propertyNames.includes(value)) propertyNames.push(value);
  };
  const periodForRow = (table: DmpMarketViewerTable, row: string[], rowIndex: number) => {
    const direct = table.rowPeriods[rowIndex];
    const periodIndex = table.columns.indexOf("周期");
    const parsed = direct ?? (periodIndex >= 0 ? parseBusinessPeriod(row[periodIndex]) : null);
    if (!parsed) return null;
    const key = `${parsed.start}\u001f${parsed.end}`;
    if (!periods.has(key)) {
      const suppliedLabel = periodIndex >= 0 ? String(row[periodIndex] ?? "").trim() : "";
      periods.set(key, {
        key,
        label: hasBusinessValue(suppliedLabel)
          ? suppliedLabel
          : parsed.start === parsed.end ? parsed.start : `${parsed.start} 至 ${parsed.end}`,
        start: parsed.start,
        end: parsed.end
      });
    }
    return periods.get(key)!;
  };
  const valueAt = (table: DmpMarketViewerTable, row: string[], column: string) => {
    const index = table.columns.indexOf(column);
    return index >= 0 ? String(row[index] ?? "").trim() : "";
  };
  const ensureGroup = (
    period: DmpMarketOpportunityPeriod,
    propertyName: string,
    title: string,
    seed: Partial<Pick<DmpMarketOpportunityWorkspaceGroup, "tag" | "description" | "declaredTrackCount">> = {}
  ) => {
    if (!hasBusinessValue(propertyName) || !hasBusinessValue(title)) return null;
    rememberProperty(propertyName);
    const key = [period.key, propertyName, title].join("\u001f");
    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        periodKey: period.key,
        propertyName,
        title,
        tag: seed.tag ?? "",
        description: seed.description ?? "",
        declaredTrackCount: seed.declaredTrackCount ?? null,
        tracks: []
      };
      groupsByKey.set(key, group);
    } else {
      if (!group.tag && seed.tag) group.tag = seed.tag;
      if (!group.description && seed.description) group.description = seed.description;
      if (group.declaredTrackCount === null && seed.declaredTrackCount !== undefined) {
        group.declaredTrackCount = seed.declaredTrackCount;
      }
    }
    return group;
  };
  const ensureTrack = (
    group: DmpMarketOpportunityWorkspaceGroup,
    seed: Pick<DmpMarketGrowthOpportunityTrack, "trackName" | "propertyName" | "propertyValue" | "priceBand">
      & Partial<Pick<DmpMarketGrowthOpportunityTrack, "score" | "shopRank" | "collected">>
  ) => {
    if (!hasBusinessValue(seed.trackName)) return null;
    const priceBand = normalizeDmpMarketPriceBand(seed.priceBand);
    let track = group.tracks.find((candidate) => (
      candidate.trackName === seed.trackName
      && candidate.propertyValue === seed.propertyValue
      && candidate.priceBand === priceBand
    ));
    if (!track) {
      track = {
        trackName: seed.trackName,
        propertyName: seed.propertyName,
        propertyValue: seed.propertyValue,
        priceBand,
        score: seed.score ?? "",
        shopRank: seed.shopRank ?? "",
        collected: seed.collected ?? "",
        overall: [],
        crowds: [],
        promotions: []
      };
      group.tracks.push(track);
    } else {
      if (!track.score && seed.score) track.score = seed.score;
      if (!track.shopRank && seed.shopRank) track.shopRank = seed.shopRank;
      if (!track.collected && seed.collected) track.collected = seed.collected;
    }
    return track;
  };
  const groupAndTrack = (table: DmpMarketViewerTable, row: string[], rowIndex: number) => {
    const period = periodForRow(table, row, rowIndex);
    if (!period) return null;
    const propertyName = valueAt(table, row, "属性维度");
    const title = valueAt(table, row, "机会类型");
    const group = ensureGroup(period, propertyName, title, {
      tag: valueAt(table, row, "机会标签"),
      description: valueAt(table, row, "机会说明")
    });
    if (!group) return null;
    const track = ensureTrack(group, {
      trackName: valueAt(table, row, "赛道名称"),
      propertyName,
      propertyValue: valueAt(table, row, "属性值"),
      priceBand: valueAt(table, row, "价格带"),
      score: valueAt(table, row, "综合潜力指数"),
      shopRank: valueAt(table, row, "本店成交排名"),
      collected: valueAt(table, row, "关注状态")
    });
    return track ? { period, group, track } : null;
  };

  for (const table of sources) {
    if (table.name === "细分赛道矩阵") {
      table.rows.forEach((row, rowIndex) => {
        const period = periodForRow(table, row, rowIndex);
        if (!period) return;
        const propertyName = valueAt(table, row, "属性维度");
        const propertyValue = valueAt(table, row, "属性值");
        const priceBand = normalizeDmpMarketPriceBand(valueAt(table, row, "价格带"));
        const metric = valueAt(table, row, "指标");
        if (![propertyName, propertyValue, priceBand, metric].every(hasBusinessValue)) return;
        rememberProperty(propertyName);
        if (!rawMetricLabels.includes(metric)) rawMetricLabels.push(metric);
        const record = {
          periodKey: period.key,
          propertyName,
          propertyValue,
          priceBand,
          metric,
          value: parseDmpMarketTrackScore(valueAt(table, row, "数值"))
        };
        const key = [period.key, propertyName, propertyValue, priceBand, metric].join("\u001f");
        const previous = matrixByKey.get(key);
        if (!previous || (previous.value === null && record.value !== null)) matrixByKey.set(key, record);
      });
      continue;
    }

    if (table.name === "货品增长机会概览") {
      table.rows.forEach((row, rowIndex) => {
        const period = periodForRow(table, row, rowIndex);
        if (!period) return;
        const rawCount = valueAt(table, row, "赛道数量");
        const parsedCount = parseBusinessNumber(rawCount, "赛道数量");
        ensureGroup(period, valueAt(table, row, "属性维度"), valueAt(table, row, "机会类型"), {
          tag: valueAt(table, row, "机会标签"),
          description: valueAt(table, row, "机会说明"),
          declaredTrackCount: parsedCount === null ? null : Math.max(0, Math.trunc(parsedCount))
        });
      });
      continue;
    }

    if (table.name === "货品增长机会") {
      table.rows.forEach((row, rowIndex) => { groupAndTrack(table, row, rowIndex); });
      continue;
    }

    table.rows.forEach((row, rowIndex) => {
      const result = groupAndTrack(table, row, rowIndex);
      if (!result) return;
      if (table.name === "赛道整体与本店") {
        result.track.overall.push({
          metric: valueAt(table, row, "指标"),
          trackValue: valueAt(table, row, "赛道整体"),
          shopValue: valueAt(table, row, "本店表现")
        });
      } else if (table.name === "赛道人群") {
        result.track.crowds.push({
          dimension: valueAt(table, row, "人群维度"),
          feature: valueAt(table, row, "特征"),
          value: valueAt(table, row, "数值")
        });
      } else if (table.name === "赛道投放结构") {
        result.track.promotions.push({
          scope: valueAt(table, row, "口径"),
          scene: valueAt(table, row, "推广场景"),
          spendShare: valueAt(table, row, "消耗占比"),
          clicks: valueAt(table, row, "点击量"),
          clicksChange: valueAt(table, row, "点击量环比"),
          clickRate: valueAt(table, row, "点击率"),
          clickRateChange: valueAt(table, row, "点击率环比"),
          conversionRate: valueAt(table, row, "支付转化率"),
          conversionRateChange: valueAt(table, row, "支付转化率环比"),
          roi: valueAt(table, row, "ROI"),
          roiChange: valueAt(table, row, "ROI环比")
        });
      }
    });
  }

  const orderedPeriods = [...periods.values()].sort((left, right) => (
    left.start.localeCompare(right.start) || left.end.localeCompare(right.end)
  ));
  const officialMetrics = rawMetricLabels.filter((label) => /aScore|搜索潜力|bScore|成交潜力|cScore|拉新潜力|eScore|蓝海/i.test(label));
  const metricLabels = [...(officialMetrics.length ? officialMetrics : rawMetricLabels)]
    .sort((left, right) => trackMetricPriority(left) - trackMetricPriority(right))
    .slice(0, 4);
  const groups = [...groupsByKey.values()].sort((left, right) => (
    orderedPeriods.findIndex((period) => period.key === left.periodKey)
      - orderedPeriods.findIndex((period) => period.key === right.periodKey)
    || propertyNames.indexOf(left.propertyName) - propertyNames.indexOf(right.propertyName)
  ));
  if (!orderedPeriods.length || (!matrixByKey.size && !groups.length)) return null;
  return {
    sourceTableNames: [...new Set(sources.map((table) => table.name))],
    periods: orderedPeriods,
    propertyNames,
    metricLabels,
    matrixRecords: [...matrixByKey.values()].filter((record) => metricLabels.includes(record.metric)),
    groups
  };
}

export function buildDmpMarketOpportunityMatrix(
  workspace: DmpMarketOpportunityWorkspace,
  periodKey: string,
  propertyName: string,
  metric: string
) {
  const records = workspace.matrixRecords.filter((record) => (
    record.periodKey === periodKey && record.propertyName === propertyName && record.metric === metric
  ));
  if (!records.length) return null;
  const propertyValues = [...new Set(records.map((record) => record.propertyValue))];
  const priceBands = [...new Set(records.map((record) => record.priceBand))];
  const byCoordinate = new Map(records.map((record) => [
    `${record.priceBand}\u001f${record.propertyValue}`,
    record.value
  ]));
  const numericValues = records.map((record) => record.value).filter((value): value is number => value !== null);
  const scale = Math.max(0, ...numericValues.map((value) => Math.abs(value)));
  return {
    propertyValues,
    priceBands,
    scale,
    rows: priceBands.map((priceBand) => ({
      priceBand,
      cells: propertyValues.map((propertyValue) => ({
        propertyValue,
        value: byCoordinate.get(`${priceBand}\u001f${propertyValue}`) ?? null
      }))
    }))
  };
}

/**
 * 把归档的货品增长机会纯数据表投影为动态机会分组。机会名称、标签和说明均来自
 * 同一份接口响应；这里不猜测 code，也不硬编码机会类型文案。
 */
export function buildDmpMarketGrowthOpportunityGroups(table: DmpMarketViewerTable): DmpMarketGrowthOpportunityGroup[] | null {
  if (!GROWTH_OPPORTUNITY_TABLE.test(table.name)) return null;
  const columnIndex = (name: string) => table.columns.indexOf(name);
  const typeIndex = columnIndex("机会类型");
  const trackIndex = columnIndex("赛道名称");
  if (typeIndex < 0 || trackIndex < 0) return null;

  const tagIndex = columnIndex("机会标签");
  const descriptionIndex = columnIndex("机会说明");
  const propertyNameIndex = columnIndex("属性维度");
  const propertyValueIndex = columnIndex("属性值");
  const priceBandIndex = columnIndex("价格带");
  const scoreIndex = columnIndex("综合潜力指数");
  const shopRankIndex = columnIndex("本店成交排名");
  const collectedIndex = columnIndex("关注状态");
  const cell = (row: string[], index: number) => index >= 0 ? String(row[index] ?? "").trim() : "";
  const groups = new Map<string, DmpMarketGrowthOpportunityGroup>();

  for (const row of table.rows) {
    const title = cell(row, typeIndex);
    const trackName = cell(row, trackIndex);
    if (!hasBusinessValue(title) || !hasBusinessValue(trackName)) continue;
    let group = groups.get(title);
    if (!group) {
      group = {
        title,
        tag: cell(row, tagIndex),
        description: cell(row, descriptionIndex),
        tracks: []
      };
      groups.set(title, group);
    } else {
      if (!group.tag) group.tag = cell(row, tagIndex);
      if (!group.description) group.description = cell(row, descriptionIndex);
    }
    group.tracks.push({
      trackName,
      propertyName: cell(row, propertyNameIndex),
      propertyValue: cell(row, propertyValueIndex),
      priceBand: normalizeDmpMarketPriceBand(cell(row, priceBandIndex)),
      score: cell(row, scoreIndex),
      shopRank: cell(row, shopRankIndex),
      collected: cell(row, collectedIndex)
    });
  }

  const result = [...groups.values()];
  return result.length ? result : null;
}

export function buildDmpMarketTrackMatrix(table: DmpMarketViewerTable): DmpMarketTrackMatrix | null {
  if (!isDmpMarketTrackComparisonTable(table)) return null;
  const tableMatch = table.name.match(TRACK_COMPARISON_TABLE);
  const records: Array<{
    propertyName: string;
    propertyValue: string;
    priceBand: string;
    metric: string;
    current: number | null;
    previous: number | null;
  }> = [];
  const propertyValues: string[] = [];
  const priceBands: string[] = [];
  const metricLabels: string[] = [];
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
    if (!propertyValues.includes(propertyValue)) propertyValues.push(propertyValue);
    if (!priceBands.includes(priceBand)) priceBands.push(priceBand);
    if (!metricLabels.includes(metric)) metricLabels.push(metric);
    records.push({
      propertyName: rowPropertyName,
      propertyValue,
      priceBand,
      metric,
      current: parseDmpMarketTrackScore(row[4]),
      previous: parseDmpMarketTrackScore(row[5])
    });
  }
  if (!records.length || !propertyValues.length || !priceBands.length || !metricLabels.length) return null;

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

  return {
    tableName: table.name,
    propertyName: propertyName || String(tableMatch?.[1] ?? "").trim(),
    currentLabel: table.columns[4],
    previousLabel: table.columns[5],
    propertyValues,
    priceBands,
    metrics
  };
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
  if (/aScore|搜索潜力/i.test(label)) return 0;
  if (/bScore|成交潜力/i.test(label)) return 1;
  if (/cScore|拉新潜力/i.test(label)) return 2;
  if (/eScore|蓝海/i.test(label)) return 3;
  if (/dScore|增长潜力/i.test(label)) return 4;
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
