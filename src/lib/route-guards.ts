import "server-only";
import { NextResponse } from "next/server";
import { isSessionAccountValid } from "@/lib/accounts";
import { getServerSession } from "@/lib/session-server";

export async function requireAdminResponse() {
  const session = await getServerSession();
  if (!session || session.role !== "admin" || !(await isSessionAccountValid(session))) {
    return NextResponse.json(
      { error: "仅管理员可执行此操作" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  return null;
}
