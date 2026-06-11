import type { PrefillItem } from "@/lib/types/domain";

/**
 * 商品是否「已填写、可纳入三阶计算」。
 * 必填：SAB 分层、毛利率(>0)、月GSV机会(>0)。任一未填则只作占位展示，不进计算。
 */
export function isPrefillReady(
  item: Pick<PrefillItem, "grade" | "grossMarginRate" | "monthlyGsvOpportunity">
): boolean {
  const gradeFilled =
    item.grade === "S" || item.grade === "A" || item.grade === "B" || item.grade === "C";
  return gradeFilled && item.grossMarginRate > 0 && item.monthlyGsvOpportunity > 0;
}
