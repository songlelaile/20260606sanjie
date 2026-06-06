import { describe, expect, it } from "vitest";
import { filterAndSortAudiencePlans } from "@/lib/audience-plan-view";
import type { AudiencePlanItem } from "@/lib/types/domain";

describe("audience plan view", () => {
  it("filters by minimum clicks and sorts by ROI descending", () => {
    const items = [
      createPlan({ planId: "low-clicks", clicks: 99, roi: 99 }),
      createPlan({ planId: "mid-roi", clicks: 100, roi: 3 }),
      createPlan({ planId: "high-roi", clicks: 170, roi: 18.32 })
    ];

    const result = filterAndSortAudiencePlans(items, 100);

    expect(result.map((item) => item.planId)).toEqual(["high-roi", "mid-roi"]);
  });
});

function createPlan(input: { planId: string; clicks: number; roi: number }): AudiencePlanItem {
  return {
    type: "追投",
    sceneName: "场景",
    planId: input.planId,
    planName: input.planId,
    audienceName: "人群",
    clicks: input.clicks,
    roi: input.roi,
    guidedPotentialCustomerRatio: 0.5,
    newCustomerRatio: 0.5,
    subjectName: "商品"
  };
}
