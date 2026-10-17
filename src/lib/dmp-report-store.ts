import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { parseSession, type Session } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  auditDmpGrowthSubjectMetrics,
  dmpExpectedTableNames,
  dmpReportKind,
  sanitizeDmpReportRenderData,
  sanitizeDmpRenderImageUrl,
  type DmpBusinessReportSummary,
  type DmpBusinessReportRecord,
  type DmpCanonicalReport,
  type DmpReportQuality,
  type DmpReportTableSnapshot
} from "@/lib/dmp-report-types";
import { getCurrentSession } from "@/lib/server-session";
import { getDmpAutomationAccessForSession } from "@/lib/tool-entitlements";
import { withDmpAutomationBrand } from "@/lib/dmp-product";
import { effectiveDmpReportQuality } from "@/lib/dmp-report-quality";
import {
  dmpCanonicalReportIdentity,
  dmpReportProductThumbnail
} from "@/lib/dmp-report-library";

const MAX_REPORT_BYTES = 2 * 1024 * 1024;
export const DMP_REPORT_ARCHIVE_MAX_BODY_BYTES = MAX_REPORT_BYTES + 64 * 1024;
const MAX_TABLES = 100;
const MAX_TABLE_ROWS = 5_000;
const MAX_CELL_LENGTH = 10_000;
const MAX_TABLE_NAME_LENGTH = 200;
const MAX_TABLE_COLUMNS = 100;
const MAX_REPORT_CELLS = 250_000;
const SENSITIVE_ARCHIVE_AUTH_WORD = /token|cookie|authorization|password|secret|session|signature/i;
const STANDALONE_ARCHIVE_SIGN = /(?:^|[^a-z0-9])sign(?:ature|data)?(?:$|[^a-z0-9])/i;

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function dmpBusinessReportFingerprint(input: {
  report: DmpCanonicalReport;
  subjectItemId: string;
  competitorItemId: string;
  shopId?: string;
  sourceScope?: string;
}) {
  const renderData = input.report.render_data
    ? Object.fromEntries(Object.entries(input.report.render_data).filter(([key]) => key !== "generated_at"))
    : undefined;
  const sourceScope = input.sourceScope?.trim()
    || (input.shopId?.trim() ? `internal-shop:${input.shopId.trim()}` : "");
  const comparable = {
    ...(sourceScope ? { sourceScope } : {}),
    subjectItemId: input.subjectItemId,
    competitorItemId: input.competitorItemId,
    report: {
      schema_version: String(input.report.schema_version ?? ""),
      report_type: dmpReportKind(input.report),
      market_scope: input.report.market_scope,
      item_id: String(input.report.item_id ?? ""),
      period: String(input.report.period ?? ""),
      render_data: renderData,
      tables: input.report.tables.map((table) => ({
        name: String(table.name ?? ""),
        columns: table.columns.map(String),
        rows: table.rows.map((row) => ({ cells: row.cells.map(String) }))
      }))
    }
  };
  return createHash("sha256").update(stableJson(comparable)).digest("hex");
}

export interface DmpReportAccess {
  userId: string;
  tenantId: string;
}

export type DmpReportRequestContextResult =
  | {
      ok: true;
      access: DmpReportAccess;
      shop: { id: string; name: string };
    }
  | {
      ok: false;
      status: 400 | 401 | 404 | 409;
      code: "UNAUTHORIZED" | "SHOP_REQUIRED" | "SHOP_INVALID" | "SHOP_MISMATCH";
      error: string;
    };

export class DmpReportSourceShopError extends Error {
  readonly code = "DMP_REPORT_SOURCE_SHOP_INVALID";

  constructor(message: string, readonly status: 400 | 404) {
    super(message);
    this.name = "DmpReportSourceShopError";
  }
}

export interface DmpReportSourceShopInput {
  /** 官网 Shop.id；扩展从达摩盘页面读取的纯数字来源 ID 不属于此字段。 */
  shopId?: string;
  /** 仅用于当前租户既有店铺的规范化唯一匹配，绝不据此创建店铺。 */
  shopName?: string;
  /** 达摩盘外部来源标识，只作来源提示，绝不写入 DmpBusinessReport.shopId。 */
  sourceShopId?: string;
}

export interface DmpReportReplaceLatestPairRetention {
  mode: "replace-latest-pair";
  confirmed: true;
  replacedReportId: string;
  absorbedReportIds: string[];
}

export class DmpReportReplaceConflictError extends Error {
  readonly code = "DMP_REPORT_REPLACE_CONFLICT";
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "DmpReportReplaceConflictError";
  }
}

export class DmpReportHistoryStaleError extends Error {
  readonly code = "DMP_REPORT_HISTORY_STALE";
  readonly status = 409;

  constructor(message = "同店铺同商品对的历史报告已变化，请重新读取后再归档") {
    super(message);
    this.name = "DmpReportHistoryStaleError";
  }
}

async function parseExtensionSession(token: string) {
  const direct = await parseSession(token);
  if (direct) return direct;
  try {
    return await parseSession(decodeURIComponent(token));
  } catch {
    return null;
  }
}

async function resolveAccess(session: Session | null): Promise<DmpReportAccess | null> {
  if (!session) return null;
  const entitlement = await getDmpAutomationAccessForSession(session).catch(() => null);
  if (!entitlement?.allowed) return null;
  const user = await prisma.user.findUnique({
    where: { username: session.username.trim() },
    select: { id: true, tenantId: true }
  });
  if (!user || user.tenantId !== session.tenantId) return null;
  return { userId: user.id, tenantId: user.tenantId };
}

export async function getDmpReportAccess() {
  return resolveAccess(await getCurrentSession());
}

export async function getDmpReportAccessFromToken(rawToken: string | null | undefined) {
  const token = String(rawToken ?? "").trim();
  return token ? resolveAccess(await parseExtensionSession(token)) : null;
}

/**
 * DMP 报告请求的唯一身份入口：在同一次调用中解析账号与归档店铺。
 * 显式 header/cookie 仍须在当前租户内精确命中；只有专用扩展路由显式
 * allowDefaultShop 时，才使用该账号按创建时间排序的默认店铺。这里不创建店铺。
 */
export async function resolveDmpReportRequestContext(input: {
  extensionToken?: string | null;
  shopId?: string | null;
  browserHeaderShopId?: string | null;
  browserCookieShopId?: string | null;
  allowDefaultShop?: boolean;
}): Promise<DmpReportRequestContextResult> {
  const extensionToken = String(input.extensionToken ?? "").trim();
  const browserHeaderShopId = String(input.browserHeaderShopId ?? "").trim();
  const browserCookieShopId = String(input.browserCookieShopId ?? "").trim();
  const shopId = extensionToken
    ? String(input.shopId ?? "").trim()
    : browserHeaderShopId || browserCookieShopId || String(input.shopId ?? "").trim();
  const access = extensionToken
    ? await getDmpReportAccessFromToken(extensionToken)
    : await getDmpReportAccess();
  if (!access) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      error: "请先登录并开通达摩盘报告权限"
    };
  }
  if (!extensionToken && browserHeaderShopId && browserCookieShopId && browserHeaderShopId !== browserCookieShopId) {
    return {
      ok: false,
      status: 409,
      code: "SHOP_MISMATCH",
      error: "页面店铺与当前官网活动店铺不一致，请刷新后重试"
    };
  }
  if (!shopId && input.allowDefaultShop !== true) {
    return {
      ok: false,
      status: 400,
      code: "SHOP_REQUIRED",
      error: "当前官网店铺未明确，请先选择店铺"
    };
  }
  if (shopId && !validInternalShopId(shopId)) {
    return {
      ok: false,
      status: 400,
      code: "SHOP_INVALID",
      error: "官网店铺编号无效"
    };
  }
  const shop = await prisma.shop.findFirst({
    where: shopId
      ? { id: shopId, tenantId: access.tenantId }
      : { tenantId: access.tenantId },
    ...(shopId ? {} : { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] }),
    select: { id: true, name: true }
  });
  if (!shop) {
    return {
      ok: false,
      status: 404,
      code: "SHOP_INVALID",
      error: shopId ? "店铺不存在或不属于当前账号" : "当前账号没有可用的默认店铺"
    };
  }
  return { ok: true, access, shop };
}

export function validateDmpCanonicalReport(
  value: unknown,
  fallback: { subjectItemId?: unknown; competitorItemId?: unknown } = {}
): { report?: DmpCanonicalReport; error?: string; issues?: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "报告内容无效" };
  const report = value as Partial<DmpCanonicalReport>;
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_REPORT_BYTES) return { error: "报告内容超过保存上限" };

  const issues: string[] = [];
  if (report.schema_version !== "3.0") pushArchiveIssue(issues, "报告版本标记已兼容归档");
  const kind = dmpReportKind(report);
  const expectedTables = dmpExpectedTableNames(kind);
  const marketScope = kind === "market" ? sanitizeMarketScope(report.market_scope) : null;
  if (kind === "market" && !marketScope) return { error: "类目范围无效，请提供中文类目名称、完整路径与类目 ID" };
  const itemIdSource = marketScope?.category_id ?? report.item_id;
  const validIdentityId = kind === "market" ? validCategoryId : validItemId;
  const itemId = validIdentityId(itemIdSource)
    ? String(itemIdSource)
    : validIdentityId(fallback.subjectItemId)
      ? String(fallback.subjectItemId)
      : "";
  if (!itemId) return { error: kind === "competition" ? "本店 ID 无效" : kind === "market" ? "类目 ID 无效" : "主体商品 ID 无效" };
  if (String(report.item_id ?? "") !== itemId) {
    pushArchiveIssue(issues, kind === "market" ? "类目 ID 已使用类目范围补全" : "主体 ID 已使用请求元数据补全");
  }

  const fallbackCompetitors = parseDmpCompetitorIds(fallback.competitorItemId).filter(validItemId);
  const rawCompetitors = Array.isArray(report.competitor_ids) ? report.competitor_ids : [];
  if (kind === "competition" && rawCompetitors.length > 3) return { error: "竞争态势报告最多允许 3 个竞店 ID" };
  const competitorIds = kind === "competition"
    ? [...new Set([
        ...rawCompetitors,
        ...fallbackCompetitors
      ].map(String).map((id) => id.trim()).filter(validItemId))]
    : [];
  if (kind === "competition" && competitorIds.length > 3) return { error: "竞争态势报告最多允许 3 个竞店 ID" };
  if (kind === "competition" && !competitorIds.length) pushArchiveIssue(issues, "竞店 ID 待补充");

  const rawTables = Array.isArray(report.tables) ? report.tables : [];
  if (!Array.isArray(report.tables)) pushArchiveIssue(issues, "业务表集合缺失，已创建空表归档");
  if (rawTables.length > MAX_TABLES) pushArchiveIssue(issues, `业务表超过 ${MAX_TABLES} 个，已截断归档`);
  if (estimatedArchivedCellCount(rawTables) > MAX_REPORT_CELLS) return { error: "报告单元格总量超过保存上限" };
  const normalizedTables = rawTables
    .slice(0, MAX_TABLES)
    .map((candidate, index) => normalizeArchivedTable(candidate, index, issues));
  if (kind === "market" && !normalizedTables.length) return { error: "类目大盘报告缺少业务数据" };
  const tables = kind === "market"
    ? orderMarketTables(normalizedTables, expectedTables)
    : orderArchivedTables(normalizedTables, expectedTables, issues);

  const period = String(report.period ?? "近30天").slice(0, 200);
  const renderData = kind === "growth" ? sanitizeDmpReportRenderData(report.render_data, {
    itemId,
    period,
    tables,
    expectedTableNames: expectedTables
  }) : undefined;

  const normalizedReport: DmpCanonicalReport = {
    schema_version: "3.0",
    ...(kind === "competition" ? { report_type: "competition" as const, competitor_ids: competitorIds } : {}),
    ...(kind === "market" ? { report_type: "market" as const, market_scope: marketScope! } : {}),
    title: withDmpAutomationBrand(
      report.title,
      kind === "competition"
        ? "达摩盘竞争态势分析报告"
        : kind === "market"
          ? "达摩盘类目大盘报告"
          : "达摩盘打爆路径报告"
    ).slice(0, 200),
    item_id: itemId,
    period,
    tables,
    ...(renderData ? { render_data: renderData } : {})
  };
  if (kind === "growth") {
    const subjectMetricAudit = auditDmpGrowthSubjectMetrics(normalizedReport);
    if (subjectMetricAudit.missing.length) {
      pushArchiveIssue(issues, `主体最低指标缺失：${subjectMetricAudit.missing.map((metric) => metric.label).join("、")}`);
    }
  }
  // 仅检查最终会落库并通过公开分享展示的规范化合同。这样能覆盖标题、周期、业务表及
  // render_data（含副标题），又不会因随后会被丢弃的调试/传输字段误阻断归档。
  if (containsSensitiveArchiveAuthData(normalizedReport)) {
    return { error: "报告包含敏感鉴权字段，禁止归档" };
  }
  if (Buffer.byteLength(JSON.stringify(normalizedReport), "utf8") > MAX_REPORT_BYTES) {
    return { error: "规范化后的报告内容超过保存上限" };
  }
  return {
    report: normalizedReport,
    ...(issues.length ? { issues } : {})
  };
}

function sanitizeMarketScope(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as { category_id?: unknown; category_name?: unknown; category_path?: unknown };
  const categoryId = String(source.category_id ?? "").trim();
  if (!validCategoryId(categoryId)) return null;
  const rawPath = Array.isArray(source.category_path)
    ? source.category_path
    : String(source.category_path ?? "").split(/[>/｜|]+/);
  const categoryPath = rawPath
    .map((segment) => cleanMarketLabel(segment))
    .filter(Boolean)
    .slice(0, 12);
  const categoryName = cleanMarketLabel(source.category_name) || categoryPath.at(-1) || "";
  if (!categoryName) return null;
  if (!categoryPath.length) categoryPath.push(categoryName);
  else if (categoryPath.at(-1) !== categoryName) categoryPath.push(categoryName);
  return { category_id: categoryId, category_name: categoryName, category_path: categoryPath };
}

function cleanMarketLabel(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function containsSensitiveArchiveAuthData(value: unknown) {
  if (value == null) return false;
  let text = "";
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return SENSITIVE_ARCHIVE_AUTH_WORD.test(text) || STANDALONE_ARCHIVE_SIGN.test(text);
}

function estimatedArchivedCellCount(tables: unknown[]) {
  let total = 0;
  for (const candidate of tables.slice(0, MAX_TABLES)) {
    const record = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as { columns?: unknown; rows?: unknown }
      : null;
    const rawColumns = Array.isArray(record?.columns) ? record.columns : [];
    const rawRows = Array.isArray(record?.rows) ? record.rows.slice(0, MAX_TABLE_ROWS) : record ? [] : [candidate];
    const widestRow = rawRows.reduce((width, row) => {
      if (row && typeof row === "object" && !Array.isArray(row) && Array.isArray((row as { cells?: unknown }).cells)) {
        return Math.max(width, (row as { cells: unknown[] }).cells.length);
      }
      return Math.max(width, Array.isArray(row) ? row.length : 1);
    }, 0);
    const normalizedWidth = Math.min(MAX_TABLE_COLUMNS, Math.max(1, rawColumns.length, widestRow));
    total += normalizedWidth * rawRows.length;
    if (total > MAX_REPORT_CELLS) return total;
  }
  return total;
}

function normalizeArchivedTable(candidate: unknown, index: number, issues: string[]): DmpReportTableSnapshot {
  const record = candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as { name?: unknown; columns?: unknown; rows?: unknown }
    : null;
  const rawName = String(record?.name ?? "").trim();
  const name = (rawName || `未命名模块 ${index + 1}`).slice(0, MAX_TABLE_NAME_LENGTH);
  if (!record) pushArchiveIssue(issues, `业务表 ${index + 1} 结构异常，已作为原始值归档`);
  if (!rawName) pushArchiveIssue(issues, `业务表 ${index + 1} 缺少名称，已自动命名`);
  if (rawName.length > MAX_TABLE_NAME_LENGTH) pushArchiveIssue(issues, `业务表「${name}」名称过长，已截断`);

  const rawColumns = Array.isArray(record?.columns) ? record.columns : [];
  const rawRows = Array.isArray(record?.rows) ? record.rows : record ? [] : [candidate];
  if (!Array.isArray(record?.columns)) pushArchiveIssue(issues, `业务表「${name}」列结构无效，已自动修复`);
  if (!Array.isArray(record?.rows)) pushArchiveIssue(issues, `业务表「${name}」行结构无效，已自动修复`);
  if (rawRows.length > MAX_TABLE_ROWS) pushArchiveIssue(issues, `业务表「${name}」超过 ${MAX_TABLE_ROWS} 行，已截断归档`);

  const rowValues = rawRows.slice(0, MAX_TABLE_ROWS).map((row) => {
    if (row && typeof row === "object" && !Array.isArray(row) && Array.isArray((row as { cells?: unknown }).cells)) {
      return (row as { cells: unknown[] }).cells;
    }
    if (Array.isArray(row)) return row;
    pushArchiveIssue(issues, `业务表「${name}」存在无效行，已按单元格归档`);
    return [row];
  });
  const widestRow = rowValues.reduce((width, row) => Math.max(width, row.length), 0);
  const normalizedWidth = Math.min(MAX_TABLE_COLUMNS, Math.max(1, rawColumns.length, widestRow));
  if (rawColumns.length > MAX_TABLE_COLUMNS || widestRow > MAX_TABLE_COLUMNS) {
    pushArchiveIssue(issues, `业务表「${name}」超过 ${MAX_TABLE_COLUMNS} 列，已截断归档`);
  }
  if (!rawColumns.length || rowValues.some((row) => row.length !== rawColumns.length)) {
    pushArchiveIssue(issues, `业务表「${name}」列结构无效，已自动对齐`);
  }
  const columns = Array.from({ length: normalizedWidth }, (_, columnIndex) => {
    const text = archiveCellText(rawColumns[columnIndex], name, issues);
    return text || `列${columnIndex + 1}`;
  });
  const rows = rowValues.map((row) => ({
    cells: Array.from({ length: normalizedWidth }, (_, columnIndex) => archiveCellText(row[columnIndex], name, issues))
  }));
  return { name, columns, rows };
}

function orderArchivedTables(
  tables: DmpReportTableSnapshot[],
  expectedNames: readonly string[],
  issues: string[]
) {
  const remaining = [...tables];
  const ordered: DmpReportTableSnapshot[] = [];
  for (const expectedName of expectedNames) {
    const index = remaining.findIndex((table) => table.name === expectedName);
    if (index >= 0) {
      ordered.push(remaining.splice(index, 1)[0]);
      continue;
    }
    pushArchiveIssue(issues, `业务表「${expectedName}」缺失，已创建空表归档`);
    ordered.push({ name: expectedName, columns: ["数据"], rows: [] });
  }
  const usedNames = new Set(ordered.map((table) => table.name));
  for (const table of remaining) {
    const originalName = table.name;
    let name = originalName;
    let copy = 2;
    while (usedNames.has(name)) name = `${originalName}（归档副本${copy++}）`.slice(0, MAX_TABLE_NAME_LENGTH);
    usedNames.add(name);
    ordered.push(name === table.name ? table : { ...table, name });
  }
  // 价格带洞察是增长报告的可选模块：有数据才归档，并固定跟在“商品与成功品”之后；
  // 旧报告不补空表，其他未知附加模块仍保持原有兼容逻辑。
  const priceBandIndex = ordered.findIndex((table) => table.name === "赛道价格带洞察");
  const productIndex = ordered.findIndex((table) => table.name === "商品与成功品");
  if (priceBandIndex >= 0 && productIndex >= 0 && priceBandIndex !== productIndex + 1) {
    const [priceBand] = ordered.splice(priceBandIndex, 1);
    ordered.splice(productIndex + 1, 0, priceBand);
  }
  const originalExpectedOrder = tables.filter((table) => expectedNames.includes(table.name)).map((table) => table.name);
  const presentExpectedOrder = expectedNames.filter((name) => originalExpectedOrder.includes(name));
  if (JSON.stringify(originalExpectedOrder) !== JSON.stringify(presentExpectedOrder) || remaining.length) {
    pushArchiveIssue(issues, "业务表顺序或附加模块已兼容归档");
  }
  return ordered;
}

function orderMarketTables(tables: DmpReportTableSnapshot[], preferredNames: readonly string[]) {
  return [...tables].sort((left, right) => {
    const leftIndex = preferredNames.indexOf(left.name);
    const rightIndex = preferredNames.indexOf(right.name);
    if (leftIndex < 0 && rightIndex < 0) return 0;
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  });
}

function archiveCellText(value: unknown, tableName: string, issues: string[]) {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value == null) text = "";
  else if (typeof value === "object") {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else text = String(value);
  if (text.length <= MAX_CELL_LENGTH) return text;
  pushArchiveIssue(issues, `业务表「${tableName}」存在过长单元格，已截断归档`);
  return text.slice(0, MAX_CELL_LENGTH);
}

function pushArchiveIssue(issues: string[], issue: string) {
  if (!issues.includes(issue)) issues.push(issue);
}

type DmpStoredSummaryPayload = {
  version: 1;
  reportType: "growth" | "competition" | "market";
  title: string;
  marketScope?: DmpCanonicalReport["market_scope"];
  subjectThumbnail: { url: string; title: string };
  competitorThumbnail: { url: string; title: string };
  coverageStart?: string;
  coverageEnd?: string;
};

type DmpSummaryRow = {
  id: string;
  shopId: string | null;
  shop: { id: string; name: string } | null;
  subjectItemId: string;
  competitorItemId: string;
  period: string;
  quality: string;
  createdAt: Date;
  summary: unknown;
};

export async function listDmpBusinessReportSummaries(
  access: DmpReportAccess,
  input: { shopId: string; page?: number; pageSize?: number }
): Promise<{
  summaries: DmpBusinessReportSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
}> {
  const shopId = String(input.shopId ?? "").trim();
  if (!validInternalShopId(shopId)) throw new DmpReportSourceShopError("官网店铺编号无效", 400);
  const page = boundedPositiveInteger(input.page, 1, 1_000_000);
  const pageSize = boundedPositiveInteger(input.pageSize, 24, 50);
  const where = {
    tenantId: access.tenantId,
    userId: access.userId,
    shopId
  };
  const [total, rows] = await Promise.all([
    prisma.dmpBusinessReport.count({ where }),
    prisma.dmpBusinessReport.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        shopId: true,
        shop: { select: { id: true, name: true } },
        subjectItemId: true,
        competitorItemId: true,
        period: true,
        quality: true,
        createdAt: true,
        summary: true
      }
    })
  ]);
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  return {
    summaries: rows.map((row) => storedDmpBusinessReportSummary(row)),
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages
  };
}

export async function listDmpBusinessReportArchivePair(
  access: DmpReportAccess,
  input: {
    shopId: string;
    reportType: "growth" | "competition" | "market";
    subjectItemId: string;
    competitorItemId: string;
    quality?: DmpReportQuality;
  }
): Promise<DmpBusinessReportRecord[]> {
  const rows = await prisma.dmpBusinessReport.findMany({
    where: {
      tenantId: access.tenantId,
      userId: access.userId,
      shopId: input.shopId,
      subjectItemId: input.subjectItemId,
      competitorItemId: input.competitorItemId,
      ...(input.quality ? { quality: input.quality } : {}),
      summary: { path: ["reportType"], equals: input.reportType }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
    select: {
      id: true,
      shopId: true,
      shop: { select: { id: true, name: true } },
      subjectItemId: true,
      competitorItemId: true,
      period: true,
      quality: true,
      createdAt: true,
      report: true
    }
  });
  return rows.flatMap((row) => {
    const checked = validateDmpCanonicalReport(row.report, {
      subjectItemId: row.subjectItemId,
      competitorItemId: row.competitorItemId
    });
    if (!checked.report || dmpReportKind(checked.report) !== input.reportType) return [];
    return [storedDmpBusinessReportRecord(
      row,
      checked.report,
      row.quality === "partial" ? "partial" : "complete"
    )];
  });
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return fallback;
  return Math.min(numeric, maximum);
}

function storedDmpBusinessReportSummary(row: DmpSummaryRow): DmpBusinessReportSummary {
  const payload = normalizeStoredDmpSummary(row.summary, row);
  return {
    id: row.id,
    reportType: payload.reportType,
    shopId: row.shop?.id ?? row.shopId ?? "",
    shopName: row.shop?.name ?? "",
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId,
    period: row.period,
    quality: row.quality === "partial" ? "partial" : "complete",
    createdAt: row.createdAt.toISOString(),
    title: payload.title,
    ...(payload.marketScope ? { marketScope: payload.marketScope } : {}),
    subjectThumbnail: payload.subjectThumbnail,
    competitorThumbnail: payload.competitorThumbnail,
    ...(payload.coverageStart ? { coverageStart: payload.coverageStart } : {}),
    ...(payload.coverageEnd ? { coverageEnd: payload.coverageEnd } : {})
  };
}

function normalizeStoredDmpSummary(value: unknown, row: Pick<DmpSummaryRow, "subjectItemId" | "competitorItemId" | "period">): DmpStoredSummaryPayload {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<DmpStoredSummaryPayload>
    : {};
  const reportType = source.reportType === "market" || source.reportType === "competition" ? source.reportType : "growth";
  const subjectTitle = cleanSummaryText(source.subjectThumbnail?.title)
    || cleanSummaryText(source.title)
    || (reportType === "market" ? `类目 ${row.subjectItemId}` : `主体商品 ${row.subjectItemId}`);
  const competitorTitle = cleanSummaryText(source.competitorThumbnail?.title)
    || (row.competitorItemId ? `成功品 ${row.competitorItemId}` : "");
  const marketScope = normalizeSummaryMarketScope(source.marketScope);
  const periodDates = String(row.period ?? "").match(/20\d{2}-\d{2}-\d{2}/g) ?? [];
  return {
    version: 1,
    reportType,
    title: cleanSummaryText(source.title) || subjectTitle,
    ...(marketScope ? { marketScope } : {}),
    subjectThumbnail: {
      url: sanitizeDmpRenderImageUrl(source.subjectThumbnail?.url),
      title: subjectTitle
    },
    competitorThumbnail: {
      url: sanitizeDmpRenderImageUrl(source.competitorThumbnail?.url),
      title: competitorTitle
    },
    coverageStart: validIsoBusinessDate(String(source.coverageStart ?? ""))
      ? String(source.coverageStart)
      : periodDates[0],
    coverageEnd: validIsoBusinessDate(String(source.coverageEnd ?? ""))
      ? String(source.coverageEnd)
      : periodDates.at(-1)
  };
}

function normalizeSummaryMarketScope(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as { category_id?: unknown; category_name?: unknown; category_path?: unknown };
  const categoryId = String(source.category_id ?? "").trim();
  const categoryName = cleanSummaryText(source.category_name);
  const categoryPath = Array.isArray(source.category_path)
    ? source.category_path.map(cleanSummaryText).filter(Boolean).slice(0, 12)
    : [];
  if (!categoryId || !categoryName) return undefined;
  return { category_id: categoryId, category_name: categoryName, category_path: categoryPath.length ? categoryPath : [categoryName] };
}

function cleanSummaryText(value: unknown) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function buildDmpStoredSummary(input: {
  report: DmpCanonicalReport;
  subjectItemId: string;
  competitorItemId: string;
}): DmpStoredSummaryPayload {
  const reportType = dmpReportKind(input.report);
  const identity = dmpCanonicalReportIdentity(input.report, {
    reportType,
    subjectItemId: input.subjectItemId,
    competitorItemId: input.competitorItemId
  });
  const syntheticRecord: DmpBusinessReportRecord = {
    id: "summary-projection",
    reportType,
    subjectItemId: input.subjectItemId,
    competitorItemId: input.competitorItemId,
    period: input.report.period,
    quality: "complete",
    createdAt: new Date(0).toISOString(),
    report: input.report
  };
  const subjectThumbnail = dmpReportProductThumbnail(syntheticRecord, "subject");
  const competitorThumbnail = dmpReportProductThumbnail(syntheticRecord, "competitor");
  const dates = new Set<string>();
  for (const table of input.report.tables) {
    const dateIndex = table.columns.findIndex((column) => /^(?:日期|自然日|请求截止日|截止日)$/.test(String(column).trim()));
    if (dateIndex < 0) continue;
    for (const row of table.rows) {
      const date = String(row.cells[dateIndex] ?? "").trim();
      if (validIsoBusinessDate(date)) dates.add(date);
    }
  }
  const orderedDates = [...dates].sort();
  const marketScope = reportType === "market" ? identity.marketScope : undefined;
  const title = reportType === "market"
    ? marketScope?.category_path.join(" / ") || marketScope?.category_name || subjectThumbnail.title
    : subjectThumbnail.title;
  return {
    version: 1,
    reportType,
    title: cleanSummaryText(title) || cleanSummaryText(input.report.title),
    ...(marketScope ? { marketScope } : {}),
    subjectThumbnail: {
      url: sanitizeDmpRenderImageUrl(subjectThumbnail.url),
      title: cleanSummaryText(subjectThumbnail.title)
    },
    competitorThumbnail: {
      url: sanitizeDmpRenderImageUrl(competitorThumbnail.url),
      title: cleanSummaryText(competitorThumbnail.title)
    },
    ...(orderedDates[0] ? { coverageStart: orderedDates[0] } : {}),
    ...(orderedDates.at(-1) ? { coverageEnd: orderedDates.at(-1) } : {})
  };
}

export async function listDmpBusinessReports(access: DmpReportAccess): Promise<DmpBusinessReportRecord[]> {
  const rows = await prisma.dmpBusinessReport.findMany({
    where: { tenantId: access.tenantId, userId: access.userId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      shopId: true,
      shop: { select: { id: true, name: true } },
      subjectItemId: true,
      competitorItemId: true,
      period: true,
      quality: true,
      createdAt: true,
      report: true
    }
  });
  return rows.flatMap((row) => {
    const checked = validateDmpCanonicalReport(row.report, {
      subjectItemId: row.subjectItemId,
      competitorItemId: row.competitorItemId
    });
    if (!checked.report) return [];
    return [{
      id: row.id,
      reportType: dmpReportKind(checked.report),
      ...(row.shop ? { shopId: row.shop.id, shopName: row.shop.name } : {}),
      subjectItemId: row.subjectItemId,
      competitorItemId: row.competitorItemId,
      period: row.period,
      quality: effectiveDmpReportQuality(
        checked.report,
        row.quality === "partial" ? "partial" : "complete"
      ),
      createdAt: row.createdAt.toISOString(),
      report: checked.report
    }];
  });
}

export async function saveDmpBusinessReport(input: {
  access: DmpReportAccess;
  shopId: string;
  report: DmpCanonicalReport;
  subjectItemId: string;
  competitorItemId: string;
  quality: DmpReportQuality;
  sourceVersion: string;
  sourceShop?: DmpReportSourceShopInput;
  archiveMode?: "replace-latest-pair";
  replaceReportId?: string;
  absorbedReportIds?: string[];
}): Promise<DmpBusinessReportRecord & { retention?: DmpReportReplaceLatestPairRetention }> {
  const shopId = String(input.shopId ?? "").trim();
  const sourceShopId = String(input.sourceShop?.shopId ?? "").trim();
  if (!validInternalShopId(shopId) || sourceShopId !== shopId) {
    const error = input.archiveMode === "replace-latest-pair"
      ? new DmpReportReplaceConflictError("本次归档缺少可验证的冻结店铺")
      : new DmpReportSourceShopError("本次归档缺少可验证的冻结店铺", 400);
    throw error;
  }
  let sourceShop: ReturnType<typeof normalizeDmpReportSourceShop>;
  try {
    sourceShop = normalizeDmpReportSourceShop(input.sourceShop);
  } catch (error) {
    if (input.archiveMode === "replace-latest-pair") {
      throw new DmpReportReplaceConflictError(error instanceof Error ? error.message : "冻结店铺信息无效");
    }
    throw error;
  }
  const effectiveQuality = effectiveDmpReportQuality(input.report, input.quality);
  const summary = buildDmpStoredSummary(input);
  if (input.archiveMode === "replace-latest-pair") {
    try {
      const replacement = normalizeDmpReportReplacement(input.replaceReportId, input.absorbedReportIds);
      const result = await prisma.$transaction(async (tx) => replaceLatestPairReport(tx, {
        ...input,
        shopId,
        sourceShop,
        summary,
        effectiveQuality,
        replacement
      }));
      return {
        ...storedDmpBusinessReportRecord(result.row, input.report, effectiveQuality),
        retention: result.retention
      };
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new DmpReportReplaceConflictError("新报告指纹已被另一份报告占用，未执行原子替换");
      }
      throw error;
    }
  }

  const row = await prisma.$transaction(async (tx) => {
    const shop = await tx.shop.findFirst({
      where: { id: shopId, tenantId: input.access.tenantId },
      select: { id: true, name: true }
    });
    if (!shop) {
      throw new DmpReportSourceShopError("店铺不存在或不属于当前账号", 404);
    }
    await lockDmpReportPair(tx, {
      access: input.access,
      shopId,
      reportType: dmpReportKind(input.report),
      subjectItemId: input.subjectItemId,
      competitorItemId: input.competitorItemId
    });
    const fingerprint = dmpBusinessReportFingerprint({
      report: input.report,
      subjectItemId: input.subjectItemId,
      competitorItemId: input.competitorItemId,
      shopId
    });
    const stored = await tx.dmpBusinessReport.upsert({
      where: {
        tenantId_userId_fingerprint: {
          tenantId: input.access.tenantId,
          userId: input.access.userId,
          fingerprint
        }
      },
      create: {
        tenantId: input.access.tenantId,
        userId: input.access.userId,
        shopId,
        subjectItemId: input.subjectItemId,
        competitorItemId: input.competitorItemId,
        period: input.report.period,
        quality: effectiveQuality,
        sourceVersion: input.sourceVersion,
        fingerprint,
        summary: summary as unknown as Prisma.InputJsonValue,
        report: input.report as unknown as Prisma.InputJsonValue
      },
      update: { summary: summary as unknown as Prisma.InputJsonValue },
      select: {
        id: true,
        shop: { select: { id: true, name: true } },
        subjectItemId: true,
        competitorItemId: true,
        period: true,
        quality: true,
        createdAt: true,
        report: true
      }
    });
    if (stored.shop?.id !== shopId) {
      throw new DmpReportSourceShopError("官网返回的报告店铺与冻结目标不一致", 400);
    }
    return stored;
  });
  return storedDmpBusinessReportRecord(row, input.report, effectiveQuality);
}

type StoredDmpReportRow = {
  id: string;
  shop: { id: string; name: string } | null;
  subjectItemId: string;
  competitorItemId: string;
  period: string;
  quality: string;
  createdAt: Date;
  report: unknown;
};

function storedDmpBusinessReportRecord(
  row: StoredDmpReportRow,
  fallbackReport: DmpCanonicalReport,
  fallbackQuality: DmpReportQuality
): DmpBusinessReportRecord {
  const storedReport = validateDmpCanonicalReport(row.report, {
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId
  }).report ?? fallbackReport;
  return {
    id: row.id,
    reportType: dmpReportKind(storedReport),
    ...(row.shop ? { shopId: row.shop.id, shopName: row.shop.name } : {}),
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId,
    period: row.period,
    quality: effectiveDmpReportQuality(
      storedReport,
      row.quality === "partial" ? "partial" : fallbackQuality
    ),
    createdAt: row.createdAt.toISOString(),
    report: storedReport
  };
}

function normalizeDmpReportReplacement(replaceReportId: unknown, absorbedReportIds: unknown) {
  const targetId = String(replaceReportId ?? "").trim();
  const rawIds = Array.isArray(absorbedReportIds) ? absorbedReportIds : [];
  const normalizedIds = rawIds.map((value) => String(value ?? "").trim());
  const absorbed = [...new Set(normalizedIds)];
  if (
    !targetId
    || targetId.length > 100
    || rawIds.length < 1
    || rawIds.length > 200
    || normalizedIds.some((id) => !id || id.length > 100)
    || !absorbed.includes(targetId)
  ) {
    throw new DmpReportReplaceConflictError("原子替换目标或吸收报告清单无效");
  }
  return { targetId, absorbed };
}

async function replaceLatestPairReport(
  tx: Prisma.TransactionClient,
  input: {
    access: DmpReportAccess;
    report: DmpCanonicalReport;
    subjectItemId: string;
    competitorItemId: string;
    quality: DmpReportQuality;
    sourceVersion: string;
    shopId: string;
    sourceShop: ReturnType<typeof normalizeDmpReportSourceShop>;
    summary: DmpStoredSummaryPayload;
    effectiveQuality: DmpReportQuality;
    replacement: { targetId: string; absorbed: string[] };
  }
) {
  const conflict = (message: string): never => {
    throw new DmpReportReplaceConflictError(message);
  };
  if (dmpReportKind(input.report) !== "growth") conflict("只有完整的商品成长报告可以原子更新");
  if (input.quality !== "complete" || input.effectiveQuality !== "complete") {
    conflict("本次商品成长报告仍为部分数据，已保留原报告且未覆盖");
  }
  const incomingIdentity = dmpCanonicalReportIdentity(input.report, {
    subjectItemId: input.subjectItemId,
    competitorItemId: input.competitorItemId
  });
  if (
    incomingIdentity.reportType !== "growth"
    || incomingIdentity.subjectItemId !== input.subjectItemId
    || incomingIdentity.competitorItemIds.length !== 1
    || incomingIdentity.competitorItemIds[0] !== input.competitorItemId
  ) {
    conflict("新报告的主体或竞品身份不一致，未执行原子替换");
  }
  const incomingRange = continuousGrowthDailyRange(input.report);
  if (!incomingRange) throw new DmpReportReplaceConflictError("新报告缺少连续的分日数据，未执行原子替换");

  // 先锁定目标编号，再依据数据库内目标的冻结店铺与商品对加第二把锁。这样相同目标
  // 或同店铺同商品对的并发归档只能串行进入验收与更新阶段。
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dmp-report-target:${input.access.tenantId}:${input.access.userId}:${input.replacement.targetId}`}))`;
  const targetSeed = await tx.dmpBusinessReport.findFirst({
    where: {
      id: input.replacement.targetId,
      tenantId: input.access.tenantId,
      userId: input.access.userId
    },
    select: {
      id: true,
      shopId: true,
      subjectItemId: true,
      competitorItemId: true
    }
  });
  if (!targetSeed || !targetSeed.shopId || targetSeed.shopId !== input.shopId) {
    throw new DmpReportReplaceConflictError("原报告不存在、未归类到冻结店铺或无权更新");
  }
  await lockDmpReportPair(tx, {
    access: input.access,
    shopId: targetSeed.shopId,
    reportType: "growth",
    subjectItemId: targetSeed.subjectItemId,
    competitorItemId: targetSeed.competitorItemId
  });

  const rows = await tx.dmpBusinessReport.findMany({
    where: {
      id: { in: input.replacement.absorbed },
      tenantId: input.access.tenantId,
      userId: input.access.userId
    },
    select: {
      id: true,
      tenantId: true,
      userId: true,
      shopId: true,
      shop: { select: { id: true, name: true } },
      subjectItemId: true,
      competitorItemId: true,
      period: true,
      quality: true,
      sourceVersion: true,
      fingerprint: true,
      createdAt: true,
      report: true
    }
  });
  if (rows.length !== input.replacement.absorbed.length) {
    conflict("吸收报告清单包含不存在或无权访问的记录，未执行原子替换");
  }
  const target = rows.find((row) => row.id === input.replacement.targetId);
  if (!target?.shopId || !target.shop || target.shopId !== targetSeed.shopId) {
    throw new DmpReportReplaceConflictError("原报告的冻结店铺已变化，未执行原子替换");
  }
  await validateFrozenReplacementShop(tx, input.access.tenantId, input.sourceShop, target.shopId, input.shopId);

  // archive-pair 的单次窗口最多 200 份。窗口之外更老的记录允许本次保留，成功后下一轮继续吸收；
  // 但锁内若发现比本次吸收窗口边界更新的未吸收完整报告，必然说明快照过期，须 409 零写重建。
  const oldestAbsorbed = [...rows].sort(compareStoredReportPosition)[0];
  const newestUnabsorbed = await tx.dmpBusinessReport.findFirst({
    where: {
      tenantId: input.access.tenantId,
      userId: input.access.userId,
      shopId: target.shopId,
      subjectItemId: input.subjectItemId,
      competitorItemId: input.competitorItemId,
      quality: "complete",
      summary: { path: ["reportType"], equals: "growth" },
      id: { notIn: input.replacement.absorbed }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true }
  });
  if (newestUnabsorbed && compareStoredReportPosition(newestUnabsorbed, oldestAbsorbed) > 0) {
    throw new DmpReportHistoryStaleError();
  }

  for (const row of rows) {
    if (
      row.tenantId !== input.access.tenantId
      || row.userId !== input.access.userId
      || row.shopId !== target.shopId
      || row.subjectItemId !== input.subjectItemId
      || row.competitorItemId !== input.competitorItemId
      || row.quality !== "complete"
    ) {
      conflict("待吸收报告不属于同一冻结店铺、主体与竞品，或质量不是完整报告");
    }
    const checked = validateDmpCanonicalReport(row.report, {
      subjectItemId: row.subjectItemId,
      competitorItemId: row.competitorItemId
    });
    if (!checked.report || checked.issues?.length || dmpReportKind(checked.report) !== "growth") {
      throw new DmpReportReplaceConflictError("待吸收记录不是可验证的完整商品成长报告");
    }
    const identity = dmpCanonicalReportIdentity(checked.report, {
      subjectItemId: row.subjectItemId,
      competitorItemId: row.competitorItemId
    });
    if (
      identity.reportType !== "growth"
      || identity.subjectItemId !== input.subjectItemId
      || identity.competitorItemIds.length !== 1
      || identity.competitorItemIds[0] !== input.competitorItemId
      || effectiveDmpReportQuality(checked.report, "complete") !== "complete"
    ) {
      conflict("待吸收报告的身份或有效质量与本次更新不一致");
    }
    const range = continuousGrowthDailyRange(checked.report);
    if (!range || !dateRangesTouch(incomingRange, range)) {
      throw new DmpReportReplaceConflictError("待吸收报告的分日范围不连续或与新报告不连通");
    }
  }

  const fingerprint = dmpBusinessReportFingerprint({
    report: input.report,
    subjectItemId: input.subjectItemId,
    competitorItemId: input.competitorItemId,
    shopId: target.shopId
  });
  const fingerprintCollision = await tx.dmpBusinessReport.findFirst({
    where: {
      tenantId: input.access.tenantId,
      userId: input.access.userId,
      fingerprint,
      id: { notIn: input.replacement.absorbed }
    },
    select: { id: true }
  });
  if (fingerprintCollision) conflict("新报告指纹已被未吸收的报告占用，未执行原子替换");

  const absorbedExceptTarget = input.replacement.absorbed.filter((id) => id !== target.id);
  if (absorbedExceptTarget.length) {
    // 分享记录只改 reportId，令牌、访问/点击统计、热力与会话明细均原样保留。
    await tx.dmpReportShare.updateMany({
      where: { reportId: { in: absorbedExceptTarget } },
      data: { reportId: target.id }
    });
    const deleted = await tx.dmpBusinessReport.deleteMany({
      where: {
        id: { in: absorbedExceptTarget },
        tenantId: input.access.tenantId,
        userId: input.access.userId,
        shopId: target.shopId
      }
    });
    if (deleted.count !== absorbedExceptTarget.length) {
      conflict("吸收报告在事务内发生变化，已回滚且未覆盖原报告");
    }
  }

  const replacedAt = new Date();
  const row = await tx.dmpBusinessReport.update({
    where: { id: target.id },
    data: {
      report: input.report as unknown as Prisma.InputJsonValue,
      period: input.report.period,
      quality: "complete",
      sourceVersion: input.sourceVersion,
      fingerprint,
      summary: input.summary as unknown as Prisma.InputJsonValue,
      createdAt: replacedAt
    },
    select: {
      id: true,
      shop: { select: { id: true, name: true } },
      subjectItemId: true,
      competitorItemId: true,
      period: true,
      quality: true,
      createdAt: true,
      report: true
    }
  });
  return {
    row,
    retention: {
      mode: "replace-latest-pair" as const,
      confirmed: true as const,
      replacedReportId: target.id,
      absorbedReportIds: [...input.replacement.absorbed]
    }
  };
}

async function validateFrozenReplacementShop(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sourceShop: ReturnType<typeof normalizeDmpReportSourceShop>,
  frozenShopId: string,
  requestedShopId: string
) {
  if (!sourceShop || requestedShopId !== frozenShopId) {
    throw new DmpReportReplaceConflictError("本次更新缺少可验证的冻结店铺，未执行原子替换");
  }
  const shop = await tx.shop.findFirst({
    where: { id: requestedShopId, tenantId },
    select: { id: true, name: true }
  });
  if (!shop || shop.id !== frozenShopId) {
    throw new DmpReportReplaceConflictError("本次冻结店铺与原报告店铺不一致，未执行原子替换");
  }
}

function continuousGrowthDailyRange(report: DmpCanonicalReport) {
  const tables = report.tables.filter((table) => table.name === "日GMV与费比");
  if (tables.length !== 1) return null;
  const table = tables[0];
  const dateIndex = table.columns.findIndex((column) => /^(?:日期|自然日)$/.test(String(column).trim()));
  if (dateIndex < 0 || !table.rows.length) return null;
  const dates = table.rows.map((row) => String(row.cells[dateIndex] ?? "").trim());
  if (
    dates.some((date) => !validIsoBusinessDate(date))
    || new Set(dates).size !== dates.length
  ) return null;
  const sorted = [...dates].sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (isoDateDay(sorted[index]) !== isoDateDay(sorted[index - 1]) + 1) return null;
  }
  return { startDate: sorted[0], endDate: sorted.at(-1) ?? sorted[0] };
}

function validIsoBusinessDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isoDateDay(value: string) {
  return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / 86_400_000);
}

function dateRangesTouch(
  left: { startDate: string; endDate: string },
  right: { startDate: string; endDate: string }
) {
  return isoDateDay(right.startDate) <= isoDateDay(left.endDate) + 1
    && isoDateDay(right.endDate) >= isoDateDay(left.startDate) - 1;
}

function compareStoredReportPosition(
  left: { id: string; createdAt: Date },
  right: { id: string; createdAt: Date }
) {
  const timeDifference = left.createdAt.getTime() - right.createdAt.getTime();
  return timeDifference || left.id.localeCompare(right.id);
}

async function lockDmpReportPair(
  tx: Prisma.TransactionClient,
  input: {
    access: DmpReportAccess;
    shopId: string;
    reportType: "growth" | "competition" | "market";
    subjectItemId: string;
    competitorItemId: string;
  }
) {
  await lockDmpReportPairs(tx, [input]);
}

async function lockDmpReportPairs(
  tx: Prisma.TransactionClient,
  inputs: Array<{
    access: DmpReportAccess;
    shopId: string;
    reportType: "growth" | "competition" | "market";
    subjectItemId: string;
    competitorItemId: string;
  }>
) {
  const keys = [...new Set(inputs.map(dmpReportPairLockKey))].sort();
  for (const key of keys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }
}

function dmpReportPairLockKey(input: {
  access: DmpReportAccess;
  shopId: string;
  reportType: "growth" | "competition" | "market";
  subjectItemId: string;
  competitorItemId: string;
}) {
  return [
    "dmp-report-pair",
    input.access.tenantId,
    input.access.userId,
    input.shopId,
    input.reportType,
    input.subjectItemId,
    input.competitorItemId
  ].join(":");
}

function reportTypeFromSummary(value: unknown): "growth" | "competition" | "market" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "growth";
  const reportType = (value as { reportType?: unknown }).reportType;
  return reportType === "competition" || reportType === "market" ? reportType : "growth";
}

function isPrismaUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

function normalizeDmpReportSourceShop(value: DmpReportSourceShopInput | undefined) {
  if (!value) return null;
  const rawShopId = String(value.shopId ?? "").trim();
  const rawSourceShopId = String(value.sourceShopId ?? "").trim();
  if (/^\d+$/.test(rawShopId) && !/^\d{5,32}$/.test(rawShopId)) {
    throw new DmpReportSourceShopError("来源店铺编号无效", 400);
  }
  const numericShopId = /^\d{5,32}$/.test(rawShopId) ? rawShopId : "";
  const internalShopId = numericShopId ? "" : rawShopId;
  const sourceShopId = rawSourceShopId || numericShopId;
  const normalizedShopName = normalizedDmpShopName(value.shopName);
  if (internalShopId.length > 100) throw new DmpReportSourceShopError("店铺编号无效", 400);
  if (sourceShopId && !/^\d{5,32}$/.test(sourceShopId)) {
    throw new DmpReportSourceShopError("来源店铺编号无效", 400);
  }
  if (!internalShopId && !sourceShopId && !normalizedShopName) {
    throw new DmpReportSourceShopError("来源店铺信息无效", 400);
  }
  const fingerprintScope = sourceShopId
    ? `dmp-source-shop:${sourceShopId}`
    : internalShopId
      ? `internal-shop:${internalShopId}`
      : `shop-name:${normalizedShopName}`;
  return { internalShopId, sourceShopId, normalizedShopName, fingerprintScope };
}

function normalizedDmpShopName(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .slice(0, 100);
}

export async function getDmpBusinessReport(access: DmpReportAccess, id: string, shopId: string) {
  const row = await prisma.dmpBusinessReport.findFirst({
    where: { id, tenantId: access.tenantId, userId: access.userId, shopId },
    select: {
      id: true,
      shopId: true,
      shop: { select: { id: true, name: true } },
      subjectItemId: true,
      competitorItemId: true,
      period: true,
      quality: true,
      createdAt: true,
      report: true
    }
  });
  if (!row) return null;
  const checked = validateDmpCanonicalReport(row.report, {
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId
  });
  if (!checked.report) return null;
  return {
    id: row.id,
    reportType: dmpReportKind(checked.report),
    ...(row.shop ? { shopId: row.shop.id, shopName: row.shop.name } : {}),
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId,
    period: row.period,
    quality: effectiveDmpReportQuality(
      checked.report,
      row.quality === "partial" ? "partial" : "complete"
    ),
    createdAt: row.createdAt.toISOString(),
    report: checked.report
  } satisfies DmpBusinessReportRecord;
}

export async function deleteDmpBusinessReport(access: DmpReportAccess, id: string, shopId: string) {
  const result = await prisma.dmpBusinessReport.deleteMany({
    where: { id, tenantId: access.tenantId, userId: access.userId, shopId }
  });
  return result.count > 0;
}

export async function assignDmpBusinessReportsShop(input: {
  access: DmpReportAccess;
  sourceShopId: string;
  targetShopId: string;
  reportIds?: string[];
  reportType?: "growth" | "competition" | "market";
  subjectItemId?: string;
  competitorItemId?: string;
}): Promise<
  | {
      ok: true;
      reportIds: string[];
      count: number;
      truncated: boolean;
      shop: { id: string; name: string } | null;
    }
  | { ok: false; error: string; status: 400 | 404 }
> {
  const sourceShopId = String(input.sourceShopId ?? "").trim();
  const targetShopId = String(input.targetShopId ?? "").trim();
  if (!validInternalShopId(sourceShopId) || (targetShopId && !validInternalShopId(targetShopId))) {
    return { ok: false, error: "店铺编号无效", status: 400 };
  }
  const explicitIds = [...new Set((input.reportIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (explicitIds.length > 200 || explicitIds.some((id) => id.length > 100)) {
    return { ok: false, error: "请选择不超过 200 份报告", status: 400 };
  }
  const reportType = input.reportType;
  const subjectItemId = String(input.subjectItemId ?? "").trim();
  const competitorItemId = String(input.competitorItemId ?? "").trim();
  const groupMode = reportType === "growth" || reportType === "competition" || reportType === "market";
  if (!explicitIds.length && (!groupMode || !subjectItemId)) {
    return { ok: false, error: "报告组身份无效", status: 400 };
  }

  return prisma.$transaction(async (tx) => {
    const shop = targetShopId
      ? await tx.shop.findFirst({
          where: { id: targetShopId, tenantId: input.access.tenantId },
          select: { id: true, name: true }
        })
      : null;
    if (targetShopId && !shop) return { ok: false as const, error: "店铺不存在或不属于当前账号", status: 404 as const };

    const sourceWhere = {
      tenantId: input.access.tenantId,
      userId: input.access.userId,
      shopId: sourceShopId,
      ...(explicitIds.length ? { id: { in: explicitIds } } : {
        subjectItemId,
        competitorItemId,
        summary: { path: ["reportType"], equals: reportType }
      })
    };
    if (groupMode) {
      await lockDmpReportPairs(tx, [sourceShopId, targetShopId].filter(Boolean).map((shopId) => ({
        access: input.access,
        shopId,
        reportType,
        subjectItemId,
        competitorItemId
      })));
    } else {
      const candidates = await tx.dmpBusinessReport.findMany({
        where: sourceWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 201,
        select: { id: true, subjectItemId: true, competitorItemId: true, summary: true }
      });
      if (candidates.length !== explicitIds.length) {
        return { ok: false as const, error: "报告组不存在、不属于当前店铺或超过 200 份", status: 404 as const };
      }
      await lockDmpReportPairs(tx, candidates.flatMap((row) => (
        [sourceShopId, targetShopId].filter(Boolean).map((shopId) => ({
          access: input.access,
          shopId,
          reportType: reportTypeFromSummary(row.summary),
          subjectItemId: row.subjectItemId,
          competitorItemId: row.competitorItemId
        }))
      )));
    }

    const ownedRows = await tx.dmpBusinessReport.findMany({
      where: sourceWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: explicitIds.length ? 201 : 200,
      select: { id: true }
    });
    const reportIds = ownedRows.map((row) => row.id);
    if (!reportIds.length || (explicitIds.length && reportIds.length !== explicitIds.length)) {
      return { ok: false as const, error: "报告组不存在、不属于当前店铺或超过 200 份", status: 404 as const };
    }

    const updated = await tx.dmpBusinessReport.updateMany({
      where: explicitIds.length
        ? {
            id: { in: reportIds },
            tenantId: input.access.tenantId,
            userId: input.access.userId,
            shopId: sourceShopId
          }
        : sourceWhere,
      data: { shopId: shop?.id ?? null }
    });
    return {
      ok: true as const,
      reportIds,
      count: updated.count,
      truncated: updated.count > reportIds.length,
      shop
    };
  });
}

function validInternalShopId(value: unknown) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(String(value ?? ""));
}

export function validItemId(value: unknown) {
  return /^\d{6,20}$/.test(String(value ?? ""));
}

/** 达摩盘叶子类目 ID 合同与商品 ID 不同，插件允许 1 至 20 位纯数字。 */
export function validCategoryId(value: unknown) {
  return /^\d{1,20}$/.test(String(value ?? ""));
}

export function parseDmpCompetitorIds(value: unknown) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[,，、;；\s]+/);
  return [...new Set(source.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 4);
}
