import { NextResponse } from "next/server";
import { POST as archiveDmpReport } from "@/app/api/dmp-reports/route";
import {
  DMP_REPORT_ARCHIVE_MAX_BODY_BYTES
} from "@/lib/dmp-report-store";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sanjie-session",
  "Cache-Control": "private, no-store"
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * Category-market archives use a dedicated transport route so they can never
 * fall through the product subject/competitor contract. Storage remains in the
 * common report library after both the envelope and canonical body say market.
 */
export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await readJsonWithLimit(request, DMP_REPORT_ARCHIVE_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "类目大盘归档请求超过保存上限" }, { status: 413, headers: CORS });
    }
    return NextResponse.json({ error: "类目大盘归档请求读取失败" }, { status: 400, headers: CORS });
  }

  const body = rawBody as {
    reportType?: unknown;
    report?: { report_type?: unknown };
  } | null;
  if (body?.reportType !== "market" || body?.report?.report_type !== "market") {
    return NextResponse.json(
      { error: "该接口仅接收类目大盘报告，未进入商品 ID 校验" },
      { status: 400, headers: CORS }
    );
  }

  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  const response = await archiveDmpReport(new Request(request.url, {
    method: "POST",
    headers,
    body: JSON.stringify(rawBody)
  }));
  for (const [name, value] of Object.entries(CORS)) response.headers.set(name, value);
  return response;
}
