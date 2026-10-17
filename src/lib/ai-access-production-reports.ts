import "server-only";
import { prisma } from "@/lib/db";
import { getDmpBusinessReport as getBaselineReport, type DmpReportAccess } from "@/lib/dmp-report-store";

/** AI-only adapter. Existing report storage, validation and browser APIs stay unchanged. */
export async function getDmpBusinessReport(access: DmpReportAccess, id: string, shopId: string) {
  const row = await prisma.dmpBusinessReport.findFirst({
    where: { id, userId: access.userId, tenantId: access.tenantId, shopId }, select: { id: true }
  });
  if (!row) return null;
  const report = await getBaselineReport(access, id);
  return report?.shopId === shopId ? report : null;
}

/** A bounded metadata query, with no loading or forwarding of full report JSON. */
export async function listDmpBusinessReportSummaries(
  access: DmpReportAccess, options: { shopId: string; page?: number; pageSize?: number }
) {
  const page = Number.isInteger(options.page) && options.page! > 0 ? Math.min(options.page!, 1_000_000) : 1;
  const pageSize = Number.isInteger(options.pageSize) && options.pageSize! > 0 ? Math.min(options.pageSize!, 50) : 24;
  const where = { userId: access.userId, tenantId: access.tenantId, shopId: options.shopId };
  const [total, rows] = await Promise.all([
    prisma.dmpBusinessReport.count({ where }),
    prisma.dmpBusinessReport.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * pageSize, take: pageSize,
      select: { id: true, shopId: true, subjectItemId: true, competitorItemId: true,
        period: true, quality: true, createdAt: true } })
  ]);
  const summaries = rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
  const totalPages = Math.ceil(total / pageSize);
  return { summaries, page, pageSize, total, totalPages, hasNext: page < totalPages };
}
