-- 管理员隐藏导出只记录最小授权元数据；不复制报告 JSON、表格单元格或导出文件内容。
-- adminId/reportId 故意不设级联外键，确保账号或报告删除后审计记录仍然保留。
CREATE TABLE "DmpReportExportAudit" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "clientVersion" TEXT NOT NULL DEFAULT '',
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmpReportExportAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DmpReportExportAudit_adminId_exportedAt_idx"
ON "DmpReportExportAudit"("adminId", "exportedAt");

CREATE INDEX "DmpReportExportAudit_reportId_exportedAt_idx"
ON "DmpReportExportAudit"("reportId", "exportedAt");

CREATE INDEX "DmpReportExportAudit_exportedAt_idx"
ON "DmpReportExportAudit"("exportedAt");
