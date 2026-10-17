import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { deleteInviteCode, UserManagementAccessError } from "@/lib/store/user-store";

const headers = { "Cache-Control": "private, no-store" };

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdminResponse();
  if (forbidden) {
    forbidden.headers.set("Cache-Control", headers["Cache-Control"]);
    return forbidden;
  }
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return NextResponse.json({ error: "邀请码 ID 无效" }, { status: 400, headers });
  }
  try {
    const deleted = await deleteInviteCode(id);
    if (!deleted) {
      return NextResponse.json({ error: "未找到邀请码" }, { status: 404, headers });
    }
    return NextResponse.json({ data: { deleted: true } }, { headers });
  } catch (error) {
    if (error instanceof UserManagementAccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    throw error;
  }
}
