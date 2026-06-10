import { describe, expect, it } from "vitest";
import { runThreeStageCalculation } from "@/lib/algorithm/three-stage";
import { getGoldenScenario } from "@/lib/fixtures/golden-scenario";
import type { PrefillItem } from "@/lib/types/domain";

const scenario = getGoldenScenario();

function runWith(prefillItems: PrefillItem[]) {
  return runThreeStageCalculation({
    cycleId: scenario.cycle.id,
    productSourceRows: scenario.productSourceRows,
    damoProductRows: scenario.damoProductRows,
    promotionProductRows: scenario.promotionProductRows,
    audienceSourceRows: scenario.audienceSourceRows,
    prefillItems
  });
}

describe("three-stage 对非法分层的健壮性", () => {
  it("未知 grade 不会抛错，而是安全回退（修复 calc-runs 500 崩溃）", () => {
    const corrupted: PrefillItem[] = [
      { ...scenario.prefillItems[0], grade: "Z" as PrefillItem["grade"] },
      ...scenario.prefillItems.slice(1)
    ];

    expect(() => runWith(corrupted)).not.toThrow();

    const run = runWith(corrupted);
    expect(Number.isFinite(run.investmentResults[0].attackDefenseMarginRate)).toBe(true);
    expect(Number.isFinite(run.managementDashboard.availableAdBudget)).toBe(true);
  });
});
