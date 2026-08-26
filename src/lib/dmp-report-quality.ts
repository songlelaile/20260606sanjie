import {
  normalizeDmpCanonicalReportForUse,
  type DmpCell,
  type DmpReport,
  type DmpReportTable
} from "@/lib/dmp-report-import";
import {
  DMP_GROWTH_OVERVIEW_METRICS,
  dmpMetricCellIsDisclosed,
  dmpReportKind,
  type DmpCanonicalReport,
  type DmpGrowthOverviewMetricKey,
  type DmpReportQuality
} from "@/lib/dmp-report-types";

type ReportSide = "subject" | "competitor";

export interface DmpReportMissingMetric {
  side: ReportSide;
  role: "主体" | "对手";
  key: DmpGrowthOverviewMetricKey;
  label: string;
}

export interface DmpEffectiveReportQuality {
  effectiveQuality: DmpReportQuality;
  missing: DmpReportMissingMetric[];
  coverage: string[];
  coverageLabel: string;
  notice: string;
}

/**
 * 服务端、官网和导出共用的有效质量复核。客户端只能把报告降级为 partial，
 * 不能用 complete 跳过八项业务指标与日覆盖检查。规范化过程始终基于副本，
 * 不修改历史报告原文。
 */
export function assessDmpEffectiveReportQuality(
  report: DmpCanonicalReport,
  declaredQuality: DmpReportQuality = "complete",
  normalizedInput?: DmpReport | null
): DmpEffectiveReportQuality {
  if (dmpReportKind(report) !== "growth") {
    const effectiveQuality = declaredQuality === "partial" ? "partial" : "complete";
    return {
      effectiveQuality,
      missing: [],
      coverage: [],
      coverageLabel: "",
      notice: effectiveQuality === "partial" ? "部分数据报告；缺失值未按0计入，可继续补采。" : ""
    };
  }

  const normalized = normalizedInput ?? normalizeDmpCanonicalReportForUse(report);
  if (!normalized) {
    return {
      effectiveQuality: "partial",
      missing: [],
      coverage: [],
      coverageLabel: "覆盖情况未完整披露",
      notice: "部分数据报告；覆盖情况未完整披露；缺失值未按0计入，可继续补采。"
    };
  }

  const values = new Map<ReportSide, Partial<Record<DmpGrowthOverviewMetricKey, DmpCell>>>([
    ["subject", {}],
    ["competitor", {}]
  ]);
  for (const side of ["subject", "competitor"] as const) {
    for (const metric of DMP_GROWTH_OVERVIEW_METRICS) {
      const value = disclosedMetric(normalized, side, metric.aliases);
      if (dmpMetricCellIsDisclosed(value)) values.get(side)![metric.key] = value as DmpCell;
    }
  }

  const missing: DmpReportMissingMetric[] = [];
  for (const side of ["subject", "competitor"] as const) {
    const sideValues = values.get(side)!;
    const spend = exactMetricNumber(sideValues.spend);
    const totalGmv = exactMetricNumber(sideValues.totalGmv);
    for (const metric of DMP_GROWTH_OVERVIEW_METRICS) {
      if (sideValues[metric.key] !== undefined) continue;
      // 分母明确为 0 时比率不适用，不得伪造为 0，也不因该空值单独降级。
      if (spend === 0 && (metric.key === "roi" || metric.key === "ppc" || metric.key === "roas")) continue;
      if (totalGmv === 0 && (metric.key === "feeRatio" || metric.key === "paidShare" || metric.key === "roas")) continue;
      missing.push({
        side,
        role: side === "subject" ? "主体" : "对手",
        key: metric.key,
        label: metric.label
      });
    }
  }

  const coverage = reportCoverage(normalized);
  const partialCoverage = coverage.some((label) => {
    const match = label.match(/(\d+)\s*\/\s*(\d+)\s*日/);
    return Boolean(match && Number(match[1]) < Number(match[2]));
  });
  const effectiveQuality: DmpReportQuality = declaredQuality === "partial" || missing.length || partialCoverage
    ? "partial"
    : "complete";
  const coverageLabel = coverage.length
    ? coverage.join("；")
    : `业务周期${normalized.period.days}/${normalized.period.days}日（逐日覆盖未披露）`;
  const missingLabel = missing.length
    ? `缺失字段：${missing.map((item) => `${item.role}${item.label}`).join("、")}`
    : "";
  const notice = effectiveQuality === "partial"
    ? ["部分数据报告", coverageLabel, missingLabel, "缺失值未按0计入，可继续补采。"].filter(Boolean).join("；")
    : "";
  return { effectiveQuality, missing, coverage, coverageLabel, notice };
}

export function effectiveDmpReportQuality(
  report: DmpCanonicalReport,
  declaredQuality: DmpReportQuality
) {
  return assessDmpEffectiveReportQuality(report, declaredQuality).effectiveQuality;
}

function disclosedMetric(
  report: DmpReport,
  side: ReportSide,
  aliases: readonly string[]
) {
  for (const name of ["周期汇总", "报告总览", "对标总表", "基础指标对比"]) {
    const table = report.tables.find((candidate) => candidate.name === name);
    const value = name === "周期汇总"
      ? periodMetric(table, side, aliases, report)
      : matrixMetric(table, side, aliases);
    if (dmpMetricCellIsDisclosed(value)) return value;
  }
  return undefined;
}

function periodMetric(
  table: DmpReportTable | undefined,
  side: ReportSide,
  aliases: readonly string[],
  report: DmpReport
) {
  if (!table) return undefined;
  const valueIndex = columnIndex(table, aliases);
  if (valueIndex < 0) return undefined;
  const idIndex = columnIndex(table, ["商品ID", "商品编号"]);
  const targetId = side === "subject" ? report.item.id : report.item.competitorId;
  let row = idIndex >= 0 && targetId
    ? table.rows.find((candidate) => String(candidate[idIndex] ?? "").trim() === targetId)
    : undefined;
  const roleIndex = columnIndex(table, ["对象", "角色"]);
  if (!row && roleIndex >= 0) {
    const pattern = side === "subject" ? /主体|本店/ : /目标对手|对手|竞品/;
    row = table.rows.find((candidate) => pattern.test(String(candidate[roleIndex] ?? "")));
  }
  if (!row && table.rows.length === 2) row = table.rows[side === "subject" ? 0 : 1];
  return row?.[valueIndex];
}

function matrixMetric(table: DmpReportTable | undefined, side: ReportSide, aliases: readonly string[]) {
  if (!table) return undefined;
  const metricIndex = columnIndex(table, ["项目", "指标", "对标指标"]);
  const valueIndex = columnIndex(table, side === "subject"
    ? ["主体", "主体值", "主体周期值", "本品", "本品值"]
    : ["对手", "对手值", "对手周期值", "目标对手", "目标对手值", "竞品", "竞品值"]);
  if (metricIndex < 0 || valueIndex < 0) return undefined;
  const accepted = new Set(aliases.map(normalizedLabel));
  return table.rows.find((row) => accepted.has(normalizedLabel(row[metricIndex])))?.[valueIndex];
}

function reportCoverage(report: DmpReport) {
  const labels: string[] = [];
  const remember = (value: unknown) => {
    const text = String(value ?? "").trim();
    for (const match of text.matchAll(/(?:(?:主体|对手)已返回)?\s*(\d+)\s*\/\s*(\d+)\s*日(?:（[^\n]*?）)?/g)) {
      const prefix = match[0].trim().startsWith("主体") ? "主体" : match[0].trim().startsWith("对手") ? "对手" : "";
      const label = `${prefix}覆盖${match[1]}/${match[2]}日`;
      if (!labels.includes(label)) labels.push(label);
    }
  };
  const overview = report.tables.find((table) => table.name === "报告总览");
  overview?.rows.forEach((row) => row.forEach(remember));
  if (labels.length) return labels;

  const daily = report.tables.find((table) => table.name === "日GMV与费比");
  const dateIndex = daily ? columnIndex(daily, ["日期", "自然日"]) : -1;
  if (daily && dateIndex >= 0) {
    const metricIndexes = daily.columns.map((column, index) => ({ column, index }))
      .filter(({ column, index }) => index !== dateIndex && !/^(?:阶段|阶段名称|对象|角色)$/.test(String(column).trim()))
      .map(({ index }) => index);
    const dates = new Set(daily.rows.filter((row) => metricIndexes.some((index) => dmpMetricCellIsDisclosed(row[index])))
      .map((row) => String(row[dateIndex] ?? "").trim())
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
    return [`覆盖${dates.size}/${report.period.days}日`];
  }
  return [];
}

function columnIndex(table: Pick<DmpReportTable, "columns">, aliases: readonly string[]) {
  const accepted = new Set(aliases.map(normalizedLabel));
  return table.columns.findIndex((column) => accepted.has(normalizedLabel(column)));
}

function normalizedLabel(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN").replace(/[\s_\-/（）()【】\[\]：:]+/g, "");
}

function exactMetricNumber(value: DmpCell | undefined) {
  if (!dmpMetricCellIsDisclosed(value)) return null;
  let text = String(value).trim().replace(/[,，￥¥\s]/g, "");
  if (text.endsWith("%")) text = text.slice(0, -1);
  text = text.replace(/[元个次笔人件]$/, "");
  const unit = text.match(/(亿|万|千|[wWkK])$/)?.[1] ?? "";
  const multiplier = unit === "亿" ? 100_000_000 : /^(万|[wW])$/.test(unit) ? 10_000 : /^(千|[kK])$/.test(unit) ? 1_000 : 1;
  const numeric = Number(unit ? text.slice(0, -unit.length) : text);
  return Number.isFinite(numeric) ? numeric * multiplier : null;
}
