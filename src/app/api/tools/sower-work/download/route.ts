import { NextResponse } from "next/server";
import { loadSowerWorkSessionAccess, requireSowerWorkAccess } from "@/lib/sower-work-entitlements";
import { readSowerWorkSession, sowerWorkError, sowerWorkHeaders, sowerWorkOptions } from "@/lib/sower-work-http";
import { readSowerWorkPackage } from "@/lib/sower-work-package";
import { SOWER_WORK_DOWNLOAD_NAME } from "@/lib/sower-work-product";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = sowerWorkOptions;
export async function GET(request: Request) {
  try {
    const { access } = await loadSowerWorkSessionAccess(await readSowerWorkSession(request));
    requireSowerWorkAccess(access);
    const { bytes, sha256 } = await readSowerWorkPackage();
    return new NextResponse(new Uint8Array(bytes), { headers: {
      ...sowerWorkHeaders(request), "Content-Type": "application/zip",
      "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff",
      "X-Content-SHA256": sha256, "Content-Disposition": 'attachment; filename="' + SOWER_WORK_DOWNLOAD_NAME + '"'
    } });
  } catch (error) { return sowerWorkError(error); }
}
