import { NextResponse } from "next/server";
import { getPrefillItems, getProductTags, updatePrefillItems } from "@/lib/store/runtime-store";
import type { PrefillItem, ProductGrade, ProductTag } from "@/lib/types/domain";

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
    // 允许空串 ""＝未填写（仅占位、不参与计算）；非空时必须是 S/A/B/C。
    if (
      item.grade !== undefined &&
      item.grade !== "" &&
      !VALID_GRADES.includes(item.grade as ProductGrade)
    ) {
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
    if (
      item.tagIds !== undefined &&
      (!Array.isArray(item.tagIds) || item.tagIds.some((id) => typeof id !== "string"))
    ) {
      return `商品 ${item.id} 的标签必须是字符串数组`;
    }
  }
  return null;
}

function validateProductTags(tags: unknown): string | null {
  if (tags === undefined) return null;
  if (!Array.isArray(tags)) {
    return "tags 必须是数组";
  }
  const seen = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== "object" || raw === null) {
      return "tags 中存在非法记录";
    }
    const tag = raw as Record<string, unknown>;
    if (typeof tag.id !== "string" || !/^[a-zA-Z0-9_-]{3,80}$/.test(tag.id)) {
      return "标签 id 必须为 3-80 位字母、数字、下划线或短横线";
    }
    if (typeof tag.name !== "string" || tag.name.trim().length < 1 || tag.name.trim().length > 24) {
      return "标签名称需为 1 到 24 个字符";
    }
    const key = tag.name.trim().toLowerCase();
    if (seen.has(key)) {
      return `标签「${tag.name}」重复`;
    }
    seen.add(key);
  }
  return null;
}

export async function GET(_request: Request, context: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await context.params;
  return NextResponse.json({
    data: {
      items: await getPrefillItems(cycleId),
      tags: await getProductTags()
    }
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await context.params;
  const body = (await request.json().catch(() => null)) as { items?: unknown; tags?: unknown } | null;
  if (!Array.isArray(body?.items)) {
    return NextResponse.json({ error: "items 必须是数组" }, { status: 400 });
  }
  const validationError = validatePrefillItems(body.items);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }
  const tagError = validateProductTags(body.tags);
  if (tagError) {
    return NextResponse.json({ error: tagError }, { status: 400 });
  }
  const items = await updatePrefillItems(
    cycleId,
    body.items as PrefillItem[],
    body.tags === undefined ? undefined : (body.tags as ProductTag[])
  );
  return NextResponse.json({ data: { items, tags: await getProductTags() } });
}
