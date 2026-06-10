import { NextResponse } from "next/server";
import { getWorkspaceContext, runCalculation } from "@/lib/store/runtime-store";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { cycleId?: string } | null;
  const { cycle } = await getWorkspaceContext();
  const run = await runCalculation(body?.cycleId ?? cycle.id);
  return NextResponse.json({ data: { run } }, { status: 201 });
}
