import type { AudiencePlanItem, AudiencePlanType } from "@/lib/types/domain";

export const audiencePlanOrder: AudiencePlanType[] = ["拉新", "追投", "收割"];

export function filterAndSortAudiencePlans(items: AudiencePlanItem[], minimumClicks: number) {
  const threshold = Number.isFinite(minimumClicks) ? Math.max(0, minimumClicks) : 0;
  return items
    .filter((item) => item.clicks >= threshold)
    .sort((left, right) => right.roi - left.roi || right.clicks - left.clicks);
}

export function groupAudiencePlans(items: AudiencePlanItem[]) {
  return items.reduce<Partial<Record<AudiencePlanType, AudiencePlanItem[]>>>((acc, item) => {
    acc[item.type] = [...(acc[item.type] ?? []), item];
    return acc;
  }, {});
}
