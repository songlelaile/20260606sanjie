import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server-session";
import { relayManagementError } from "@/lib/model-gateway/relay-config";

export const RELAY_PRIVATE_HEADERS = { "Cache-Control": "no-store" };

export async function relayAdminGuard(): Promise<NextResponse | null> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401, headers: RELAY_PRIVATE_HEADERS });
  if (user.authRole !== "admin" || user.status !== "active") {
    return NextResponse.json({ error: "仅启用中的管理员可管理中转站" }, { status: 403, headers: RELAY_PRIVATE_HEADERS });
  }
  return null;
}

export function relayErrorResponse(error: unknown) {
  const safe = relayManagementError(error);
  return NextResponse.json({ error: safe.message }, { status: safe.status, headers: RELAY_PRIVATE_HEADERS });
}
