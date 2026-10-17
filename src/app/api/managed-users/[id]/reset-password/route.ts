import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { resetManagedUserPassword } from "@/lib/store/user-store";

const headers = { "Cache-Control": "private, no-store" };

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdminResponse();
  if (forbidden) {
    forbidden.headers.set("Cache-Control", headers["Cache-Control"]);
    return forbidden;
  }
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return NextResponse.json({ error: "用户 ID 无效" }, { status: 400, headers });
  }
  const result = await resetManagedUserPassword(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers });
  }
  return NextResponse.json({ data: { password: result.password } }, { headers });
}
