import { NextResponse } from "next/server";
import {
  createDmpReportShare,
  getDmpReportInteractionSummary
} from "@/lib/dmp-report-share";
import {
  getDmpReportAccess,
  getDmpReportAccessFromToken
} from "@/lib/dmp-report-store";

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sanjie-session",
  "Cache-Control": "private, no-store"
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const access = await resolveAccess(request);
  if (!access) return unauthorized();
  const reportId = new URL(request.url).searchParams.get("reportId")?.trim() ?? "";
  if (!reportId) return NextResponse.json({ error: "缺少报告编号" }, { status: 400, headers: CORS });
  const analytics = await getDmpReportInteractionSummary(access, reportId);
  if (!analytics) return NextResponse.json({ error: "报告不存在或无权访问" }, { status: 404, headers: CORS });
  return NextResponse.json({ data: { analytics } }, { headers: CORS });
}

export async function POST(request: Request) {
  const access = await resolveAccess(request);
  if (!access) return unauthorized();
  const body = await request.json().catch(() => null) as { reportId?: unknown } | null;
  const reportId = String(body?.reportId ?? "").trim();
  if (!reportId) return NextResponse.json({ error: "缺少报告编号" }, { status: 400, headers: CORS });
  const share = await createDmpReportShare(access, reportId);
  if (!share) return NextResponse.json({ error: "报告不存在或无权访问" }, { status: 404, headers: CORS });
  const url = new URL(share.path, request.url).toString();
  return NextResponse.json({ data: { share: { id: share.id, url, createdAt: share.createdAt } } }, { status: 201, headers: CORS });
}

async function resolveAccess(request: Request) {
  const extensionToken = request.headers.get("x-sanjie-session");
  return extensionToken ? getDmpReportAccessFromToken(extensionToken) : getDmpReportAccess();
}

function unauthorized() {
  return NextResponse.json({ error: "请先登录并开通达摩盘报告权限" }, { status: 401, headers: CORS });
}
