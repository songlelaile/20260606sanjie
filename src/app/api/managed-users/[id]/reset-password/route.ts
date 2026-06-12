import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/session-server";
import { resetManagedUserPassword } from "@/lib/store/runtime-store";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可执行此操作" }, { status: 403 });
  }
  const { id } = await context.params;
  const result = await resetManagedUserPassword(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: { password: result.password } });
}
