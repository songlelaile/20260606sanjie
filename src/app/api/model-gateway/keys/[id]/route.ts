import { NextResponse } from "next/server";
import { disableGatewayApiKey } from "@/lib/model-gateway/store";
import { getCurrentUser } from "@/lib/server-session";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  const { id } = await params;
  const ok = await disableGatewayApiKey(user.id, id);
  if (!ok) {
    return NextResponse.json({ error: "API Key 不存在" }, { status: 404 });
  }
  return NextResponse.json({ data: { ok: true } });
}
