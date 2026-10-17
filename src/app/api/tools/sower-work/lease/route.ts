import { NextResponse } from "next/server";
import { loadSowerWorkSessionAccess } from "@/lib/sower-work-entitlements";
import { readSowerWorkJson, readSowerWorkSession, sowerWorkError, sowerWorkHeaders, sowerWorkOptions } from "@/lib/sower-work-http";
import { issueSowerWorkLease, parseSowerWorkBinding } from "@/lib/sower-work-lease";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = sowerWorkOptions;
export async function POST(request: Request) {
  try {
    const session = await readSowerWorkSession(request);
    const binding = parseSowerWorkBinding(await readSowerWorkJson(request));
    const loaded = await loadSowerWorkSessionAccess(session);
    const issued = issueSowerWorkLease(binding, loaded);
    return NextResponse.json({ data: { ...loaded.access, ...issued } }, { headers: sowerWorkHeaders(request) });
  } catch (error) { return sowerWorkError(error); }
}
