import { NextResponse } from "next/server";
import { parseWorkbookUpload } from "@/lib/imports/parse-workbook";
import { locateHeaderRow, reportContracts, validateImportRows } from "@/lib/imports/contracts";
import { inferImportDate } from "@/lib/imports/map-rows";
import {
  addImportBatch,
  clearImportBatches,
  getImportBatches,
  getRetentionStatus,
  getWorkspaceContext,
  ImportRetentionError,
  validateImportDatasetWrite
} from "@/lib/store/runtime-store";
import type { ReportType } from "@/lib/types/domain";

export async function GET() {
  return NextResponse.json({
    data: {
      batches: await getImportBatches(),
      retention: await getRetentionStatus()
    }
  });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const { cycle } = await getWorkspaceContext();

  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      // 大文件请求体若被代理/服务器截断，formData() 会抛 "expected boundary after body"。
      // 兜成明确的 413，而非不透明 500，便于前端提示「文件过大/上传中断」。
      formData = await request.formData();
    } catch {
      return NextResponse.json(
        {
          error:
            "文件上传中断或超过服务器请求体上限，请减小单次上传体积，或调大上传服务的 body 上限（生产环境为 nginx client_max_body_size）后重试。"
        },
        { status: 413 }
      );
    }
    const reportType = formData.get("reportType");
    const file = formData.get("file");
    if (!isReportType(reportType) || !(file instanceof File)) {
      return NextResponse.json(
        { error: "reportType 与 file 为必填项" },
        { status: 400 }
      );
    }

    const datasetId = readString(formData.get("datasetId")) ?? `dataset-${Date.now()}`;
    const datasetTotalBytes = readNumber(formData.get("datasetTotalBytes")) ?? file.size;
    const fileSizeBytes = readNumber(formData.get("fileSizeBytes")) ?? file.size;
    const retentionError = await validateImportDatasetWrite({ datasetId, datasetTotalBytes });
    if (retentionError) {
      return NextResponse.json({ error: retentionError.message }, { status: retentionError.status });
    }

    let parsed;
    try {
      parsed = await parseWorkbookUpload(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : "文件解析失败";
      return NextResponse.json({ error: message }, { status: 400 });
    }
    const { headers, rows } = locateHeaderRow(parsed.matrix, reportType);
    const validation = validateImportRows(reportType, headers, rows, {
      fallbackDate: inferImportDate(file.name)
    });
    if (parsed.warnings.length > 0) {
      validation.warnings = [...validation.warnings, ...parsed.warnings];
    }
    try {
      const batch = await addImportBatch({
        cycleId: cycle.id,
        datasetId,
        datasetTotalBytes,
        reportType,
        fileName: file.name,
        fileSizeBytes,
        validation,
        parsedHeaders: headers,
        parsedRows: rows
      });
      return NextResponse.json({ data: { batch } }, { status: validation.ok ? 201 : 422 });
    } catch (error) {
      if (error instanceof ImportRetentionError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  }

  const body = (await request.json().catch(() => null)) as
    | {
        reportType?: ReportType;
        fileName?: string;
        datasetId?: string;
        datasetTotalBytes?: number;
        fileSizeBytes?: number;
        headers?: string[];
        rows?: unknown[][];
      }
    | null;

  if (!body?.reportType || !isReportType(body.reportType)) {
    return NextResponse.json({ error: "reportType 不合法" }, { status: 400 });
  }

  const headers = Array.isArray(body.headers) ? body.headers : [];
  const rows = Array.isArray(body.rows) ? body.rows.filter(Array.isArray) : [];
  const validation = validateImportRows(body.reportType, headers, rows, {
    fallbackDate: inferImportDate(body.fileName ?? "")
  });
  const datasetId = body.datasetId ?? `dataset-${Date.now()}`;
  const datasetTotalBytes = body.datasetTotalBytes ?? body.fileSizeBytes ?? 0;
  const fileSizeBytes = body.fileSizeBytes ?? datasetTotalBytes;
  try {
    const batch = await addImportBatch({
      cycleId: cycle.id,
      datasetId,
      datasetTotalBytes,
      reportType: body.reportType,
      fileName: body.fileName ?? reportContracts[body.reportType].label,
      fileSizeBytes,
      validation,
      parsedHeaders: headers,
      parsedRows: rows
    });
    return NextResponse.json({ data: { batch } }, { status: validation.ok ? 201 : 422 });
  } catch (error) {
    if (error instanceof ImportRetentionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function DELETE(request: Request) {
  // keepPrefill=1：上传前换源数据，保留运营已填参数；否则为主动清空，连参数一起从零。
  const keepPrefill = new URL(request.url).searchParams.get("keepPrefill") === "1";
  await clearImportBatches({ keepPrefill });
  return NextResponse.json({ data: { batches: [] } });
}

function isReportType(value: unknown): value is ReportType {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(reportContracts, value)
  );
}

function readString(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readNumber(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
