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
  type DmpBusinessReportRecord,
  type DmpCanonicalReport,
  type DmpReportQuality,
  type DmpReportTableSnapshot
} from "@/lib/dmp-report-types";
import { getCurrentSession } from "@/lib/server-session";
import { getDmpAutomationAccessForSession } from "@/lib/tool-entitlements";
import { withDmpAutomationBrand } from "@/lib/dmp-product";
import { effectiveDmpReportQuality } from "@/lib/dmp-report-quality";
import { dmpCanonicalReportIdentity } from "@/lib/dmp-report-library";

const MAX_REPORT_BYTES = 8 * 1024 * 1024;
export const DMP_REPORT_ARCHIVE_MAX_BODY_BYTES = MAX_REPORT_BYTES + 64 * 1024;
const MAX_TABLES = 200;
const MAX_TABLE_ROWS = 5_000;
const MAX_CELL_LENGTH = 10_000;
const MAX_TABLE_NAME_LENGTH = 200;
const MAX_TABLE_COLUMNS = 100;
const MAX_REPORT_CELLS = 1_000_000;
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

  constructor(message = "官网同商品对历史已变化，请重新读取并合并后再提交") {
    super(message);
    this.name = "DmpReportHistoryStaleError";
  }
}

/**
 * 所有会改动报告归属、报告本体或其分享外键的事务都按同一稳定顺序获取这些锁。
 * 锁键包含租户与用户作用域，避免跨账号互相阻塞；排序可避免多报告操作死锁。
 */
export async function lockDmpReportTargets(
  tx: Prisma.TransactionClient,
  access: DmpReportAccess,
  reportIds: string[]
) {
  const normalized = reportIds.map((id) => String(id ?? "").trim());
  if (normalized.some((id) => !id || id.length > 100)) throw new Error("报告锁目标无效");
  const ordered = [...new Set(normalized)]
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const reportId of ordered) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dmp-report-target:${access.tenantId}:${access.userId}:${reportId}`}))`;
  }
}

function dmpReportPairLockKey(
  access: DmpReportAccess,
  shopId: string,
  subjectItemId: string,
  competitorItemId: string
) {
  return `dmp-report-pair:${access.tenantId}:${access.userId}:${shopId}:${subjectItemId}:${competitorItemId}`;
}

async function lockDmpReportPairKeys(tx: Prisma.TransactionClient, pairKeys: string[]) {
  const ordered = [...new Set(pairKeys)].sort((left, right) => left.localeCompare(right, "en"));
  for (const pairKey of ordered) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`;
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
  if (rawTables.length > MAX_TABLES) {
    if (kind === "market") return { error: `类目大盘业务表超过 ${MAX_TABLES} 个保存上限` };
    pushArchiveIssue(issues, `业务表超过 ${MAX_TABLES} 个，已截断归档`);
  }
  if (kind === "market" && rawTables.some((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    return Array.isArray((candidate as { rows?: unknown }).rows)
      && ((candidate as { rows: unknown[] }).rows.length > MAX_TABLE_ROWS);
  })) {
    return { error: `类目大盘单表超过 ${MAX_TABLE_ROWS} 行，请按周期或属性分片后重试` };
  }
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
  if (input.archiveMode === "replace-latest-pair") {
    try {
      const replacement = normalizeDmpReportReplacement(input.replaceReportId, input.absorbedReportIds);
      const result = await prisma.$transaction(async (tx) => replaceLatestDmpGrowthReport(tx, {
        ...input,
        sourceShop,
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
    let tenantShops: Array<{ id: string; name: string }> | null = null;
    let shop = sourceShop?.internalShopId
      ? await tx.shop.findFirst({
          where: { id: sourceShop.internalShopId, tenantId: input.access.tenantId },
          select: { id: true, name: true }
        })
      : null;
    if (sourceShop?.internalShopId && !shop) {
      throw new DmpReportSourceShopError("店铺不存在或不属于当前账号", 404);
    }
    if (!shop && sourceShop?.normalizedShopName) {
      tenantShops = await tx.shop.findMany({
        where: { tenantId: input.access.tenantId },
        orderBy: { createdAt: "asc" },
        take: 201,
        select: { id: true, name: true }
      });
      // 只在已完整读取租户店铺且规范化名称唯一命中时归类；歧义/未命中均继续走安全回退。
      if (tenantShops.length < 201) {
        const matches = tenantShops.filter((candidate) => normalizedDmpShopName(candidate.name) === sourceShop.normalizedShopName);
        if (matches.length === 1) shop = matches[0];
      }
    }
    if (!shop) {
      const previous = await tx.dmpBusinessReport.findFirst({
        where: {
          tenantId: input.access.tenantId,
          userId: input.access.userId,
          subjectItemId: input.subjectItemId,
          competitorItemId: input.competitorItemId
        },
        orderBy: { createdAt: "desc" },
        select: { shop: { select: { id: true, name: true } } }
      });
      shop = previous?.shop ?? null;
    }
    if (!shop) {
      const fallbackShops = tenantShops ?? await tx.shop.findMany({
          where: { tenantId: input.access.tenantId },
          orderBy: { createdAt: "asc" },
          take: 2,
          select: { id: true, name: true }
        });
      if (fallbackShops.length === 1) shop = fallbackShops[0];
    }
    if (shop && dmpReportKind(input.report) === "growth") {
      await lockDmpReportPairKeys(tx, [dmpReportPairLockKey(
        input.access,
        shop.id,
        input.subjectItemId,
        input.competitorItemId
      )]);
    }
    const fingerprint = dmpBusinessReportFingerprint({
      report: input.report,
      subjectItemId: input.subjectItemId,
      competitorItemId: input.competitorItemId,
      // 匹配成功时按内部店铺隔离；未匹配时只让外部来源进入哈希，绝不写入关系字段。
      ...(sourceShop ? {
        sourceScope: shop ? `internal-shop:${shop.id}` : sourceShop.fingerprintScope
      } : {})
    });
    if (shop && dmpReportKind(input.report) === "growth" && effectiveQuality === "complete") {
      const incomingRange = continuousGrowthDailyRange(input.report);
      if (incomingRange) {
        const existing = await tx.dmpBusinessReport.findMany({
          where: {
            tenantId: input.access.tenantId,
            userId: input.access.userId,
            shopId: shop.id,
            subjectItemId: input.subjectItemId,
            competitorItemId: input.competitorItemId,
            quality: "complete"
          },
          select: growthCandidateSelect
        });
        for (const candidate of existing) {
          const validated = validatedGrowthCandidate(candidate, input.subjectItemId, input.competitorItemId);
          if (!validated) continue;
          const candidateFingerprint = dmpBusinessReportFingerprint({
            report: validated.report,
            subjectItemId: input.subjectItemId,
            competitorItemId: input.competitorItemId,
            shopId: shop.id
          });
          if (candidateFingerprint === fingerprint) continue;
          if (dateRangesTouch(incomingRange, validated.range)) {
            throw new DmpReportHistoryStaleError();
          }
        }
      }
    }
    return tx.dmpBusinessReport.upsert({
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
        shopId: shop?.id ?? null,
        subjectItemId: input.subjectItemId,
        competitorItemId: input.competitorItemId,
        period: input.report.period,
        quality: effectiveQuality,
        sourceVersion: input.sourceVersion,
        fingerprint,
        report: input.report as unknown as Prisma.InputJsonValue
      },
      // Fingerprint 去重后只允许质量单向升级；失败重试不得把已有完整报告降回 partial。
      update: effectiveQuality === "complete"
        ? { quality: "complete", sourceVersion: input.sourceVersion }
        : {},
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

const growthCandidateSelect = {
  id: true,
  tenantId: true,
  userId: true,
  shopId: true,
  subjectItemId: true,
  competitorItemId: true,
  period: true,
  quality: true,
  createdAt: true,
  report: true
} as const;

type DmpGrowthCandidateRow = {
  id: string;
  tenantId: string;
  userId: string;
  shopId: string | null;
  subjectItemId: string;
  competitorItemId: string;
  period: string;
  quality: string;
  createdAt: Date;
  report: unknown;
};

function validatedGrowthCandidate(
  row: DmpGrowthCandidateRow,
  subjectItemId: string,
  competitorItemId: string
) {
  if (
    row.quality !== "complete"
    || row.subjectItemId !== subjectItemId
    || row.competitorItemId !== competitorItemId
  ) return null;
  const checked = validateDmpCanonicalReport(row.report, {
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId
  });
  if (!checked.report || checked.issues?.length || dmpReportKind(checked.report) !== "growth") return null;
  const identity = dmpCanonicalReportIdentity(checked.report, {
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId
  });
  if (
    identity.reportType !== "growth"
    || identity.subjectItemId !== subjectItemId
    || identity.competitorItemIds.length !== 1
    || identity.competitorItemIds[0] !== competitorItemId
    || effectiveDmpReportQuality(checked.report, "complete") !== "complete"
  ) return null;
  const range = continuousGrowthDailyRange(checked.report);
  return range ? { report: checked.report, range } : null;
}

async function replaceLatestDmpGrowthReport(
  tx: Prisma.TransactionClient,
  input: {
    access: DmpReportAccess;
    report: DmpCanonicalReport;
    subjectItemId: string;
    competitorItemId: string;
    quality: DmpReportQuality;
    sourceVersion: string;
    sourceShop: ReturnType<typeof normalizeDmpReportSourceShop>;
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

  // 所有 absorbed 目标先按统一顺序锁定，再锁冻结店铺商品对；assignment/share/delete
  // 使用同一 target 锁协议，因此验收后的迁移、删除和原位更新不会被交叉写入打断。
  await lockDmpReportTargets(tx, input.access, input.replacement.absorbed);
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
  if (!targetSeed || !targetSeed.shopId) {
    throw new DmpReportReplaceConflictError("原报告不存在、未归类到冻结店铺或无权更新");
  }
  await lockDmpReportPairKeys(tx, [dmpReportPairLockKey(
    input.access,
    targetSeed.shopId,
    targetSeed.subjectItemId,
    targetSeed.competitorItemId
  )]);

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
  await validateFrozenReplacementShop(tx, input.access.tenantId, input.sourceShop, target.shopId);

  const absorbedRanges: Array<{ id: string; startDate: string; endDate: string }> = [];
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
    if (!range) throw new DmpReportReplaceConflictError("待吸收报告的分日表自身不连续");
    absorbedRanges.push({ id: row.id, ...range });
  }
  const rangeById = new Map(absorbedRanges.map((range) => [range.id, range]));
  const targetRange = rangeById.get(target.id);
  const newestAbsorbed = targetRange
    ? [...rows].sort((left, right) => compareGrowthReportRecency(
        left,
        rangeById.get(left.id)!,
        right,
        rangeById.get(right.id)!
      ))[0]
    : null;
  if (!newestAbsorbed || newestAbsorbed.id !== target.id) {
    conflict("原位更新目标不是吸收清单中按生成时间、分日截止日和编号确定的最新报告");
  }
  if (absorbedRanges.some((range) => (
    isoDateDay(range.startDate) < isoDateDay(incomingRange.startDate)
    || isoDateDay(range.endDate) > isoDateDay(incomingRange.endDate)
  ))) {
    throw new DmpReportReplaceConflictError("新报告未完整覆盖待吸收报告的分日范围，未执行原子替换");
  }
  if (!dateRangeUnionIsConnected([incomingRange, ...absorbedRanges])) {
    throw new DmpReportReplaceConflictError("新报告与待吸收报告的分日范围存在断层，未执行原子替换");
  }

  const absorbedIds = new Set(input.replacement.absorbed);
  const currentCandidates = await tx.dmpBusinessReport.findMany({
    where: {
      tenantId: input.access.tenantId,
      userId: input.access.userId,
      shopId: target.shopId,
      subjectItemId: input.subjectItemId,
      competitorItemId: input.competitorItemId,
      quality: "complete"
    },
    select: growthCandidateSelect
  });
  for (const candidate of currentCandidates) {
    if (absorbedIds.has(candidate.id)) continue;
    const validated = validatedGrowthCandidate(candidate, input.subjectItemId, input.competitorItemId);
    if (!validated) continue;
    if (dateRangesTouch(incomingRange, validated.range)) {
      throw new DmpReportHistoryStaleError();
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
    // 仅迁移外键，分享令牌、访问/点击统计、热力与会话明细全部保持原值。
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

  const row = await tx.dmpBusinessReport.update({
    where: { id: target.id },
    data: {
      report: input.report as unknown as Prisma.InputJsonValue,
      period: input.report.period,
      quality: "complete",
      sourceVersion: input.sourceVersion,
      fingerprint,
      createdAt: new Date()
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
  frozenShopId: string
) {
  if (!sourceShop?.internalShopId) {
    throw new DmpReportReplaceConflictError("本次更新缺少可验证的冻结店铺，未执行原子替换");
  }
  const shop = await tx.shop.findFirst({
    where: { id: sourceShop.internalShopId, tenantId },
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
  if (dates.some((date) => !validIsoBusinessDate(date)) || new Set(dates).size !== dates.length) return null;
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

function dateRangeUnionIsConnected(ranges: Array<{ startDate: string; endDate: string }>) {
  const ordered = [...ranges].sort((left, right) => (
    isoDateDay(left.startDate) - isoDateDay(right.startDate)
    || isoDateDay(left.endDate) - isoDateDay(right.endDate)
  ));
  if (!ordered.length) return false;
  let connectedEnd = isoDateDay(ordered[0].endDate);
  for (const range of ordered.slice(1)) {
    if (isoDateDay(range.startDate) > connectedEnd + 1) return false;
    connectedEnd = Math.max(connectedEnd, isoDateDay(range.endDate));
  }
  return true;
}

function dateRangesTouch(
  left: { startDate: string; endDate: string },
  right: { startDate: string; endDate: string }
) {
  return isoDateDay(right.startDate) <= isoDateDay(left.endDate) + 1
    && isoDateDay(right.endDate) >= isoDateDay(left.startDate) - 1;
}

function compareGrowthReportRecency(
  left: { id: string; createdAt: Date },
  leftRange: { endDate: string },
  right: { id: string; createdAt: Date },
  rightRange: { endDate: string }
) {
  const leftTime = left.createdAt.getTime();
  const rightTime = right.createdAt.getTime();
  if (leftTime !== rightTime) return rightTime - leftTime;
  return rightRange.endDate.localeCompare(leftRange.endDate)
    || left.id.localeCompare(right.id, "en");
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

export async function getDmpBusinessReport(access: DmpReportAccess, id: string) {
  const row = await prisma.dmpBusinessReport.findFirst({
    where: { id, tenantId: access.tenantId, userId: access.userId },
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

export async function deleteDmpBusinessReport(access: DmpReportAccess, id: string) {
  const reportId = String(id ?? "").trim();
  if (!reportId || reportId.length > 100) return false;
  return prisma.$transaction(async (tx) => {
    await lockDmpReportTargets(tx, access, [reportId]);
    const owned = await tx.dmpBusinessReport.findFirst({
      where: { id: reportId, tenantId: access.tenantId, userId: access.userId },
      select: { id: true }
    });
    if (!owned) return false;
    const result = await tx.dmpBusinessReport.deleteMany({
      where: { id: reportId, tenantId: access.tenantId, userId: access.userId }
    });
    return result.count === 1;
  });
}

class DmpReportAssignmentRaceError extends Error {}

const assignmentReportSelect = {
  id: true,
  shopId: true,
  subjectItemId: true,
  competitorItemId: true,
  report: true
} as const;

export async function assignDmpBusinessReportsShop(input: {
  access: DmpReportAccess;
  reportIds: string[];
  shopId: string;
}): Promise<
  | { ok: true; reportIds: string[]; shop: { id: string; name: string } | null }
  | { ok: false; error: string; status: 400 | 404 | 409 }
> {
  const rawReportIds = input.reportIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  const reportIds = [...new Set(rawReportIds)];
  const shopId = input.shopId.trim();
  if (!reportIds.length || reportIds.length > 200 || reportIds.some((id) => id.length > 100)) {
    return { ok: false, error: "请选择 1 至 200 份报告", status: 400 };
  }
  if (shopId.length > 100) return { ok: false, error: "店铺编号无效", status: 400 };

  try {
    return await prisma.$transaction(async (tx) => {
      await lockDmpReportTargets(tx, input.access, reportIds);
      const shop = shopId
        ? await tx.shop.findFirst({
            where: { id: shopId, tenantId: input.access.tenantId },
            select: { id: true, name: true }
          })
        : null;
      if (shopId && !shop) return { ok: false as const, error: "店铺不存在或不属于当前账号", status: 404 as const };

      const initialRows = await tx.dmpBusinessReport.findMany({
        where: {
          id: { in: reportIds },
          tenantId: input.access.tenantId,
          userId: input.access.userId
        },
        select: assignmentReportSelect
      });
      if (initialRows.length !== reportIds.length) {
        return { ok: false as const, error: "报告不存在或无权修改", status: 404 as const };
      }
      const pairKeys = initialRows.flatMap((row) => [
        ...(row.shopId ? [dmpReportPairLockKey(
          input.access,
          row.shopId,
          row.subjectItemId,
          row.competitorItemId
        )] : []),
        ...(shop ? [dmpReportPairLockKey(
          input.access,
          shop.id,
          row.subjectItemId,
          row.competitorItemId
        )] : [])
      ]);
      await lockDmpReportPairKeys(tx, pairKeys);

      const rows = await tx.dmpBusinessReport.findMany({
        where: {
          id: { in: reportIds },
          tenantId: input.access.tenantId,
          userId: input.access.userId
        },
        select: assignmentReportSelect
      });
      const initialById = new Map(initialRows.map((row) => [row.id, row]));
      if (
        rows.length !== reportIds.length
        || rows.some((row) => {
          const initial = initialById.get(row.id);
          return !initial
            || initial.shopId !== row.shopId
            || initial.subjectItemId !== row.subjectItemId
            || initial.competitorItemId !== row.competitorItemId;
        })
      ) throw new DmpReportAssignmentRaceError();

      for (const row of [...rows].sort((left, right) => left.id.localeCompare(right.id, "en"))) {
        const checked = validateDmpCanonicalReport(row.report, {
          subjectItemId: row.subjectItemId,
          competitorItemId: row.competitorItemId
        });
        if (!checked.report) throw new DmpReportAssignmentRaceError();
        const fingerprint = shop
          ? dmpBusinessReportFingerprint({
              report: checked.report,
              subjectItemId: row.subjectItemId,
              competitorItemId: row.competitorItemId,
              shopId: shop.id
            })
          : null;
        const updated = await tx.dmpBusinessReport.updateMany({
          where: {
            id: row.id,
            tenantId: input.access.tenantId,
            userId: input.access.userId,
            shopId: row.shopId
          },
          data: { shopId: shop?.id ?? null, fingerprint }
        });
        if (updated.count !== 1) throw new DmpReportAssignmentRaceError();
      }
      return { ok: true as const, reportIds, shop };
    });
  } catch (error) {
    if (error instanceof DmpReportAssignmentRaceError || isPrismaUniqueConstraintError(error)) {
      return { ok: false, error: "报告归类期间发生变化，请刷新后重试", status: 409 };
    }
    throw error;
  }
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
