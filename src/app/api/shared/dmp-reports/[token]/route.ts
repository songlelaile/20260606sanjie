import { NextResponse } from "next/server";
import { normalizeDmpPublicShareEvent } from "@/lib/dmp-report-share-events";
import { recordDmpPublicShareEvent } from "@/lib/dmp-report-share";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

export const runtime = "nodejs";

const MAX_EVENT_BODY_BYTES = 64 * 1024;
const REPORT_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...REPORT_HEADERS, Allow: "POST, OPTIONS" }
  });
}

export function GET() {
  return NextResponse.json(
    { error: "公开报告数据仅由只读页面提供" },
    { status: 405, headers: { ...REPORT_HEADERS, Allow: "POST, OPTIONS" } }
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> }
) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "请求内容类型无效" }, { status: 415, headers: REPORT_HEADERS });
  }
  let rawBody: unknown;
  try {
    rawBody = await readJsonWithLimit(request, MAX_EVENT_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "行为数据超过 64KB 上限" }, { status: 413, headers: REPORT_HEADERS });
    }
    return NextResponse.json({ error: "行为数据读取失败" }, { status: 400, headers: REPORT_HEADERS });
  }
  const event = normalizeDmpPublicShareEvent(rawBody);
  if (!event) {
    return NextResponse.json({ error: "行为数据无效" }, { status: 400, headers: REPORT_HEADERS });
  }
  const { token } = await context.params;
  const result = await recordDmpPublicShareEvent(token, event);
  if (!result) {
    return NextResponse.json({ error: "分享报告不存在或已失效" }, { status: 404, headers: REPORT_HEADERS });
  }
  return NextResponse.json({ data: result }, { headers: REPORT_HEADERS });
}
