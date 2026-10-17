import { NextResponse } from "next/server";
import { testRelayConnection } from "@/lib/model-gateway/relay-config";
import { relayAdminGuard, relayErrorResponse, RELAY_PRIVATE_HEADERS } from "../_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const denied = await relayAdminGuard();
  if (denied) return denied;
  try { return NextResponse.json({ data: await testRelayConnection() }, { headers: RELAY_PRIVATE_HEADERS }); }
  catch (error) { return relayErrorResponse(error); }
}
