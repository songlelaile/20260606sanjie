import { getSowerWorkAccess, sowerWorkAccessResponse } from "@/lib/sower-work-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return sowerWorkAccessResponse(await getSowerWorkAccess());
}
