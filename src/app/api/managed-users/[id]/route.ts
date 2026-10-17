import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { deleteManagedUser, setManagedUserStatus } from "@/lib/store/user-store";

const headers = { "Cache-Control": "private, no-store" };

function isValidId(id: string) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdminResponse();
  if (forbidden) {
    forbidden.headers.set("Cache-Control", headers["Cache-Control"]);
    return forbidden;
  }
  const { id } = await context.params;
  if (!isValidId(id)) {
    return NextResponse.json({ error: "用户 ID 无效" }, { status: 400, headers });
  }
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "status")) {
    return NextResponse.json({ error: "请提交有效的账号状态对象" }, { status: 400, headers });
  }
  const status = (body as Record<string, unknown>).status;
  if (status !== "active" && status !== "disabled") {
    return NextResponse.json({ error: "status 仅支持 active / disabled" }, { status: 400, headers });
  }
  const result = await setManagedUserStatus(id, status);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers });
  }
  return NextResponse.json({ data: { id, status } }, { headers });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdminResponse();
  if (forbidden) {
    forbidden.headers.set("Cache-Control", headers["Cache-Control"]);
    return forbidden;
  }
  const { id } = await context.params;
  if (!isValidId(id)) {
    return NextResponse.json({ error: "用户 ID 无效" }, { status: 400, headers });
  }
  const result = await deleteManagedUser(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status, headers });
  }
  return NextResponse.json({ data: { deleted: true } }, { headers });
}
