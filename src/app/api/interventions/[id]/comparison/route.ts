import { NextResponse } from "next/server";
import { buildInterventionComparison } from "@/lib/store/runtime-store";

function clampDays(value: string | null, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(90, Math.max(1, Math.round(n)));
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const beforeDays = clampDays(url.searchParams.get("before"), 7);
  const afterDays = clampDays(url.searchParams.get("after"), 7);
  const comparison = await buildInterventionComparison(id, beforeDays, afterDays);
  if (!comparison) {
    return NextResponse.json({ error: "动作不存在" }, { status: 404 });
  }
  return NextResponse.json({ data: { comparison } });
}
