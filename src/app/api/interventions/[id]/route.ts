import { NextResponse } from "next/server";
import { deleteIntervention, updateIntervention } from "@/lib/store/interventions";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as
    | { date?: string; title?: string; note?: string; category?: string; productIds?: string[] }
    | null;
  const result = await updateIntervention(id, body ?? {});
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: { intervention: result.intervention } });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await deleteIntervention(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: { deleted: true } });
}
