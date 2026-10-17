import { NextResponse } from "next/server";
import { ACTIVE_SHOP_COOKIE } from "@/lib/auth";
import { createDmpReportShare } from "@/lib/dmp-report-share";
import { toPublicAppUrl } from "@/lib/dmp-public-origin";
import { resolveDmpReportRequestContext } from "@/lib/dmp-report-store";

export const runtime = "nodejs";

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
  const context = await resolveContext(request);
  if (!context.ok) {
    return NextResponse.json(
      { error: context.error, code: context.code },
      { status: context.status, headers: CORS }
    );
  }
  const body = await request.json().catch(() => null) as { reportId?: unknown } | null;
  const reportId = String(body?.reportId ?? "").trim();
  if (!reportId) return NextResponse.json({ error: "缺少报告编号" }, { status: 400, headers: CORS });
  const share = await createDmpReportShare(context.access, reportId, context.shop.id);
  if (!share) return NextResponse.json({ error: "报告不存在或无权访问" }, { status: 404, headers: CORS });
  const url = toPublicAppUrl(share.path);
  return NextResponse.json({ data: { share: { id: share.id, url, createdAt: share.createdAt } } }, { status: 201, headers: CORS });
}

async function resolveContext(request: Request) {
  const extensionToken = request.headers.get("x-sanjie-session")?.trim() ?? "";
  const headerShopId = request.headers.get("x-sanjie-shop")?.trim() ?? "";
  const cookieShopId = readCookie(request.headers.get("cookie"), ACTIVE_SHOP_COOKIE);
  return resolveDmpReportRequestContext({
    ...(extensionToken ? { extensionToken } : {}),
    ...(extensionToken
      ? { shopId: headerShopId }
      : { browserHeaderShopId: headerShopId, browserCookieShopId: cookieShopId })
  });
}

function readCookie(rawCookie: string | null, name: string) {
  const prefix = `${name}=`;
  const matched = String(rawCookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!matched) return "";
  try {
    return decodeURIComponent(matched.slice(prefix.length)).trim();
  } catch {
    return "";
  }
}
