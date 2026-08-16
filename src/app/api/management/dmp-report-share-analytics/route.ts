import { NextResponse } from "next/server";
import {
  getDmpReportShareManagementAnalytics,
  revokeDmpReportShare
} from "@/lib/dmp-report-share";
import type { DmpReportAnalyticsDays } from "@/lib/dmp-report-types";
import { requireAdminResponse } from "@/lib/route-guards";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };
const ALLOWED_DAYS = new Set<DmpReportAnalyticsDays>([7, 30, 90]);

export async function GET(request: Request) {
  const forbidden = await requireAdminResponse();
  if (forbidden) return forbidden;
  const days = parseDays(new URL(request.url).searchParams.get("days"));
  if (!days) {
    return NextResponse.json({ error: "days 只支持 7、30 或 90" }, { status: 400, headers: PRIVATE_HEADERS });
  }
  const analytics = await getDmpReportShareManagementAnalytics(days);
  return NextResponse.json({ data: { analytics } }, { headers: PRIVATE_HEADERS });
}

export async function DELETE(request: Request) {
  const forbidden = await requireAdminResponse();
  if (forbidden) return forbidden;
  const shareId = new URL(request.url).searchParams.get("shareId")?.trim() ?? "";
  if (!shareId) {
    return NextResponse.json({ error: "缺少分享编号" }, { status: 400, headers: PRIVATE_HEADERS });
  }
  const share = await revokeDmpReportShare(shareId);
  if (!share) {
    return NextResponse.json({ error: "分享链接不存在" }, { status: 404, headers: PRIVATE_HEADERS });
  }
  return NextResponse.json({ data: { share } }, { headers: PRIVATE_HEADERS });
}

function parseDays(value: string | null): DmpReportAnalyticsDays | null {
  if (value === null || value.trim() === "") return 30;
  const days = Number(value);
  return ALLOWED_DAYS.has(days as DmpReportAnalyticsDays) ? days as DmpReportAnalyticsDays : null;
}
