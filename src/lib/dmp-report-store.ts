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
const MAX_TABLE_ROWS = 5_000;
const MAX_CELL_LENGTH = 10_000;

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
    const checked = validateDmpCanonicalReport(row.report);
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
  const storedReport = validateDmpCanonicalReport(row.report).report ?? input.report;
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
  const checked = validateDmpCanonicalReport(row.report);
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
