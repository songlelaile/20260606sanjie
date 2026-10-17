import { NextResponse } from "next/server";
import { ACTIVE_SHOP_COOKIE } from "@/lib/auth";
import { dmpCanonicalReportIdentity } from "@/lib/dmp-report-library";
import { toOfficialDmpReportUrl } from "@/lib/dmp-public-origin";
import {
  assignDmpBusinessReportsShop,
  deleteDmpBusinessReport,
  getDmpBusinessReport,
  listDmpBusinessReportArchivePair,
  listDmpBusinessReportSummaries,
  resolveDmpReportRequestContext,
  saveDmpBusinessReport,
  DMP_REPORT_ARCHIVE_MAX_BODY_BYTES,
  validCategoryId,
  validItemId,
  validateDmpCanonicalReport
} from "@/lib/dmp-report-store";
import { readJsonWithLimit, RequestBodyTooLargeError } from "@/lib/read-json-with-limit";

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-sanjie-session, x-sanjie-shop",
  "Cache-Control": "private, no-store"
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const id = requestUrl.searchParams.get("id")?.trim() ?? "";
  const resolvesArchiveShop = requestUrl.searchParams.get("scope") === "archive-shop";
  if (resolvesArchiveShop && id) {
    return NextResponse.json(
      { error: "默认归档店铺解析请求不能同时读取报告正文", code: "INVALID_ARCHIVE_SHOP_SCOPE" },
      { status: 400, headers: CORS }
    );
  }
  if (resolvesArchiveShop && !request.headers.get("x-sanjie-session")?.trim()) {
    return NextResponse.json(
      { error: "默认归档店铺仅供已登录扩展解析", code: "UNAUTHORIZED" },
      { status: 401, headers: CORS }
    );
  }
  const context = await resolveRequestContext(request, { resolveExtensionDefaultShop: resolvesArchiveShop });
  if (!context.ok) return requestContextError(context);
  if (!id) {
    if (resolvesArchiveShop) {
      return NextResponse.json({ data: { shop: context.shop } }, { headers: CORS });
    }
    if (requestUrl.searchParams.get("scope") === "archive-pair") {
      const pair = parseArchivePairQuery(requestUrl.searchParams);
      if (!pair.ok) return NextResponse.json({ error: pair.error }, { status: 400, headers: CORS });
      const reports = await listDmpBusinessReportArchivePair(context.access, {
        shopId: context.shop.id,
        ...pair.value
      });
      return NextResponse.json({ data: { reports } }, { headers: CORS });
    }
    const listed = await listDmpBusinessReportSummaries(context.access, {
      shopId: context.shop.id,
      page: Number(requestUrl.searchParams.get("page") ?? ""),
      pageSize: Number(requestUrl.searchParams.get("pageSize") ?? "")
    });
    return NextResponse.json({
      data: {
        reports: listed.summaries,
        pagination: {
          page: listed.page,
          pageSize: listed.pageSize,
          total: listed.total,
          totalPages: listed.totalPages,
          hasNext: listed.hasNext
        }
      }
    }, { headers: CORS });
  }

  const report = await getDmpBusinessReport(context.access, id, context.shop.id);
  if (!report) return NextResponse.json({ error: "报告不存在或无权访问" }, { status: 404, headers: CORS });
  const format = requestUrl.searchParams.get("format");
  if (format === "xlsx" || format === "csv" || format === "html") {
    return NextResponse.json(
      { error: "当前版本仅支持官网在线查看，暂不提供数据下载" },
      { status: 403, headers: CORS }
    );
  }
  return NextResponse.json({ data: { report } }, { headers: CORS });
}

export async function POST(request: Request) {
  const context = await resolveRequestContext(request);
  if (!context.ok) return requestContextError(context);
  let rawBody: unknown;
  try {
    rawBody = await readJsonWithLimit(request, DMP_REPORT_ARCHIVE_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "报告归档请求超过保存上限" }, { status: 413, headers: CORS });
    }
    return NextResponse.json({ error: "报告归档请求读取失败" }, { status: 400, headers: CORS });
  }
  const body = rawBody as
    | {
        report?: unknown;
        subjectItemId?: unknown;
        competitorItemId?: unknown;
        quality?: unknown;
        sourceVersion?: unknown;
        sourceShop?: unknown;
        expectedShop?: unknown;
        archiveMode?: unknown;
        replaceReportId?: unknown;
        absorbedReportIds?: unknown;
      }
    | null;
  const sourceShop = parseSourceShop(body?.sourceShop);
  if (!sourceShop.ok) {
    return NextResponse.json({ error: sourceShop.error }, { status: 400, headers: CORS });
  }
  const expectedShop = parseExpectedShop(body?.expectedShop);
  if (!expectedShop.ok) {
    return NextResponse.json({ error: expectedShop.error, code: "DMP_REPORT_SHOP_MISMATCH" }, { status: 400, headers: CORS });
  }
  if (expectedShop.officialShopId !== context.shop.id || sourceShop.value?.shopId !== context.shop.id) {
    return NextResponse.json(
      { error: "请求店铺、冻结店铺与报告来源店铺不一致", code: "DMP_REPORT_SHOP_MISMATCH" },
      { status: 409, headers: CORS }
    );
  }
  const replacement = parseArchiveReplacement(body);
  if (!replacement.ok) {
    return NextResponse.json({ error: replacement.error }, { status: 400, headers: CORS });
  }
  const checked = validateDmpCanonicalReport(body?.report, {
    subjectItemId: body?.subjectItemId,
    competitorItemId: body?.competitorItemId
  });
  if (!checked.report) return NextResponse.json({ error: checked.error ?? "报告结构无效" }, { status: 400, headers: CORS });

  const identity = dmpCanonicalReportIdentity(checked.report, {
    subjectItemId: body?.subjectItemId,
    competitorItemId: body?.competitorItemId
  });
  const subjectItemId = identity.subjectItemId;
  const competitionReport = identity.reportType === "competition";
  const marketReport = identity.reportType === "market";
  const competitorIds = identity.competitorItemIds;
  const competitorItemId = competitionReport ? competitorIds.join(",") : marketReport ? "" : competitorIds[0] ?? "";
  const invalidIdentity = marketReport
    ? !validCategoryId(subjectItemId) || competitorIds.length > 0
    : !validItemId(subjectItemId)
      || competitorIds.length < 1
      || competitorIds.some((id) => !validItemId(id))
      || (!competitionReport && competitorIds.length !== 1)
      || (competitionReport && competitorIds.length > 3);
  if (invalidIdentity) {
    return NextResponse.json({
      error: marketReport ? "类目 ID 或类目范围无效" : competitionReport ? "本店与竞店 ID 无效" : "主体商品与对标商品 ID 无效"
    }, { status: 400, headers: CORS });
  }
  let report;
  try {
    report = await saveDmpBusinessReport({
      access: context.access,
      shopId: context.shop.id,
      report: checked.report,
      subjectItemId,
      competitorItemId,
      quality: body?.quality === "partial" || checked.issues?.length ? "partial" : "complete",
      sourceVersion: String(body?.sourceVersion ?? "").slice(0, 32),
      ...(sourceShop.value ? { sourceShop: sourceShop.value } : {}),
      ...(replacement.value ?? {})
    });
  } catch (error) {
    if (isAtomicReplaceConflict(error) || isHistoryStaleConflict(error)) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409, headers: CORS });
    }
    if (isSourceShopArchiveError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: CORS });
    }
    throw error;
  }
  const { retention, ...storedReport } = report;
  if (storedReport.shopId !== context.shop.id) {
    return NextResponse.json(
      { error: "保存后的报告店铺与冻结目标不一致", code: "DMP_REPORT_SHOP_MISMATCH" },
      { status: 409, headers: CORS }
    );
  }
  const reportUrl = toOfficialDmpReportUrl(storedReport.id);
  return NextResponse.json({
    data: {
      report: storedReport,
      reportUrl,
      archived: true,
      ...(retention ? { retention } : {})
    }
  }, { status: 201, headers: CORS });
}

export async function PATCH(request: Request) {
  const context = await resolveRequestContext(request);
  if (!context.ok) return requestContextError(context);
  const body = await request.json().catch(() => null) as
    | {
        reportIds?: unknown;
        sourceShopId?: unknown;
        targetShopId?: unknown;
        reportType?: unknown;
        subjectItemId?: unknown;
        competitorItemId?: unknown;
      }
    | null;
  const reportIds = Array.isArray(body?.reportIds) ? body.reportIds.map(String) : [];
  const sourceShopId = String(body?.sourceShopId ?? "").trim();
  if (sourceShopId !== context.shop.id) {
    return NextResponse.json(
      { error: "仅可调整当前冻结店铺内的报告", code: "DMP_REPORT_SHOP_MISMATCH" },
      { status: 409, headers: CORS }
    );
  }
  const result = await assignDmpBusinessReportsShop({
    access: context.access,
    sourceShopId,
    targetShopId: String(body?.targetShopId ?? ""),
    ...(reportIds.length ? { reportIds } : {}),
    reportType: parseReportType(body?.reportType),
    subjectItemId: String(body?.subjectItemId ?? ""),
    competitorItemId: String(body?.competitorItemId ?? "")
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: CORS });
  return NextResponse.json({ data: { assignment: result } }, { headers: CORS });
}

export async function DELETE(request: Request) {
  const context = await resolveRequestContext(request);
  if (!context.ok) return requestContextError(context);
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return NextResponse.json({ error: "缺少报告编号" }, { status: 400, headers: CORS });
  const deleted = await deleteDmpBusinessReport(context.access, id, context.shop.id);
  if (!deleted) return NextResponse.json({ error: "报告不存在或无权删除" }, { status: 404, headers: CORS });
  return NextResponse.json({ data: { id } }, { headers: CORS });
}

async function resolveRequestContext(
  request: Request,
  options: { resolveExtensionDefaultShop?: boolean } = {}
) {
  const extensionToken = request.headers.get("x-sanjie-session")?.trim() ?? "";
  const headerShopId = request.headers.get("x-sanjie-shop")?.trim() ?? "";
  const cookieShopId = readCookie(request.headers.get("cookie"), ACTIVE_SHOP_COOKIE);
  const allowDefaultShop = Boolean(extensionToken && options.resolveExtensionDefaultShop);
  return resolveDmpReportRequestContext({
    ...(extensionToken ? { extensionToken } : {}),
    ...(allowDefaultShop ? { allowDefaultShop: true } : {}),
    // 专用 GET 仅按登录账号解析默认店铺，不能借旧 header 改选；其他扩展请求必须携带已冻结的店铺。
    // 扩展令牌绝不能借浏览器 cookie 选店；官网 header 与 cookie 同时出现时由严格 resolver 校验一致。
    ...(extensionToken
      ? { shopId: allowDefaultShop ? "" : headerShopId }
      : { browserHeaderShopId: headerShopId, browserCookieShopId: cookieShopId })
  });
}

function requestContextError(context: Extract<Awaited<ReturnType<typeof resolveRequestContext>>, { ok: false }>) {
  return NextResponse.json({ error: context.error, code: context.code }, { status: context.status, headers: CORS });
}

function parseSourceShop(value: unknown):
  | {
      ok: true;
      value?: { shopId?: string; shopName?: string; sourceShopId?: string };
    }
  | { ok: false; error: string } {
  if (value == null) return { ok: true };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "来源店铺信息无效" };
  const source = value as { shopId?: unknown; shopName?: unknown; sourceShopId?: unknown };
  if (source.shopId != null && typeof source.shopId !== "string") return { ok: false, error: "来源店铺信息无效" };
  if (source.shopName != null && typeof source.shopName !== "string") return { ok: false, error: "来源店铺信息无效" };
  if (source.sourceShopId != null && typeof source.sourceShopId !== "string") return { ok: false, error: "来源店铺信息无效" };
  const shopId = String(source.shopId ?? "").trim();
  const shopName = String(source.shopName ?? "").trim();
  const sourceShopId = String(source.sourceShopId ?? "").trim();
  if (shopId.length > 100 || shopName.length > 100 || (sourceShopId && !/^\d{5,32}$/.test(sourceShopId))) {
    return { ok: false, error: "来源店铺信息无效" };
  }
  if (!shopId && !shopName && !sourceShopId) return { ok: false, error: "来源店铺信息无效" };
  return {
    ok: true,
    value: {
      ...(shopId ? { shopId } : {}),
      ...(shopName ? { shopName } : {}),
      ...(sourceShopId ? { sourceShopId } : {})
    }
  };
}

function parseExpectedShop(value: unknown):
  | { ok: true; officialShopId: string }
  | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "缺少冻结的官网店铺信息" };
  }
  const officialShopId = String((value as { officialShopId?: unknown }).officialShopId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(officialShopId)) {
    return { ok: false, error: "冻结的官网店铺编号无效" };
  }
  return { ok: true, officialShopId };
}

function parseArchivePairQuery(searchParams: URLSearchParams):
  | {
      ok: true;
      value: {
        reportType: "growth" | "competition" | "market";
        subjectItemId: string;
        competitorItemId: string;
        quality?: "complete" | "partial";
      };
    }
  | { ok: false; error: string } {
  const reportType = parseReportType(searchParams.get("reportType"));
  const subjectItemId = searchParams.get("subjectItemId")?.trim() ?? "";
  const competitorItemId = searchParams.get("competitorItemId")?.trim() ?? "";
  const qualityValue = searchParams.get("quality")?.trim() ?? "";
  const quality = qualityValue === "complete" || qualityValue === "partial" ? qualityValue : undefined;
  const competitorIds = competitorItemId.split(",").map((id) => id.trim()).filter(Boolean);
  const validIdentity = reportType === "market"
    ? validCategoryId(subjectItemId) && competitorIds.length === 0
    : reportType === "competition"
      ? validItemId(subjectItemId)
        && competitorIds.length >= 1
        && competitorIds.length <= 3
        && competitorIds.every(validItemId)
      : reportType === "growth"
        && validItemId(subjectItemId)
        && competitorIds.length === 1
        && competitorIds.every(validItemId);
  if (!reportType || !validIdentity || (qualityValue && !quality)) {
    return { ok: false, error: "报告类型、商品对或质量参数无效" };
  }
  return {
    ok: true,
    value: {
      reportType,
      subjectItemId,
      competitorItemId: reportType === "competition" ? competitorIds.join(",") : competitorItemId,
      ...(quality ? { quality } : {})
    }
  };
}

function parseReportType(value: unknown) {
  return value === "growth" || value === "competition" || value === "market" ? value : undefined;
}

function readCookie(rawCookie: string | null, name: string) {
  const prefix = `${name}=`;
  for (const part of String(rawCookie ?? "").split(";")) {
    const cookie = part.trim();
    if (!cookie.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(cookie.slice(prefix.length)).trim();
    } catch {
      return "";
    }
  }
  return "";
}

function parseArchiveReplacement(body: {
  archiveMode?: unknown;
  replaceReportId?: unknown;
  absorbedReportIds?: unknown;
} | null):
  | {
      ok: true;
      value?: {
        archiveMode: "replace-latest-pair";
        replaceReportId: string;
        absorbedReportIds: string[];
      };
    }
  | { ok: false; error: string } {
  const mode = body?.archiveMode;
  if (mode == null || mode === "") {
    if (body?.replaceReportId != null || body?.absorbedReportIds != null) {
      return { ok: false, error: "缺少原子替换模式" };
    }
    return { ok: true };
  }
  if (mode !== "replace-latest-pair") return { ok: false, error: "报告归档模式无效" };
  if (typeof body?.replaceReportId !== "string" || !Array.isArray(body.absorbedReportIds)) {
    return { ok: false, error: "原子替换目标或吸收报告清单无效" };
  }
  const replaceReportId = body.replaceReportId.trim();
  const rawIds = body.absorbedReportIds;
  if (
    !replaceReportId
    || replaceReportId.length > 100
    || rawIds.length < 1
    || rawIds.length > 200
    || rawIds.some((id) => typeof id !== "string" || !id.trim() || id.trim().length > 100)
  ) {
    return { ok: false, error: "原子替换目标或吸收报告清单无效" };
  }
  const absorbedReportIds = [...new Set(rawIds.map((id) => id.trim()))];
  if (!absorbedReportIds.includes(replaceReportId)) {
    return { ok: false, error: "吸收报告清单必须包含原位更新目标" };
  }
  return {
    ok: true,
    value: { archiveMode: mode, replaceReportId, absorbedReportIds }
  };
}

function isSourceShopArchiveError(error: unknown): error is Error & { status: 400 | 404 } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; status?: unknown };
  return candidate.code === "DMP_REPORT_SOURCE_SHOP_INVALID"
    && (candidate.status === 400 || candidate.status === 404);
}

function isAtomicReplaceConflict(error: unknown): error is Error & { status: 409; code: "DMP_REPORT_REPLACE_CONFLICT" } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; status?: unknown };
  return candidate.code === "DMP_REPORT_REPLACE_CONFLICT" && candidate.status === 409;
}

function isHistoryStaleConflict(error: unknown): error is Error & { status: 409; code: "DMP_REPORT_HISTORY_STALE" } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; status?: unknown };
  return candidate.code === "DMP_REPORT_HISTORY_STALE" && candidate.status === 409;
}
