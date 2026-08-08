import { describe, expect, it } from "vitest";
import {
  buildDashboardShareCalcRun,
  parseDashboardShareSections,
  normalizeDashboardShareSections
} from "@/lib/dashboard-share";
import type { CalcRun } from "@/lib/types/domain";

describe("dashboard share helpers", () => {
  it("accepts only known sections and removes duplicates", () => {
    expect(parseDashboardShareSections(["prefill", "prefill", "management"])).toEqual([
      "prefill",
      "management"
    ]);
    expect(parseDashboardShareSections(["prefill", "bad-section"])).toBeNull();
    expect(parseDashboardShareSections([])).toBeNull();
    expect(normalizeDashboardShareSections()).toEqual(["management"]);
  });

  it("keeps only selected module data in the shared calc snapshot", () => {
    const run = createCalcRun();

    const prefillOnly = buildDashboardShareCalcRun(run, ["prefill"]);
    expect(prefillOnly.investmentResults).toEqual([]);
    expect(prefillOnly.breakthroughResults).toEqual([]);
    expect(prefillOnly.audiencePlans).toEqual([]);
    expect(prefillOnly.managementDashboard.productCount).toBe(0);
    expect(prefillOnly.managementDashboard.topProducts).toEqual([]);

    const managementOnly = buildDashboardShareCalcRun(run, ["management"]);
    expect(managementOnly.managementDashboard.productCount).toBe(1);
    expect(managementOnly.managementDashboard.topProducts).toHaveLength(1);
    expect(managementOnly.investmentResults).toEqual([]);
    expect(managementOnly.breakthroughResults).toEqual([]);
    expect(managementOnly.audiencePlans).toEqual([]);

    const allSections = buildDashboardShareCalcRun(run, [
      "management",
      "breakthrough",
      "audience",
      "prefill"
    ]);
    expect(allSections.managementDashboard.productCount).toBe(1);
    expect(allSections.breakthroughResults).toHaveLength(1);
    expect(allSections.audiencePlans).toHaveLength(1);
    expect(allSections.investmentResults).toEqual([]);
  });
});

function createCalcRun(): CalcRun {
  const investment = {
    productId: "p-1",
    productName: "测试商品"
  };
  return {
    id: "run-1",
    cycleId: "cycle-1",
    createdAt: "2026-06-30T00:00:00.000Z",
    investmentResults: [investment],
    breakthroughResults: [{ productId: "p-1", productName: "测试商品", score: 8, dimensions: [] }],
    audiencePlans: [{ planId: "plan-1", clicks: 100, roi: 2 }],
    managementDashboard: {
      productCount: 1,
      monthlyNetSales: 100,
      monthlyProfitEstimate: 20,
      monthlyGsvOpportunity: 50,
      marketSalesGap: 0,
      historicalMarginRate: 0.2,
      plannedProfit: 10,
      availableAdBudget: 5,
      plannedMarginRate: 0.2,
      topProducts: [investment]
    }
  } as unknown as CalcRun;
}
