import { NextResponse } from "next/server";
import { deleteInviteCode } from "@/lib/store/runtime-store";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const deleted = deleteInviteCode(id);
  if (!deleted) {
    return NextResponse.json({ error: "未找到邀请码" }, { status: 404 });
  }

  return NextResponse.json({ data: { deleted: true } });
}
