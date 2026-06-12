import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/session-server";
import { deleteManagedUser, setManagedUserStatus } from "@/lib/store/runtime-store";

/** 中间件只拦未登录；用户管理是管理员能力，这里再校验角色。 */
async function requireAdmin() {
  const session = await getServerSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可执行此操作" }, { status: 403 });
  }
  return null;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdmin();
  if (forbidden) {
    return forbidden;
  }
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { status?: string } | null;
  const status = body?.status;
  if (status !== "active" && status !== "disabled") {
    return NextResponse.json({ error: "status 仅支持 active / disabled" }, { status: 400 });
  }
  const result = await setManagedUserStatus(id, status);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: { id, status } });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdmin();
  if (forbidden) {
    return forbidden;
  }
  const { id } = await context.params;
  const result = await deleteManagedUser(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: { deleted: true } });
}
