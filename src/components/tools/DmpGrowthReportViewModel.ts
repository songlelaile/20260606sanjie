import { hasAuthoritativeDmpGrowthSnapshot, normalizeDmpCanonicalReportForUse, type DmpCell, type DmpReportTable } from "@/lib/dmp-report-import";
import { isDmpIntervalCell } from "@/lib/dmp-report-format";
import {
  DMP_GROWTH_OVERVIEW_METRICS,
  DMP_GROWTH_METRIC_ALIASES,
  dmpMetricCellIsDisclosed,
  sanitizeDmpRenderHttpsUrl,
  sanitizeDmpRenderImageUrl,
  type DmpBusinessReportRecord
} from "@/lib/dmp-report-types";
import { assessDmpEffectiveReportQuality, type DmpEffectiveReportQuality } from "@/lib/dmp-report-quality";

const CORE_TABLES = new Set(["报告总览", "商品与成功品", "对标总表", "周期汇总", "基础指标对比"]);
const FORBIDDEN_VISIBLE = /接口清单|页面字段映射|系统诊断|方法与证据|结构解读|业务解读|复盘结论|判断|建议动作|证据等级|校验状态|反推口径|备注|(?:^|\s)请求(?:$|\s)|GMV指数|指数变化|平均GMV指数|工程计算(?:逻辑)?|计算(?:逻辑|公式)|推导过程|算法口径|完整性(?:门禁|状态|提示)|质量门禁|(?:接口|数据)证据|错误(?:码|代码)|失败原因|采集失败|解析失败|待补采|部分数据(?:报告)?|缺失字段|取数时段提示|花费覆盖|数据说明|细分赛道数据状态/i;

export const DMP_GROWTH_SECTION_IDS: Record<string, string> = {
  报告总览: "overview",
  对标总表: "benchmark",
  商品与成功品: "products",
  周期汇总: "period",
  日GMV与费比: "daily",
  渠道花费: "channel",
  一级场景: "scene-primary",
  二级场景: "scene-secondary",
  成长阶段数据: "stages",
  基础指标对比: "metrics",
  关键词样本: "keywords",
  赛道价格带洞察: "price-band"
};

export const DMP_GROWTH_FREEZE_COLUMNS: Record<string, number> = {
  对标总表: 2,
  商品与成功品: 3,
  周期汇总: 2,
  日GMV与费比: 1,
  渠道花费: 1,
  一级场景: 3,
  二级场景: 4,
  成长阶段数据: 4,
  基础指标对比: 1,
  关键词样本: 2,
  赛道价格带洞察: 3
};

export interface DmpViewerTable extends DmpReportTable {
  groupedChannel?: boolean;
  subtitle?: string;
  /** v2.3.100 shop competition layout: object column groups derived from column names. */
  shopLayout?: DmpShopLayout;
  /** Rendering hints for the competition layout (folded / notes / kpi). */
  layoutRole?: "overview" | "kpi" | "core" | "module" | "channel" | "samples" | "notes" | "benchmark" | "archive";
}

export interface DmpShopObjectGroup {
  role: "subject" | "competitor-1" | "competitor-2" | "competitor-3";
  label: string;
  start: number;
  span: number;
  precisionIndex: number;
  relativeIndex: number;
}

export interface DmpShopLayout {
  metaCount: number;
  groups: DmpShopObjectGroup[];
}

export interface DmpShopKpiCard {
  metric: string;
  title: string;
  values: Array<{ role: DmpShopObjectGroup["role"]; label: string; current: DmpCell; previous?: DmpCell; change: DmpCell; precision: string }>;
  relative: Array<{ role: DmpShopObjectGroup["role"]; label: string; value: DmpCell }>;
  /** v2.3.103 (R14): derived (公式) card such as 全店费比 — the display layer renders `current` verbatim. */
  derived?: boolean;
  derivedNote?: string;
}

export interface DmpViewerProduct {
  id: string;
  title: string;
  category: DmpCell;
  price: DmpCell;
  lifecycle: DmpCell;
  gmv: DmpCell;
  pictureUrl: string;
  detailUrl: string;
}

export interface DmpViewerKpi {
  label: string;
  subject: DmpCell;
  competitor: DmpCell;
  scope: DmpCell;
}

export interface DmpDailyGmvChartSeries {
  competitorIndex: number;
  subjectIndex: number;
  competitorValues: Array<number | null>;
  subjectValues: Array<number | null>;
  subjectAverage: number | null;
}

export interface DmpGrowthReportViewModel {
  kind: "growth" | "competition";
  title: string;
  generatedAt: string;
  subjectId: string;
  competitorId: string;
  periodLabel: string;
  startDate: string;
  endDate: string;
  days: number;
  subject: DmpViewerProduct;
  competitor: DmpViewerProduct;
  kpis: DmpViewerKpi[];
  quality: DmpEffectiveReportQuality;
  tables: DmpViewerTable[];
  /** v2.3.100 competition layout: KPI cards from 周期汇总 and 数据说明 notes from 报告总览. */
  shopKpis?: DmpShopKpiCard[];
  shopNotes?: string[];
  shopObjects?: Array<{ role: DmpShopObjectGroup["role"]; label: string; id: string; name: string }>;
  /** v2.3.103 (R14) 店铺视角七区块派生模型（展示层，不写回 canonical）。 */
  shopView?: DmpShopView;
}

export function projectDmpReportForViewer(record: DmpBusinessReportRecord): DmpGrowthReportViewModel {
  const competition = record.reportType === "competition" || record.report.report_type === "competition";
  if (competition) return projectGenericReport(record);

  const report = normalizeDmpCanonicalReportForUse(record.report);
  const rawTables: DmpViewerTable[] = report?.tables ?? record.report.tables.map((table) => ({
    name: table.name,
    columns: [...table.columns],
    rows: table.rows.map((row) => [...row.cells])
  }));
  const promotedTables = hasAuthoritativeDmpGrowthSnapshot(record.report)
    ? rawTables : promoteClosedSubjectSceneMetrics(rawTables);
  const projected = promotedTables.map((table) => projectGrowthTable(table)).map(sanitizeViewerTable).filter(Boolean) as DmpViewerTable[];
  const withBusinessData = projected.filter(tableHasBusinessData);
  const byName = new Map(projected.map((table) => [table.name, table]));
  const subjectId = String(record.subjectItemId || report?.item.id || record.report.item_id || "");
  const competitorId = String(record.competitorItemId || report?.item.competitorId || "").split(",")[0]?.trim() ?? "";
  const startDate = report?.period.startDate || dateMatches(record.period)[0] || "";
  const endDate = report?.period.endDate || dateMatches(record.period)[1] || "";
  const days = report?.period.days || inclusiveDays(startDate, endDate) || 30;
  const productTable = byName.get("商品与成功品");
  const subject = productFromTable(productTable, "subject", subjectId, {
    pictureUrl: report?.item.pictureUrl,
    detailUrl: report?.item.detailUrl
  });
  const competitor = productFromTable(productTable, "competitor", competitorId, {
    pictureUrl: report?.item.competitorPictureUrl,
    detailUrl: report?.item.competitorDetailUrl
  });
  const overview = byName.get("报告总览");
  subject.title ||= overviewValue(overview, "商品标题", "subject");
  competitor.title ||= overviewValue(overview, "商品标题", "competitor");

  return {
    kind: "growth",
    title: record.report.title || "达摩盘商品成长竞品对标报告",
    generatedAt: report?.generatedAt || record.createdAt,
    subjectId,
    competitorId,
    periodLabel: record.period || report?.periodLabel || "",
    startDate,
    endDate,
    days,
    subject,
    competitor,
    kpis: growthKpis(byName, startDate, endDate, days),
    quality: assessDmpEffectiveReportQuality(record.report, record.quality, report),
    tables: withBusinessData.map((table) => ({
      ...table,
      subtitle: table.subtitle || growthSubtitle(table.name, startDate, endDate, subjectId, competitorId, days)
    }))
  };
}

/**
 * 兼容已归档的稀疏场景报告：只在同一份报告的主体一级场景精确闭合到
 * 100% 时补齐展示层指标。全空场景保持空白；不读取其它报告、周期或对象。
 */
export function promoteClosedSubjectSceneMetrics(source: DmpViewerTable[]) {
  const tables = source.map((table) => ({ ...table, rows: table.rows.map((row) => [...row]) }));
  const byName = new Map(tables.map((table) => [table.name, table]));
  const scene = byName.get("一级场景");
  if (!scene) return tables;
  const roleIndex = columnByAliases(scene, ["对象", "角色"]);
  const nameIndex = columnByAliases(scene, ["一级场景", "渠道", "场景"]);
  const chargeIndex = columnByAliases(scene, ["消耗", "花费"]);
  const ratioIndex = columnByAliases(scene, ["消耗占比", "花费占比"]);
  const directIndex = columnByAliases(scene, ["直接成交金额", "直接成交额"]);
  const businessIndexes = [
    chargeIndex, ratioIndex,
    columnByAliases(scene, ["分配后消耗"]),
    columnByAliases(scene, ["展现"]),
    columnByAliases(scene, ["点击"]),
    columnByAliases(scene, ["CTR"]),
    columnByAliases(scene, ["CPC"]),
    directIndex,
    columnByAliases(scene, ["直接ROI"])
  ].filter((index) => index >= 0);
  if (roleIndex < 0 || chargeIndex < 0 || ratioIndex < 0 || !businessIndexes.length) return tables;

  const activeRows = scene.rows.filter((row) => /^主体/.test(String(row[roleIndex] ?? ""))
    && businessIndexes.some((index) => dmpMetricCellIsDisclosed(row[index])));
  if (!activeRows.length) return tables;
  const charges = activeRows.map((row) => exactViewerBusinessNumber(row[chargeIndex]));
  const ratios = activeRows.map((row) => exactViewerRatio(row[ratioIndex]));
  if (!charges.every((value): value is number => value !== null && value >= 0)
    || !ratios.every((value): value is number => value !== null)) return tables;
  const ratioSum = ratios.reduce((sum, value) => sum + value, 0);
  if (Math.abs(ratioSum - 1) > 0.000001) return tables;
  const spend = roundViewer(charges.reduce((sum, value) => sum + value, 0), 2);
  if (!(spend > 0) || !charges.every((charge, index) => Math.abs(charge / spend - ratios[index]) <= 0.00005)) return tables;

  const totalGmv = exactSubjectMetric(tables, DMP_GROWTH_METRIC_ALIASES.totalGmv);
  const marketingClicks = exactSubjectMetric(tables, DMP_GROWTH_METRIC_ALIASES.marketingClicks);
  const directValues = directIndex >= 0
    ? activeRows.map((row) => exactViewerBusinessNumber(row[directIndex]))
    : [];
  const paidGmv = directValues.length === activeRows.length
    && directValues.every((value): value is number => value !== null && value >= 0)
    ? roundViewer(directValues.reduce((sum, value) => sum + value, 0), 2)
    : null;
  const values: Partial<Record<keyof typeof DMP_GROWTH_METRIC_ALIASES, number>> = {
    spend,
    ...(totalGmv !== null && totalGmv > 0 ? {
      feeRatio: roundViewer(spend / totalGmv, 6),
      roas: roundViewer(totalGmv / spend, 4)
    } : {}),
    ...(marketingClicks !== null && marketingClicks > 0 ? { ppc: roundViewer(spend / marketingClicks, 2) } : {}),
    ...(paidGmv !== null ? {
      paidGmv,
      roi: roundViewer(paidGmv / spend, 2),
      ...(totalGmv !== null && totalGmv > 0 ? { paidShare: roundViewer(paidGmv / totalGmv, 6) } : {})
    } : {})
  };

  patchSubjectMetricTables(tables, values);
  patchSubjectChannelRows(byName.get("渠道花费"), activeRows, scene, nameIndex, charges, ratios, spend);
  return tables;
}

function exactSubjectMetric(tables: DmpViewerTable[], aliases: readonly string[]) {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const candidates = [
    overviewMetricPair(byName.get("报告总览"), aliases).subject,
    periodMetricPair(byName.get("周期汇总"), aliases).subject,
    comparisonMetricPair(byName.get("对标总表"), aliases, {
      metric: ["对标指标", "指标"], subject: ["主体周期值", "主体值"], competitor: ["对手周期值", "对手值"]
    }).subject,
    comparisonMetricPair(byName.get("基础指标对比"), aliases, {
      metric: ["指标", "对标指标"], subject: ["主体值", "主体周期值"], competitor: ["对手值", "对手周期值"]
    }).subject
  ];
  for (const value of candidates) {
    const numeric = exactViewerBusinessNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

function patchSubjectMetricTables(
  tables: DmpViewerTable[],
  values: Partial<Record<keyof typeof DMP_GROWTH_METRIC_ALIASES, number>>
) {
  for (const table of tables) {
    if (["报告总览", "对标总表", "基础指标对比"].includes(table.name)) {
      const metricIndex = columnByAliases(table, ["项目", "对标指标", "指标"]);
      const subjectIndex = columnByAliases(table, ["主体", "主体值", "主体周期值", "本品", "本品值"]);
      if (metricIndex < 0 || subjectIndex < 0) continue;
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        const aliases = DMP_GROWTH_METRIC_ALIASES[key as keyof typeof DMP_GROWTH_METRIC_ALIASES];
        const accepted = new Set(aliases.map(normalizeMetricLabel));
        const row = table.rows.find((candidate) => accepted.has(normalizeMetricLabel(candidate[metricIndex])));
        if (row && !dmpMetricCellIsDisclosed(row[subjectIndex])) row[subjectIndex] = value;
      }
      continue;
    }
    if (table.name !== "周期汇总") continue;
    const roleIndex = columnByAliases(table, ["对象", "角色"]);
    const row = roleIndex >= 0 ? table.rows.find((candidate) => /主体/.test(String(candidate[roleIndex] ?? ""))) : table.rows[0];
    if (!row) continue;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const index = columnByAliases(table, DMP_GROWTH_METRIC_ALIASES[key as keyof typeof DMP_GROWTH_METRIC_ALIASES]);
      if (index >= 0 && !dmpMetricCellIsDisclosed(row[index])) row[index] = value;
    }
    const averageSpendIndex = columnByAliases(table, ["日均消耗", "日均花费"]);
    const daysIndex = columnByAliases(table, ["天数"]);
    const days = daysIndex >= 0 ? exactViewerBusinessNumber(row[daysIndex]) : null;
    if (averageSpendIndex >= 0 && !dmpMetricCellIsDisclosed(row[averageSpendIndex]) && days && values.spend !== undefined) {
      row[averageSpendIndex] = roundViewer(values.spend / days, 2);
    }
  }
}

function patchSubjectChannelRows(
  table: DmpViewerTable | undefined,
  activeRows: DmpCell[][],
  scene: DmpViewerTable,
  nameIndex: number,
  charges: number[],
  ratios: number[],
  spend: number
) {
  if (!table || nameIndex < 0) return;
  const channelIndex = columnByAliases(table, ["渠道", "一级场景", "场景"]);
  const spendIndex = table.columns.findIndex((column) => /^主体.*(?:消耗|花费)$/.test(column));
  const shareIndex = table.columns.findIndex((column) => /^主体.*(?:占比)$/.test(column));
  if (channelIndex < 0 || spendIndex < 0) return;
  const byChannel = new Map(activeRows.map((row, index) => [String(row[nameIndex] ?? "").trim(), {
    spend: charges[index], share: ratios[index]
  }]));
  for (const row of table.rows) {
    const channel = String(row[channelIndex] ?? "").trim();
    const value = byChannel.get(channel);
    if (value) {
      if (!dmpMetricCellIsDisclosed(row[spendIndex])) row[spendIndex] = value.spend;
      if (shareIndex >= 0 && !dmpMetricCellIsDisclosed(row[shareIndex])) row[shareIndex] = value.share;
    } else if (/^合计$/.test(channel)) {
      if (!dmpMetricCellIsDisclosed(row[spendIndex])) row[spendIndex] = spend;
      if (shareIndex >= 0 && !dmpMetricCellIsDisclosed(row[shareIndex])) row[shareIndex] = 1;
    }
  }
}

function exactViewerBusinessNumber(value: DmpCell): number | null {
  if (!dmpMetricCellIsDisclosed(value)) return null;
  let text = String(value).trim().replace(/[,，￥¥\s]/g, "");
  if (/[~～]|以上|以下|以内/.test(text)) return null;
  text = text.replace(/[元个次笔人件]$/, "");
  const unit = text.match(/(亿|万|千|[wWkK])$/)?.[1] ?? "";
  const multiplier = unit === "亿" ? 100_000_000 : /^(万|[wW])$/.test(unit) ? 10_000 : /^(千|[kK])$/.test(unit) ? 1_000 : 1;
  const numeric = Number(unit ? text.slice(0, -unit.length) : text);
  return Number.isFinite(numeric) ? numeric * multiplier : null;
}

function exactViewerRatio(value: DmpCell) {
  if (!dmpMetricCellIsDisclosed(value)) return null;
  const text = String(value).trim();
  const numeric = exactViewerBusinessNumber(text.endsWith("%") ? text.slice(0, -1) : text);
  if (numeric === null) return null;
  const ratio = text.endsWith("%") ? numeric / 100 : numeric;
  return ratio >= 0 && ratio <= 1 ? ratio : null;
}

function roundViewer(value: number, digits: number) {
  const base = 10 ** digits;
  return Math.round((value + Number.EPSILON) * base) / base;
}

export function sanitizeViewerTable(table: DmpViewerTable): DmpViewerTable | null {
  if (FORBIDDEN_VISIBLE.test(table.name)) return null;
  const keptIndexes = table.columns.map((column, index) => ({ column, index }))
    .filter(({ column }) => !FORBIDDEN_VISIBLE.test(String(column)))
    .map(({ index }) => index);
  if (!keptIndexes.length) return null;
  const rows = table.rows
    .filter((row) => !row.some((cell) => FORBIDDEN_VISIBLE.test(String(cell ?? ""))))
    .map((row) => keptIndexes.map((index) => row[index] ?? ""));
  return {
    ...table,
    columns: keptIndexes.map((index) => table.columns[index]),
    rows,
    ...(table.widths?.length === table.columns.length ? { widths: keptIndexes.map((index) => table.widths?.[index] ?? 0) } : {})
  };
}

export function tableHasBusinessData(table: DmpViewerTable) {
  if (CORE_TABLES.has(table.name)) return true;
  if (table.name === "关键词样本") {
    const keywordIndex = Math.max(0, table.columns.indexOf("关键词"));
    return table.rows.some((row) => String(row[keywordIndex] ?? "").trim());
  }
  if (table.name === "成长阶段数据") return table.rows.some((row) => row.some((value) => !isMissing(value)));
  if (table.name === "一级场景" || table.name === "二级场景") return table.rows.length > 0;
  if (table.name === "渠道花费") return table.rows.some((row) => row.slice(1).some((value) => !isMissing(value)));
  if (table.name === "日GMV与费比") return table.rows.some((row) => row.slice(1, -1).some((value) => !isMissing(value)));
  return table.rows.length > 0;
}

export function isDmpViewerMetricColumn(table: Pick<DmpViewerTable, "name" | "columns">, index: number) {
  const column = table.columns[index] ?? "";
  if (table.name === "报告总览") return index >= 2;
  if (table.name === "对标总表") {
    const growthShape = table.columns[0] === "页面模块" || table.columns.includes("主体周期值");
    return growthShape ? index >= 2 && index <= 4 : index >= 3;
  }
  if (table.name === "基础指标对比" && index >= 1 && index <= 3) return true;
  if (table.name === "流量投放结构") return index === 1 || index >= 4;
  if (table.name === "渠道指标") return index === 1 || index >= 5;
  if (table.name === "人群画像") return index >= 4;
  if (/商品ID|场景编号|日期|开始|结束|对象|角色|渠道|层级|页面指标|标题|描述|类目|生命周期|阶段名称|阶段描述|广告打法|执行细节|运营动作|一级场景|二级场景|关键词|词类型|标签|图片|详情/.test(column)) return false;
  return /当前(?:值)?$|对比期值$|变化率$|GMV|消耗|占比|展现|点击|CTR|CPC|成交|ROI|ROAS|费比|转化率|贡献率|笔单价|天数|上架|排名|百分位|访客|人数|覆盖规模|数量|日均|变化|金额|价格|得分|Score|指数原值|规模|增速|买家|商品数|集中度|供给比/i.test(column);
}

export function projectDailyGmvChartSeries(
  table: DmpViewerTable,
  periodTable: DmpViewerTable | undefined
): DmpDailyGmvChartSeries {
  const competitorIndex = table.columns.findIndex((column) => /^(?:对手)?日GMV$/.test(column));
  const subjectIndex = table.columns.findIndex((column) => /^主体日GMV$/.test(column));
  return {
    competitorIndex,
    subjectIndex,
    competitorValues: competitorIndex >= 0
      ? table.rows.map((row) => numericViewerValue(row[competitorIndex]))
      : [],
    subjectValues: subjectIndex >= 0
      ? table.rows.map((row) => numericViewerValue(row[subjectIndex]))
      : [],
    subjectAverage: numericViewerValue(periodValue(periodTable, "subject", "日均GMV"))
  };
}

const SHOP_KPI_ORDER = ["成交金额（元）", "广告消耗（元）", "样本费比", "整体成交笔数", "样本加权笔单价（元）", "当天引导ROI", "广告引导成交金额（元）", "样本覆盖率"];
const SHOP_KPI_TITLES: Record<string, string> = { "成交金额（元）": "全店总销售额", "广告消耗（元）": "全店总推广消耗", "样本费比": "样本费比", "整体成交笔数": "整体成交笔数", "样本加权笔单价（元）": "样本加权笔单价", "当天引导ROI": "当天引导ROI", "广告引导成交金额（元）": "广告引导成交金额", "样本覆盖率": "样本覆盖率" };
const SHOP_MODULE_ORDER = ["店铺竞争态势·推广表现", "店铺竞争态势·经营表现", "店铺竞争态势·对标比例", "店铺竞争态势·付费与免费流量", "店铺竞争态势·投放结构", "店铺竞争态势·购买新老客结构"];

/** Detect the v2.3.100 shop comparison column layout from column names alone (canonical is flat). */
export function detectShopLayout(columns: string[]): DmpShopLayout | null {
  const first = columns.findIndex((column) => column === "本店本期");
  if (first < 0) return null;
  const labels: string[] = [];
  for (let index = first; index + 2 < columns.length; index += 3) {
    const match = String(columns[index]).match(/^(本店|竞店\d+)本期$/);
    if (!match || columns[index + 1] !== `${match[1]}上期` || columns[index + 2] !== `${match[1]}变化`) break;
    labels.push(match[1]);
  }
  if (!labels.length) return null;
  const groups: DmpShopObjectGroup[] = labels.map((label, position) => ({
    role: position === 0 ? "subject" : `competitor-${Math.min(position, 3)}` as DmpShopObjectGroup["role"],
    label,
    start: first + position * 3,
    span: 3,
    precisionIndex: columns.indexOf(`${label}精度`),
    relativeIndex: position === 0 ? -1 : columns.indexOf(`本店相对${label}`)
  }));
  return { metaCount: first, groups };
}

function shopKpiCards(summary: DmpViewerTable | undefined): DmpShopKpiCard[] {
  const layout = summary?.shopLayout;
  if (!summary || !layout) return [];
  const metricIndex = summary.columns.indexOf("指标");
  const channelIndex = summary.columns.indexOf("渠道 / 客群");
  const cards: DmpShopKpiCard[] = [];
  for (const metric of SHOP_KPI_ORDER) {
    const row = summary.rows.find((candidate) => String(candidate[metricIndex] ?? "") === metric && (channelIndex < 0 || isMissing(candidate[channelIndex]) || candidate[channelIndex] === "—"));
    if (!row) continue;
    const values = layout.groups.map((group) => ({
      role: group.role, label: group.label, current: row[group.start] ?? "", change: row[group.start + 2] ?? "",
      precision: group.precisionIndex >= 0 ? String(row[group.precisionIndex] ?? "") : ""
    }));
    if (values.every((value) => isMissing(value.current))) continue;
    cards.push({
      metric, title: SHOP_KPI_TITLES[metric] ?? metric, values,
      relative: layout.groups.slice(1).map((group) => ({ role: group.role, label: group.label, value: group.relativeIndex >= 0 ? row[group.relativeIndex] ?? "" : "" }))
    });
  }
  return cards;
}

function projectGenericReport(record: DmpBusinessReportRecord): DmpGrowthReportViewModel {
  const sanitized = record.report.tables.map((table) => sanitizeViewerTable({
    name: table.name,
    columns: [...table.columns],
    rows: table.rows.map((row) => [...row.cells])
  })).filter((table): table is DmpViewerTable => table !== null).filter(table =>
    tableHasBusinessData(table) || table.name === "店铺竞争态势·渠道表现" && table.columns.includes("归因范围"));
  const dates = dateMatches(record.period);
  const competitors = String(record.competitorItemId || "").split(",").map((value) => value.trim()).filter(Boolean);
  // v2.3.100 (R6): shop comparison layout — object groups from column names, three tiers,
  // 对标总表 folded to the end, 数据说明 rows lifted out of 报告总览.
  const withLayout = sanitized.map((table) => {
    const shopLayout = detectShopLayout(table.columns);
    return shopLayout ? { ...table, shopLayout } : table;
  });
  const isShopLayout = withLayout.some((table) => table.shopLayout);
  let tables = withLayout;
  let shopKpis: DmpShopKpiCard[] | undefined;
  let shopNotes: string[] | undefined;
  let shopObjects: DmpGrowthReportViewModel["shopObjects"];
  let shopView: DmpShopView | undefined;
  if (isShopLayout) {
    const byName = new Map(withLayout.map((table) => [table.name, table]));
    const overview = byName.get("报告总览");
    shopNotes = (overview?.rows ?? []).filter((row) => String(row[0] ?? "") === "数据说明").map((row) => String(row[2] ?? "")).filter(Boolean);
    shopObjects = (overview?.rows ?? []).filter((row) => /^(本店|竞店\d+)$/.test(String(row[0] ?? ""))).map((row, position) => ({
      role: position === 0 ? "subject" : `competitor-${Math.min(position, 3)}` as DmpShopObjectGroup["role"],
      label: String(row[0]), id: String(row[1] ?? ""), name: String(row[2] ?? "")
    }));
    shopKpis = shopKpiCards(byName.get("周期汇总"));
    const ordered: DmpViewerTable[] = [];
    if (overview) ordered.push({ ...overview, rows: overview.rows.filter((row) => String(row[0] ?? "") !== "数据说明"), layoutRole: "overview", subtitle: "对象、周期与归因范围" });
    const summary = byName.get("周期汇总");
    if (summary) ordered.push({ ...summary, layoutRole: "core", subtitle: "推广与经营主指标 · 各店并列" });
    for (const name of SHOP_MODULE_ORDER) { const table = byName.get(name); if (table) ordered.push({ ...table, layoutRole: "module" }); }
    const channel = byName.get("店铺竞争态势·渠道表现");
    if (channel) ordered.push({ ...channel, layoutRole: "channel", subtitle: "一级渠道展开，二级渠道折叠" });
    const samples = byName.get("店铺竞争态势·单品样本");
    if (samples) ordered.push({ ...samples, layoutRole: "samples", subtitle: "每店末行为精确样本合计" });
    const benchmark = byName.get("对标总表");
    if (benchmark) ordered.push({ ...benchmark, layoutRole: "benchmark", subtitle: "全量字段，供导出核对" });
    const known = new Set(ordered.map((table) => table.name));
    for (const table of withLayout) if (!known.has(table.name)) ordered.push(table);
    tables = ordered;
    // v2.3.103 (R14): derive the seven-block shop view from the same sanitized canonical tables.
    shopView = deriveShopView(withLayout) ?? undefined;
  }
  return {
    ...(shopKpis ? { shopKpis } : {}),
    ...(shopNotes ? { shopNotes } : {}),
    ...(shopObjects ? { shopObjects } : {}),
    ...(shopView ? { shopView } : {}),
    kind: "competition",
    title: record.report.title || "达摩盘竞争态势分析报告",
    generatedAt: record.createdAt,
    subjectId: record.subjectItemId,
    competitorId: competitors.join("、"),
    periodLabel: record.period,
    startDate: dates[0] || "",
    endDate: dates[1] || "",
    days: inclusiveDays(dates[0] || "", dates[1] || ""),
    subject: emptyProduct(record.subjectItemId),
    competitor: emptyProduct(competitors.join("、")),
    kpis: [],
    quality: assessDmpEffectiveReportQuality(record.report, record.quality),
    tables
  };
}

function projectGrowthTable(table: DmpViewerTable): DmpViewerTable {
  if (table.name === "对标总表" || table.name === "基础指标对比") return suppressExactIntervalDifferences(table);
  if (table.name === "渠道花费") return projectChannelTable(table);
  if (table.name === "日GMV与费比") return projectDailyTable(table);
  if (table.name === "一级场景" || table.name === "二级场景") {
    return { ...table, rows: filterSceneRows({ ...table, rows: alignRoleRows(table) }) };
  }
  if (table.name === "关键词样本") return projectKeywordTable(table);
  return table;
}

function suppressExactIntervalDifferences(table: DmpViewerTable): DmpViewerTable {
  const subjectIndex = columnByAliases(table, ["主体周期值", "主体值", "本品", "本品值"]);
  const competitorIndex = columnByAliases(table, [
    "对手周期值", "目标对手周期值", "竞品周期值", "对手值", "目标对手值", "竞品值"
  ]);
  const differenceIndex = columnByAliases(table, ["主体相对对手", "主体差异", "差异", "变化率"]);
  if ([subjectIndex, competitorIndex, differenceIndex].some((index) => index < 0)) return table;
  return {
    ...table,
    rows: table.rows.map((row) => {
      if (!isDmpIntervalCell(row[subjectIndex]) && !isDmpIntervalCell(row[competitorIndex])) return row;
      if (isDmpIntervalCell(row[differenceIndex])) return row;
      const next = [...row];
      next[differenceIndex] = "";
      return next;
    })
  };
}

function projectChannelTable(table: DmpViewerTable): DmpViewerTable {
  const subjectSpend = table.columns.findIndex((column) => /^主体\d+日消耗$/.test(column));
  const competitorSpend = table.columns.findIndex((column) => /^对手\d+日消耗$/.test(column));
  const subjectShare = table.columns.findIndex((column) => /^主体\d+日占比$/.test(column));
  const competitorShare = table.columns.findIndex((column) => /^对手\d+日占比$/.test(column));
  if ([subjectSpend, competitorSpend, subjectShare, competitorShare].some((index) => index < 0)) return table;
  const rows = table.rows.map((row) => table.columns.map((_, index) => row[index] ?? ""));
  const active = rows.filter((row) => row[0] !== "合计" && row.slice(1).some((value) => !isMissing(value)));
  const total = rows.find((row) => row[0] === "合计");
  return {
    ...table,
    groupedChannel: table.columns.length === 5,
    rows: total ? [...active, total] : active
  };
}

function projectDailyTable(table: DmpViewerTable): DmpViewerTable {
  const dimensions = new Map<string, {
    subjectIndex: number | null;
    competitorIndex: number | null;
    competitorExplicit: boolean;
  }>();
  const parsedColumns = table.columns.map((column, index) => {
    const parsed = dailyMetricColumn(column);
    if (!parsed) return null;
    const current = dimensions.get(parsed.dimension) ?? {
      subjectIndex: null,
      competitorIndex: null,
      competitorExplicit: false
    };
    if (parsed.role === "subject") current.subjectIndex ??= index;
    else if (parsed.explicit) {
      current.competitorIndex = index;
      current.competitorExplicit = true;
    } else if (current.competitorIndex === null) current.competitorIndex = index;
    dimensions.set(parsed.dimension, current);
    return parsed;
  });
  if (!dimensions.size) return table;
  if ([...dimensions.values()].every(({ subjectIndex, competitorIndex, competitorExplicit }) =>
    subjectIndex !== null && competitorIndex !== null && competitorExplicit
  )) return table;

  const columns: string[] = [];
  const sourceIndexes: Array<number | null> = [];
  const widthSourceIndexes: number[] = [];
  const emitted = new Set<string>();
  table.columns.forEach((column, index) => {
    const parsed = parsedColumns[index];
    if (!parsed) {
      columns.push(column);
      sourceIndexes.push(index);
      widthSourceIndexes.push(index);
      return;
    }
    if (emitted.has(parsed.dimension)) return;
    emitted.add(parsed.dimension);
    const pair = dimensions.get(parsed.dimension);
    if (!pair) return;
    columns.push(`主体${parsed.dimension}`, `对手${parsed.dimension}`);
    sourceIndexes.push(pair.subjectIndex, pair.competitorIndex);
    widthSourceIndexes.push(
      pair.subjectIndex ?? pair.competitorIndex ?? index,
      pair.competitorIndex ?? pair.subjectIndex ?? index
    );
  });

  const hasAlignedWidths = table.widths?.length === table.columns.length;
  return {
    ...table,
    columns,
    rows: table.rows.map((row) => sourceIndexes.map((sourceIndex) =>
      sourceIndex === null ? "" : row[sourceIndex] ?? ""
    )),
    widths: hasAlignedWidths
      ? widthSourceIndexes.map((sourceIndex) => table.widths?.[sourceIndex] ?? 16)
      : undefined
  };
}

function dailyMetricColumn(column: string) {
  const match = column.match(/^(主体|对手)?(.+)$/);
  if (!match) return null;
  const dimension = match[2];
  if (dimension !== "日GMV" && dimension !== "日总消耗" && dimension !== "日费比" && !/.+日消耗$/.test(dimension)) {
    return null;
  }
  return {
    dimension,
    role: match[1] === "主体" ? "subject" as const : "competitor" as const,
    explicit: match[1] === "对手"
  };
}

function projectKeywordTable(table: DmpViewerTable): DmpViewerTable {
  const roleIndex = table.columns.indexOf("对象");
  const keywordIndex = table.columns.indexOf("关键词");
  const typeIndex = table.columns.indexOf("词类型");
  if (roleIndex < 0 || keywordIndex < 0) return table;

  const metricIndexes = table.columns
    .map((column, index) => ({ column, index }))
    .filter(({ index }) => index !== roleIndex && index !== keywordIndex && index !== typeIndex);
  const columns = ["关键词", "词类型", ...metricIndexes.flatMap(({ column }) => [`主体${column}`, `对手${column}`])];
  const grouped = new Map<string, { keyword: DmpCell; type: DmpCell; subject?: DmpCell[]; competitor?: DmpCell[] }>();
  for (const row of table.rows) {
    const keyword = row[keywordIndex] ?? "";
    const type = typeIndex >= 0 ? row[typeIndex] ?? "" : "";
    const key = `${String(keyword).trim().toLocaleLowerCase("zh-CN")}\u0001${String(type).trim().toLocaleLowerCase("zh-CN")}`;
    if (!String(keyword).trim()) continue;
    const current = grouped.get(key) ?? { keyword, type };
    const values = metricIndexes.map(({ index }) => row[index] ?? "");
    if (/^主体/.test(String(row[roleIndex] ?? ""))) current.subject = values;
    else if (/目标对手|^对手|^竞品/.test(String(row[roleIndex] ?? ""))) current.competitor = values;
    grouped.set(key, current);
  }
  const rows = [...grouped.values()].map((entry) => [
    entry.keyword,
    entry.type,
    ...metricIndexes.flatMap((_, index) => [entry.subject?.[index] ?? "", entry.competitor?.[index] ?? ""])
  ]);
  return { ...table, columns, rows, widths: undefined };
}

function alignRoleRows(table: DmpViewerTable): DmpCell[][] {
  const roleIndex = table.columns.indexOf("对象");
  if (roleIndex < 0) return table.rows;
  const dimensionIndexes = ["层级", "一级场景", "二级场景", "场景编号", "sceneId"]
    .map((column) => table.columns.indexOf(column))
    .filter((index, position, values) => index >= 0 && values.indexOf(index) === position);
  if (!dimensionIndexes.length) return table.rows;
  const keyFor = (row: DmpCell[]) => sceneDimensionKey(table, row);

  const groups = new Map<string, { template: DmpCell[]; subject?: DmpCell[]; competitor?: DmpCell[] }>();
  for (const row of table.rows) {
    const key = keyFor(row);
    const current = groups.get(key) ?? { template: row };
    if (/^主体/.test(String(row[roleIndex] ?? ""))) current.subject = row;
    else if (/目标对手|^对手|^竞品/.test(String(row[roleIndex] ?? ""))) current.competitor = row;
    groups.set(key, current);
  }

  return [...groups.values()].flatMap(({ template, subject, competitor }) => {
    const placeholder = (role: "主体" | "对手") => table.columns.map((_, index) => {
      if (index === roleIndex) return role;
      return dimensionIndexes.includes(index) ? template[index] ?? "" : "";
    });
    return [subject ?? placeholder("主体"), competitor ?? placeholder("对手")];
  });
}

function filterSceneRows(table: DmpViewerTable) {
  const groups = new Map<string, DmpCell[][]>();
  for (const row of table.rows) {
    const key = sceneDimensionKey(table, row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const active = new Set([...groups].filter(([, rows]) => rows.some((row) => row.slice(5).some((value) => !isMissing(value)))).map(([key]) => key));
  return table.rows.filter((row) => active.has(sceneDimensionKey(table, row)));
}

function sceneDimensionKey(table: Pick<DmpViewerTable, "columns">, row: DmpCell[]) {
  const at = (column: string) => {
    const index = table.columns.indexOf(column);
    return index >= 0 ? String(row[index] ?? "").trim() : "";
  };
  const names = [at("层级"), at("一级场景"), at("二级场景")];
  if (names.slice(1).some(Boolean)) return names.join("\u0001");
  return [...names, at("场景编号"), at("sceneId")].join("\u0001");
}

function productFromTable(
  table: DmpViewerTable | undefined,
  role: "subject" | "competitor",
  fallbackId: string,
  render?: { pictureUrl?: string; detailUrl?: string }
): DmpViewerProduct {
  const row = table?.rows.find((candidate) => role === "subject"
    ? /^主体/.test(String(candidate[0] ?? ""))
    : /目标对手|^对手|^竞品/.test(String(candidate[0] ?? ""))) ?? [];
  const media = tableCell(table, row, "图片/详情");
  const pictureUrl = safeViewerImageUrl(render?.pictureUrl || media);
  return {
    id: String(tableCell(table, row, "商品ID") || fallbackId),
    title: String(tableCell(table, row, "商品标题") || ""),
    category: tableCell(table, row, "类目/成功品描述"),
    price: tableCell(table, row, "标价/价格带"),
    lifecycle: tableCell(table, row, "生命周期"),
    gmv: tableCell(table, row, "30日GMV"),
    pictureUrl,
    detailUrl: safeViewerHttpsUrl(render?.detailUrl || (pictureUrl ? "" : media))
  };
}

function growthKpis(
  tables: Map<string, DmpViewerTable>,
  startDate: string,
  endDate: string,
  days: number
): DmpViewerKpi[] {
  const overview = tables.get("报告总览");
  const period = tables.get("周期汇总");
  const benchmark = tables.get("对标总表");
  const base = tables.get("基础指标对比");
  const defaultScope = startDate && endDate ? `${startDate} 至 ${endDate}（${days}天）` : `近${days}天`;

  return DMP_GROWTH_OVERVIEW_METRICS.map((metric) => {
    const primary = overviewMetricPair(overview, metric.aliases);
    const fallbacks = [
      periodMetricPair(period, metric.aliases),
      comparisonMetricPair(benchmark, metric.aliases, {
        metric: ["对标指标", "指标"],
        subject: ["主体周期值", "主体值"],
        competitor: ["对手周期值", "目标对手周期值", "竞品周期值", "对手值"]
      }),
      comparisonMetricPair(base, metric.aliases, {
        metric: ["指标", "对标指标"],
        subject: ["主体值", "主体周期值"],
        competitor: ["对手值", "目标对手值", "竞品值", "对手周期值"]
      })
    ];
    return {
      label: metric.label,
      subject: firstDisclosed(primary.subject, ...fallbacks.map((pair) => pair.subject)),
      competitor: firstDisclosed(primary.competitor, ...fallbacks.map((pair) => pair.competitor)),
      scope: firstDisclosed(primary.scope, defaultScope)
    };
  });
}

type MetricPair = { subject: DmpCell; competitor: DmpCell; scope: DmpCell };

function overviewMetricPair(table: DmpViewerTable | undefined, aliases: readonly string[]): MetricPair {
  const row = metricRow(table, aliases, ["项目", "指标", "对标指标"]);
  if (!table || !row) return emptyMetricPair();
  return {
    subject: cellByColumn(table, row, ["主体", "主体值"], 1),
    competitor: cellByColumn(table, row, ["对手", "目标对手", "竞品", "对手值"], 2),
    scope: cellByColumn(table, row, ["范围", "数据范围", "周期"], 3)
  };
}

function periodMetricPair(table: DmpViewerTable | undefined, aliases: readonly string[]): MetricPair {
  if (!table) return emptyMetricPair();
  const metricIndex = columnByAliases(table, aliases);
  const roleIndex = columnByAliases(table, ["对象", "角色"]);
  if (metricIndex < 0 || roleIndex < 0) return emptyMetricPair();
  const subject = table.rows.find((row) => /主体/.test(String(row[roleIndex] ?? "")));
  const competitor = table.rows.find((row) => /目标对手|对手|竞品/.test(String(row[roleIndex] ?? "")));
  return {
    subject: subject?.[metricIndex] ?? "",
    competitor: competitor?.[metricIndex] ?? "",
    scope: ""
  };
}

function comparisonMetricPair(
  table: DmpViewerTable | undefined,
  aliases: readonly string[],
  columns: { metric: readonly string[]; subject: readonly string[]; competitor: readonly string[] }
): MetricPair {
  const row = metricRow(table, aliases, columns.metric);
  if (!table || !row) return emptyMetricPair();
  return {
    subject: cellByColumn(table, row, columns.subject),
    competitor: cellByColumn(table, row, columns.competitor),
    scope: ""
  };
}

function metricRow(table: DmpViewerTable | undefined, aliases: readonly string[], metricColumns: readonly string[]) {
  if (!table) return undefined;
  const metricIndex = columnByAliases(table, metricColumns);
  if (metricIndex < 0) return undefined;
  const accepted = new Set(aliases.map(normalizeMetricLabel));
  return table.rows.find((row) => accepted.has(normalizeMetricLabel(row[metricIndex])));
}

function cellByColumn(
  table: DmpViewerTable,
  row: DmpCell[],
  aliases: readonly string[],
  fallbackIndex = -1
) {
  const index = columnByAliases(table, aliases);
  if (index >= 0) return row[index] ?? "";
  return fallbackIndex >= 0 ? row[fallbackIndex] ?? "" : "";
}

function columnByAliases(table: Pick<DmpViewerTable, "columns">, aliases: readonly string[]) {
  const accepted = new Set(aliases.map(normalizeMetricLabel));
  return table.columns.findIndex((column) => accepted.has(normalizeMetricLabel(column)));
}

function normalizeMetricLabel(value: DmpCell) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN").replace(/[\s_\-/（）()【】\[\]：:]+/g, "");
}

function firstDisclosed(...values: DmpCell[]) {
  return values.find((value) => !isMissing(value)) ?? "";
}

function emptyMetricPair(): MetricPair {
  return { subject: "", competitor: "", scope: "" };
}

function periodValue(table: DmpViewerTable | undefined, role: "subject" | "competitor", column: string) {
  const pair = periodMetricPair(table, [column]);
  return pair[role];
}

function numericViewerValue(value: DmpCell): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replaceAll(",", "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function overviewValue(table: DmpViewerTable | undefined, label: string, role: "subject" | "competitor") {
  const row = table?.rows.find((candidate) => String(candidate[0] ?? "") === label);
  return String(row?.[role === "subject" ? 1 : 2] ?? "");
}

function tableCell(table: DmpViewerTable | undefined, row: DmpCell[], column: string) {
  const index = table?.columns.indexOf(column) ?? -1;
  return index >= 0 ? row[index] ?? "" : "";
}

function growthSubtitle(name: string, startDate: string, endDate: string, subjectId: string, competitorId: string, days: number) {
  const range = startDate && endDate ? `${startDate} 至 ${endDate}` : `近${days}天`;
  const subtitles: Record<string, string> = {
    报告总览: `主体 ${subjectId}｜对手 ${competitorId}｜${range}`,
    对标总表: `${range}｜主体 ${subjectId} vs 对手 ${competitorId}`,
    商品与成功品: "本次分析目标与成功品候选",
    周期汇总: `${days}日对象与周期严格对齐`,
    日GMV与费比: `目标对手 ${competitorId}｜${range}`,
    渠道花费: `${range}｜五渠道消耗与占比`,
    一级场景: `${range}｜主体与对手一级投放场景数据`,
    二级场景: `${range}｜主体与对手二级投放场景数据`,
    成长阶段数据: `${range}｜目标对手成长阶段金额数据`,
    基础指标对比: `${range}｜主体与目标成功品数值对比`,
    关键词样本: `${range}｜按页面展示顺序排列`,
    赛道价格带洞察: `${range}｜同类目、同周期价格带原值与规则型指导`
  };
  return subtitles[name] ?? range;
}

export function safeViewerHttpsUrl(value: DmpCell) {
  for (const candidate of viewerUrlCandidates(value)) {
    const safe = sanitizeDmpRenderHttpsUrl(candidate);
    if (safe) return safe;
  }
  return "";
}

export function safeViewerImageUrl(value: DmpCell) {
  for (const candidate of viewerUrlCandidates(value)) {
    const safe = sanitizeDmpRenderImageUrl(candidate);
    if (safe) return safe;
  }
  return "";
}

function viewerUrlCandidates(value: DmpCell) {
  const text = String(value ?? "").trim();
  return (text.match(/(?:https?:)?\/\/[^\s"'<>]+/gi) ?? [])
    .map((candidate) => candidate.startsWith("//") ? `https:${candidate}` : candidate);
}

function dateMatches(value: string) {
  return [...String(value ?? "").matchAll(/\d{4}-\d{2}-\d{2}/g)].map((match) => match[0]);
}

function inclusiveDays(startDate: string, endDate: string) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 86_400_000) + 1 : 0;
}

function isMissing(value: DmpCell) {
  return !dmpMetricCellIsDisclosed(value);
}

function emptyProduct(id: string): DmpViewerProduct {
  return { id, title: "", category: "", price: "", lifecycle: "", gmv: "", pictureUrl: "", detailUrl: "" };
}

/* ===========================================================================
 * v2.3.103 (R14) 店铺视角七区块派生（展示层；不写回 canonical）
 *
 * 与插件 `source/shop-report-layout.js` 的 `parseDisplay` 语义逐条对齐：
 *   exact / interval / text / missing（含 invalid）、「约 / ≈」前缀、`~ ～ 至` 区间、
 *   千 / 万 / 亿 / % / 个百分点 / 元 / 倍 单位。
 * 所有派生值：任一输入 missing / text / invalid → 留空；区间按端点运算并向
 * 外取整（下界 floor、上界 ceil，精度 1e-6），绝不取中点；金额展示两位小数千分位，
 * 万级以上用「1,348.9万」缩写（仅展示）。派生结果一律标「公式」精度。
 * =========================================================================== */

export type DmpShopBadge = "exact" | "interval" | "text" | "sample" | "formula" | "missing";
export type DmpShopParseKind = "missing" | "exact" | "interval" | "text" | "invalid";

/** 与插件 parseDisplay 完全一致的解析结果。 */
export interface DmpShopParsed {
  kind: DmpShopParseKind;
  min?: number;
  max?: number;
  approximate?: boolean;
  percent?: boolean;
  minOpen?: boolean;
  maxOpen?: boolean;
  text?: string;
}

export interface DmpShopObject { role: DmpShopObjectGroup["role"]; label: string; id: string; name: string }

export interface DmpShopViewValue {
  role: DmpShopObjectGroup["role"];
  label: string;
  /** 已格式化（外扩取整 + 展示精度）的文本；不可派生 / 缺失时为空串或「—」。 */
  display: string;
  badge: DmpShopBadge;
  precision: string;
}

export interface DmpShopBlockMeta { code: string; title: string; note: string }

export interface DmpShopBridgeCell { label: string; value: string; note: string }
export interface DmpShopBridge {
  role: DmpShopObjectGroup["role"];
  label: string;
  cells: DmpShopBridgeCell[];
  notes: string[];
}

export interface DmpShopSpendValue {
  role: DmpShopObjectGroup["role"];
  label: string;
  share: string;
  /** 0–100 的占比数值（本期），仅用于条形宽度渲染。 */
  shareWidth: number;
  sharePrevious: string;
  spend: string;
  pp: string;
  trend: "up" | "down" | "";
  precision: string;
}
export interface DmpShopSpendRow { channel: string; values: DmpShopSpendValue[] }
export interface DmpShopSpendSection { rows: DmpShopSpendRow[]; totals: DmpShopSpendValue[]; notes: string[] }

export interface DmpShopChannelMetric { metric: string; values: DmpShopViewValue[] }
export interface DmpShopChannelRow { channel: string; metrics: DmpShopChannelMetric[]; subs: DmpShopChannelRow[] }
export interface DmpShopStructureBar { channel: string; label: string; share: string; width: number; detail: string }
export interface DmpShopChannelGroup {
  attribution: string;
  label: string;
  rows: DmpShopChannelRow[];
  structure: DmpShopStructureBar[];
  structureNote: string;
  notes: string[];
}

export interface DmpShopTrafficBar { channel: string; share: string; width: number }
export interface DmpShopTrafficStack { role: DmpShopObjectGroup["role"]; label: string; bars: DmpShopTrafficBar[]; note: string }
export interface DmpShopCustomerValue {
  role: DmpShopObjectGroup["role"];
  label: string;
  current: string;
  change: string;
  trend: "up" | "down" | "";
  badge: DmpShopBadge;
  precision: string;
}
export interface DmpShopCustomerRow { group: string; metric: string; kind: "count" | "percent"; values: DmpShopCustomerValue[] }
export interface DmpShopTrafficSection {
  stacks: DmpShopTrafficStack[];
  paidDerived: string;
  paidNote: string;
  customers: DmpShopCustomerRow[];
  notes: string[];
}

export interface DmpShopSampleRow {
  role: DmpShopObjectGroup["role"];
  label: string;
  /** canonical 单品样本行（12 列原样）；聚合行由派生构造。 */
  cells: DmpCell[];
  /** 占全店 GMV（派生；区间外扩）。 */
  share: string;
  total: boolean;
  aggregate: boolean;
  precisionNote: string;
}
export interface DmpShopSampleSection {
  columns: string[];
  shareAfterColumn: string;
  rows: DmpShopSampleRow[];
  notes: string[];
  concentration: string;
}

export interface DmpShopNote { kind: "说明" | "缺" | "建议"; text: string }

export interface DmpShopDailyCell {
  role: DmpShopObjectGroup["role"];
  label: string;
  gmv: string;
  spend: string;
  fee: string;
  roi: string;
  orders: string;
  aov: string;
  ppc: string;
  cvr: string;
  cart: string;
}

export interface DmpShopDailyChart {
  title: string;
  series: { label: string; role: string; values: Array<number | null> }[];
}

export interface DmpShopDailySection {
  dates: string[];
  byDate: Record<string, DmpShopDailyCell[]>;
  series: { title: string; values: string[]; hover?: boolean }[];
  charts: DmpShopDailyChart[];
}

export interface DmpShopView {
  objects: DmpShopObject[];
  blocks: DmpShopBlockMeta[];
  kpis: DmpShopKpiCard[];
  bridges: DmpShopBridge[];
  spend: DmpShopSpendSection;
  channelGroups: DmpShopChannelGroup[];
  traffic: DmpShopTrafficSection;
  samples: DmpShopSampleSection;
  daily: DmpShopDailySection;
  notes: DmpShopNote[];
}

const SHOP_DIRECTION = /^(?:比(?:本店|本品|主体|竞店|竞品)[^\r\n]{0,30}(?:高|低)|高于本(?:店|品)|低于本(?:店|品)|持平|上升|下降|无变化|数据不足|数据量过小|隐私保护|未展示)$/;
const SHOP_NUMBER = /^([+-]?)(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?|\.(\d+))\s*(千|万|亿|%|个百分点|元|倍)?$/;

function shopNumberToken(text: string, fallbackUnit = "") {
  const match = String(text).trim().match(SHOP_NUMBER);
  if (!match) return null;
  const unit = match[5] || fallbackUnit;
  const raw = Number(`${match[1]}${(match[2] || "0").replace(/,/g, "")}.${match[3] || match[4] || "0"}`);
  if (!Number.isFinite(raw)) return null;
  return {
    value: raw * (unit === "千" ? 1e3 : unit === "万" ? 1e4 : unit === "亿" ? 1e8 : 1),
    percent: unit === "%" || unit === "个百分点"
  };
}

/** 与插件 shop-report-layout.js#parseDisplay 语义一致的单元格解析。 */
export function parseShopDisplay(cell: DmpCell): DmpShopParsed {
  if (cell === null || cell === undefined || cell === "" || cell === "—" || cell === "--") return { kind: "missing" };
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? { kind: "exact", min: cell, max: cell, approximate: false, percent: false } : { kind: "invalid" };
  }
  if (typeof cell !== "string" || cell.length > 160) return { kind: "invalid" };
  let text = cell.trim();
  if (SHOP_DIRECTION.test(text)) return { kind: "text", text };
  const approximate = /^(约|≈)/.test(text);
  text = text.replace(/^(约|≈)\s*/, "");
  const parts = text.split(/\s*(?:~|～|至)\s*/);
  if (parts.length === 1) {
    const single = shopNumberToken(parts[0]);
    return single ? { kind: "exact", min: single.value, max: single.value, approximate, percent: single.percent } : { kind: "invalid" };
  }
  if (parts.length === 2) {
    const minOpen = /^>/.test(parts[0]);
    const maxOpen = /^</.test(parts[1]);
    const leftUnit = parts[0].match(/(千|万|亿|%|个百分点|元|倍)$/)?.[1] || "";
    const rightUnit = parts[1].match(/(千|万|亿|%|个百分点|元|倍)$/)?.[1] || "";
    const min = shopNumberToken(parts[0].replace(/^[<>]/, ""), rightUnit);
    const max = shopNumberToken(parts[1].replace(/^[<>]/, ""), leftUnit);
    if (min && max && min.value <= max.value && min.percent === max.percent) {
      return { kind: "interval", min: min.value, max: max.value, minOpen, maxOpen, approximate, percent: min.percent };
    }
  }
  return { kind: "invalid" };
}

function shopUsable(parsed: DmpShopParsed | undefined | null): parsed is DmpShopParsed & { min: number; max: number } {
  return Boolean(parsed) && (parsed!.kind === "exact" || parsed!.kind === "interval")
    && Number.isFinite(parsed!.min) && Number.isFinite(parsed!.max);
}

function shopFloor(value: number, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

function shopCeil(value: number, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}

/** 区间端点外扩除法（percent=true 时结果 ×100）。任一输入不可用 / 分母非正 → null。 */
function shopDivide(numerator: DmpShopParsed, denominator: DmpShopParsed, percent: boolean) {
  if (!shopUsable(numerator) || !shopUsable(denominator)) return null;
  if (denominator.min <= 0 || numerator.min < 0) return null;
  const scale = percent ? 100 : 1;
  return {
    min: shopFloor((numerator.min / denominator.max) * scale),
    max: shopCeil((numerator.max / denominator.min) * scale)
  };
}

/** 区间端点外扩乘法。任一输入不可用 → null。 */
function shopMultiply(left: DmpShopParsed, right: DmpShopParsed) {
  if (!shopUsable(left) || !shopUsable(right)) return null;
  if (left.min < 0 || right.min < 0) return null;
  return { min: shopFloor(left.min * right.min), max: shopCeil(left.max * right.max) };
}

function shopGrouped(value: number, decimals: number) {
  if (!Number.isFinite(value)) return "";
  const fixed = value.toFixed(decimals);
  const negative = fixed.startsWith("-");
  const [integer, fraction] = (negative ? fixed.slice(1) : fixed).split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

/** 金额：两位小数千分位（表格与逐行明细统一口径）。 */
export function formatShopAmount(value: number) {
  return Number.isFinite(value) ? shopGrouped(value, 2) : "";
}

/** 金额缩写（仅用于 KPI / 桥等概览位置）：万级以上 `1,348.9万`。 */
export function formatShopAmountCompact(value: number) {
  if (!Number.isFinite(value)) return "";
  return Math.abs(value) >= 1e6 ? `${shopGrouped(value / 1e4, 2)}万` : shopGrouped(value, 2);
}

export function formatShopPercent(value: number, decimals = 1, signed = false) {
  if (!Number.isFinite(value)) return "";
  const text = `${shopGrouped(value, decimals)}%`;
  return signed && value > 0 ? `+${text}` : text;
}

function shopAmountRange(range: { min: number; max: number } | null, compact = false) {
  if (!range) return "";
  // 2026-09-18: compact ranges use ONE unit for both ends (万 if either end ≥ 1e6) so「902,359.66～180.50万」never appears.
  const format = compact
    ? (Math.abs(range.min) >= 1e6 || Math.abs(range.max) >= 1e6
      ? (value: number) => `${shopGrouped(value / 1e4, 2)}万`
      : formatShopAmountCompact)
    : formatShopAmount;
  const min = format(range.min);
  const max = format(range.max);
  return min === max ? min : `${min}～${max}`;
}

function shopPercentRange(range: { min: number; max: number } | null, decimals = 1) {
  if (!range) return "";
  const min = formatShopPercent(range.min, decimals);
  const max = formatShopPercent(range.max, decimals);
  return min === max ? min : `${min}～${max}`;
}

const SHOP_BADGE_BY_PRECISION: Record<string, DmpShopBadge> = {
  平台精确: "exact",
  平台区间: "interval",
  方向值: "text",
  样本加权约值: "sample",
  公式: "formula"
};

export function shopBadgeForPrecision(label: string): DmpShopBadge {
  return SHOP_BADGE_BY_PRECISION[label] ?? "missing";
}

/** 展示层店名缩写。不改 canonical 的「本店 / 竞店」标签。去掉店型后缀；惠厨好太太收成店牌「惠厨」。 */
export function abbreviateShopName(name: string): string {
  let text = String(name || "").trim();
  if (!text) return "";
  text = text.replace(/(?:官方旗舰店|旗舰店|专营店|专卖店|企业店|官方店)$/u, "");
  if (text.startsWith("惠厨")) return "惠厨";
  return text;
}

/** 单元格展示：整数千分位；带 % 的精确值保留两位小数；区间 / 方向文本原样。 */
export function formatShopCell(cell: DmpCell, kind: "count" | "percent" | "ratio" = "count") {
  if (cell === null || cell === undefined || cell === "" || cell === "—" || cell === "--") return "—";
  const parsed = parseShopDisplay(cell);
  if (parsed.kind === "text" || parsed.kind === "invalid" || parsed.kind === "missing") return String(cell);
  if (kind === "count") {
    const text = String(cell).trim();
    return /^[+-]?\d{4,}$/.test(text) ? shopGrouped(Number(text), 0) : text;
  }
  if (parsed.kind === "interval") {
    return kind === "percent" || parsed.percent
      ? `${shopGrouped(parsed.min!, 2)}%～${shopGrouped(parsed.max!, 2)}%`
      : `${shopGrouped(parsed.min!, 2)}～${shopGrouped(parsed.max!, 2)}`;
  }
  return kind === "percent" ? `${shopGrouped(parsed.min!, 2)}%` : shopGrouped(parsed.min!, 2);
}

// ---- 表结构读取 ---------------------------------------------------------------------------

interface ShopTableCell { table: DmpViewerTable; layout: DmpShopLayout; index: number; row: DmpCell[] }

function shopLayoutOf(table: DmpViewerTable | undefined): { table: DmpViewerTable; layout: DmpShopLayout } | null {
  if (!table) return null;
  const layout = table.shopLayout || detectShopLayout(table.columns);
  if (!layout) return null;
  return { table, layout };
}

/** 在对比表中定位「无 渠道 / 客群」的指标行（与插件 kpiCards 的 `!candidate[2]` 等价）。 */
function shopMetricRow(table: DmpViewerTable | undefined, metric: string, channel?: string): DmpCell[] | undefined {
  if (!table) return undefined;
  const metricIndex = table.columns.indexOf("指标");
  const channelIndex = table.columns.indexOf("渠道 / 客群");
  if (metricIndex < 0) return undefined;
  return table.rows.find((row) => {
    if (String(row[metricIndex] ?? "").trim() !== metric) return false;
    const channelCell = channelIndex >= 0 ? row[channelIndex] : "";
    if (channel === undefined) return !String(channelCell ?? "").trim() || channelCell === "—";
    return String(channelCell ?? "").trim() === channel;
  });
}

function shopCellAt(cell: ShopTableCell | undefined, role: DmpShopObjectGroup["role"], offset: number, metric: string): DmpShopParsed {
  if (!cell) return { kind: "missing" };
  const group = cell.layout.groups.find((candidate) => candidate.role === role);
  if (!group) return { kind: "missing" };
  return parseShopDisplay(cell.row[group.start + offset]);
}

function shopPrecisionAt(cell: ShopTableCell | undefined, role: DmpShopObjectGroup["role"]): string {
  if (!cell) return "—";
  const group = cell.layout.groups.find((candidate) => candidate.role === role);
  if (!group || group.precisionIndex < 0) return "—";
  const value = String(cell.row[group.precisionIndex] ?? "").trim();
  return value || "—";
}

function shopValue(
  cell: ShopTableCell | undefined,
  role: DmpShopObjectGroup["role"],
  label: string,
  metric: string,
  kind: "count" | "percent" | "ratio" = "count"
): DmpShopViewValue {
  const group = cell?.layout.groups.find((candidate) => candidate.role === role);
  if (!cell || !group) return { role, label, display: "—", badge: "missing", precision: "—" };
  const raw = cell.row[group.start];
  const parsed = parseShopDisplay(raw);
  const precision = shopPrecisionAt(cell, role);
  return {
    role,
    label,
    display: parsed.kind === "missing" ? "—" : parsed.kind === "text" ? String(raw) : formatShopCell(raw, kind),
    badge: shopBadgeForPrecision(precision),
    precision
  };
}

function shopObjectsFromOverview(overview: DmpViewerTable | undefined, groups: DmpShopObjectGroup[]): DmpShopObject[] {
  const rows = (overview?.rows ?? []).filter((row) => /^(本店|竞店\d+)$/.test(String(row[0] ?? "")));
  if (!rows.length) {
    return groups.map((group) => ({ role: group.role, label: group.label, id: "", name: "" }));
  }
  return rows.map((row, position) => ({
    role: position === 0 ? "subject" : (`competitor-${Math.min(position, 3)}` as DmpShopObjectGroup["role"]),
    label: String(row[0]),
    id: String(row[1] ?? ""),
    name: String(row[2] ?? "")
  }));
}

// ---- 01 KPI（8 卡） -----------------------------------------------------------------------

const SHOP_METRIC_TABLES = ["周期汇总", "店铺竞争态势·经营表现", "店铺竞争态势·推广表现"] as const;

interface ShopMetricEntry { table: DmpViewerTable; layout: DmpShopLayout; row: DmpCell[] }

function shopMetricEntry(tables: Map<string, DmpViewerTable>, metric: string): ShopMetricEntry | null {
  for (const name of SHOP_METRIC_TABLES) {
    const entry = shopLayoutOf(tables.get(name));
    if (!entry) continue;
    const row = shopMetricRow(entry.table, metric);
    if (row) return { table: entry.table, layout: entry.layout, row };
  }
  return null;
}

function shopEntryCell(entry: ShopMetricEntry | null, role: DmpShopObjectGroup["role"], offset: number): DmpCell {
  if (!entry) return "";
  const group = entry.layout.groups.find((candidate) => candidate.role === role);
  return group ? entry.row[group.start + offset] ?? "" : "";
}

function shopEntryPrecision(entry: ShopMetricEntry | null, role: DmpShopObjectGroup["role"]): string {
  if (!entry) return "—";
  const group = entry.layout.groups.find((candidate) => candidate.role === role);
  if (!group || group.precisionIndex < 0) return "—";
  return String(entry.row[group.precisionIndex] ?? "").trim() || "—";
}

function shopSampleFeeRatioFor(tables: Map<string, DmpViewerTable>, role: DmpShopObjectGroup["role"]) {
  const entry = shopMetricEntry(tables, "样本费比");
  if (!entry) return "";
  const group = entry.layout.groups.find((candidate) => candidate.role === role);
  if (!group) return "";
  const parsed = parseShopDisplay(entry.row[group.start]);
  return shopUsable(parsed) ? formatShopPercent(parsed.min, 2) : "";
}

// ---- R15 (2026-09-19): 竞店销售额 / 消耗 点值 -------------------------------------------------
// Point values are derived when 成交笔数 and 笔单价 are both exact point values (not intervals)
// and the product falls inside the platform interval. Display layer only; canonical rows untouched.
export interface ShopPointFigures {
  orders: number;            // 控比反推 成交笔数（点）
  price: number;             // 笔单价（点）
  gmv: number;               // orders × price
  spend: number | null;      // gmv × 样本费比
  feeRatio: number | null;   // 样本费比（%）
  platformGmv: { min: number; max: number } | null; // 原平台区间，供 07 说明核对
}

export function shopPointFiguresFor(tables: Map<string, DmpViewerTable>, role: DmpShopObjectGroup["role"]): ShopPointFigures | null {
  if (role === "subject") return null; // 本店口径不变
  const orderEntry = shopMetricEntry(tables, "整体成交笔数");
  const priceEntry = shopMetricEntry(tables, "样本加权笔单价（元）");
  const gmvEntry = shopMetricEntry(tables, "成交金额（元）");
  const feeEntry = shopMetricEntry(tables, "样本费比");
  const orders = parseShopDisplay(shopEntryCell(orderEntry, role, 0));
  const price = parseShopDisplay(shopEntryCell(priceEntry, role, 0));
  const gmv = parseShopDisplay(shopEntryCell(gmvEntry, role, 0));
  if (!shopUsable(orders) || orders.min !== orders.max || orders.min <= 0) return null;
  if (!shopUsable(price) || price.min !== price.max || price.min <= 0) return null;
  const point = orders.min * price.min;
  const platformGmv = shopUsable(gmv) ? { min: gmv.min, max: gmv.max } : null;
  if (platformGmv && (point < platformGmv.min || point > platformGmv.max)) return null;
  const fee = parseShopDisplay(shopEntryCell(feeEntry, role, 0));
  const feeRatio = shopUsable(fee) && fee.min === fee.max ? fee.min : null;
  return { orders: orders.min, price: price.min, gmv: point, spend: feeRatio === null ? null : point * feeRatio / 100, feeRatio, platformGmv };
}

function shopCrowdOrders(tables: Map<string, DmpViewerTable>, role: DmpShopObjectGroup["role"], newCustomer: boolean) {
  const point = shopPointFiguresFor(tables, role);
  const gmvEntry = shopMetricEntry(tables, "成交金额（元）");
  const shareEntry = shopMetricEntry(tables, "新客成交金额占比");
  const aovEntry = shopMetricEntry(tables, "样本加权笔单价（元）");
  const gmvParsed: DmpShopParsed = point
    ? { kind: "exact", min: point.gmv, max: point.gmv, approximate: true, percent: false }
    : parseShopDisplay(shopEntryCell(gmvEntry, role, 0));
  const share = parseShopDisplay(shopEntryCell(shareEntry, role, 0));
  if (!shopUsable(gmvParsed) || !shopUsable(share) || !share.percent) return null;
  const lo = (newCustomer ? share.min : 100 - share.max) / 100;
  const hi = (newCustomer ? share.max : 100 - share.min) / 100;
  const aov: DmpShopParsed = point && point.price > 0
    ? { kind: "exact", min: point.price, max: point.price, percent: false }
    : parseShopDisplay(shopEntryCell(aovEntry, role, 0));
  if (!shopUsable(aov) || aov.min <= 0) return null;
  return { min: (gmvParsed.min * lo) / aov.max, max: (gmvParsed.max * hi) / aov.min };
}

function shopSpendParsed(tables: Map<string, DmpViewerTable>, role: DmpShopObjectGroup["role"]): DmpShopParsed {
  const point = shopPointFiguresFor(tables, role);
  if (point && point.spend !== null) return { kind: "exact", min: point.spend, max: point.spend, approximate: true, percent: false };
  return parseShopDisplay(shopEntryCell(shopMetricEntry(tables, "广告消耗（元）"), role, 0));
}

/** 竞店 ROI 用各推广链接上已保存的推广成交额 ÷ 推广花费。不用总GMV，也不用 30 日消耗。 */
function shopLinkRoi(tables: Map<string, DmpViewerTable>, label: string) {
  const table = tables.get("店铺竞争态势·单品样本");
  if (!table) return "";
  const gmvIndex = table.columns.indexOf("推广成交额");
  const spendIndex = table.columns.indexOf("推广花费");
  const labelIndex = table.columns.indexOf("对象");
  const itemIndex = table.columns.indexOf("商品ID");
  if (gmvIndex < 0 || spendIndex < 0 || labelIndex < 0) return "";
  let gmvCents = 0;
  let spendCents = 0;
  let used = 0;
  let listed = 0;
  for (const row of table.rows) {
    if (String(row[labelIndex] ?? "") !== label) continue;
    if (itemIndex >= 0 && String(row[itemIndex] ?? "") === "合计") continue;
    listed += 1;
    const gmv = parseShopDisplay(row[gmvIndex]);
    const spend = parseShopDisplay(row[spendIndex]);
    if (gmv.kind !== "exact" || spend.kind !== "exact" || typeof gmv.min !== "number" || typeof spend.min !== "number" || gmv.min < 0 || spend.min < 0) continue;
    gmvCents += Math.round(gmv.min * 100);
    spendCents += Math.round(spend.min * 100);
    used += 1;
  }
  if (!used || spendCents <= 0) return "";
  const value = Math.round((gmvCents / spendCents) * 100) / 100;
  const text = shopGrouped(value, 2);
  return used < listed ? `约${text}` : text;
}

/** 方向文字不展示。点击单价 = 总花费÷付费点击；转化率 = 笔数÷点击。ROI 优先用推广链接成交额÷推广花费。 */
function shopConcreteFromDirection(tables: Map<string, DmpViewerTable>, role: DmpShopObjectGroup["role"], metric: string) {
  const clicks = parseShopDisplay(shopEntryCell(shopMetricEntry(tables, "付费点击量"), role, 0));
  const orders = parseShopDisplay(shopEntryCell(shopMetricEntry(tables, "付费成交笔数"), role, 0));
  const spend = shopSpendParsed(tables, role);
  if (metric === "点击单价（元）") return shopAmountRange(shopDivide(spend, clicks, false));
  if (metric === "推广转化率") return shopPercentRange(shopDivide(orders, clicks, true), 2);
  if (metric === "当天引导ROI") return "";
  if (metric === "整体成交转化率") {
    const allOrders = parseShopDisplay(shopEntryCell(shopMetricEntry(tables, "整体成交笔数"), role, 0));
    const ipv = parseShopDisplay(shopEntryCell(shopMetricEntry(tables, "整体IPV"), role, 0));
    return shopPercentRange(shopDivide(allOrders, ipv, true), 2);
  }
  return "";
}

/** 全店经营 KPI：含派生费比与推广指标；缺行则不建卡。总览不展示客单价。 */
export function shopViewKpiCards(
  tables: Map<string, DmpViewerTable>,
  channelGroup: Array<{ role: DmpShopObjectGroup["role"]; label: string }>
): DmpShopKpiCard[] {
  const cards: DmpShopKpiCard[] = [];
  for (const spec of SHOP_VIEW_KPI_ORDER) {
    if (spec.kind === "derived") {
      const spendEntry = shopMetricEntry(tables, "广告消耗（元）");
      const gmvEntry = shopMetricEntry(tables, "成交金额（元）");
      const values = channelGroup.map(({ role, label }) => {
        const point = shopPointFiguresFor(tables, role); // R15
        if (point && point.feeRatio !== null) {
          return { role, label, current: formatShopPercent(point.feeRatio, 2), previous: "", change: "", precision: "公式" };
        }
        const ratio = shopDivide(
          parseShopDisplay(shopEntryCell(spendEntry, role, 0)),
          parseShopDisplay(shopEntryCell(gmvEntry, role, 0)),
          true
        );
        return { role, label, current: ratio ? shopPercentRange(ratio, 2) : "", previous: "", change: "", precision: "公式" };
      });
      if (!values.some((value) => String(value.current ?? "").trim())) continue;
      const subjectSpend = formatShopCell(shopEntryCell(spendEntry, "subject", 0), "ratio");
      const subjectGmv = formatShopCell(shopEntryCell(gmvEntry, "subject", 0), "ratio");
      const sampleSubject = shopSampleFeeRatioFor(tables, "subject");
      const sampleCompetitor = shopSampleFeeRatioFor(tables, "competitor-1");
      const note = [
        subjectSpend !== "—" && subjectGmv !== "—" ? `本店 = ${subjectSpend} / ${subjectGmv}` : "",
        values.length > 1 && values[1].current ? (shopPointFiguresFor(tables, "competitor-1") ? "竞店 = 推广消耗 ÷ 销售额（均为点值）" : "竞店 = 广告消耗 ÷ 成交金额（区间端点外扩）") : "",
        sampleSubject || sampleCompetitor ? `对照 样本费比 本店 ${sampleSubject || "—"} / 竞店 ${sampleCompetitor || "—"}` : ""
      ].filter(Boolean).join("；");
      cards.push({ metric: spec.metric, title: spec.title, values, relative: [], derived: true, derivedNote: note });
      continue;
    }
    const entry = shopMetricEntry(tables, spec.metric);
    const forcePromo = ["当天引导ROI", "点击单价（元）", "推广转化率"].includes(spec.metric);
    if (!entry) {
      if (forcePromo) {
        cards.push({
          metric: spec.metric,
          title: spec.title,
          values: channelGroup.map(({ role, label }) => ({ role, label, current: "", previous: "", change: "", precision: "—" })),
          relative: []
        });
      }
      continue;
    }
    const pointByRole = new Map<DmpShopObjectGroup["role"], number>(); // R15 point overrides for this card
    const values = channelGroup.map(({ role, label }) => {
      const raw = shopEntryCell(entry, role, 0);
      const parsed = parseShopDisplay(raw);
      if (parsed.kind === "text") {
        const concrete = spec.metric === "当天引导ROI" ? (shopLinkRoi(tables, label) || shopConcreteFromDirection(tables, role, spec.metric)) : shopConcreteFromDirection(tables, role, spec.metric);
        const changeRaw = shopEntryCell(entry, role, 2);
        return {
          role,
          label,
          current: concrete,
          previous: shopEntryCell(entry, role, 1),
          change: parseShopDisplay(changeRaw).kind === "text" ? "" : changeRaw,
          precision: concrete ? "公式" : "—"
        };
      }
      const point = spec.metric === "成交金额（元）" || spec.metric === "广告消耗（元）" ? shopPointFiguresFor(tables, role) : null;
      const pointValue = point ? (spec.metric === "成交金额（元）" ? point.gmv : point.spend) : null;
      if (pointValue !== null && pointValue !== undefined) {
        pointByRole.set(role, pointValue);
        return { role, label, current: `约${formatShopAmountCompact(pointValue)}`, previous: shopEntryCell(entry, role, 1), change: "", precision: "公式" };
      }
      const display = !shopUsable(parsed) ? "" : spec.kind === "amount"
        ? shopAmountRange({ min: parsed.min, max: parsed.max }, true)
        : spec.kind === "percent"
          ? shopPercentRange({ min: parsed.min, max: parsed.max }, 2)
          : spec.kind === "ratio"
            ? (parsed.min === parsed.max ? shopGrouped(parsed.min, 2) : `${shopGrouped(parsed.min, 2)}～${shopGrouped(parsed.max, 2)}`)
            : formatShopCell(raw, "count");
      const linkRoi = spec.metric === "当天引导ROI" && (parsed.kind === "missing" || !display) ? shopLinkRoi(tables, label) : "";
      return {
        role,
        label,
        current: linkRoi || (parsed.kind === "missing" ? "" : display),
        previous: shopEntryCell(entry, role, 1),
        change: shopEntryCell(entry, role, 2),
        precision: linkRoi ? "公式" : shopEntryPrecision(entry, role)
      };
    });
    if (!values.some((value) => String(value.current ?? "").trim())) {
      if (forcePromo) cards.push({ metric: spec.metric, title: spec.title, values, relative: [] });
      continue;
    }
    cards.push({
      metric: spec.metric,
      title: spec.title,
      values,
      relative: entry.layout.groups.slice(1).map((group) => {
        const competitorPoint = pointByRole.get(group.role);
        if (competitorPoint !== undefined && competitorPoint > 0) {
          const subjectParsed = parseShopDisplay(shopEntryCell(entry, "subject", 0));
          if (shopUsable(subjectParsed) && subjectParsed.min === subjectParsed.max) {
            return { role: group.role, label: group.label, value: `约${formatShopPercent((subjectParsed.min / competitorPoint - 1) * 100, 2, true)}` };
          }
        }
        return { role: group.role, label: group.label, value: group.relativeIndex >= 0 ? entry.row[group.relativeIndex] ?? "" : "" };
      })
    });
  }
  return cards;
}

// ---- 02 进店 → 全店 桥 ---------------------------------------------------------------------

interface ShopSampleTotals {
  sampleCount: number;
  exactCount: number;
  spendCount: number;
  sumN: number;
  sumGmv: number;
  averagePrice: number | null;
  sumSpend: number;
  topGmv: number;
  topItem: string;
}

function shopSampleRowsFor(table: DmpViewerTable | undefined, objectLabel: string) {
  if (!table) return [];
  const labelIndex = table.columns.indexOf("对象");
  const itemIndex = table.columns.indexOf("商品ID");
  if (labelIndex < 0 || itemIndex < 0) return [];
  return table.rows.filter((row) => String(row[labelIndex] ?? "").trim() === objectLabel
    && String(row[itemIndex] ?? "").trim() !== "合计");
}

function shopSampleTotalsFor(table: DmpViewerTable | undefined, objectLabel: string): ShopSampleTotals {
  const index = (column: string) => table?.columns.indexOf(column) ?? -1;
  const totals: ShopSampleTotals = { sampleCount: 0, exactCount: 0, spendCount: 0, sumN: 0, sumGmv: 0, averagePrice: null, sumSpend: 0, topGmv: 0, topItem: "" };
  const nIndex = index("成交笔数");
  const pIndex = index("笔单价");
  const gmvIndex = index("总GMV");
  const spendIndex = index("30日消耗");
  const precisionIndex = index("精度");
  const itemIndex = index("商品ID");
  for (const row of shopSampleRowsFor(table, objectLabel)) {
    totals.sampleCount += 1;
    const precision = String(row[precisionIndex] ?? "");
    if (!precision.startsWith("精确")) continue;
    const n = Number(row[nIndex]);
    const price = Number(row[pIndex]);
    const gmv = Number(String(row[gmvIndex] ?? "").replaceAll(",", ""));
    if (!Number.isFinite(n) || n < 0) continue;
    const rowGmv = Number.isFinite(gmv) ? gmv : (Number.isFinite(price) ? n * price : 0);
    totals.exactCount += 1;
    totals.sumN += n;
    totals.sumGmv += rowGmv;
    if (rowGmv > totals.topGmv) {
      totals.topGmv = rowGmv;
      totals.topItem = String(row[itemIndex] ?? "");
    }
    const spend = parseShopDisplay(row[spendIndex]);
    if (precision === "精确" && spend.kind === "exact" && !spend.approximate) {
      totals.spendCount += 1;
      totals.sumSpend += spend.min!;
    }
  }
  totals.averagePrice = totals.sumN > 0 ? totals.sumGmv / totals.sumN : null;
  return totals;
}

/** 02 进店 → 全店 桥（每对象三格）。 */
export function shopViewBridges(tables: Map<string, DmpViewerTable>, objects: DmpShopObject[]): DmpShopBridge[] {
  const samples = tables.get("店铺竞争态势·单品样本");
  const orderEntry = shopMetricEntry(tables, "整体成交笔数");
  const gmvEntry = shopMetricEntry(tables, "成交金额（元）");
  const coverageEntry = shopMetricEntry(tables, "样本覆盖率");
  return objects.map((object) => {
    const totals = shopSampleTotalsFor(samples, object.label);
    const point = shopPointFiguresFor(tables, object.role); // R15
    const orderParsed = parseShopDisplay(shopEntryCell(orderEntry, object.role, 0));
    const gmvParsed: DmpShopParsed = point ? { kind: "exact", min: point.gmv, max: point.gmv, approximate: true, percent: false } : parseShopDisplay(shopEntryCell(gmvEntry, object.role, 0));
    const coverageParsed: DmpShopParsed = point && totals.sumN > 0
      ? { kind: "exact", min: totals.sumN / point.orders * 100, max: totals.sumN / point.orders * 100, approximate: true, percent: true }
      : parseShopDisplay(shopEntryCell(coverageEntry, object.role, 0));
    const topShare = totals.topGmv > 0 ? shopDivide({ kind: "exact", min: totals.topGmv, max: totals.topGmv }, gmvParsed, true) : null;
    const coverage = shopUsable(coverageParsed) ? shopPercentRange({ min: coverageParsed.min, max: coverageParsed.max }, 1) : "";
    const averagePrice = totals.averagePrice === null ? "—" : shopGrouped(totals.averagePrice, 2);
    const cells: DmpShopBridgeCell[] = [
      {
        label: `单品样本（${totals.exactCount} 个精确）`,
        value: totals.sumGmv > 0 ? `Σ ${formatShopAmountCompact(totals.sumGmv)}` : "—",
        note: `${shopGrouped(totals.sumN, 0)} 笔 · 笔单价 ${averagePrice}` + (totals.sampleCount > totals.exactCount ? `（${totals.sampleCount} 个样本，仅精确样本计和）` : "")
      },
      {
        label: "× 店铺成交笔数",
        value: orderParsed.kind === "missing" ? "—" : `${formatShopCell(shopEntryCell(orderEntry, object.role, 0), "count")} 笔`,
        note: coverage ? `样本覆盖率 ${coverage}` : "样本覆盖率 —"
      },
      {
        label: "全店销售额",
        value: point ? `约${formatShopAmountCompact(point.gmv)}` : gmvParsed.kind === "missing" ? "—" : formatShopCardValue(shopEntryCell(gmvEntry, object.role, 0)),
        note: topShare ? `Top1 单品占 ${shopPercentRange(topShare, 1)}` : "Top1 单品占 —"
      }
    ];
    const notes: string[] = [];
    const precisionNote = [
      shopEntryPrecision(orderEntry, object.role),
      shopEntryPrecision(gmvEntry, object.role)
    ].filter((value) => value && value !== "—" && value !== "样本加权约值").join(" / "); // 2026-09-18: hide「样本加权」wording
    if (precisionNote) notes.push(`平台精度：${precisionNote}`);
    if (point) {
      notes.push(`全店销售额 = ${shopGrouped(point.orders, 0)} 笔 × 笔单价 ${shopGrouped(point.price, 2)} = ${formatShopAmount(point.gmv)}`);
    }
    if (totals.sampleCount > totals.exactCount) notes.push(`该对象 ${totals.sampleCount} 个样本中仅 ${totals.exactCount} 个精确，Sigma 仅计精确样本。`);
    return { role: object.role, label: object.label, cells, notes };
  });
}

function formatShopCardValue(cell: DmpCell) {
  const parsed = parseShopDisplay(cell);
  if (!shopUsable(parsed)) return String(cell ?? "");
  return shopAmountRange({ min: parsed.min, max: parsed.max }, true);
}

// ---- 03 全店渠道花费 -----------------------------------------------------------------------

/** 03 全店渠道花费：全店消耗 × 投放成本占比（区间端点外扩）。 */
export function shopViewSpend(tables: Map<string, DmpViewerTable>, objects: DmpShopObject[]): DmpShopSpendSection {
  const structure = shopLayoutOf(tables.get("店铺竞争态势·投放结构"));
  const spendEntry = shopMetricEntry(tables, "广告消耗（元）");
  const rows: DmpShopSpendRow[] = [];
  const channelIndex = structure?.table.columns.indexOf("渠道 / 客群") ?? -1;
  if (structure && channelIndex >= 0) {
    for (const row of structure.table.rows) {
      const channel = String(row[channelIndex] ?? "").trim();
      if (!channel) continue;
      const shareCell = (role: DmpShopObjectGroup["role"], offset: number) => {
        const group = structure.layout.groups.find((candidate) => candidate.role === role);
        return group ? row[group.start + offset] ?? "" : "";
      };
      const values: DmpShopSpendValue[] = objects.map((object) => {
        const shareNow = parseShopDisplay(shareCell(object.role, 0));
        const sharePrevious = parseShopDisplay(shareCell(object.role, 1));
        const pointFigures = shopPointFiguresFor(tables, object.role); // R15
        const base: DmpShopParsed = pointFigures && pointFigures.spend !== null
          ? { kind: "exact", min: pointFigures.spend, max: pointFigures.spend, approximate: true, percent: false }
          : parseShopDisplay(shopEntryCell(spendEntry, object.role, 0));
        // 占比单元格按 % 单位解析（与插件 parseDisplay 一致），相乘前换算为分数。
        const shareRatio: DmpShopParsed = shareNow.kind === "exact" || shareNow.kind === "interval"
          ? { kind: "interval", min: shareNow.min! / 100, max: shareNow.max! / 100, percent: false }
          : { kind: "missing" };
        const spend = shopMultiply(base, shareRatio);
        const pp = shareNow.kind === "exact" && sharePrevious.kind === "exact" ? shareNow.min! - sharePrevious.min! : null;
        return {
          role: object.role,
          label: object.label,
          share: shopUsable(shareNow) ? shopPercentRange({ min: shareNow.min, max: shareNow.max }, 2) : "—",
          shareWidth: shopUsable(shareNow) ? Math.max(0, Math.min(100, shareNow.min)) : 0,
          sharePrevious: shopUsable(sharePrevious) ? shopPercentRange({ min: sharePrevious.min, max: sharePrevious.max }, 2) : "—",
          spend: spend ? (pointFigures && pointFigures.spend !== null ? `约${shopAmountRange(spend)}` : shopAmountRange(spend)) : "—",
          pp: pp === null ? "—" : `${pp > 0 ? "+" : ""}${shopGrouped(pp, 1)}pp`,
          trend: pp === null ? "" : pp > 0 ? "up" : pp < 0 ? "down" : "",
          precision: "公式"
        };
      });
      rows.push({ channel, values });
    }
  }
  const totals: DmpShopSpendValue[] = objects.map((object) => {
    const raw = shopEntryCell(spendEntry, object.role, 0);
    const parsed = parseShopDisplay(raw);
    const pointFigures = shopPointFiguresFor(tables, object.role); // R15
    const pointSpend = pointFigures && pointFigures.spend !== null ? pointFigures.spend : null;
    return {
      role: object.role,
      label: object.label,
      share: "100%",
      shareWidth: 100,
      sharePrevious: "100%",
      spend: pointSpend !== null ? `约${formatShopAmount(pointSpend)}` : shopUsable(parsed) ? shopAmountRange({ min: parsed.min, max: parsed.max }) : "—",
      pp: "—",
      trend: "",
      precision: pointSpend !== null ? "公式" : shopEntryPrecision(spendEntry, object.role)
    };
  });
  const notes: string[] = [];
  const competitorShift = rows
    .map((row) => ({ row, value: row.values[1] }))
    .filter((entry) => entry.value && (entry.value.trend === "up" || entry.value.trend === "down"))
    .sort((left, right) => Math.abs(Number.parseFloat(right.value.pp) || 0) - Math.abs(Number.parseFloat(left.value.pp) || 0))[0];
  if (competitorShift) {
    notes.push(`结构变化：竞店「${competitorShift.row.channel}」占比 ${competitorShift.value.sharePrevious} → ${competitorShift.value.share}（${competitorShift.value.pp}）。`);
  }
  const subjectOnly = rows.filter((row) => row.values[0] && row.values[0].spend !== "—" && row.values[0].spend !== "0.00").map((row) => row.channel);
  notes.push(subjectOnly.length
    ? `本店本期有消耗的投放渠道：${subjectOnly.join("、")}；其余渠道未投放（—）。`
    : "本店本期投放结构未披露消耗归属。");
  notes.push("各渠道消耗为派生值（全店广告消耗 × 投放成本占比），区间按端点相乘并向外取整；合计行仍为平台广告消耗原值。");
  return { rows, totals, notes };
}
// ---- 04 渠道表现对标 -----------------------------------------------------------------------

const SHOP_VIEW_KPI_ORDER: Array<{ metric: string; title: string; kind: "amount" | "count" | "percent" | "ratio" | "derived" }> = [
  { metric: "成交金额（元）", title: "全店销售额（元）", kind: "amount" },
  { metric: "广告消耗（元）", title: "全店推广消耗（元）", kind: "amount" },
  { metric: "全店费比", title: "全店费比", kind: "derived" },
  { metric: "当天引导ROI", title: "当天引导ROI", kind: "ratio" },
  { metric: "点击单价（元）", title: "点击单价（元）", kind: "amount" },
  { metric: "推广转化率", title: "转化率", kind: "percent" },
  { metric: "整体成交笔数", title: "整体成交笔数", kind: "count" },
  { metric: "样本加权笔单价（元）", title: "笔单价（元）", kind: "amount" },
  { metric: "整体成交转化率", title: "整体成交转化率", kind: "percent" },
  { metric: "新客成交金额占比", title: "新客成交金额占比", kind: "percent" }
];

const SHOP_CHANNEL_METRICS: Array<{ metric: string; kind: "count" | "percent" | "ratio" }> = [
  { metric: "成交笔数", kind: "count" },
  { metric: "点击量", kind: "count" },
  { metric: "支付转化率", kind: "percent" },
  { metric: "直接投产比", kind: "ratio" }
];

const SHOP_ATTRIBUTION_LABELS = ["广告域归因", "全域归因"];

/** 04 渠道表现对标：一级渠道默认展开、二级折叠；全域组附本店成交结构条。 */
export function shopViewChannelGroups(tables: Map<string, DmpViewerTable>, objects: DmpShopObject[]): DmpShopChannelGroup[] {
  const entry = shopLayoutOf(tables.get("店铺竞争态势·渠道表现"));
  if (!entry) return [];
  const { table, layout } = entry;
  const channelIndex = table.columns.indexOf("渠道 / 客群");
  const attributionIndex = table.columns.indexOf("归因范围");
  const metricIndex = table.columns.indexOf("指标");
  if (channelIndex < 0 || attributionIndex < 0 || metricIndex < 0) return [];

  const metricValues = (channel: string, metric: string, kind: "count" | "percent" | "ratio"): DmpShopViewValue[] => {
    const row = table.rows.find((candidate) => String(candidate[channelIndex] ?? "").trim() === channel
      && String(candidate[metricIndex] ?? "").trim() === metric);
    const cell: ShopTableCell | undefined = row ? { table, layout, index: 0, row } : undefined;
    return objects.map((object) => shopValue(cell, object.role, object.label, metric, kind));
  };

  const groups: DmpShopChannelGroup[] = [];
  for (const attribution of SHOP_ATTRIBUTION_LABELS) {
    const rows = table.rows.filter((row) => String(row[attributionIndex] ?? "").trim() === attribution);
    const order: string[] = [];
    for (const row of rows) {
      const channel = String(row[channelIndex] ?? "").trim();
      if (channel && !order.includes(channel)) order.push(channel);
    }
    const oneLevel = order.filter((channel) => !channel.includes(" / "));
    const channelRows: DmpShopChannelRow[] = oneLevel.map((channel) => ({
      channel,
      metrics: SHOP_CHANNEL_METRICS.map((spec) => ({ metric: spec.metric, values: metricValues(channel, spec.metric, spec.kind) })),
      subs: order.filter((candidate) => candidate.startsWith(`${channel} / `)).map((sub) => ({
        channel: sub,
        metrics: SHOP_CHANNEL_METRICS.map((spec) => ({ metric: spec.metric, values: metricValues(sub, spec.metric, spec.kind) })),
        subs: []
      }))
    }));

    const structure: DmpShopStructureBar[] = [];
    let structureTotal = 0;
    const shares: Array<{ channel: string; value: number; competitor: string }> = [];
    for (const channel of oneLevel) {
      const subjectRow = rows.find((row) => String(row[channelIndex] ?? "").trim() === channel && String(row[metricIndex] ?? "").trim() === "成交笔数");
      if (!subjectRow) continue;
      const subject = shopCellAt({ table, layout, index: 0, row: subjectRow }, "subject", 0, "成交笔数");
      const competitorCell = shopEntryFromGroups(layout, subjectRow, "competitor-1");
      const competitorParsed = parseShopDisplay(competitorCell);
      const competitorText = shopUsable(competitorParsed) ? formatShopCell(competitorCell, "count") : "—";
      const positiveCompetitor = shopUsable(competitorParsed) && competitorParsed.min > 0;
      if (subject.kind === "exact" && subject.min! > 0) {
        structureTotal += subject.min!;
        shares.push({ channel, value: subject.min!, competitor: competitorText });
      } else if (positiveCompetitor) {
        shares.push({ channel, value: 0, competitor: competitorText });
      }
    }
    shares.sort((left, right) => right.value - left.value);
    for (const item of shares) {
      const share = structureTotal > 0 && item.value > 0 ? (item.value / structureTotal) * 100 : 0;
      structure.push({
        channel: item.channel,
        label: item.channel,
        share: item.value > 0 ? formatShopPercent(share, 1) : "—",
        width: Math.max(0, Math.min(100, share)),
        detail: item.value > 0
          ? `${shopGrouped(item.value, 0)} 笔 · ${formatShopPercent(share, 1)} ｜ 竞店 ${item.competitor}`
          : `本店 — ｜ 竞店 ${item.competitor}`
      });
    }
    const structureNote = structureTotal > 0
      ? `本店共 ${shopGrouped(structureTotal, 0)} 笔有渠道归属（仅精确值计入分母）；竞店各渠道为平台区间。`
      : "本店成交笔数无精确渠道归属，结构条不可用。";

    const notes: string[] = [];
    if (attribution === "广告域归因") {
      const missingSubject = channelRows
        .filter((row) => {
          const subjectMetric = row.metrics[0]?.values.find((value) => value.role === "subject");
          const competitorMetric = row.metrics[0]?.values.find((value) => value.role !== "subject");
          return subjectMetric?.display === "—" && competitorMetric && competitorMetric.display !== "—";
        })
        .map((row) => row.channel);
      if (missingSubject.length) notes.push(`本店在 ${missingSubject.join(" / ")} 无数据（未投放），竞店同渠道有成交——「竞店做了、本店没做」清单。`);
    }
    if (attribution === "全域归因") {
      notes.push("全域组按渠道展示本店 / 竞店本期四指标；一级渠道默认展开，二级渠道折叠在每条一级行下方。");
    }
    groups.push({ attribution, label: attribution, rows: channelRows, structure, structureNote, notes });
  }
  return groups;
}

function shopEntryFromGroups(layout: DmpShopLayout, row: DmpCell[], role: DmpShopObjectGroup["role"]): DmpCell {
  const group = layout.groups.find((candidate) => candidate.role === role);
  return group ? row[group.start] ?? "" : "";
}

// ---- 05 流量结构 + 新老客 -------------------------------------------------------------------

const SHOP_TRAFFIC_ROWS = ["付费", "免费搜索", "免费推荐", "免费其他"];

/** 05 付费 / 免费流量堆叠条 + 本店付费占比派生 + 新老客结构表。 */
export function shopViewTraffic(tables: Map<string, DmpViewerTable>, objects: DmpShopObject[]): DmpShopTrafficSection {
  const entry = shopLayoutOf(tables.get("店铺竞争态势·付费与免费流量"));
  const stacks: DmpShopTrafficStack[] = [];
  if (entry) {
    const channelIndex = entry.table.columns.indexOf("渠道 / 客群");
    for (const object of objects) {
      const bars: DmpShopTrafficBar[] = [];
      for (const channel of SHOP_TRAFFIC_ROWS) {
        const row = entry.table.rows.find((candidate) => String(candidate[channelIndex] ?? "").trim() === channel);
        if (!row) continue;
        const parsed = shopCellAt({ table: entry.table, layout: entry.layout, index: 0, row }, object.role, 0, "流量占比");
        const share = shopUsable(parsed) ? parsed.min! : 0;
        bars.push({
          channel,
          share: shopUsable(parsed) ? shopPercentRange({ min: parsed.min!, max: parsed.max! }, 2) : "—",
          width: Math.max(0, Math.min(100, share))
        });
      }
      stacks.push({ role: object.role, label: object.label, bars, note: "" });
    }
  }

  const paidEntry = shopMetricEntry(tables, "付费点击量");
  const ipvEntry = shopMetricEntry(tables, "整体IPV");
  const paidParsed = parseShopDisplay(shopEntryCell(paidEntry, "subject", 0));
  const ipvParsed = parseShopDisplay(shopEntryCell(ipvEntry, "subject", 0));
  const paidRatio = shopDivide(paidParsed, ipvParsed, true);
  const paidDerived = paidRatio ? shopPercentRange(paidRatio, 1) : "";
  const paidNote = paidDerived
    ? `本店「付费流量占比」平台未披露（—），按 付费点击量 ${formatShopCell(shopEntryCell(paidEntry, "subject", 0), "count")} ÷ 整体 IPV ${formatShopCell(shopEntryCell(ipvEntry, "subject", 0), "count")} 公式补位 ≈ ${paidDerived}，标「公式」，不写入 canonical。`
    : "本店「付费流量占比」平台未披露，且 付费点击量 / 整体 IPV 不足（需两者均为精确值）→ 留空。";
  const subjectStack = stacks.find((stack) => stack.role === "subject");
  if (subjectStack) subjectStack.note = paidDerived ? `付费占比 缺失（公式补位 ${paidDerived}）` : "付费占比 缺失";
  for (const stack of stacks) {
    if (stack.role !== "subject") {
      const paidBar = stack.bars.find((bar) => bar.channel === "付费");
      if (paidBar && paidBar.share !== "—") stack.note = `付费占比 ${paidBar.share}`;
    }
  }

  const customers: DmpShopCustomerRow[] = [];
  const customerEntry = shopLayoutOf(tables.get("店铺竞争态势·购买新老客结构"));
  if (customerEntry) {
    const groupIndex = customerEntry.table.columns.indexOf("渠道 / 客群");
    const metricIndex = customerEntry.table.columns.indexOf("指标");
    for (const row of customerEntry.table.rows) {
      const group = String(row[groupIndex] ?? "").trim();
      const metric = String(row[metricIndex] ?? "").trim();
      if (!group || !metric) continue;
      const kind: "count" | "percent" = /率|占比/.test(metric) ? "percent" : "count";
      const values = objects.map((object) => {
        const cell: ShopTableCell = { table: customerEntry.table, layout: customerEntry.layout, index: 0, row };
        const parsedRoleValue = shopCellAt(cell, object.role, 0, metric);
        const change = shopCellAt(cell, object.role, 2, metric);
        return {
          role: object.role,
          label: object.label,
          current: shopValue(cell, object.role, object.label, metric, kind).display,
          change: parsedRoleValue.kind === "missing" ? "" : formatShopChange(change),
          trend: change.kind === "exact" ? (change.min! > 0 ? "up" as const : change.min! < 0 ? "down" as const : "" as const) : "",
          badge: shopValue(cell, object.role, object.label, metric, kind).badge,
          precision: shopPrecisionAt(cell, object.role)
        };
      });
      customers.push({ group, metric, kind, values });
    }
    for (const row of customers) {
      const isNew = row.group.includes("新客");
      const isOld = row.group.includes("老客");
      if ((!isNew && !isOld) || (row.metric !== "成交笔数" && row.metric !== "支付转化率")) continue;
      const clickRow = customerEntry.table.rows.find((candidate) => String(candidate[groupIndex] ?? "").trim() === row.group
        && String(candidate[metricIndex] ?? "").trim() === "点击量");
      row.values = objects.map((object, index) => {
        const derived = shopCrowdOrders(tables, object.role, isNew);
        if (!derived) return row.values[index];
        if (row.metric === "成交笔数") {
          const lo = Math.floor(derived.min), hi = Math.ceil(derived.max);
          if (hi < lo) return row.values[index];
          return {
            ...row.values[index],
            current: `约${lo === hi ? shopGrouped(lo, 0) : `${shopGrouped(lo, 0)}～${shopGrouped(hi, 0)}`}`,
            change: "",
            trend: "" as const,
            badge: "formula" as DmpShopCustomerValue["badge"],
            precision: "公式"
          };
        }
        const clicks = clickRow
          ? shopCellAt({ table: customerEntry.table, layout: customerEntry.layout, index: 0, row: clickRow }, object.role, 0, "点击量")
          : { kind: "missing" as const };
        if (!shopUsable(clicks) || clicks.min <= 0) return row.values[index];
        const conv = { min: derived.min / clicks.max, max: derived.max / clicks.min };
        const lo = shopFloor(conv.min * 100), hi = shopCeil(conv.max * 100);
        if (hi < lo) return row.values[index];
        return {
          ...row.values[index],
          current: `约${lo === hi ? formatShopPercent(lo, 2) : `${formatShopPercent(lo, 2)}～${formatShopPercent(hi, 2)}`}`,
          change: "",
          trend: "" as const,
          badge: "formula" as DmpShopCustomerValue["badge"],
          precision: "公式"
        };
      });
    }
  }
  const shareEntry = shopMetricEntry(tables, "新客成交金额占比");
  if (shareEntry) {
    customers.push({
      group: "—",
      metric: "新客成交金额占比",
      kind: "percent",
      values: objects.map((object) => {
        const cell: ShopTableCell = { table: shareEntry.table, layout: shareEntry.layout, index: 0, row: shareEntry.row };
        const change = shopCellAt(cell, object.role, 2, "新客成交金额占比");
        return {
          role: object.role,
          label: object.label,
          current: shopValue(cell, object.role, object.label, "新客成交金额占比", "percent").display,
          change: formatShopChange(change),
          trend: change.kind === "exact" ? (change.min! > 0 ? "up" as const : change.min! < 0 ? "down" as const : "" as const) : "",
          badge: shopValue(cell, object.role, object.label, "新客成交金额占比", "percent").badge,
          precision: shopPrecisionAt(cell, object.role)
        };
      })
    });
    // R15: 新客 / 老客成交金额 = 全店销售额（本店平台值 / 竞店点值）× 占比（占比为平台区间时结果仍为区间，不取中点）。
    const gmvEntry = shopMetricEntry(tables, "成交金额（元）");
    const amountRows: Array<{ metric: string; newCustomer: boolean }> = [
      { metric: "新客成交金额（元）", newCustomer: true },
      { metric: "老客成交金额（元）", newCustomer: false }
    ];
    for (const spec of amountRows) {
      const values = objects.map((object) => {
        const point = shopPointFiguresFor(tables, object.role);
        const gmvParsed: DmpShopParsed = point
          ? { kind: "exact", min: point.gmv, max: point.gmv, approximate: true, percent: false }
          : parseShopDisplay(shopEntryCell(gmvEntry, object.role, 0));
        const share = parseShopDisplay(shopEntryCell(shareEntry, object.role, 0));
        const ratio: DmpShopParsed = shopUsable(share)
          ? { kind: "interval", min: (spec.newCustomer ? share.min : 100 - share.max) / 100, max: (spec.newCustomer ? share.max : 100 - share.min) / 100, percent: false }
          : { kind: "missing" };
        const amount = shopMultiply(gmvParsed, ratio);
        const approximate = Boolean(point) || (shopUsable(share) && share.min !== share.max);
        return {
          role: object.role,
          label: object.label,
          current: amount ? `${approximate ? "约" : ""}${shopAmountRange(amount, true)}` : "—",
          change: "—",
          trend: "" as const,
          badge: "formula" as DmpShopCustomerValue["badge"],
          precision: "公式"
        };
      });
      if (values.some((value) => value.current !== "—")) customers.push({ group: "—", metric: spec.metric, kind: "count", values });
    }
    const orderShareRows: Array<{ metric: string; newCustomer: boolean }> = [
      { metric: "新客成交笔数占比", newCustomer: true },
      { metric: "老客成交笔数占比", newCustomer: false }
    ];
    const ordersEntry = shopMetricEntry(tables, "整体成交笔数");
    for (const spec of orderShareRows) {
      const values = objects.map((object) => {
        const derived = shopCrowdOrders(tables, object.role, spec.newCustomer);
        const point = shopPointFiguresFor(tables, object.role);
        const shopOrders: DmpShopParsed = point
          ? { kind: "exact", min: point.orders, max: point.orders, percent: false }
          : parseShopDisplay(shopEntryCell(ordersEntry, object.role, 0));
        if (!derived || !shopUsable(shopOrders) || shopOrders.min <= 0) {
          return { role: object.role, label: object.label, current: "—", change: "—", trend: "" as const, badge: "missing" as DmpShopCustomerValue["badge"], precision: "—" };
        }
        const lo = shopFloor(Math.max(0, derived.min / shopOrders.max) * 100);
        const hi = shopCeil((derived.max / shopOrders.min) * 100);
        return {
          role: object.role,
          label: object.label,
          current: hi < lo ? "—" : `约${lo === hi ? formatShopPercent(lo, 2) : `${formatShopPercent(lo, 2)}～${formatShopPercent(hi, 2)}`}`,
          change: "—",
          trend: "" as const,
          badge: "formula" as DmpShopCustomerValue["badge"],
          precision: "公式"
        };
      });
      if (values.some((value) => value.current !== "—")) customers.push({ group: "—", metric: spec.metric, kind: "percent", values });
    }
  }
  const notes = [paidNote];
  const oldCustomer = customers.find((row) => row.group.includes("老客") && row.metric === "支付转化率");
  const newCustomer = customers.find((row) => row.group.includes("新客") && row.metric === "支付转化率");
  if (oldCustomer && newCustomer) {
    const subjectOld = oldCustomer.values.find((value) => value.role === "subject");
    const subjectNew = newCustomer.values.find((value) => value.role === "subject");
    if (subjectOld && subjectNew) notes.push(`本店新客转化 ${subjectNew.current}（环比 ${subjectNew.change || "—"}）、老客转化 ${subjectOld.current}（环比 ${subjectOld.change || "—"}）。`);
  }
  return { stacks, paidDerived, paidNote, customers, notes };
}

function formatShopChange(parsed: DmpShopParsed) {
  if (parsed.kind === "text") return parsed.text ?? "";
  if (!shopUsable(parsed)) return "";
  return parsed.min === parsed.max ? formatShopPercent(parsed.min, 0) : shopPercentRange({ min: parsed.min, max: parsed.max }, 0);
}

// ---- 06 单品样本增强 -----------------------------------------------------------------------

export function hideShopSampleWording(text: string) {
  return String(text ?? "")
    .replace(/本店样本费比/g, "本店单品费比")
    .replace(/样本费比/g, "单品费比")
    .replace(/样本加权约值/g, "")
    .replace(/样本加权/g, "")
    .replace(/精确样本/g, "精确商品")
    .replace(/样本单品/g, "投放商品")
    .replace(/样本笔数/g, "商品笔数")
    .replace(/个样本/g, "个商品")
    .replace(/样本合计/g, "商品合计")
    .replace(/样本未取数/g, "商品未取数")
    .replace(/样本不足以/g, "商品不足以")
    .replace(/其余样本聚合行（仅展示）/g, "其余商品")
    .replace(/样本聚合/g, "商品合计")
    .replace(/打爆路径/g, "");
}

/** 06 重点单品：保留 12 列 + 追加「占全店GMV」；全部商品展开，不聚合。 */
export function shopViewSamples(tables: Map<string, DmpViewerTable>, objects: DmpShopObject[]): DmpShopSampleSection {
  const table = tables.get("店铺竞争态势·单品样本");
  const empty: DmpShopSampleSection = { columns: [], shareAfterColumn: "总GMV", rows: [], notes: [], concentration: "" };
  if (!table) return empty;
  const index = (column: string) => table.columns.indexOf(column);
  const labelIndex = index("对象");
  const itemIndex = index("商品ID");
  const gmvIndex = index("总GMV");
  const nIndex = index("成交笔数");
  const pIndex = index("笔单价");
  const spendIndex = index("30日消耗");
  const sourceIndex = index("来源");
  const precisionIndex = index("精度");
  const gmvOf = (row: DmpCell[]) => {
    const numeric = Number(String(row[gmvIndex] ?? "").replaceAll(",", ""));
    if (Number.isFinite(numeric) && numeric !== 0) return numeric;
    const n = Number(row[nIndex]);
    const price = Number(row[pIndex]);
    return Number.isFinite(n) && Number.isFinite(price) ? n * price : 0;
  };
  const gmvParsedByRole = new Map<DmpShopObjectGroup["role"], DmpShopParsed>();
  for (const object of objects) {
    const entry = shopMetricEntry(tables, "成交金额（元）");
    const pointFigures = shopPointFiguresFor(tables, object.role); // R15: 占全店GMV 分母用点值销售额
    gmvParsedByRole.set(object.role, pointFigures
      ? { kind: "exact", min: pointFigures.gmv, max: pointFigures.gmv, approximate: true, percent: false }
      : parseShopDisplay(shopEntryCell(entry, object.role, 0)));
  }

  const rows: DmpShopSampleRow[] = [];
  for (const object of objects) {
    const objectRows = table.rows.filter((row) => String(row[labelIndex] ?? "").trim() === object.label);
    const detail = objectRows.filter((row) => String(row[itemIndex] ?? "").trim() !== "合计");
    const totalRow = objectRows.find((row) => String(row[itemIndex] ?? "").trim() === "合计");
    const denominator = gmvParsedByRole.get(object.role) ?? { kind: "missing" as const };
    const push = (cells: DmpCell[], aggregate: boolean, note: string) => {
      const share = shopDivide({ kind: "exact", min: gmvOf(cells), max: gmvOf(cells) }, denominator, true);
      rows.push({
        role: object.role,
        label: object.label,
        cells,
        share: share ? shopPercentRange(share, 1) : "—",
        total: String(cells[itemIndex] ?? "").trim() === "合计",
        aggregate,
        precisionNote: note || String(cells[precisionIndex] ?? "")
      });
    };
    const sorted = [...detail].sort((left, right) => gmvOf(right) - gmvOf(left));
    for (const row of sorted) push(row, false, object.role === "subject" ? "本店货清单商品" : "竞店货清单商品");
    if (totalRow) push(totalRow, false, "商品合计行");
  }

  const totalsByRole = new Map<DmpShopObjectGroup["role"], ShopSampleTotals>();
  for (const object of objects) totalsByRole.set(object.role, shopSampleTotalsFor(table, object.label));
  const concentrationParts: string[] = [];
  const subjectTotals = totalsByRole.get("subject");
  const subjectGmv = gmvParsedByRole.get("subject");
  if (subjectTotals && subjectTotals.topGmv > 0) {
    const share = shopDivide({ kind: "exact", min: subjectTotals.topGmv, max: subjectTotals.topGmv }, subjectGmv ?? { kind: "missing" }, true);
    if (share) concentrationParts.push(`本店 Top1 单品（${subjectTotals.topItem}）占全店 ${shopPercentRange(share, 1)}`);
  }
  for (const object of objects) {
    if (object.role === "subject") continue;
    const totals = totalsByRole.get(object.role);
    if (!totals || totals.topGmv <= 0) continue;
    const share = shopDivide({ kind: "exact", min: totals.topGmv, max: totals.topGmv }, gmvParsedByRole.get(object.role) ?? { kind: "missing" }, true);
    if (share) concentrationParts.push(`${object.label} Top1 仅占 ${shopPercentRange(share, 1)}`);
  }
  const concentration = concentrationParts.length
    ? `${concentrationParts.join("，")}——本店集中度显著高于竞店时属单品依赖型，竞店为多爆款矩阵。`
    : "商品不足以计算头部集中度。";

  const notes: string[] = [hideShopSampleWording(concentration)].filter(Boolean);
  return { columns: [...table.columns], shareAfterColumn: "总GMV", rows, notes, concentration: hideShopSampleWording(concentration) };
}

// ---- 07 数据说明与待补项 -------------------------------------------------------------------

export function shopViewDaily(tables: Map<string, DmpViewerTable>, objects: DmpShopObject[]): DmpShopDailySection {
  const table = tables.get("店铺竞争态势·逐日趋势");
  const empty: DmpShopDailySection = { dates: [], byDate: {}, series: [], charts: [] };
  if (!table) return empty;
  const dates = [...new Set(table.rows.map((row) => String(row[3] ?? "")).filter((date) => /^20\d{2}-\d{2}-\d{2}$/.test(date)))].sort();
  const byDate: Record<string, DmpShopDailyCell[]> = {};
  for (const date of dates) {
    byDate[date] = objects.map((object) => {
      const pick = (metric: string) => {
        const row = table.rows.find((candidate) => String(candidate[1] ?? "") === object.id && String(candidate[3] ?? "") === date && String(candidate[4] ?? "") === metric);
        return row ? String(row[5] ?? "") : "";
      };
      return {
        role: object.role,
        label: object.label,
        gmv: pick("成交金额（元）"),
        spend: pick("广告消耗（元）"),
        fee: pick("费比"),
        roi: pick("当天引导ROI"),
        orders: pick("付费成交笔数"),
        aov: pick("推广客单价（元）"),
        ppc: pick("点击单价（元）"),
        cvr: pick("推广转化率"),
        cart: pick("推广加购率")
      };
    });
  }
  const series = [
    { title: "本店日销售额", values: dates.map((date) => byDate[date]?.[0]?.gmv || "") },
    { title: "竞店日销售额", values: dates.map((date) => byDate[date]?.[1]?.gmv || "") },
    { title: "本店日消耗", values: dates.map((date) => byDate[date]?.[0]?.spend || ""), hover: true },
    { title: "竞店日消耗", values: dates.map((date) => byDate[date]?.[1]?.spend || ""), hover: true }
  ].filter((item) => item.values.some(Boolean));
  const chartSpecs: Array<[string, keyof DmpShopDailyCell]> = [
    ["日销售额", "gmv"], ["日消耗", "spend"], ["日费比", "fee"], ["日引导ROI", "roi"],
    ["日单量", "orders"], ["日客单价", "aov"], ["日点击单价", "ppc"], ["日转化率", "cvr"], ["日加购率", "cart"]
  ];
  const charts: DmpShopDailyChart[] = chartSpecs.map(([title, key]) => ({
    title,
    series: objects.map((object, index) => ({
      label: object.label,
      role: object.role,
      values: dates.map((date): number | null => {
        const raw = byDate[date]?.[index]?.[key];
        const parsed = parseShopDisplay(typeof raw === "string" ? raw : "");
        return parsed.kind === "exact" && typeof parsed.min === "number" ? parsed.min : null;
      })
    }))
  })).filter((chart) => chart.series.some((item) => item.values.some((value) => value != null)));
  return { dates, byDate, series, charts };
}

export function shopViewNotes(shopNotes: string[], sections: {
  paidDerived: string;
  competitorOrderPreviousMissing: boolean;
  competitorPointEstimate: boolean;
  hasDaily: boolean;
}, tables: Map<string, DmpViewerTable>): DmpShopNote[] {
  const notes: DmpShopNote[] = shopNotes.filter(Boolean).map((text) => ({ kind: "说明" as const, text: hideShopSampleWording(text) }));
  if (!sections.hasDaily) {
    notes.push({ kind: "缺", text: "全店日趋势未返回逐日序列，环比上的日值保持留空。" });
  }
  if (sections.competitorOrderPreviousMissing) {
    notes.push({ kind: "缺", text: "上期广告消耗未返回，环比留空。" });
  }
  const point = shopPointFiguresFor(tables, "competitor-1"); // R15
  if (point) {
    const inside = point.platformGmv ? `，落在平台区间 ${formatShopAmount(point.platformGmv.min)}～${formatShopAmount(point.platformGmv.max)} 内` : "";
    notes.push({ kind: "说明", text: `竞店全店销售额 = 成交笔数 ${shopGrouped(point.orders, 0)} × 笔单价 ${shopGrouped(point.price, 2)} = ${formatShopAmount(point.gmv)}${inside}；推广消耗 = 销售额 × 费比 ${point.feeRatio === null ? "—" : formatShopPercent(point.feeRatio, 2)}${point.spend === null ? "" : ` = ${formatShopAmount(point.spend)}`}。各渠道消耗、占全店GMV、新老客成交金额均按此点值计算；仍为区间的指标（新老客成交笔数、转化率、占比）保持平台区间，不取中点。` });
  } else if (sections.competitorPointEstimate) {
    notes.push({ kind: "建议", text: "竞店成交笔数用「控比反推」点估收窄销售额区间，不替代平台区间。" });
  }
  notes.push({ kind: "建议", text: "本店消耗始终用平台值；竞店仍为计算衍生字段。新老客成交笔数、转化率、占比保持平台区间，不取中点。" });
  const benchmark = tables.get("对标总表");
  if (benchmark) notes.push({ kind: "说明", text: `对标总表（${benchmark.rows.length} 行）与渠道表现全表折叠在本页末尾，供导出核对。` });
  return notes;
}

// ---- 派生入口 -----------------------------------------------------------------------------

const SHOP_VIEW_BLOCKS: DmpShopBlockMeta[] = [
  { code: "01", title: "全店经营 KPI", note: "每张卡：本店 / 竞店 / 相对差；右上角为精度" },
  { code: "02", title: "进店 → 全店：投放商品如何推出全店销售额", note: "回答「商品表里的单品数字，和全店到底什么关系」" },
  { code: "03", title: "全店渠道花费对比", note: "全店消耗 × 投放成本占比 = 各渠道消耗" },
  { code: "04", title: "全店渠道表现对标", note: "一级渠道默认展开；二级渠道折叠" },
  { code: "05", title: "付费 / 免费流量结构 + 新老客", note: "店铺版的一级 / 二级场景替代" },
  { code: "06", title: "重点单品对比", note: "" },
  { code: "07", title: "全店日趋势", note: "同一日期坐标对比本店与竞店。柱状图只画已取到的精确日值；区间不取中点。下方表格保留全部日期。" },
  { code: "08", title: "数据说明", note: "报告总览「数据说明」全部列出" }
];

/** v2.3.103 (R14)：从店铺 canonical 表派生 01–07 七区块展示模型；无法识别店铺版式 → null。 */
export function deriveShopView(tables: DmpViewerTable[]): DmpShopView | null {
  const prepared = tables.map((table) => table.shopLayout ? table : { ...table, shopLayout: detectShopLayout(table.columns) || undefined });
  const layoutTable = prepared.find((table) => table.shopLayout);
  if (!layoutTable?.shopLayout) return null;
  const byName = new Map(prepared.map((table) => [table.name, table]));
  const objects = shopObjectsFromOverview(byName.get("报告总览"), layoutTable.shopLayout.groups);
  if (!objects.length) return null;
  const channelGroup = objects.map(({ role, label }) => ({ role, label }));

  const kpis = shopViewKpiCards(byName, channelGroup);
  const bridges = shopViewBridges(byName, objects);
  const spend = shopViewSpend(byName, objects);
  const channelGroups = shopViewChannelGroups(byName, objects);
  const traffic = shopViewTraffic(byName, objects);
  const samples = shopViewSamples(byName, objects);
  const daily = shopViewDaily(byName, objects);

  const spendEntry = shopMetricEntry(byName, "广告消耗（元）");
  const competitorPrevious = parseShopDisplay(shopEntryCell(spendEntry, "competitor-1", 1));
  const competitorOrder = parseShopDisplay(shopEntryCell(shopMetricEntry(byName, "整体成交笔数"), "competitor-1", 0));
  const coverage = parseShopDisplay(shopEntryCell(shopMetricEntry(byName, "样本覆盖率"), "competitor-1", 0));

  const rawNotes = (byName.get("报告总览")?.rows ?? [])
    .filter((row) => String(row[0] ?? "") === "数据说明")
    .map((row) => String(row[2] ?? ""))
    .filter(Boolean);
  const notes = shopViewNotes(rawNotes, {
    paidDerived: traffic.paidDerived,
    competitorOrderPreviousMissing: competitorPrevious.kind === "missing",
    competitorPointEstimate: Boolean(competitorOrder.approximate) && coverage.kind === "interval",
    hasDaily: daily.dates.length > 0
  }, byName);

  return { objects, blocks: SHOP_VIEW_BLOCKS, kpis, bridges, spend, channelGroups, traffic, samples, daily, notes };
}
