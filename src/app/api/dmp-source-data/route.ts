import { NextResponse } from "next/server";
import { ACTIVE_SHOP_COOKIE } from "@/lib/auth";
import { getDmpReportAccess, getDmpReportAccessFromToken } from "@/lib/dmp-report-store";
import { ingestDmpSourceMatrix } from "@/lib/dmp-source-data";
import { locateHeaderRow } from "@/lib/imports/contracts";
import { parseWorkbookUpload } from "@/lib/imports/parse-workbook";
import type { ReportType } from "@/lib/types/domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sanjie-session, x-sanjie-shop",
  "Cache-Control": "private, no-store"
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function POST(request: Request) {
  const access = await resolveAccess(request);
  if (!access) return NextResponse.json({ error: "请先登录官网后再保存经营数据" }, { status: 401, headers: CORS });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "经营数据请求无效" }, { status: 400, headers: CORS });
  const reportType = String(body.reportType || "") as ReportType;
  let headers = Array.isArray(body.headers) ? body.headers.map(String) : undefined;
  let rows = Array.isArray(body.rows) ? body.rows.filter(Array.isArray) as unknown[][] : undefined;
  let fileSizeBytes = 0;

  if (typeof body.fileBase64 === "string" && body.fileBase64) {
    try {
      const bytes = Buffer.from(body.fileBase64, "base64");
      fileSizeBytes = bytes.byteLength;
      const file = new File([bytes], String(body.fileName || "经营数据.xls"));
      const parsed = await parseWorkbookUpload(file);
      const located = locateHeaderRow(parsed.matrix, reportType);
      headers = located.headers;
      rows = located.rows;
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "下载文件自动解析失败" }, { status: 400, headers: CORS });
    }
  }

  try {
    const data = await ingestDmpSourceMatrix({
      access,
      shopId: String(request.headers.get("x-sanjie-shop") || readCookie(request.headers.get("cookie"), ACTIVE_SHOP_COOKIE)).trim(),
      reportType,
      acquisitionMode: String(body.acquisitionMode || "page-table"),
      day: String(body.day || ""),
      expectedStart: String(body.expectedStart || ""),
      expectedEnd: String(body.expectedEnd || ""),
      headers,
      rows,
      rawBody: body.rawBody,
      fileName: String(body.fileName || ""),
      fileSizeBytes
    });
    return NextResponse.json({ data }, { status: 201, headers: CORS });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "经营数据保存失败" }, { status: 422, headers: CORS });
  }
}

async function resolveAccess(request: Request) {
  const extensionToken = request.headers.get("x-sanjie-session");
  return extensionToken ? getDmpReportAccessFromToken(extensionToken) : getDmpReportAccess();
}

function readCookie(raw: string | null, name: string) {
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}
