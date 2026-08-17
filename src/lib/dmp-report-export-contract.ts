import type { DmpReportKind } from "@/lib/dmp-report-types";

export const DMP_REPORT_EXPORT_FORMAT = "xlsx" as const;
export const DMP_REPORT_EXPORT_MAX_BODY_BYTES = 8 * 1024;

export interface DmpReportExportRequest {
  reportId: string;
  reportType: DmpReportKind;
  format: typeof DMP_REPORT_EXPORT_FORMAT;
  clientVersion: string;
}

export interface DmpReportExportAuthorization {
  authorized: true;
  auditId: string;
  authorizedAt: string;
}

const EXPORT_REQUEST_KEYS = new Set(["reportId", "reportType", "format", "clientVersion"]);

/**
 * 插件只提交导出授权所需的四个低敏元数据字段。报告 JSON、表格内容和文件名均不接收。
 */
export function normalizeDmpReportExportRequest(value: unknown): DmpReportExportRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !EXPORT_REQUEST_KEYS.has(key))) return null;
  const reportId = cleanMetadata(input.reportId, 128);
  const clientVersion = cleanMetadata(input.clientVersion, 64);
  if (!reportId || !clientVersion) return null;
  if (!/^[a-z0-9_-]{1,128}$/i.test(reportId)) return null;
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/i.test(clientVersion)) return null;
  if (input.reportType !== "growth" && input.reportType !== "competition") return null;
  if (input.format !== DMP_REPORT_EXPORT_FORMAT) return null;
  return {
    reportId,
    reportType: input.reportType,
    format: DMP_REPORT_EXPORT_FORMAT,
    clientVersion
  };
}

function cleanMetadata(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && cleaned.length <= maxLength ? cleaned : null;
}
