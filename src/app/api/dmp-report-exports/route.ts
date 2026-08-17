import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import {
  DMP_REPORT_EXPORT_MAX_BODY_BYTES,
  normalizeDmpReportExportRequest
} from "@/lib/dmp-report-export-contract";
import { authorizeAndAuditDmpReportExport } from "@/lib/dmp-report-export-authorization";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sanjie-session",
  "Cache-Control": "private, no-store"
};

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS, Allow: "POST, OPTIONS" }
  });
}

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "请求内容类型无效" }, { status: 415, headers: CORS });
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonWithLimit(request, DMP_REPORT_EXPORT_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "导出授权请求超过 8KB 上限" }, { status: 413, headers: CORS });
    }
    return NextResponse.json({ error: "导出授权请求读取失败" }, { status: 400, headers: CORS });
  }

  const exportRequest = normalizeDmpReportExportRequest(rawBody);
  if (!exportRequest) {
    return NextResponse.json({ error: "导出授权参数无效" }, { status: 400, headers: CORS });
  }

  const rawSessionToken = request.headers.get("x-sanjie-session")
    ?? readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  try {
    const result = await authorizeAndAuditDmpReportExport(rawSessionToken, exportRequest);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status, headers: CORS });
    }
    return NextResponse.json(
      { data: { authorization: result.authorization } },
      { status: 201, headers: CORS }
    );
  } catch {
    // 审计无法落库时必须 fail-closed，插件不得继续在本地生成 XLSX。
    return NextResponse.json({ error: "导出授权服务暂不可用" }, { status: 503, headers: CORS });
  }
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
