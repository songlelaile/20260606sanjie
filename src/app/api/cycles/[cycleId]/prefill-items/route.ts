import { NextResponse } from "next/server";
import { getPrefillItems, updatePrefillItems } from "@/lib/store/runtime-store";
import type { PrefillItem, ProductGrade } from "@/lib/types/domain";

const VALID_GRADES: ProductGrade[] = ["S", "A", "B", "C"];

function validatePrefillItems(items: unknown[]): string | null {
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) {
      return "items 中存在非法记录";
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || item.id === "") {
      return "每条记录必须包含合法的 id";
    }
    if (item.grade !== undefined && !VALID_GRADES.includes(item.grade as ProductGrade)) {
      return `商品 ${item.id} 的分层必须是 S/A/B/C 之一`;
    }
    if (
      item.monthlyGsvOpportunity !== undefined &&
      (typeof item.monthlyGsvOpportunity !== "number" ||
        !Number.isFinite(item.monthlyGsvOpportunity) ||
        item.monthlyGsvOpportunity < 0)
    ) {
      return `商品 ${item.id} 的月GSV机会必须是不小于 0 的数值`;
    }
    for (const field of ["grossMarginRate", "paidVisitorRatio"] as const) {
      const value = item[field];
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
      ) {
        return `商品 ${item.id} 的${field === "grossMarginRate" ? "毛利率" : "付费访客占比"}必须是 0 到 1 之间的数值`;
      }
    }
  }
  return null;
}

export async function GET(_request: Request, context: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await context.params;
  return NextResponse.json({
    data: {
      items: await getPrefillItems(cycleId)
    }
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await context.params;
  const body = (await request.json().catch(() => null)) as { items?: unknown } | null;
  if (!Array.isArray(body?.items)) {
    return NextResponse.json({ error: "items 必须是数组" }, { status: 400 });
  }
  const validationError = validatePrefillItems(body.items);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }
  const items = await updatePrefillItems(cycleId, body.items as PrefillItem[]);
  return NextResponse.json({ data: { items } });
}
