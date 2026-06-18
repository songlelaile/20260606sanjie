import { NextResponse } from "next/server";
import { locateHeaderRow, validateImportRows } from "@/lib/imports/contracts";
import {
  buildShengyiMergePlan,
  type ParsedShengyiFile
} from "@/lib/imports/merge-shengyi";
import { parseWorkbookUpload } from "@/lib/imports/parse-workbook";
import { validateTenantDatasetSize } from "@/lib/retention-policy";
import { addImportBatch, getWorkspaceContext, ImportRetentionError } from "@/lib/store/runtime-store";

export const dynamic = "force-dynamic";

const MAX_MERGE_FILES = 120; // 一店分日通常 ≤ 几十个；上限防滥用/DoS
const MAX_MERGE_ROWS = 1_000_000;

/**
 * 生意参谋逐日 .xls 多文件合并 →（预检 / 执行合并并作为"商品维度"分日源）。
 * dryRun=1 仅返回预检报告；否则 ok 后合并所有数据行走商品分日 upsert。
 */
export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "请使用 multipart 上传文件" }, { status: 400 });
  }

  const formData = await request.formData();
  const dryRun = formData.get("dryRun") === "1";
  const expectedStart = typeof formData.get("expectedStart") === "string" ? String(formData.get("expectedStart")) : "";
  const expectedEnd = typeof formData.get("expectedEnd") === "string" ? String(formData.get("expectedEnd")) : "";
  const fileEntries = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (fileEntries.length === 0) {
    return NextResponse.json({ error: "请至少选择一个生意参谋日表文件" }, { status: 400 });
  }
  if (fileEntries.length > MAX_MERGE_FILES) {
    return NextResponse.json(
      { error: `单次最多合并 ${MAX_MERGE_FILES} 个文件，当前 ${fileEntries.length} 个` },
      { status: 400 }
    );
  }
  // 合并绕过了 addImportBatch 的数据集守卫，这里独立校验总大小（防绕过 1000MB 上限 / DoS）。
  const totalSize = fileEntries.reduce((sum, f) => sum + f.size, 0);
  const sizeError = validateTenantDatasetSize(totalSize);
  if (sizeError) {
    return NextResponse.json({ error: sizeError }, { status: 413 });
  }

  // 逐个解析 → 定位表头行（按 product_source 契约）→ 收集 {name, headers, rows}。
  const parsed: ParsedShengyiFile[] = [];
  let totalBytes = 0;
  for (const file of fileEntries) {
    totalBytes += file.size;
    let matrix: unknown[][];
    try {
      const result = await parseWorkbookUpload(file);
      matrix = result.matrix;
    } catch (error) {
      const message = error instanceof Error ? error.message : "文件解析失败";
      return NextResponse.json({ error: `${file.name}：${message}` }, { status: 400 });
    }
    const { headers, rows } = locateHeaderRow(matrix, "product_source");
    parsed.push({ name: file.name, headers, rows });
  }

  const plan = buildShengyiMergePlan(parsed, { expectedStart, expectedEnd });

  if (plan.report.totalDataRows > MAX_MERGE_ROWS) {
    return NextResponse.json(
      { error: `合计数据行 ${plan.report.totalDataRows} 超过上限 ${MAX_MERGE_ROWS}`, report: plan.report },
      { status: 413 }
    );
  }

  if (dryRun) {
    return NextResponse.json({ data: { report: plan.report } });
  }

  if (!plan.report.ok) {
    return NextResponse.json(
      { error: "预检未通过，请先修正后再合并", report: plan.report },
      { status: 422 }
    );
  }

  // 合并后的行作为一份"商品维度"源表，走现有商品分日 upsert（addImportBatch 内部按日 upsert + 保留清理）。
  const validation = validateImportRows("product_source", plan.mergedHeaders, plan.mergedRows);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.errors.join("；") || "合并数据校验未通过", report: plan.report },
      { status: 422 }
    );
  }

  const { cycle } = await getWorkspaceContext();
  const fileName = `生意参谋合并_${plan.report.dateStart}~${plan.report.dateEnd}_${plan.report.fileCount}日.xlsx`;
  const datasetId = `shengyi-merge-${Date.now()}`;

  try {
    const batch = await addImportBatch({
      cycleId: cycle.id,
      datasetId,
      datasetTotalBytes: totalBytes,
      reportType: "product_source",
      fileName,
      fileSizeBytes: totalBytes,
      validation,
      parsedHeaders: plan.mergedHeaders,
      parsedRows: plan.mergedRows,
      skipDatasetGuard: true
    });
    return NextResponse.json({ data: { report: plan.report, batch } }, { status: 201 });
  } catch (error) {
    if (error instanceof ImportRetentionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
