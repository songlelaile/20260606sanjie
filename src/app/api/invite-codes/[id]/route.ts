import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { deleteInviteCode } from "@/lib/store/runtime-store";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdminResponse();
  if (forbidden) return forbidden;
  const { id } = await context.params;
  const deleted = await deleteInviteCode(id);
  if (!deleted) {
    return NextResponse.json({ error: "未找到邀请码" }, { status: 404 });
  }

  return NextResponse.json({ data: { deleted: true } });
}
