import { NextResponse } from "next/server";
import { createIntervention, getInterventions } from "@/lib/store/interventions";

export async function GET() {
  return NextResponse.json({ data: { interventions: await getInterventions() } });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { date?: string; title?: string; note?: string; category?: string; productIds?: string[] }
    | null;
  const result = await createIntervention({
    date: body?.date ?? "",
    title: body?.title ?? "",
    note: body?.note,
    category: body?.category,
    productIds: body?.productIds
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ data: { intervention: result.intervention } }, { status: 201 });
}
