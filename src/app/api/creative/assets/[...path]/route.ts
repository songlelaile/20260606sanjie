import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import type { Session } from "@/lib/auth";
import { getCurrentSession } from "@/lib/server-session";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";
import { createUatEnvironmentScript } from "@/lib/uat-environment";
import { CREATIVE_ASSET_HEADERS, creativeAssetContentType } from "@/lib/creative-asset-policy";
import { CREATIVE_ENTRY_CSS, CREATIVE_ENTRY_JS, isCreativeEntryPath, loadCreativeEntryBundle } from "@/lib/creative-entry-bundle";

export const dynamic = "force-dynamic";

// A restart or another worker can cause a safe 200 cache miss. This key is
// independent of credentials and never exposes account fields in validators.
const assetValidatorKey = randomBytes(32);

function assetETag(session: Session, relative: string, bytes: Uint8Array) {
  const digest = createHmac("sha256", assetValidatorKey)
    .update(JSON.stringify([session.tenantId, session.username, session.role, relative]))
    .update("\0")
    .update(bytes)
    .digest("hex");
  // The existing server/proxy may compress the response; weak comparison is
  // intentional and does not require changing the compression pipeline.
  return `W/"${digest}"`;
}

function matchesIfNoneMatch(value: string | null, etag: string) {
  if (!value || value.length > 8192) return false;
  const input = value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (input === "*") return true;
  const opaqueTag = etag.slice(2);
  let index = 0;
  let matched = false;
  let sawTag = false;
  const skipWhitespace = () => {
    while (input[index] === " " || input[index] === "\t") index++;
  };
  while (index < input.length) {
    skipWhitespace();
    // HTTP lists allow empty members; they do not match a representation.
    if (input[index] === ",") { index++; continue; }
    if (index === input.length) break;
    if (input.startsWith("W/", index)) index += 2;
    if (input[index] !== '"') return false;
    const start = index++;
    while (index < input.length && input[index] !== '"') {
      const code = input.charCodeAt(index++);
      if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff))) return false;
    }
    if (input[index++] !== '"') return false;
    sawTag = true;
    if (input.slice(start, index) === opaqueTag) matched = true;
    skipWhitespace();
    if (index === input.length) break;
    if (input[index++] !== ",") return false;
  }
  return sawTag && matched;
}

function errorResponse(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: CREATIVE_ASSET_HEADERS });
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  let session: Session;
  try {
    const currentSession = await getCurrentSession();
    if (!currentSession) return errorResponse("未登录", 401);
    session = currentSession;
    const access = await getCreativeAccessForSession(session);
    if (!access.allowed) return errorResponse("请先充值开通工作台", access.reason === "invalid_account" ? 401 : 402);
  } catch { return errorResponse("授权查询暂不可用", 503); }
  const parts = (await context.params).path;
  const contentType = creativeAssetContentType(parts);
  if (!contentType) return errorResponse("资源不存在", 404);
  try {
    const root = await realpath(path.join(process.cwd(), "public", "creative"));
    let relative = parts.join("/");
    let bytes: Buffer;
    if (isCreativeEntryPath(relative)) {
      const bundle = await loadCreativeEntryBundle(root);
      bytes = Buffer.from(relative === CREATIVE_ENTRY_CSS ? bundle.css : relative === CREATIVE_ENTRY_JS ? bundle.js : bundle.html);
    } else {
      const filename = await realpath(path.join(root, ...parts));
      relative = path.relative(root, filename);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
          creativeAssetContentType(relative.split(path.sep)) !== contentType || !(await stat(filename)).isFile()) {
        return errorResponse("资源不存在", 404);
      }
      bytes = await readFile(filename);
    }
    if (contentType === "text/javascript; charset=utf-8" || contentType === "text/css; charset=utf-8") {
      const etag = assetETag(session, relative, bytes);
      const headers = { ...CREATIVE_ASSET_HEADERS, "Content-Type": contentType,
        "Cache-Control": "private, no-cache", Vary: "Cookie", ETag: etag };
      if (matchesIfNoneMatch(request.headers.get("If-None-Match"), etag)) {
        return new NextResponse(null, { status: 304, headers });
      }
      return new NextResponse(new Uint8Array(bytes), { headers });
    }
    let body: BodyInit = new Uint8Array(bytes);
    if (contentType.startsWith("text/html")) {
      const html = bytes.toString("utf8");
      const script = createUatEnvironmentScript(process.env.SANJIE_TEST_ENVIRONMENT);
      body = script ? html.replace(/<head\b[^>]*>/i, match => `${match}<script>${script}</script>`) : html;
    }
    return new NextResponse(body, { headers: { ...CREATIVE_ASSET_HEADERS, "Content-Type": contentType } });
  } catch { return errorResponse("资源不存在", 404); }
}
