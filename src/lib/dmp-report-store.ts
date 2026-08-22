import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { parseSession, type Session } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
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
}) {
  const renderData = input.report.render_data
    ? Object.fromEntries(Object.entries(input.report.render_data).filter(([key]) => key !== "generated_at"))
    : undefined;
  const comparable = {
    subjectItemId: input.subjectItemId,
    competitorItemId: input.competitorItemId,
    report: {
      schema_version: String(input.report.schema_version ?? ""),
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
  const itemId = validItemId(report.item_id)
    ? String(report.item_id)
    : validItemId(fallback.subjectItemId)
      ? String(fallback.subjectItemId)
      : "";
  if (!itemId) return { error: kind === "competition" ? "本店 ID 无效" : "主体商品 ID 无效" };
  if (String(report.item_id ?? "") !== itemId) pushArchiveIssue(issues, "主体 ID 已使用请求元数据补全");

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
  const tables = orderArchivedTables(normalizedTables, expectedTables, issues);

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
    title: withDmpAutomationBrand(
      report.title,
      kind === "competition" ? "达摩盘竞争态势分析报告" : "达摩盘打爆路径报告"
    ).slice(0, 200),
    item_id: itemId,
    period,
    tables,
    ...(renderData ? { render_data: renderData } : {})
  };
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
  const originalExpectedOrder = tables.filter((table) => expectedNames.includes(table.name)).map((table) => table.name);
  const presentExpectedOrder = expectedNames.filter((name) => originalExpectedOrder.includes(name));
  if (JSON.stringify(originalExpectedOrder) !== JSON.stringify(presentExpectedOrder) || remaining.length) {
    pushArchiveIssue(issues, "业务表顺序或附加模块已兼容归档");
  }
  return ordered;
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
      quality: row.quality === "partial" ? "partial" : "complete",
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
}): Promise<DmpBusinessReportRecord> {
  const fingerprint = dmpBusinessReportFingerprint({
    report: input.report,
    subjectItemId: input.subjectItemId,
    competitorItemId: input.competitorItemId
  });
  const row = await prisma.$transaction(async (tx) => {
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
    let shop = previous?.shop ?? null;
    if (!shop) {
      const tenantShops = await tx.shop.findMany({
        where: { tenantId: input.access.tenantId },
        orderBy: { createdAt: "asc" },
        take: 2,
        select: { id: true, name: true }
      });
      if (tenantShops.length === 1) shop = tenantShops[0];
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
        quality: input.quality,
        sourceVersion: input.sourceVersion,
        fingerprint,
        report: input.report as unknown as Prisma.InputJsonValue
      },
      update: {},
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
  const storedReport = validateDmpCanonicalReport(row.report, {
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId
  }).report ?? input.report;
  return {
    id: row.id,
    reportType: dmpReportKind(storedReport),
    ...(row.shop ? { shopId: row.shop.id, shopName: row.shop.name } : {}),
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId,
    period: row.period,
    quality: row.quality === "partial" ? "partial" : "complete",
    createdAt: row.createdAt.toISOString(),
    report: storedReport
  };
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
    quality: row.quality === "partial" ? "partial" : "complete",
    createdAt: row.createdAt.toISOString(),
    report: checked.report
  } satisfies DmpBusinessReportRecord;
}

export async function deleteDmpBusinessReport(access: DmpReportAccess, id: string) {
  const result = await prisma.dmpBusinessReport.deleteMany({
    where: { id, tenantId: access.tenantId, userId: access.userId }
  });
  return result.count > 0;
}

export async function assignDmpBusinessReportsShop(input: {
  access: DmpReportAccess;
  reportIds: string[];
  shopId: string;
}): Promise<
  | { ok: true; reportIds: string[]; shop: { id: string; name: string } | null }
  | { ok: false; error: string; status: 400 | 404 }
> {
  const rawReportIds = input.reportIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  const reportIds = [...new Set(rawReportIds)];
  const shopId = input.shopId.trim();
  if (!reportIds.length || reportIds.length > 200 || reportIds.some((id) => id.length > 100)) {
    return { ok: false, error: "请选择 1 至 200 份报告", status: 400 };
  }
  if (shopId.length > 100) return { ok: false, error: "店铺编号无效", status: 400 };

  return prisma.$transaction(async (tx) => {
    const shop = shopId
      ? await tx.shop.findFirst({
          where: { id: shopId, tenantId: input.access.tenantId },
          select: { id: true, name: true }
        })
      : null;
    if (shopId && !shop) return { ok: false as const, error: "店铺不存在或不属于当前账号", status: 404 as const };

    const owned = await tx.dmpBusinessReport.count({
      where: {
        id: { in: reportIds },
        tenantId: input.access.tenantId,
        userId: input.access.userId
      }
    });
    if (owned !== reportIds.length) return { ok: false as const, error: "报告不存在或无权修改", status: 404 as const };

    await tx.dmpBusinessReport.updateMany({
      where: {
        id: { in: reportIds },
        tenantId: input.access.tenantId,
        userId: input.access.userId
      },
      data: { shopId: shop?.id ?? null }
    });
    return { ok: true as const, reportIds, shop };
  });
}

export function validItemId(value: unknown) {
  return /^\d{6,20}$/.test(String(value ?? ""));
}

export function parseDmpCompetitorIds(value: unknown) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[,，、;；\s]+/);
  return [...new Set(source.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 4);
}
