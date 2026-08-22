import "server-only";
import { parseSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type {
  DmpReportExportAuthorization,
  DmpReportExportRequest
} from "@/lib/dmp-report-export-contract";
import { DMP_AUTOMATION_TOOL_CODE } from "@/lib/dmp-product";
import type { DmpReportKind } from "@/lib/dmp-report-types";
import { resolveToolEntitlementAccess } from "@/lib/tool-entitlements";

type ExportAuthorizationFailure = {
  ok: false;
  status: 401 | 403 | 404 | 409;
  error: string;
};

export type DmpReportExportAuthorizationResult =
  | { ok: true; authorization: DmpReportExportAuthorization }
  | ExportAuthorizationFailure;

/**
 * 导出按钮点击后的实时授权边界。这里不信任 /api/auth/me 的 capability 缓存：
 * 每次都重新验签并在同一数据库事务内核对账号、角色、付费权限、报告归属和报告类型，
 * 只有审计写入成功才返回授权成功。
 */
export async function authorizeAndAuditDmpReportExport(
  rawSessionToken: string | null | undefined,
  request: DmpReportExportRequest,
  now = new Date()
): Promise<DmpReportExportAuthorizationResult> {
  const session = await parseExtensionSession(rawSessionToken);
  if (!session) return unauthorized("未登录或会话已失效");

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { username: session.username.trim() },
      select: {
        id: true,
        tenantId: true,
        authRole: true,
        status: true,
        toolEntitlements: {
          where: { toolCode: DMP_AUTOMATION_TOOL_CODE },
          select: { status: true, grantedAt: true, expiresAt: true },
          take: 1
        }
      }
    });
    const databaseRole = user?.authRole === "admin" ? "admin" : "tenant";
    if (
      !user ||
      user.status === "disabled" ||
      user.tenantId !== session.tenantId ||
      databaseRole !== session.role
    ) {
      return unauthorized("未登录或会话已失效");
    }
    if (session.role !== "admin" || user.authRole !== "admin") {
      return { ok: false, status: 403, error: "仅平台管理员可导出报告表格" } as const;
    }

    const entitlement = resolveToolEntitlementAccess(user.toolEntitlements[0], now);
    if (!entitlement.allowed) {
      return unauthorized("达摩盘授权未开通、已撤销或已过期");
    }

    const report = await tx.dmpBusinessReport.findFirst({
      where: {
        id: request.reportId,
        tenantId: user.tenantId,
        userId: user.id
      },
      select: { id: true, report: true }
    });
    if (!report) {
      return { ok: false, status: 404, error: "报告不存在或无权导出" } as const;
    }

    const actualReportType = storedReportType(report.report);
    if (!actualReportType || actualReportType !== request.reportType) {
      return { ok: false, status: 409, error: "报告类型与导出请求不一致" } as const;
    }

    const audit = await tx.dmpReportExportAudit.create({
      data: {
        adminId: user.id,
        reportId: report.id,
        reportType: actualReportType,
        format: request.format,
        clientVersion: request.clientVersion,
        exportedAt: now
      },
      select: { id: true, exportedAt: true }
    });
    return {
      ok: true,
      authorization: {
        authorized: true,
        auditId: audit.id,
        authorizedAt: audit.exportedAt.toISOString()
      }
    } as const;
  });
}

async function parseExtensionSession(rawSessionToken: string | null | undefined) {
  const token = String(rawSessionToken ?? "").trim();
  if (!token) return null;
  const direct = await parseSession(token);
  if (direct) return direct;
  try {
    return await parseSession(decodeURIComponent(token));
  } catch {
    return null;
  }
}

function storedReportType(value: unknown): DmpReportKind | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const report = value as { schema_version?: unknown; report_type?: unknown };
  if (report.schema_version !== "3.0") return null;
  if (report.report_type === "competition") return "competition";
  if (report.report_type === "market") return "market";
  if (report.report_type === undefined || report.report_type === "growth") return "growth";
  return null;
}

function unauthorized(error: string): ExportAuthorizationFailure {
  return { ok: false, status: 401, error };
}
