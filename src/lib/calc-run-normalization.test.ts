import { describe, expect, it } from "vitest";
import { normalizeCalcRun, normalizeInvestmentResults } from "@/lib/calc-run-normalization";

describe("calc run backward compatibility", () => {
  it("turns legacy missing profit evidence into null instead of trusting zero sentinels", () => {
    const [row] = normalizeInvestmentResults([{
      productId: "P-1",
      productName: "旧商品",
      historicalPpc: 0,
      historicalAov: 0,
      netSales: 100,
      historicalGrossProfit: 0,
      historicalMarginRate: 0,
      remainingAdBudget: 0
    }]);
    expect(row.historicalAov).toBeNull();
    expect(row.historicalGrossProfit).toBeNull();
    expect(row.profitEvidenceAvailable).toBe(false);
  });

  it("fills newly added dashboard collections for old snapshots", () => {
    const run = normalizeCalcRun({
      id: "old",
      cycleId: "C-1",
      managementDashboard: { topProducts: [] }
    });
    expect(run.schemaVersion).toBe(2);
    expect(run.managementDashboard.negativeMarginProducts).toEqual([]);
    expect(run.audiencePlans).toEqual([]);
  });
});
