import { NextResponse } from "next/server";
import { requireAdminResponse } from "@/lib/route-guards";
import { getServerSession } from "@/lib/session-server";
import { setDmpAutomationEntitlement } from "@/lib/tool-entitlements";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const forbidden = await requireAdminResponse();
  if (forbidden) return forbidden;

  const session = await getServerSession();
  const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled 必须是布尔值" }, { status: 400 });
  }

  const { id } = await context.params;
  const result = await setDmpAutomationEntitlement({
    userId: id,
    enabled: body.enabled,
    grantedBy: session?.username ?? "admin"
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { data: { id, dmpAutomationAccess: result.access } },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
