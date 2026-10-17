import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server-session";

export const dynamic = "force-dynamic";
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (user.authRole !== "admin") return NextResponse.json({ error: "仅管理员可查看充值订单" }, { status: 403 });
  const orders = await prisma.gatewayOrder.findMany({
    orderBy: { createdAt: "desc" }, take: 100,
    include: { user: { select: { username: true, name: true } } }
  });
  return NextResponse.json({ data: { orders } }, { headers: { "Cache-Control": "private, no-store" } });
}
