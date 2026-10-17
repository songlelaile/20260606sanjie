import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/server-session";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";

export const dynamic = "force-dynamic";
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: "未登录" }, { status: 401 });
  try {
    const access = await getCreativeAccessForSession(session);
    return NextResponse.json({ data: { access } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "授权查询暂不可用，请重试" }, { status: 503 });
  }
}
