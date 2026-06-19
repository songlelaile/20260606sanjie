import { NextResponse } from "next/server";
import { runCalculation } from "@/lib/store/runtime-store";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { cycleId?: string } | null;
  // runCalculation 在 cycleId 省略时回落 state.context.cycle.id，无需先单独加载一次 blob 拿 cycle。
  const run = await runCalculation(body?.cycleId);
  return NextResponse.json({ data: { run } }, { status: 201 });
}
