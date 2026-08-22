import {
  DMP_GROWTH_REPORT_TABLES,
  sanitizeDmpReportRenderData,
  sanitizeDmpRenderImageUrl,
  type DmpBusinessReportRecord,
  type DmpCanonicalReport,
  type DmpReportKind
} from "@/lib/dmp-report-types";

export interface DmpReportLibraryGroup {
  key: string;
  reportType: DmpReportKind;
  subjectItemId: string;
  competitorItemId: string;
  subjectThumbnail: DmpReportThumbnail;
  competitorThumbnail: DmpReportThumbnail;
  records: DmpBusinessReportRecord[];
}

export interface DmpReportThumbnail {
  url: string;
  title: string;
}

export interface DmpReportIdentity {
  reportType: DmpReportKind;
  subjectItemId: string;
  competitorItemIds: string[];
  competitorItemId: string;
}

export function dmpReportIdentity(record: DmpBusinessReportRecord): DmpReportIdentity {
  return dmpCanonicalReportIdentity(record.report, {
    reportType: record.reportType,
    subjectItemId: record.subjectItemId,
    competitorItemId: record.competitorItemId
  });
}

export function dmpCanonicalReportIdentity(
  report: DmpCanonicalReport,
  fallback: {
    reportType?: DmpReportKind;
    subjectItemId?: unknown;
    competitorItemId?: unknown;
  } = {}
): DmpReportIdentity {
  const reportType = fallback.reportType === "competition" || report.report_type === "competition"
    ? "competition"
    : "growth";
  const productTable = report.tables.find((table) => table.name === "商品与成功品");
  const productIdIndex = productTable?.columns.indexOf("商品ID") ?? -1;
  const productRoleIndex = productTable?.columns.findIndex((column) => /^(?:对象|角色)$/.test(column)) ?? -1;
  const productCompetitorId = productTable?.rows.find(({ cells }) => {
    const role = productRoleIndex >= 0 ? cells[productRoleIndex] : cells[0];
    return /目标对手|^对手|^竞品/.test(String(role ?? ""));
  })?.cells[productIdIndex];
  const overview = report.tables.find((table) => table.name === "报告总览");
  const overviewCompetitorId = overview?.rows.find(({ cells }) => String(cells[0] ?? "") === "商品ID")?.cells[2];
  const canonicalCompetitors = reportType === "competition"
    ? report.competitor_ids?.join(",")
    : String(productCompetitorId || overviewCompetitorId || "");
  const competitorItemIds = normalizedIdList(canonicalCompetitors || fallback.competitorItemId);
  const subjectItemId = String(report.item_id || fallback.subjectItemId || "").trim();
  return {
    reportType,
    subjectItemId,
    competitorItemIds,
    competitorItemId: competitorItemIds.join("、")
  };
}

export function groupDmpBusinessReports(
  reports: DmpBusinessReportRecord[]
): DmpReportLibraryGroup[] {
  const groups = new Map<string, DmpReportLibraryGroup>();
  const sorted = [...reports].sort(compareReportTimeDescending);

  for (const record of sorted) {
    const identity = dmpReportIdentity(record);
    const { reportType, subjectItemId } = identity;
    const competitorIds = identity.competitorItemIds;
    const competitorItemId = competitorIds.join("、");
    const key = [reportType, subjectItemId, competitorIds.join(",")].join(":");
    const current = groups.get(key);
    const subjectThumbnail = dmpReportProductThumbnail(record, "subject");
    const competitorThumbnail = dmpReportProductThumbnail(record, "competitor");

    if (current) {
      current.records.push(record);
      if (!current.subjectThumbnail.url && subjectThumbnail.url) current.subjectThumbnail = subjectThumbnail;
      if (!current.competitorThumbnail.url && competitorThumbnail.url) current.competitorThumbnail = competitorThumbnail;
      continue;
    }
    groups.set(key, {
      key,
      reportType,
      subjectItemId,
      competitorItemId,
      subjectThumbnail,
      competitorThumbnail,
      records: [record]
    });
  }

  return [...groups.values()];
}

export function dmpReportSubjectThumbnail(record: DmpBusinessReportRecord): DmpReportThumbnail {
  return dmpReportProductThumbnail(record, "subject");
}

export function dmpReportProductThumbnail(
  record: DmpBusinessReportRecord,
  role: "subject" | "competitor"
): DmpReportThumbnail {
  const renderProduct = role === "subject"
    ? record.report.render_data?.products?.subject
    : record.report.render_data?.products?.competitor;
  const renderUrl = sanitizeDmpRenderImageUrl(renderProduct?.picture_url);
  const productTable = record.report.tables.find((table) => table.name === "商品与成功品");
  const roleIndex = productTable?.columns.findIndex((column) => /^(?:对象|角色)$/.test(column)) ?? -1;
  const titleIndex = productTable?.columns.findIndex((column) => /商品标题/.test(column)) ?? -1;
  const mediaIndex = productTable?.columns.findIndex((column) => /图片|详情/.test(column)) ?? -1;
  const row = productTable?.rows.find(({ cells }) => {
    const label = String(cells[roleIndex >= 0 ? roleIndex : 0] ?? "");
    return role === "subject"
      ? /^(?:主体|本店)/.test(label)
      : /^(?:目标对手|对手|竞品|成功品|竞店)/.test(label);
  })?.cells;
  const tableUrl = mediaIndex >= 0 ? firstSafeImageUrl(row?.[mediaIndex]) : "";
  const overview = record.report.tables.find((table) => table.name === "报告总览");
  const overviewTitleRow = overview?.rows.find(({ cells }) => String(cells[0] ?? "") === "商品标题")?.cells;
  const identity = dmpReportIdentity(record);
  const competition = identity.reportType === "competition";
  const fallbackLabel = role === "subject"
    ? competition ? "本店" : "主体商品"
    : competition ? "竞店" : "成功品";
  const fallbackId = role === "subject" ? identity.subjectItemId : identity.competitorItemId;

  return {
    url: renderUrl || tableUrl,
    title: String(
      (titleIndex >= 0 ? row?.[titleIndex] : "")
      || overviewTitleRow?.[role === "subject" ? 1 : 2]
      || `${fallbackLabel} ${fallbackId}`
    ).trim()
  };
}

export function mergeDmpReportGroupDaily(
  records: DmpBusinessReportRecord[],
  selectedId = ""
): DmpBusinessReportRecord | null {
  const sorted = [...records].sort(compareReportTimeDescending);
  const base = sorted.find((record) => record.id === selectedId) ?? sorted[0] ?? null;
  if (!base || dmpReportIdentity(base).reportType === "competition" || sorted.length < 2) return base;

  const dailySources = sorted.map((record) => dailySource(record)).filter((source): source is DailySource => Boolean(source));
  if (dailySources.length < 2) return base;
  const baseDaily = dailySources.find((source) => source.record.id === base.id)?.table ?? dailySources[0].table;
  const columns = baseDaily.columns.map(normalizedDailyColumn);
  for (const source of dailySources) {
    for (const column of source.columns) if (!columns.includes(column)) columns.push(column);
  }
  const hasSubjectDaily = dailySources.some((source) => source.subjectByDate.size > 0 || source.columns.includes("主体日GMV"));
  if (hasSubjectDaily && !columns.includes("主体日GMV")) columns.splice(Math.min(1, columns.length), 0, "主体日GMV");
  if (columns[0] !== "日期") {
    const dateIndex = columns.indexOf("日期");
    if (dateIndex >= 0) columns.unshift(...columns.splice(dateIndex, 1));
  }

  const byDate = new Map<string, Map<string, string>>();
  for (const source of dailySources) {
    for (const row of source.table.rows) {
      const date = String(row.cells[source.dateIndex] ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const target = byDate.get(date) ?? new Map<string, string>([["日期", date]]);
      source.columns.forEach((column, index) => {
        const value = String(row.cells[index] ?? "");
        if (isBlank(target.get(column)) && !isBlank(value)) target.set(column, value);
      });
      const subjectValue = source.subjectByDate.get(date);
      if (isBlank(target.get("主体日GMV")) && !isBlank(subjectValue)) target.set("主体日GMV", subjectValue ?? "");
      byDate.set(date, target);
    }
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return base;
  const mergedDaily = {
    name: "日GMV与费比",
    columns,
    rows: dates.map((date) => ({ cells: columns.map((column) => byDate.get(date)?.get(column) ?? "") }))
  };
  const tables = base.report.tables.map((table) => table.name === "日GMV与费比" ? mergedDaily : table);
  const renderData = mergedRenderData(base, dates[0], dates.at(-1) ?? dates[0], dates.length);

  return {
    ...base,
    report: {
      ...base.report,
      tables,
      ...(renderData ? { render_data: renderData } : { render_data: undefined })
    }
  };
}

function normalizedIdList(value: unknown) {
  return [...new Set(String(value ?? "").split(/[,，、;；]+/).map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}

function compareReportTimeDescending(left: DmpBusinessReportRecord, right: DmpBusinessReportRecord) {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

interface DailySource {
  record: DmpBusinessReportRecord;
  table: DmpBusinessReportRecord["report"]["tables"][number];
  columns: string[];
  dateIndex: number;
  subjectByDate: Map<string, string>;
}

function dailySource(record: DmpBusinessReportRecord): DailySource | null {
  const table = record.report.tables.find((candidate) => candidate.name === "日GMV与费比");
  if (!table) return null;
  const columns = table.columns.map(normalizedDailyColumn);
  const dateIndex = columns.indexOf("日期");
  if (dateIndex < 0) return null;
  const sanitized = sanitizeDmpReportRenderData(record.report.render_data, {
    itemId: record.report.item_id,
    period: record.report.period,
    tables: record.report.tables,
    expectedTableNames: DMP_GROWTH_REPORT_TABLES
  });
  return {
    record,
    table,
    columns,
    dateIndex,
    subjectByDate: new Map((sanitized?.subject_daily_gmv ?? []).map((row) => [row.date, row.gmv]))
  };
}

function normalizedDailyColumn(column: string) {
  return column === "对手日GMV" ? "日GMV" : column;
}

function mergedRenderData(
  base: DmpBusinessReportRecord,
  startDate: string,
  endDate: string,
  days: number
) {
  const source = base.report.render_data;
  const tableMeta = [...(source?.tables ?? [])].filter((table) => table.name !== "日GMV与费比");
  tableMeta.push({
    name: "日GMV与费比",
    subtitle: `同组分日合并｜${startDate} 至 ${endDate}｜${days}天`
  });
  const { subject_daily_gmv: _subjectDailyGmv, tables: _tables, ...rest } = source ?? { version: "1" as const };
  void _subjectDailyGmv;
  void _tables;
  return {
    ...rest,
    version: "1" as const,
    tables: tableMeta
  };
}

function isBlank(value: string | undefined) {
  return value == null || value.trim() === "" || /^(?:[-–—]|null|undefined)$/i.test(value.trim());
}

function firstSafeImageUrl(value: unknown) {
  const candidates = String(value ?? "").match(/(?:https?:)?\/\/[^\s\"'<>]+/gi) ?? [];
  for (const candidate of candidates) {
    const safe = sanitizeDmpRenderImageUrl(candidate.startsWith("//") ? `https:${candidate}` : candidate);
    if (safe) return safe;
  }
  return "";
}
