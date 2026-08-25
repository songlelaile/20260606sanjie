import { NextResponse } from "next/server";
import { dmpCanonicalReportIdentity } from "@/lib/dmp-report-library";
import { toOfficialDmpReportUrl } from "@/lib/dmp-public-origin";
import {
  assignDmpBusinessReportsShop,
  deleteDmpBusinessReport,
  getDmpBusinessReport,
  getDmpReportAccess,
  getDmpReportAccessFromToken,
  listDmpBusinessReports,
  saveDmpBusinessReport,
  DMP_REPORT_ARCHIVE_MAX_BODY_BYTES,
  validCategoryId,
  validItemId,
  validateDmpCanonicalReport
} from "@/lib/dmp-report-store";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sanjie-session",
  "Cache-Control": "private, no-store"
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const access = await resolveAccess(request);
  if (!access) return unauthorized();
  const requestUrl = new URL(request.url);
  const id = requestUrl.searchParams.get("id")?.trim() ?? "";
  if (!id) return NextResponse.json({ data: { reports: await listDmpBusinessReports(access) } }, { headers: CORS });

  const report = await getDmpBusinessReport(access, id);
  if (!report) return NextResponse.json({ error: "报告不存在或无权访问" }, { status: 404, headers: CORS });
  const format = requestUrl.searchParams.get("format");
  if (format === "xlsx" || format === "csv" || format === "html") {
    return NextResponse.json(
      { error: "当前版本仅支持官网在线查看，暂不提供数据下载" },
      { status: 403, headers: CORS }
    );
  }
  return NextResponse.json({ data: { report } }, { headers: CORS });
}

export async function POST(request: Request) {
  const access = await resolveAccess(request);
  if (!access) return unauthorized();
  let rawBody: unknown;
  try {
    rawBody = await readJsonWithLimit(request, DMP_REPORT_ARCHIVE_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "报告归档请求超过保存上限" }, { status: 413, headers: CORS });
    }
    return NextResponse.json({ error: "报告归档请求读取失败" }, { status: 400, headers: CORS });
  }
  const body = rawBody as
    | {
        report?: unknown;
        subjectItemId?: unknown;
        competitorItemId?: unknown;
        quality?: unknown;
        sourceVersion?: unknown;
        sourceShop?: unknown;
      }
    | null;
  const sourceShop = parseSourceShop(body?.sourceShop);
  if (!sourceShop.ok) {
    return NextResponse.json({ error: sourceShop.error }, { status: 400, headers: CORS });
  }
  const checked = validateDmpCanonicalReport(body?.report, {
    subjectItemId: body?.subjectItemId,
    competitorItemId: body?.competitorItemId
  });
  if (!checked.report) return NextResponse.json({ error: checked.error ?? "报告结构无效" }, { status: 400, headers: CORS });

  const identity = dmpCanonicalReportIdentity(checked.report, {
    subjectItemId: body?.subjectItemId,
    competitorItemId: body?.competitorItemId
  });
  const subjectItemId = identity.subjectItemId;
  const competitionReport = identity.reportType === "competition";
  const marketReport = identity.reportType === "market";
  const competitorIds = identity.competitorItemIds;
  const competitorItemId = competitionReport ? competitorIds.join(",") : marketReport ? "" : competitorIds[0] ?? "";
  const invalidIdentity = marketReport
    ? !validCategoryId(subjectItemId) || competitorIds.length > 0
    : !validItemId(subjectItemId)
      || competitorIds.length < 1
      || competitorIds.some((id) => !validItemId(id))
      || (!competitionReport && competitorIds.length !== 1)
      || (competitionReport && competitorIds.length > 3);
  if (invalidIdentity) {
    return NextResponse.json({
      error: marketReport ? "类目 ID 或类目范围无效" : competitionReport ? "本店与竞店 ID 无效" : "主体商品与对标商品 ID 无效"
    }, { status: 400, headers: CORS });
  }
  if (!marketReport && competitorIds.includes(subjectItemId)) {
    return NextResponse.json({ error: competitionReport ? "本店与竞店 ID 不能相同" : "主体商品与对标商品 ID 不能相同" }, { status: 400, headers: CORS });
  }
  let report;
  try {
    report = await saveDmpBusinessReport({
      access,
      report: checked.report,
      subjectItemId,
      competitorItemId,
      quality: body?.quality === "partial" || checked.issues?.length ? "partial" : "complete",
      sourceVersion: String(body?.sourceVersion ?? "").slice(0, 32),
      ...(sourceShop.value ? { sourceShop: sourceShop.value } : {})
    });
  } catch (error) {
    if (isSourceShopArchiveError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: CORS });
    }
    throw error;
  }
  const reportUrl = toOfficialDmpReportUrl(report.id);
  return NextResponse.json({ data: { report, reportUrl, archived: true } }, { status: 201, headers: CORS });
}

export async function PATCH(request: Request) {
  const access = await resolveAccess(request);
  if (!access) return unauthorized();
  const body = await request.json().catch(() => null) as
    | { reportIds?: unknown; shopId?: unknown }
    | null;
  const reportIds = Array.isArray(body?.reportIds) ? body.reportIds.map(String) : [];
  const result = await assignDmpBusinessReportsShop({
    access,
    reportIds,
    shopId: String(body?.shopId ?? "")
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: CORS });
  return NextResponse.json({ data: { assignment: result } }, { headers: CORS });
}

export async function DELETE(request: Request) {
  const access = await resolveAccess(request);
  if (!access) return unauthorized();
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return NextResponse.json({ error: "缺少报告编号" }, { status: 400, headers: CORS });
  const deleted = await deleteDmpBusinessReport(access, id);
  if (!deleted) return NextResponse.json({ error: "报告不存在或无权删除" }, { status: 404, headers: CORS });
  return NextResponse.json({ data: { id } }, { headers: CORS });
}

async function resolveAccess(request: Request) {
  const extensionToken = request.headers.get("x-sanjie-session");
  return extensionToken ? getDmpReportAccessFromToken(extensionToken) : getDmpReportAccess();
}

function unauthorized() {
  return NextResponse.json({ error: "请先登录并开通达摩盘报告权限" }, { status: 401, headers: CORS });
}

function parseSourceShop(value: unknown):
  | {
      ok: true;
      value?: { shopId?: string; shopName?: string; sourceShopId?: string };
    }
  | { ok: false; error: string } {
  if (value == null) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "来源店铺信息无效" };
  const source = value as { shopId?: unknown; shopName?: unknown; sourceShopId?: unknown };
  if (source.shopId != null && typeof source.shopId !== "string") return { ok: false, error: "来源店铺信息无效" };
  if (source.shopName != null && typeof source.shopName !== "string") return { ok: false, error: "来源店铺信息无效" };
  if (source.sourceShopId != null && typeof source.sourceShopId !== "string") return { ok: false, error: "来源店铺信息无效" };
  const shopId = String(source.shopId ?? "").trim();
  const shopName = String(source.shopName ?? "").trim();
  const sourceShopId = String(source.sourceShopId ?? "").trim();
  if (shopId.length > 100 || shopName.length > 100 || (sourceShopId && !/^\d{5,32}$/.test(sourceShopId))) {
    return { ok: false, error: "来源店铺信息无效" };
  }
  if (!shopId && !shopName && !sourceShopId) return { ok: false, error: "来源店铺信息无效" };
  return {
    ok: true,
    value: {
      ...(shopId ? { shopId } : {}),
      ...(shopName ? { shopName } : {}),
      ...(sourceShopId ? { sourceShopId } : {})
    }
  };
}

function isSourceShopArchiveError(error: unknown): error is Error & { status: 400 | 404 } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; status?: unknown };
  return candidate.code === "DMP_REPORT_SOURCE_SHOP_INVALID"
    && (candidate.status === 400 || candidate.status === 404);
}
