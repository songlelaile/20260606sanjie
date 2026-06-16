import { NextResponse } from "next/server";
import { getDailyDataStatus, setDailyRetentionDays } from "@/lib/store/runtime-store";

export async function GET() {
  return NextResponse.json({ data: await getDailyDataStatus() });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as { days?: number } | null;
  if (typeof body?.days !== "number" || !Number.isFinite(body.days)) {
    return NextResponse.json({ error: "days 必须是数值（0=永久保留）" }, { status: 400 });
  }
  const pruned = await setDailyRetentionDays(body.days);
  const status = await getDailyDataStatus();
  return NextResponse.json({ data: { ...status, pruned } });
}
