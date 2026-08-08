import { NextResponse } from "next/server";
import { createGatewayApiKey, getGatewayOverview } from "@/lib/model-gateway/store";
import { getCurrentUser } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const overview = await getGatewayOverview(user.id);
  return NextResponse.json({ data: { keys: overview.keys } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { name?: string } | null;
  try {
    const created = await createGatewayApiKey(user.id, body?.name || "默认 Key");
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建失败" }, { status: 400 });
  }
}
