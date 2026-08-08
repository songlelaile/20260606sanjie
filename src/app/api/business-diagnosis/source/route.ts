import { diagnosisJson, requireDiagnosisApiAccess } from "@/lib/diagnosis-route-security";
import {
  getBusinessDiagnosisWorkspaceSource,
  ImportRetentionError,
  saveBusinessDiagnosisWorkspaceSource
} from "@/lib/store/runtime-store";
import type { BusinessDiagnosisSource } from "@/lib/business-diagnosis";
import { validateBusinessDiagnosisSourcePatch } from "@/lib/imports/business-diagnosis-source";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SOURCE_BODY_BYTES = 32 * 1024 * 1024;

export async function GET() {
  const unauthorized = await requireDiagnosisApiAccess();
  if (unauthorized) return unauthorized;
  const source = await getBusinessDiagnosisWorkspaceSource();
  return diagnosisJson({
    data: {
      source,
      hasCustomSource: Boolean(source)
    }
  });
}

export async function POST(request: Request) {
  const unauthorized = await requireDiagnosisApiAccess("write");
  if (unauthorized) return unauthorized;
  let rawBody: unknown;
  try {
    rawBody = await readJsonWithLimit(request, MAX_SOURCE_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return diagnosisJson({ error: "业务诊断请求超过 32MB，请拆分或清理后再上传" }, { status: 413 });
    }
    throw error;
  }
  const body = rawBody as
    | {
        storeCategoryRows?: BusinessDiagnosisSource["storeCategoryRows"];
        market?: BusinessDiagnosisSource["market"];
        sourceNote?: string;
        fileNames?: string[];
      }
    | null;

  if (!body || (!Array.isArray(body.storeCategoryRows) && !body.market)) {
    return diagnosisJson({ error: "请提交本店类目数据或市场大盘数据" }, { status: 400 });
  }
  if (body.storeCategoryRows && body.storeCategoryRows.length > 50000) {
    return diagnosisJson({ error: "本店类目数据超过 50000 行，请拆分或清理后再上传" }, { status: 413 });
  }
  if (body.market && !Array.isArray(body.market.overview)) {
    return diagnosisJson({ error: "市场大盘数据结构不合法" }, { status: 400 });
  }
  if (body.sourceNote !== undefined && (typeof body.sourceNote !== "string" || body.sourceNote.length > 2000)) {
    return diagnosisJson({ error: "数据说明必须为 2000 字以内文本" }, { status: 400 });
  }
  if (
    body.fileNames !== undefined &&
    (!Array.isArray(body.fileNames) ||
      body.fileNames.length > 20 ||
      body.fileNames.some((item) => typeof item !== "string" || item.length === 0 || item.length > 255))
  ) {
    return diagnosisJson({ error: "文件名列表最多 20 项，单项不超过 255 字" }, { status: 400 });
  }
  const validationErrors = validateBusinessDiagnosisSourcePatch({
    ...(body.storeCategoryRows ? { storeCategoryRows: body.storeCategoryRows } : {}),
    ...(body.market ? { market: body.market } : {})
  });
  if (validationErrors.length > 0) {
    return diagnosisJson(
      { error: `业务诊断数据校验失败：${validationErrors.join("；")}` },
      { status: 400 }
    );
  }

  try {
    const source = await saveBusinessDiagnosisWorkspaceSource({
      storeCategoryRows: body.storeCategoryRows,
      market: body.market,
      sourceNote: body.sourceNote,
      fileNames: Array.isArray(body.fileNames) ? body.fileNames : []
    });
    return diagnosisJson({
      data: {
        source,
        summary: {
          storeRows: source.storeCategoryRows.length,
          marketOverviewRows: source.market.overview.length,
          priceBands: source.market.priceBands.length,
          attributeSignals: source.market.attributeSignals.length,
          searchSignals: source.market.searchSignals.length
        }
      }
    });
  } catch (error) {
    if (error instanceof ImportRetentionError) {
      return diagnosisJson({ error: error.message }, { status: error.status });
    }
    return diagnosisJson(
      { error: error instanceof Error ? error.message : "业务诊断源表保存失败" },
      { status: 500 }
    );
  }
}
