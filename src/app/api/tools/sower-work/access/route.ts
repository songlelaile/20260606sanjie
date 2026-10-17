import { NextResponse } from "next/server";
import { loadSowerWorkSessionAccess } from "@/lib/sower-work-entitlements";
import { readSowerWorkSession, sowerWorkError, sowerWorkHeaders, sowerWorkOptions } from "@/lib/sower-work-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = sowerWorkOptions;
export async function GET(request: Request) {
  try {
    const session = await readSowerWorkSession(request);
    const { access } = await loadSowerWorkSessionAccess(session);
    return NextResponse.json({ data: access }, { headers: sowerWorkHeaders(request) });
  } catch (error) { return sowerWorkError(error); }
}
