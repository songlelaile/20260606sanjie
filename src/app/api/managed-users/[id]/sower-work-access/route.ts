import { NextResponse } from "next/server";
import { z } from "zod";
import { setSowerWorkEntitlement, SowerWorkAccessError } from "@/lib/sower-work-entitlements";
import { readSowerWorkJson, readSowerWorkSession, sowerWorkError, SOWER_PRIVATE_HEADERS } from "@/lib/sower-work-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const bodySchema = z.object({ enabled: z.boolean() }).strict();
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await readSowerWorkSession(request);
    const { id } = await context.params;
    const body = bodySchema.safeParse(await readSowerWorkJson(request, 1024));
    if (!body.success || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new SowerWorkAccessError(400, "INVALID_GRANT_REQUEST", "授权参数无效");
    }
    const data = await setSowerWorkEntitlement(session, { userId: id, enabled: body.data.enabled });
    return NextResponse.json({ data }, { headers: SOWER_PRIVATE_HEADERS });
  } catch (error) { return sowerWorkError(error); }
}
