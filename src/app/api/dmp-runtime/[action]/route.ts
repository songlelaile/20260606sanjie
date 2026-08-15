import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  analyzeDmpPayload,
  dmpRuntimeErrorResponse,
  getDmpRuntimeHealth,
  validateDmpRuntimeReport
} from "@/lib/dmp-runtime";
import {
  getDmpReportAccessFromToken,
  validateDmpCanonicalReport
} from "@/lib/dmp-report-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 24 * 1024 * 1024;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sanjie-session",
  "Cache-Control": "private, no-store"
};

type RouteContext = { params: Promise<{ action: string }> };

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

async function authorized(request: Request) {
  return getDmpReportAccessFromToken(request.headers.get("x-sanjie-session"));
}

function unauthorized() {
  return NextResponse.json({ ok: false, error: "请先登录并开通达摩盘自动化权限" }, { status: 401, headers: CORS });
}

async function readBody(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new Error("请求数据超过 24MB 限制");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new Error("请求数据超过 24MB 限制");
  return JSON.parse(text) as Record<string, unknown>;
}

function safeKeyMatch(provided: unknown, expected: string) {
  const left = crypto.createHash("sha256").update(String(provided || "")).digest();
  const right = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

export async function GET(request: Request, context: RouteContext) {
  if (!await authorized(request)) return unauthorized();
  const { action } = await context.params;
  if (action !== "health") return NextResponse.json({ ok: false, error: "Not found" }, { status: 404, headers: CORS });
  return NextResponse.json(getDmpRuntimeHealth(), { headers: CORS });
}

export async function POST(request: Request, context: RouteContext) {
  if (!await authorized(request)) return unauthorized();
  const { action } = await context.params;
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "请求不是有效 JSON" }, { status: 400, headers: CORS });
  }

  if (action === "qc-auth") {
    const expected = String(process.env.DMP_QC_ADMIN_KEY || "").trim();
    if (!expected) return NextResponse.json({ ok: false, error: "管理员校验服务未配置" }, { status: 503, headers: CORS });
    if (!safeKeyMatch(body.key, expected)) return NextResponse.json({ ok: false, error: "管理员登录失败" }, { status: 401, headers: CORS });
    return NextResponse.json({ ok: true, expires_in: 600 }, { headers: CORS });
  }

  const checked = validateDmpCanonicalReport(body.report);
  if (!checked.report) return NextResponse.json({ ok: false, error: checked.error || "报告结构无效" }, { status: 400, headers: CORS });
  const reportError = validateDmpRuntimeReport(checked.report);
  if (reportError) return NextResponse.json({ ok: false, error: reportError }, { status: 400, headers: CORS });

  if (action === "report") {
    return NextResponse.json({ ok: true, report: checked.report, model: "云端确定性校验", provider: "少壮AI云端托管" }, { headers: CORS });
  }
  if (action !== "analyze") return NextResponse.json({ ok: false, error: "Not found" }, { status: 404, headers: CORS });

  try {
    const result = await analyzeDmpPayload(body.payload as Record<string, unknown>, checked.report);
    return NextResponse.json(result, { headers: CORS });
  } catch (error) {
    const response = dmpRuntimeErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status, headers: CORS });
  }
}
