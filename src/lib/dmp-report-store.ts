import "server-only";
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
const MAX_TABLE_ROWS = 5_000;
const MAX_CELL_LENGTH = 10_000;

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

export function validateDmpCanonicalReport(value: unknown): { report?: DmpCanonicalReport; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "报告内容无效" };
  const report = value as Partial<DmpCanonicalReport>;
  if (report.schema_version !== "3.0" || !validItemId(report.item_id) || !Array.isArray(report.tables)) {
    return { error: "报告结构不完整" };
  }
  const kind = dmpReportKind(report);
  const expectedTables = dmpExpectedTableNames(kind);
  if (JSON.stringify(report.tables.map((table) => table?.name)) !== JSON.stringify(expectedTables)) {
    return { error: "报告业务表不完整" };
  }
  const competitorIds = kind === "competition"
    ? [...new Set((Array.isArray(report.competitor_ids) ? report.competitor_ids : []).map(String).map((id) => id.trim()).filter(Boolean))]
    : [];
  if (kind === "competition" && (competitorIds.length < 1 || competitorIds.length > 3 || competitorIds.some((id) => !validItemId(id)))) {
    return { error: "竞争态势报告的竞店 ID 无效" };
  }
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_REPORT_BYTES) return { error: "报告内容超过保存上限" };

  const tables: DmpReportTableSnapshot[] = [];
  for (const candidate of report.tables) {
    if (!candidate || !expectedTables.includes(String(candidate.name)) || !Array.isArray(candidate.columns) || !Array.isArray(candidate.rows)) {
      return { error: "业务表结构无效" };
    }
    if (candidate.rows.length > MAX_TABLE_ROWS || candidate.columns.length === 0 || candidate.columns.length > 100) {
      return { error: `业务表「${candidate.name}」超出保存范围` };
    }
    const columns = candidate.columns.map(String);
    const rows: Array<{ cells: string[] }> = [];
    for (const row of candidate.rows) {
      if (!row || !Array.isArray(row.cells) || row.cells.length !== columns.length) {
        return { error: `业务表「${candidate.name}」行列不一致` };
      }
      const cells = row.cells.map(String);
      if (cells.some((cell) => cell.length > MAX_CELL_LENGTH)) return { error: `业务表「${candidate.name}」单元格内容过长` };
      rows.push({ cells });
    }
    tables.push({ name: String(candidate.name), columns, rows });
  }

  const period = String(report.period ?? "近30天").slice(0, 200);
  const itemId = String(report.item_id);
  const renderData = kind === "growth" ? sanitizeDmpReportRenderData(report.render_data, {
    itemId,
    period,
    tables,
    expectedTableNames: expectedTables
  }) : undefined;

  return {
    report: {
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
    }
  };
}

export async function listDmpBusinessReports(access: DmpReportAccess): Promise<DmpBusinessReportRecord[]> {
  const rows = await prisma.dmpBusinessReport.findMany({
    where: { tenantId: access.tenantId, userId: access.userId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      subjectItemId: true,
      competitorItemId: true,
      period: true,
      quality: true,
      createdAt: true,
      report: true
    }
  });
  return rows.flatMap((row) => {
    const checked = validateDmpCanonicalReport(row.report);
    if (!checked.report) return [];
    return [{
      id: row.id,
      reportType: dmpReportKind(checked.report),
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
  const row = await prisma.dmpBusinessReport.create({
    data: {
      tenantId: input.access.tenantId,
      userId: input.access.userId,
      subjectItemId: input.subjectItemId,
      competitorItemId: input.competitorItemId,
      period: input.report.period,
      quality: input.quality,
      sourceVersion: input.sourceVersion,
      report: input.report as unknown as Prisma.InputJsonValue
    }
  });
  return {
    id: row.id,
    reportType: dmpReportKind(input.report),
    subjectItemId: row.subjectItemId,
    competitorItemId: row.competitorItemId,
    period: row.period,
    quality: row.quality === "partial" ? "partial" : "complete",
    createdAt: row.createdAt.toISOString(),
    report: input.report
  };
}

export async function getDmpBusinessReport(access: DmpReportAccess, id: string) {
  const row = await prisma.dmpBusinessReport.findFirst({
    where: { id, tenantId: access.tenantId, userId: access.userId },
    select: {
      id: true,
      subjectItemId: true,
      competitorItemId: true,
      period: true,
      quality: true,
      createdAt: true,
      report: true
    }
  });
  if (!row) return null;
  const checked = validateDmpCanonicalReport(row.report);
  if (!checked.report) return null;
  return {
    id: row.id,
    reportType: dmpReportKind(checked.report),
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

export function validItemId(value: unknown) {
  return /^\d{6,20}$/.test(String(value ?? ""));
}

export function parseDmpCompetitorIds(value: unknown) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[,，、;；\s]+/);
  return [...new Set(source.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, 4);
}
