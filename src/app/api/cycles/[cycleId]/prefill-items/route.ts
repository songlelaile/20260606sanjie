import { NextResponse } from "next/server";
import { getPrefillItems, updatePrefillItems } from "@/lib/store/runtime-store";
import type { PrefillItem } from "@/lib/types/domain";

export async function GET(_request: Request, context: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await context.params;
  return NextResponse.json({
    data: {
      items: getPrefillItems(cycleId)
    }
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await context.params;
  const body = (await request.json().catch(() => null)) as { items?: PrefillItem[] } | null;
  if (!Array.isArray(body?.items)) {
    return NextResponse.json({ error: "items 必须是数组" }, { status: 400 });
  }
  const items = updatePrefillItems(cycleId, body.items);
  return NextResponse.json({ data: { items } });
}
