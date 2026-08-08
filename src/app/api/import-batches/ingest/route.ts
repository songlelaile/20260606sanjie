import { NextResponse } from "next/server";
import {
  finalizeImportBatch,
  getWorkspaceContext,
  ImportRetentionError,
  ingestDailyRows,
  validateImportDatasetWrite
} from "@/lib/store/runtime-store";
import type { DamoProductRow, ImportValidationResult, ReportType } from "@/lib/types/domain";
import { validateMappedImportRows } from "@/lib/imports/daily-dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORT_TYPES: ReportType[] = [
  "product_source",
  "damo_product_source",
  "promotion_product_source",
  "audience_source"
];

/**
 * 分批导入：浏览器端已解析+映射成分日行，这里逐批 upsert，最后一批收尾建记录。
 * 永不上传原始大文件，每批都是小 JSON → 绕开任何代理/服务器 body 上限，且无长请求/超时。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    sessionId?: string;
    reportType?: string;
    fileName?: string;
    fileSizeBytes?: number;
    datasetTotalBytes?: number;
    validation?: ImportValidationResult;
    ingestedRowCount?: number;
    rows?: unknown[];
    index?: number;
    total?: number;
  } | null;

  if (!body || !REPORT_TYPES.includes(body.reportType as ReportType) || !Array.isArray(body.rows)) {
    return NextResponse.json({ error: "请求参数不合法（reportType / rows）" }, { status: 400 });
  }
  const reportType = body.reportType as ReportType;
  const index = Number(body.index ?? 0);
  const total = Math.max(1, Number(body.total ?? 1));
  const datasetTotalBytes = Number(body.datasetTotalBytes ?? 0);

  // 体积守卫只在首批校验一次。
  if (index === 0) {
    const err = await validateImportDatasetWrite({
      datasetId: body.sessionId ?? "",
      datasetTotalBytes
    });
    if (err) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
  }

  try {
    let serverRejected = 0;
    let serverIssues: string[] = [];
    if (reportType !== "damo_product_source") {
      // 商品/推广/人群：当批 upsert 入分日表（达摩盘无日期，整批在收尾时落 blob）。
      const result = await ingestDailyRows(reportType, body.rows);
      serverRejected = result.rejectedCount;
      serverIssues = result.issues;
      if (body.rows.length > 0 && result.acceptedCount === 0) {
        return NextResponse.json(
          { error: `本批没有可入库的有效行：${serverIssues.join("；") || "映射结果不合法"}` },
          { status: 422 }
        );
      }
    }

    if (index >= total - 1) {
      const { cycle } = await getWorkspaceContext();
      const validation =
        body.validation ?? emptyValidation(reportType, body.rows.length);
      const damoValidation = reportType === "damo_product_source"
        ? validateMappedImportRows(reportType, body.rows)
        : null;
      const acceptedDamoRows = damoValidation?.acceptedRows as DamoProductRow[] | undefined;
      const rejectedCount = serverRejected + (damoValidation?.rejectedCount ?? 0);
      if (rejectedCount > 0) {
        validation.rejectedRowCount = (validation.rejectedRowCount ?? 0) + rejectedCount;
        validation.acceptedRowCount = Math.max(0, (validation.acceptedRowCount ?? validation.rowCount) - rejectedCount);
        validation.warnings = [
          ...validation.warnings,
          `服务端二次校验隔离 ${rejectedCount} 行，其余有效行继续入库`,
          ...serverIssues,
          ...(damoValidation?.issues ?? [])
        ];
      }
      if (reportType === "damo_product_source" && body.rows.length > 0 && acceptedDamoRows?.length === 0) {
        return NextResponse.json({ error: "达摩盘数据没有可入库的有效行" }, { status: 422 });
      }
      const batch = await finalizeImportBatch({
        cycleId: cycle.id,
        datasetId: body.sessionId ?? `ingest-${reportType}`,
        datasetTotalBytes,
        reportType,
        fileName: body.fileName ?? "未命名源表",
        fileSizeBytes: Number(body.fileSizeBytes ?? 0),
        validation,
        ingestedRowCount: body.ingestedRowCount,
        damoSourceRows:
          reportType === "damo_product_source" ? acceptedDamoRows : undefined
      });
      return NextResponse.json({ data: { batch } }, { status: validation.ok ? 201 : 422 });
    }

    return NextResponse.json({ data: { ok: true, received: body.rows.length, rejected: serverRejected, issues: serverIssues } });
  } catch (error) {
    if (error instanceof ImportRetentionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "分批导入失败" },
      { status: 500 }
    );
  }
}

function emptyValidation(reportType: ReportType, rowCount: number): ImportValidationResult {
  return {
    ok: rowCount > 0,
    reportType,
    receivedHeaders: [],
    requiredHeaders: [],
    missingHeaders: [],
    extraHeaders: [],
    rowCount,
    uniqueEntityCount: 0,
    duplicateEntityIds: [],
    dateValues: [],
    warnings: [],
    errors: rowCount > 0 ? [] : ["无有效数据行"]
  };
}
