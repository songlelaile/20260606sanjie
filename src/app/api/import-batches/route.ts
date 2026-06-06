import { NextResponse } from "next/server";
import { parseWorkbookUpload } from "@/lib/imports/parse-workbook";
import { reportContracts, validateImportRows } from "@/lib/imports/contracts";
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
      batches: getImportBatches(),
      retention: getRetentionStatus()
    }
  });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  const { cycle } = getWorkspaceContext();

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
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
    const retentionError = validateImportDatasetWrite({ datasetId, datasetTotalBytes });
    if (retentionError) {
      return NextResponse.json({ error: retentionError.message }, { status: retentionError.status });
    }

    const parsed = await parseWorkbookUpload(file);
    const validation = validateImportRows(reportType, parsed.headers, parsed.rows);
    try {
      const batch = addImportBatch({
        cycleId: cycle.id,
        datasetId,
        datasetTotalBytes,
        reportType,
        fileName: file.name,
        fileSizeBytes,
        validation
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

  const validation = validateImportRows(body.reportType, body.headers ?? [], body.rows ?? []);
  const datasetId = body.datasetId ?? `dataset-${Date.now()}`;
  const datasetTotalBytes = body.datasetTotalBytes ?? body.fileSizeBytes ?? 0;
  const fileSizeBytes = body.fileSizeBytes ?? datasetTotalBytes;
  try {
    const batch = addImportBatch({
      cycleId: cycle.id,
      datasetId,
      datasetTotalBytes,
      reportType: body.reportType,
      fileName: body.fileName ?? reportContracts[body.reportType].label,
      fileSizeBytes,
      validation
    });
    return NextResponse.json({ data: { batch } }, { status: validation.ok ? 201 : 422 });
  } catch (error) {
    if (error instanceof ImportRetentionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function DELETE() {
  clearImportBatches();
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
