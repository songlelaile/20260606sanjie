import { describe, expect, it } from "vitest";
import {
  buildAudiencePlans,
  buildBreakthroughResults,
  marginMatrix,
  runThreeStageCalculation
} from "@/lib/algorithm/three-stage";
import { getGoldenScenario } from "@/lib/fixtures/golden-scenario";

const scenario = getGoldenScenario();

describe("three-stage calculation", () => {
  it("matches the V9 workbook golden management KPIs", () => {
    const run = runThreeStageCalculation({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows,
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: scenario.audienceSourceRows,
      prefillItems: scenario.prefillItems
    });

    expect(run.managementDashboard.productCount).toBe(60);
    expect(run.managementDashboard.monthlyNetSales).toBeCloseTo(89825.9, 3);
    expect(run.managementDashboard.monthlyProfitEstimate).toBeCloseTo(14990.8, 3);
    expect(run.managementDashboard.monthlyGsvOpportunity).toBeCloseTo(429225.9, 3);
    expect(run.managementDashboard.availableAdBudget).toBeCloseTo(8454.842, 3);
    expect(run.managementDashboard.marketSalesGap).toBeCloseTo(-339400, 3);
  });

  it("keeps core investment formula behavior explicit", () => {
    const run = runThreeStageCalculation({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows,
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: scenario.audienceSourceRows,
      prefillItems: scenario.prefillItems
    });

    const first = run.investmentResults[0];
    expect(first.lifecycle).toBe("爆品期");
    expect(first.grade).toBe("S");
    expect(first.attackDefenseMarginRate).toBe(0.1);
    expect(first.netSales).toBeCloseTo(47111.02, 2);
    expect(first.historicalGrossProfit).toBeCloseTo(10108.078, 3);
    expect(first.remainingAdBudget).toBeCloseTo(5396.976, 3);
  });

  it("uses an editable growth profit margin matrix when provided", () => {
    const editableMatrix = {
      ...marginMatrix,
      S: {
        ...marginMatrix.S,
        爆品期: 0.22
      }
    };
    const run = runThreeStageCalculation({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows,
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: scenario.audienceSourceRows,
      prefillItems: scenario.prefillItems,
      marginMatrix: editableMatrix
    });

    const first = run.investmentResults[0];
    expect(first.attackDefenseMarginRate).toBe(0.22);
    expect(first.plannedGrossProfit).toBeCloseTo(14256, 3);
  });

  it("generates eight-dimension solution codes without spreadsheet errors", () => {
    const items = buildBreakthroughResults({
      cycleId: scenario.cycle.id,
      productSourceRows: scenario.productSourceRows,
      damoProductRows: scenario.damoProductRows,
      promotionProductRows: scenario.promotionProductRows,
      audienceSourceRows: scenario.audienceSourceRows,
      prefillItems: scenario.prefillItems
    });

    expect(items).toHaveLength(60);
    expect(items[0].solutionCode).toMatch(/^[01]{8}$/);
    expect(items[0].dimensions).toHaveLength(8);
    expect(items.every((item) => !item.solution.includes("#DIV/0!"))).toBe(true);
  });

  it("classifies audience rows into acquisition, retargeting, and harvesting", () => {
    const plans = buildAudiencePlans(scenario.audienceSourceRows);

    expect(plans.map((item) => item.type)).toEqual(["拉新", "追投", "收割"]);
  });
});
