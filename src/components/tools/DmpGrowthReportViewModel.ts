import { canonicalToDmpReport, type DmpCell, type DmpReportTable } from "@/lib/dmp-report-import";
import {
  sanitizeDmpRenderHttpsUrl,
  sanitizeDmpRenderImageUrl,
  type DmpBusinessReportRecord
} from "@/lib/dmp-report-types";

const CORE_TABLES = new Set(["报告总览", "商品与成功品", "对标总表", "周期汇总", "基础指标对比"]);
const FORBIDDEN_VISIBLE = /接口清单|页面字段映射|系统诊断|方法与证据|结构解读|业务解读|复盘结论|判断|建议动作|证据等级|校验状态|反推口径|备注|(?:^|\s)请求(?:$|\s)|GMV指数|指数变化|平均GMV指数/i;

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
  value: DmpCell;
  role: "subject" | "competitor";
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
  tables: DmpViewerTable[];
}

export function projectDmpReportForViewer(record: DmpBusinessReportRecord): DmpGrowthReportViewModel {
  const competition = record.reportType === "competition" || record.report.report_type === "competition";
  if (competition) return projectGenericReport(record);

  const report = canonicalToDmpReport(record.report);
  const rawTables: DmpViewerTable[] = report?.tables ?? record.report.tables.map((table) => ({
    name: table.name,
    columns: [...table.columns],
    rows: table.rows.map((row) => [...row.cells])
  }));
  const projected = rawTables.map((table) => projectGrowthTable(table)).map(sanitizeViewerTable).filter(Boolean) as DmpViewerTable[];
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
    kpis: growthKpis(byName.get("周期汇总"), days),
    tables: withBusinessData.map((table) => ({
      ...table,
      subtitle: table.subtitle || growthSubtitle(table.name, startDate, endDate, subjectId, competitorId, days)
    }))
  };
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

function projectGenericReport(record: DmpBusinessReportRecord): DmpGrowthReportViewModel {
  const tables = record.report.tables.map((table) => sanitizeViewerTable({
    name: table.name,
    columns: [...table.columns],
    rows: table.rows.map((row) => [...row.cells])
  })).filter((table): table is DmpViewerTable => table !== null).filter(tableHasBusinessData);
  const dates = dateMatches(record.period);
  const competitors = String(record.competitorItemId || "").split(",").map((value) => value.trim()).filter(Boolean);
  return {
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
    tables
  };
}

function projectGrowthTable(table: DmpViewerTable): DmpViewerTable {
  if (table.name === "渠道花费") return projectChannelTable(table);
  if (table.name === "日GMV与费比") return projectDailyTable(table);
  if (table.name === "一级场景" || table.name === "二级场景") {
    return { ...table, rows: filterSceneRows({ ...table, rows: alignRoleRows(table) }) };
  }
  if (table.name === "关键词样本") return projectKeywordTable(table);
  return table;
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

function growthKpis(period: DmpViewerTable | undefined, days: number): DmpViewerKpi[] {
  return [
    { label: `主体${days}日GMV`, value: periodValue(period, "subject", "总GMV"), role: "subject" },
    { label: `对手${days}日GMV`, value: periodValue(period, "competitor", "总GMV"), role: "competitor" },
    { label: "主体费比", value: periodValue(period, "subject", "费比"), role: "subject" },
    { label: "对手费比", value: periodValue(period, "competitor", "费比"), role: "competitor" }
  ].filter((metric) => !isMissing(metric.value)) as DmpViewerKpi[];
}

function periodValue(table: DmpViewerTable | undefined, role: "subject" | "competitor", column: string) {
  const index = table?.columns.indexOf(column) ?? -1;
  if (index < 0) return "";
  const row = table?.rows.find((candidate) => role === "subject"
    ? /主体/.test(String(candidate[1] ?? ""))
    : /目标对手|对手|竞品/.test(String(candidate[1] ?? "")));
  return row?.[index] ?? "";
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
  return value == null || value === "" || value === "—";
}

function emptyProduct(id: string): DmpViewerProduct {
  return { id, title: "", category: "", price: "", lifecycle: "", gmv: "", pictureUrl: "", detailUrl: "" };
}
