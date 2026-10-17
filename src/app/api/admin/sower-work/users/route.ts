import { NextResponse } from "next/server";
import { z } from "zod";
import { listSowerWorkUsers, SowerWorkAccessError } from "@/lib/sower-work-entitlements";
import { readSowerWorkSession, sowerWorkError, SOWER_PRIVATE_HEADERS } from "@/lib/sower-work-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const querySchema = z.object({
  search: z.string().trim().max(80).default(""),
  page: z.coerce.number().int().min(1).max(10000).default(1)
}).strict();
export async function GET(request: Request) {
  try {
    const session = await readSowerWorkSession(request);
    const url = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new SowerWorkAccessError(400, "INVALID_QUERY", "查询参数无效");
    const data = await listSowerWorkUsers(session, parsed.data);
    return NextResponse.json({ data }, { headers: SOWER_PRIVATE_HEADERS });
  } catch (error) { return sowerWorkError(error); }
}
