import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/server-session";
import { CREATIVE_TOOL_CODE } from "@/lib/creative-access-policy";
import { getCreativeAccessForSession } from "@/lib/creative-entitlements";
import { readJsonWithLimit } from "@/lib/read-json-with-limit";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await getCurrentUser();
  if (!admin) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (admin.authRole !== "admin") return NextResponse.json({ error: "仅管理员可确认受邀客户" }, { status: 403 });
  const body = await readJsonWithLimit(request, 4096).catch(() => null) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "enabled 必须是布尔值" }, { status: 400 });
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return NextResponse.json({ error: "用户 ID 无效" }, { status: 400 });
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, name: true, tenantId: true, authRole: true } });
  if (!user) return NextResponse.json({ error: "账号不存在" }, { status: 404 });
  if (user.authRole === "admin" || user.id === admin.id) return NextResponse.json({ error: "平台管理员无需受邀授权" }, { status: 403 });
  const data = { status: body.enabled ? "active" : "revoked", grantedBy: admin.id, grantedAt: new Date(), expiresAt: null,
    note: body.enabled ? "管理员确认受邀客户" : "管理员撤销受邀工作台权限" };
  const access = await prisma.toolEntitlement.upsert({
    where: { userId_toolCode: { userId: id, toolCode: CREATIVE_TOOL_CODE } },
    create: { userId: id, toolCode: CREATIVE_TOOL_CODE, ...data }, update: data
  });
  const actualAccess = await getCreativeAccessForSession({ username: user.username, name: user.name, tenantId: user.tenantId, role: "tenant" });
  return NextResponse.json({ data: { id, creativeStudioAccess: { allowed: access.status === "active", status: access.status === "active" ? "active" : "revoked", grantedAt: access.grantedAt.toISOString(), expiresAt: null, remainingDays: 0 }, creativeAccess: actualAccess } },
    { headers: { "Cache-Control": "private, no-store" } });
}
