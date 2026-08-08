import { NextResponse } from "next/server";
import { parseDashboardShareSections } from "@/lib/dashboard-share";
import { createDashboardShare } from "@/lib/store/runtime-store";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { sections?: unknown } | null;
  const sections = parseDashboardShareSections(body?.sections);
  if (!sections) {
    return NextResponse.json({ error: "请选择要分享的看板模块" }, { status: 400 });
  }
  const share = await createDashboardShare({ sections });
  return NextResponse.json({ data: { share } }, { status: 201 });
}
