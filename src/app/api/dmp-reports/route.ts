import { NextResponse } from "next/server";
import { buildDmpReportCsv, buildDmpReportWorkbook } from "@/lib/dmp-report-export";
import {
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
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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
  if (format === "xlsx") {
    const file = await buildDmpReportWorkbook(report.report);
    return downloadResponse(file, report, "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  if (format === "csv") {
    return downloadResponse(Buffer.from(buildDmpReportCsv(report.report)), report, "csv", "text/csv;charset=utf-8");
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

  const subjectItemId = String(body?.subjectItemId ?? checked.report.item_id).trim();
  const competitorItemId = String(body?.competitorItemId ?? "").trim();
  if (!validItemId(subjectItemId) || !validItemId(competitorItemId)) {
    return NextResponse.json({ error: "主体商品与对标商品 ID 无效" }, { status: 400, headers: CORS });
  }
  const report = await saveDmpBusinessReport({
    access,
    report: checked.report,
    subjectItemId,
    competitorItemId,
    quality: body?.quality === "partial" ? "partial" : "complete",
    sourceVersion: String(body?.sourceVersion ?? "").slice(0, 32)
  });
  return NextResponse.json({ data: { report } }, { status: 201, headers: CORS });
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

function downloadResponse(
  body: Buffer,
  report: { subjectItemId: string; competitorItemId: string },
  extension: "xlsx" | "csv",
  contentType: string
) {
  const filename = `达摩盘打爆路径报告_${report.subjectItemId}_vs_${report.competitorItemId}.${extension}`;
  const content = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return new NextResponse(content, {
    headers: {
      ...CORS,
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    }
  });
}
