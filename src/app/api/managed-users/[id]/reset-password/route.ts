import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { resetManagedUserPassword } from "@/lib/store/runtime-store";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdminResponse();
  if (forbidden) return forbidden;
  const { id } = await context.params;
  const result = await resetManagedUserPassword(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: { password: result.password } });
}
