import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { deleteManagedUser, setManagedUserStatus } from "@/lib/store/runtime-store";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdminResponse();
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
  const forbidden = await requireAdminResponse();
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
