import { NextResponse } from "next/server";
import {
  getDmpSharedReport,
  recordDmpSharedReportClicks,
  recordDmpSharedReportView
} from "@/lib/dmp-report-share";
import { getDmpReportAccess } from "@/lib/dmp-report-store";

export const runtime = "nodejs";

const REPORT_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer"
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const access = await getDmpReportAccess();
  if (!access) return unauthorized();
  const { token } = await context.params;
  const snapshot = await getDmpSharedReport(access, token);
  if (!snapshot) return NextResponse.json({ error: "分享报告不存在或已失效" }, { status: 404, headers: REPORT_HEADERS });
  return NextResponse.json({ data: { report: snapshot.report, createdAt: snapshot.createdAt } }, { headers: REPORT_HEADERS });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  const access = await getDmpReportAccess();
  if (!access) return unauthorized();
  const { token } = await context.params;
  const body = await request.json().catch(() => null) as { type?: unknown; events?: unknown } | null;
  if (body?.type === "view") {
    const accepted = await recordDmpSharedReportView(access, token);
    if (!accepted) return NextResponse.json({ error: "分享报告不存在或已失效" }, { status: 404, headers: REPORT_HEADERS });
    return NextResponse.json({ data: { accepted: 1 } }, { headers: REPORT_HEADERS });
  }
  if (body?.type === "click") {
    const result = await recordDmpSharedReportClicks(access, token, body.events);
    if (!result) return NextResponse.json({ error: "分享报告不存在或已失效" }, { status: 404, headers: REPORT_HEADERS });
    return NextResponse.json({ data: result }, { headers: REPORT_HEADERS });
  }
  return NextResponse.json({ error: "行为类型无效" }, { status: 400, headers: REPORT_HEADERS });
}

function unauthorized() {
  return NextResponse.json({ error: "请先登录官网同一授权账号" }, { status: 401, headers: REPORT_HEADERS });
}
