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
  validItemId,
  validateDmpCanonicalReport
} from "@/lib/dmp-report-store";

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
  const body = (await request.json().catch(() => null)) as
    | {
        report?: unknown;
        subjectItemId?: unknown;
        competitorItemId?: unknown;
        quality?: unknown;
        sourceVersion?: unknown;
      }
    | null;
  const checked = validateDmpCanonicalReport(body?.report);
  if (!checked.report) return NextResponse.json({ error: checked.error ?? "报告结构无效" }, { status: 400, headers: CORS });

  const identity = dmpCanonicalReportIdentity(checked.report, {
    subjectItemId: body?.subjectItemId,
    competitorItemId: body?.competitorItemId
  });
  const subjectItemId = identity.subjectItemId;
  const competitionReport = identity.reportType === "competition";
  const competitorIds = identity.competitorItemIds;
  const competitorItemId = competitionReport ? competitorIds.join(",") : competitorIds[0] ?? "";
  if (!validItemId(subjectItemId) || competitorIds.length < 1 || competitorIds.some((id) => !validItemId(id)) || (!competitionReport && competitorIds.length !== 1) || (competitionReport && competitorIds.length > 3)) {
    return NextResponse.json({ error: competitionReport ? "本店与竞店 ID 无效" : "主体商品与对标商品 ID 无效" }, { status: 400, headers: CORS });
  }
  const report = await saveDmpBusinessReport({
    access,
    report: checked.report,
    subjectItemId,
    competitorItemId,
    quality: body?.quality === "partial" ? "partial" : "complete",
    sourceVersion: String(body?.sourceVersion ?? "").slice(0, 32)
  });
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
