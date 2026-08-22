import {
  DMP_GROWTH_REPORT_TABLES,
  sanitizeDmpReportRenderData,
  sanitizeDmpRenderImageUrl,
  type DmpBusinessReportRecord,
  type DmpCanonicalReport,
  type DmpMarketScope,
  type DmpReportKind
} from "@/lib/dmp-report-types";

export interface DmpReportLibraryGroup {
  key: string;
  reportType: DmpReportKind;
  subjectItemId: string;
  competitorItemId: string;
  subjectThumbnail: DmpReportThumbnail;
  competitorThumbnail: DmpReportThumbnail;
  marketScope?: DmpMarketScope;
  records: DmpBusinessReportRecord[];
}

export interface DmpReportShopGroup {
  key: string;
  shopId: string;
  shopName: string;
  reportCount: number;
  groups: DmpReportLibraryGroup[];
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
  marketScope?: DmpMarketScope;
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
  const reportType: DmpReportKind = fallback.reportType === "market" || report.report_type === "market"
    ? "market"
    : fallback.reportType === "competition" || report.report_type === "competition"
      ? "competition"
      : "growth";
  const marketScope = reportType === "market" ? normalizedMarketScope(report.market_scope, report.item_id || fallback.subjectItemId) : undefined;
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
    : reportType === "growth" ? String(productCompetitorId || overviewCompetitorId || "") : "";
  const competitorItemIds = reportType === "market"
    ? []
    : normalizedIdList(canonicalCompetitors || fallback.competitorItemId);
  const subjectItemId = String(marketScope?.category_id || report.item_id || fallback.subjectItemId || "").trim();
  return {
    reportType,
    subjectItemId,
    competitorItemIds,
    competitorItemId: competitorItemIds.join("、"),
    ...(marketScope ? { marketScope } : {})
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
    const marketScope = identity.marketScope;
    const key = reportType === "market"
      ? [reportType, marketScope?.category_path.join("/"), subjectItemId].join(":")
      : [reportType, subjectItemId, competitorIds.join(",")].join(":");
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
      ...(marketScope ? { marketScope } : {}),
      records: [record]
    });
  }

  return [...groups.values()];
}

export function groupDmpBusinessReportsByShop(
  reports: DmpBusinessReportRecord[]
): DmpReportShopGroup[] {
  const partitions = new Map<string, {
    shopId: string;
    shopName: string;
    records: DmpBusinessReportRecord[];
  }>();

  for (const record of [...reports].sort(compareReportTimeDescending)) {
    const shopId = String(record.shopId ?? "").trim();
    const key = shopId ? `shop:${shopId}` : "unassigned";
    const current = partitions.get(key);
    if (current) {
      current.records.push(record);
      if (!current.shopName && record.shopName?.trim()) current.shopName = record.shopName.trim();
      continue;
    }
    partitions.set(key, {
      shopId,
      shopName: String(record.shopName ?? "").trim(),
      records: [record]
    });
  }

  return [...partitions].map(([key, partition]) => ({
    key,
    shopId: partition.shopId,
    shopName: partition.shopName || (partition.shopId ? "未命名店铺" : "未归类店铺"),
    reportCount: partition.records.length,
    groups: groupDmpBusinessReports(partition.records)
  }));
}

export function dmpReportGroupIdsByShopAndIdentity(
  shopGroups: DmpReportShopGroup[],
  shopGroupKey: string,
  reportGroupKey: string
) {
  return shopGroups
    .find((shopGroup) => shopGroup.key === shopGroupKey)
    ?.groups.find((group) => group.key === reportGroupKey)
    ?.records.map((record) => record.id) ?? [];
}

export function dmpReportSubjectThumbnail(record: DmpBusinessReportRecord): DmpReportThumbnail {
  return dmpReportProductThumbnail(record, "subject");
}

export function dmpReportProductThumbnail(
  record: DmpBusinessReportRecord,
  role: "subject" | "competitor"
): DmpReportThumbnail {
  const identity = dmpReportIdentity(record);
  if (identity.reportType === "market") {
    const fullPath = identity.marketScope?.category_path.join(" / ") || identity.marketScope?.category_name || "类目大盘";
    return { url: "", title: fullPath };
  }
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
  const ordered = [...records].sort(compareReportTimeDescending);
  const base = ordered.find((record) => record.id === selectedId) ?? ordered[0] ?? null;
  if (!base) return null;
  const baseShopId = String(base.shopId ?? "").trim();
  const sorted = ordered.filter((record) => String(record.shopId ?? "").trim() === baseShopId);
  if (sorted.length < 2) return base;
  if (dmpReportIdentity(base).reportType === "market") return mergeMarketReportGroupDaily(sorted, base);
  if (dmpReportIdentity(base).reportType !== "growth") return base;

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
      // 报告已按生成时间从新到旧排序。同一业务日期必须整行由最新报告负责：
      // 空串表示该次报告确实缺失，不能再用旧报告补值；字符串 "0" 则是有效业务值。
      if (byDate.has(date)) continue;
      const target = new Map<string, string>([["日期", date]]);
      source.columns.forEach((column, index) => {
        if (column !== "日期") target.set(column, String(row.cells[index] ?? ""));
      });
      const subjectValue = source.subjectByDate.get(date);
      if (subjectValue !== undefined) target.set("主体日GMV", subjectValue);
      byDate.set(date, target);
    }
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return base;
  const mergedDaily = {
    name: "日GMV与费比",
    columns,
    rows: dates.map((date) => ({ cells: columns.map((column) => byDate.get(date)?.get(column) ?? "") }))
  };
  const tables = base.report.tables.map((table) => table.name === "日GMV与费比" ? mergedDaily : table);
  const renderData = mergedRenderData(base, dates[0], dates.at(-1) ?? dates[0], dates.length);
  const period = `${dates[0]} 至 ${dates.at(-1)}`;

  return {
    ...base,
    period,
    report: {
      ...base.report,
      period,
      tables,
      ...(renderData ? { render_data: renderData } : { render_data: undefined })
    }
  };
}

function mergeMarketReportGroupDaily(
  sorted: DmpBusinessReportRecord[],
  base: DmpBusinessReportRecord
): DmpBusinessReportRecord {
  const sources = sorted.map((record) => marketDailySource(record)).filter((source): source is MarketDailySource => Boolean(source));
  if (sources.length < 2) return base;
  const columns = ["日期"];
  for (const source of sources) {
    for (const column of source.columns) if (column !== "日期" && !columns.includes(column)) columns.push(column);
  }
  const byDate = new Map<string, Map<string, string>>();
  // sources 已按报告生成时间从新到旧排序：重叠截止日整行以最新值为准，绝不累加或用旧值补空。
  for (const source of sources) {
    for (const row of source.table.rows) {
      const date = String(row.cells[source.dateIndex] ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (byDate.has(date)) continue;
      const target = new Map<string, string>([["日期", date]]);
      source.columns.forEach((column, index) => {
        if (column !== "日期") target.set(column, String(row.cells[index] ?? ""));
      });
      byDate.set(date, target);
    }
  }
  const dates = [...byDate.keys()].sort();
  if (!dates.length) return base;
  const mergedDaily = {
    name: "滚动7日明细",
    columns,
    rows: dates.map((date) => ({ cells: columns.map((column) => byDate.get(date)?.get(column) ?? "") }))
  };
  let replaced = false;
  const tables = base.report.tables.map((table) => {
    if (!marketDailyTableName(table.name)) return table;
    if (replaced) return null;
    replaced = true;
    return mergedDaily;
  }).filter((table): table is DmpCanonicalReport["tables"][number] => Boolean(table));
  if (!replaced) tables.push(mergedDaily);
  return {
    ...base,
    period: `${dates[0]} 至 ${dates.at(-1)}`,
    report: {
      ...base.report,
      period: `${dates[0]} 至 ${dates.at(-1)}`,
      tables
    }
  };
}

interface MarketDailySource {
  table: DmpCanonicalReport["tables"][number];
  columns: string[];
  dateIndex: number;
}

function marketDailySource(record: DmpBusinessReportRecord): MarketDailySource | null {
  const table = record.report.tables.find((candidate) => marketDailyTableName(candidate.name));
  if (!table) return null;
  const dateIndex = table.columns.findIndex((column) => /^(?:日期|请求截止日|截止日)$/.test(String(column).trim()));
  if (dateIndex < 0) return null;
  const columns = table.columns.map((column, index) => index === dateIndex ? "日期" : String(column).trim());
  return { table, columns, dateIndex };
}

function marketDailyTableName(value: string) {
  return /^(?:滚动\s*7\s*(?:日明细|天市场数据)|市场核心指标)$/.test(String(value).trim());
}

function normalizedIdList(value: unknown) {
  return [...new Set(String(value ?? "").split(/[,，、;；]+/).map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
}

function normalizedMarketScope(value: DmpCanonicalReport["market_scope"], fallbackId: unknown): DmpMarketScope | undefined {
  if (!value) return undefined;
  const categoryId = String(value.category_id || fallbackId || "").trim();
  const categoryPath = (Array.isArray(value.category_path) ? value.category_path : [])
    .map((segment) => String(segment ?? "").trim())
    .filter(Boolean);
  const categoryName = String(value.category_name || categoryPath.at(-1) || "").trim();
  if (!categoryId || !categoryName) return undefined;
  if (!categoryPath.length) categoryPath.push(categoryName);
  return { category_id: categoryId, category_name: categoryName, category_path: categoryPath };
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

function firstSafeImageUrl(value: unknown) {
  const candidates = String(value ?? "").match(/(?:https?:)?\/\/[^\s\"'<>]+/gi) ?? [];
  for (const candidate of candidates) {
    const safe = sanitizeDmpRenderImageUrl(candidate.startsWith("//") ? `https:${candidate}` : candidate);
    if (safe) return safe;
  }
  return "";
}
