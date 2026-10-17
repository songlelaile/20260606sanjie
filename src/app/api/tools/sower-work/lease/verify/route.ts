import { NextResponse } from "next/server";
import { SowerWorkAccessError } from "@/lib/sower-work-entitlements";
import { readSowerWorkJson, sowerWorkError, sowerWorkHeaders, sowerWorkOptions } from "@/lib/sower-work-http";
import { sowerWorkVerificationSchema, verifySowerWorkLease } from "@/lib/sower-work-lease";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = sowerWorkOptions;
export async function POST(request: Request) {
  try {
    const parsed = sowerWorkVerificationSchema.safeParse(await readSowerWorkJson(request));
    if (!parsed.success) throw new SowerWorkAccessError(400, "INVALID_BINDING", "授权凭证或绑定参数无效");
    const { lease, ...binding } = parsed.data;
    const data = await verifySowerWorkLease(lease, binding);
    return NextResponse.json({ data }, { headers: sowerWorkHeaders(request) });
  } catch (error) { return sowerWorkError(error); }
}
