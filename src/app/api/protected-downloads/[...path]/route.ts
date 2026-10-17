import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/server-session";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin"
};

type RouteContext = { params: Promise<{ path: string[] }> };
const STABLE_VERSION = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
const CREATIVE_PACKAGE_BASENAME = new RegExp(
  `^(?:sycm-keyword-collector-v${STABLE_VERSION}|shaozhuang-ai-v${STABLE_VERSION}-macos-full)\\.zip$`
);

function creativePackageBasename(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 &&
    CREATIVE_PACKAGE_BASENAME.test(value);
}

function errorResponse(error: string, status: number, head: boolean) {
  return head
    ? new NextResponse(null, { status, headers: PRIVATE_HEADERS })
    : NextResponse.json({ error }, { status, headers: PRIVATE_HEADERS });
}

async function download(request: Request, context: RouteContext, head: boolean) {
  // Historical SYCM packages contain the creative workspace code. Their old
  // URLs must receive the same live entitlement check as the workspace itself.
  // Authentication precedes filesystem resolution to avoid an anonymous oracle.
  try {
    const session = await getCurrentSession();
    if (!session) return errorResponse("请先登录", 401, head);
    const access = await getCreativeAccessForSession(session);
    if (!access.allowed) {
      if (access.reason === "invalid_account") return errorResponse("登录已失效", 401, head);
      if (access.reason === "unavailable") return errorResponse("授权查询暂不可用", 503, head);
      return errorResponse("请先充值开通工作台", 402, head);
    }
  } catch {
    return errorResponse("授权查询暂不可用", 503, head);
  }

  let file: FileHandle | null = null;
  try {
    const parts = (await context.params).path;
    if (!Array.isArray(parts) || parts.length !== 1 || !creativePackageBasename(parts[0])) {
      return errorResponse("资源不存在", 404, head);
    }
    const basename = parts[0];
    const root = await realpath(path.join(process.cwd(), "public", "downloads"));
    const expectedFilename = path.join(root, basename);
    const filename = await realpath(expectedFilename);
    const relative = path.relative(root, filename);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) || filename !== expectedFilename || !creativePackageBasename(path.basename(filename))) {
      return errorResponse("资源不存在", 404, head);
    }

    // Product authorization only covers the two known creative package families.
    // Exact canonical-path equality rejects all package symlink aliases, including
    // aliases to another ZIP inside this root. The public root itself may be an
    // existing deployment symlink: it was canonicalized before this comparison.
    // Refuse a final-component symlink at open time too, and use
    // the same file descriptor for metadata and streaming, rather than reopening
    // the user-supplied path after authorization or loading the ZIP into memory.
    // Nonblocking also ensures an unexpected FIFO/device named *.zip cannot
    // hold an authenticated request open before the regular-file check.
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile()) return errorResponse("资源不存在", 404, head);
    const headers = {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/zip",
      "Content-Length": String(metadata.size),
      "Content-Disposition": `attachment; filename="${basename}"; filename*=UTF-8''${encodeURIComponent(basename)}`
    };
    if (head) return new NextResponse(null, { headers });

    const stream = file.createReadStream({ autoClose: true, signal: request.signal });
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    const response = new NextResponse(body, { headers });
    file = null; // Stream owns the descriptor and closes it on end/cancel/error.
    return response;
  } catch {
    return errorResponse("资源不存在", 404, head);
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

export async function GET(request: Request, context: RouteContext) {
  return download(request, context, false);
}

export async function HEAD(request: Request, context: RouteContext) {
  return download(request, context, true);
}

function methodNotAllowed() {
  return new NextResponse(null, { status: 405, headers: { ...PRIVATE_HEADERS, Allow: "GET, HEAD" } });
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
