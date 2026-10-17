import { NextResponse } from "next/server";
import { getRelaySettings, saveRelaySettings } from "@/lib/model-gateway/relay-config";
import { readJsonWithLimit } from "@/lib/read-json-with-limit";
import { relayAdminGuard, relayErrorResponse, RELAY_PRIVATE_HEADERS } from "./_shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const denied = await relayAdminGuard();
  if (denied) return denied;
  try { return NextResponse.json({ data: await getRelaySettings() }, { headers: RELAY_PRIVATE_HEADERS }); }
  catch (error) { return relayErrorResponse(error); }
}

export async function PUT(request: Request) {
  const denied = await relayAdminGuard();
  if (denied) return denied;
  let input: unknown;
  try { input = await readJsonWithLimit(request, 1_000_000); }
  catch { return NextResponse.json({ error: "配置请求超过 1 MB 限制" }, { status: 413, headers: RELAY_PRIVATE_HEADERS }); }
  try { return NextResponse.json({ data: await saveRelaySettings(input) }, { headers: RELAY_PRIVATE_HEADERS }); }
  catch (error) { return relayErrorResponse(error); }
}
