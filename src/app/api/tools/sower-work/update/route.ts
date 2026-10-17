import { NextResponse } from "next/server";
import { loadSowerWorkSessionAccess, requireSowerWorkAccess } from "@/lib/sower-work-entitlements";
import { readSowerWorkSession, sowerWorkError, sowerWorkHeaders, sowerWorkOptions } from "@/lib/sower-work-http";
import { readSowerWorkPackage } from "@/lib/sower-work-package";
import { SOWER_WORK_DOWNLOAD_NAME, SOWER_WORK_EXTENSION_ID, SOWER_WORK_PRODUCT_ID, SOWER_WORK_PROTOCOL_VERSION, SOWER_WORK_VERSION } from "@/lib/sower-work-product";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = sowerWorkOptions;
export async function GET(request: Request) {
  try {
    const { access } = await loadSowerWorkSessionAccess(await readSowerWorkSession(request));
    requireSowerWorkAccess(access);
    const { bytes, sha256 } = await readSowerWorkPackage();
    return NextResponse.json({ data: {
      productId: SOWER_WORK_PRODUCT_ID, version: SOWER_WORK_VERSION, releaseVersion: SOWER_WORK_VERSION,
      extensionId: SOWER_WORK_EXTENSION_ID, protocolVersion: SOWER_WORK_PROTOCOL_VERSION,
      downloadUrl: "/api/tools/sower-work/download", filename: SOWER_WORK_DOWNLOAD_NAME,
      sha256, size: bytes.length
    } }, { headers: sowerWorkHeaders(request) });
  } catch (error) { return sowerWorkError(error); }
}
